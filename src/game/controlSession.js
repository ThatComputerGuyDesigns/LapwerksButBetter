// Race Control session: an all-AI race you direct as race control /
// stewards. TV-style director cameras, focus on any car, flags, safety car,
// incident review room (replay buffer) and decisions.
import * as THREE from 'three';
import { DriveSession } from './drive.js';
import { RaceField } from './rivals.js';
import { RaceControl } from './raceControl.js';
import { ReplayBuffer } from './replay.js';
import { createCar, disposeCar } from '../car/carModel.js';
import { clamp, angleWrap, damp, lerp } from '../core/math.js';
import { CarPoser } from './pose.js';
import { audio } from '../audio/audio.js';

const PHYS_DT = 1 / 240;
export const RC_CAMERAS = ['tv', 'chase', 'onboard', 'heli'];

export class ControlSession extends DriveSession {
  constructor(app, cfg) {
    super(app, { mode: 'control' });
    this.cfg = cfg;
    this.mesh.visible = false;
    this.lineMesh.visible = false;
    this.playerMesh = this.mesh;
    this.field = new RaceField(this, { laps: cfg.laps, rivals: cfg.cars, difficulty: 'hard', rivalBodies: cfg.bodies, spectator: true, drama: cfg.drama, paceSpread: [0.9, 1.0] });
    this.field.control = new RaceControl(this.field);
    this.rc = this.field.control;
    this.field.resetGrid();
    this.field.onSafetyCar = (sc, out) => this.safetyCarMesh(sc, out);
    this.field.onIncident = (inc) => this.onIncident(inc);
    this.field.onMessage = (text) => this.app.rcui?.message(text);
    this.replay = new ReplayBuffer(this.field.cars.length + 1);
    this.focus = this.field.cars[0];
    this.car = this.focus.car;
    this.mesh = this.focus.mesh;
    this.camMode = 'tv';
    this.autoDirector = true;
    this.directorT = 0;
    this.raceTime = 0;
    this.review = null;
    this.buildCameraPosts();
    this.tvPost = null;
    this.shotT = 0;
    this.state = 'countdown';
    this.countdown = 4.2;
  }

  dispose() {
    for (const p of this.panels || []) this.world.content.remove(p.g);
    if (this.scMesh) { this.world.content.remove(this.scMesh); disposeCar(this.scMesh); }
    this.mesh = this.playerMesh;
    super.dispose();
  }

  // --------------------------------------------------------------- cameras
  buildCameraPosts() {
    const T = this.T;
    this.posts = [];
    // camera positions placed in the Track Studio take priority
    const cams = T.def.cams || [];
    if (cams.length >= 2) {
      for (const c of cams) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < T.N; i += 2) { const d = (T.px[i] - c.x) ** 2 + (T.pz[i] - c.z) ** 2; if (d < bd) { bd = d; bi = i; } }
        this.posts.push({ s: T.s[bi], i: bi, x: c.x, z: c.z, y: T.py[bi] + 8 });
      }
      this.posts.sort((a, b) => a.s - b.s);
    }
    // otherwise TV posts every ~260 m, on the outside of the nearest corner, raised
    for (let s = 0; s < T.length - 120 && cams.length < 2; s += 260) {
      let i = Math.floor(s / T.DS) % T.N;
      let bestK = 0, bestC = 0;
      for (let k = 0; k < 60; k++) { const c = Math.abs(T.curv[(i + k) % T.N]); if (c > bestC) { bestC = c; bestK = k; } }
      i = (i + bestK) % T.N;
      const side = T.curv[i] > 0 ? -1 : 1; // outside of the turn
      const room = side > 0 ? T.runL[i] : T.runR[i];
      const d = side * (T.half + Math.min(room, 15) + 6);
      this.posts.push({ s: T.s[i], i, x: T.px[i] + T.nx[i] * d, z: T.pz[i] + T.nz[i] * d, y: T.py[i] + 7 + (bestC > 1 / 120 ? 3 : 0) });
    }
    // marshal light panels (show flags in the world)
    const geo = new THREE.BoxGeometry(0.9, 0.6, 0.12);
    const pole = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x555a60, metalness: 0.6, roughness: 0.4 });
    this.panels = [];
    for (let s = 60; s < T.length; s += 230) {
      const i = Math.floor(s / T.DS) % T.N;
      const side = T.wallL[i] ? 1 : -1;
      const d = side * (T.half + (side > 0 ? T.runL[i] : T.runR[i]) + 0.9);
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x000000, emissiveIntensity: 3 });
      const panel = new THREE.Mesh(geo, mat);
      panel.position.y = 2.6;
      const p = new THREE.Mesh(pole, poleMat);
      p.position.y = 1.2;
      g.add(panel, p);
      g.position.set(T.px[i] + T.nx[i] * d, T.py[i], T.pz[i] + T.nz[i] * d);
      g.rotation.y = Math.atan2(T.tx[i], T.tz[i]) + Math.PI;
      this.world.content.add(g);
      this.panels.push({ g, mat, sector: Math.min(2, Math.floor((s / T.length) * 3)) });
    }
  }

  updatePanels() {
    const RC = this.rc;
    const blink = Math.sin(this.time * 9) > 0;
    for (const p of this.panels) {
      let c = 0x000000;
      if (RC.flag === 'red') c = 0xff2010;
      else if (RC.flag === 'sc' || RC.flag === 'vsc') c = blink ? 0xffa000 : 0x000000;
      else if (RC.yellowSectors.has(p.sector)) c = blink ? 0xffd000 : 0x302800;
      p.mat.emissive.setHex(c);
    }
  }

  /** Best TV post for a track position (the one covering it, else the next). */
  postFor(s, current) {
    const T = this.T;
    const rel = (p) => { let d = p.s - s; if (d < -T.length / 2) d += T.length; if (d > T.length / 2) d -= T.length; return d; };
    if (current) { const d = rel(current); if (d > -90 && d < 200) return current; } // hold the shot
    let best = this.posts[0], bd = Infinity;
    for (const p of this.posts) { const d = rel(p); const score = d < -40 ? Infinity : Math.abs(d - 110); if (score < bd) { bd = score; best = p; } }
    return best;
  }

  setFocus(entry) {
    if (!entry) return;
    this.focus = entry;
    this.car = entry.car;
    this.mesh = entry.mesh;
    this.camInit = false;
    this.skids.reset();
  }

  cycleCamera(dir = 1) {
    const i = RC_CAMERAS.indexOf(this.camMode);
    this.camMode = RC_CAMERAS[(i + dir + RC_CAMERAS.length) % RC_CAMERAS.length];
    this.camInit = false;
  }

  safetyCarMesh(sc, out) {
    if (out) {
      const m = createCar(sc.setup);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.08, 0.22), new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffa000, emissiveIntensity: 3 }));
      bar.position.set(0, 1.3, -0.2);
      m.userData.body.add(bar);
      m.userData.lightBar = bar.material;
      this.world.content.add(m);
      this.scMesh = m;
    } else if (this.scMesh) {
      this.world.content.remove(this.scMesh);
      disposeCar(this.scMesh);
      this.scMesh = null;
    }
  }

  onIncident(inc) {
    audio.beep(inc.severity >= 2 ? 660 : 520, 0.12, 0.12, 'triangle');
    this.app.rcui?.incidentsChanged(inc);
    // no forced camera cut: the steward desk raises it; you decide when to look
  }

  // --------------------------------------------------------------- loop
  update(dt) {
    dt = Math.min(dt, 0.05);
    if (this.review) { this.updateReview(dt); return; }
    if (this.paused) { this.updateCamera(dt); return; }
    this.time += dt;
    const F = this.field;
    const lights = this.app.trackGroup?.userData.startLights;
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const lit = clamp(Math.floor((4.2 - this.countdown) / 0.7), 0, 5);
      if (lights) lights.forEach((m, k) => (m.emissiveIntensity = k < lit ? 6 : 0));
      F.step(PHYS_DT, 0, false);
      if (this.countdown <= 0) {
        this.state = 'running';
        if (lights) lights.forEach((m) => (m.emissiveIntensity = 0));
        this.app.rcui?.message('Lights out — the race is on');
      }
    } else {
      const k = this.timeScale || 1; // fast-forward through quiet laps
      this.acc += dt * k;
      let steps = 0;
      while (this.acc >= PHYS_DT && steps < 16 * k) {
        F.step(PHYS_DT, this.raceTime, true);
        this.raceTime += PHYS_DT;
        this.acc -= PHYS_DT;
        steps++;
      }
      if (steps >= 16 * k) this.acc = 0;
      const cars = F.cars.map((r) => r.car);
      cars.push(this.rc.sc ? this.rc.sc.car : null);
      this.replay.record(this.raceTime, cars);
      if (this.state === 'running' && F.cars.every((r) => r.finished != null || r.dsq)) {
        this.state = 'finished';
        setTimeout(() => this.app.onControlFinish?.(this), 1500);
      }
    }
    // director: follow the closest battle; only change focus at a natural cut
    // (when the current TV shot ends) and never more often than every 12 s
    this.directorT -= dt;
    this.shotT += dt;
    if (this.autoDirector && this.state === 'running' && this.directorT <= 0 && this.cutReady) {
      const o = F.order();
      let best = o[0], gap = Infinity;
      for (let k = 1; k < o.length; k++) {
        let g = o[k - 1].car.q.s - o[k].car.q.s;
        if (g < 0) g += this.T.length;
        if (g < gap && !o[k].dsq && o[k].stoppedT === 0) { gap = g; best = o[k]; }
      }
      if (best !== this.focus) this.setFocus(best);
      this.directorT = 12;
    }
    // visuals
    const alpha = this.state === 'running' ? clamp(this.acc / PHYS_DT, 0, 1) : 1;
    F.sync(dt, alpha);
    this.updatePanels();
    if (this.rc.sc && this.scMesh) this.poseMesh(this.scMesh, this.rc.sc, alpha, dt);
    if (this.scMesh) this.scMesh.userData.lightBar.emissiveIntensity = Math.sin(this.time * 12) > 0 ? 4 : 0.5;
    const r = this.focus;
    this.visHeading = r.visH ?? r.car.heading;
    this.effects(dt);
    this.updateCamera(dt);
    this.world.followShadow(this.mesh.position);
    audio.update(this.car, { interior: this.camMode === 'onboard' });
  }

  poseMesh(mesh, e, alpha, dt) {
    const c = e.car;
    const x = e.prev.x + (c.x - e.prev.x) * alpha, z = e.prev.z + (c.z - e.prev.z) * alpha;
    const h = e.prev.h + angleWrap(c.heading - e.prev.h) * alpha;
    e.poser = e.poser || new CarPoser();
    e.poser.apply(mesh, this.T, x, z, h, c.hint, dt);
    mesh.userData.sync(c, dt);
  }

  updateCamera(dt) {
    const R = this.review;
    const mode = R ? R.angle : this.camMode;
    const cam = this.world.camera;
    const target = this.mesh.position;
    const H = this.visHeading ?? this.car.heading;
    const fwd = new THREE.Vector3(Math.sin(H), 0, Math.cos(H));
    let pos, fov = 40, follow = 4;
    this.cutReady = false;
    if (mode === 'chase' || mode === 'carA' || mode === 'carB') {
      pos = target.clone().addScaledVector(fwd, -7).add(new THREE.Vector3(0, 2.4, 0));
      fov = 55; follow = 8;
      this.cutReady = this.shotT > 8;
    } else if (mode === 'onboard') {
      pos = target.clone().addScaledVector(fwd, 0.6).add(new THREE.Vector3(0, 1.15, 0));
      fov = 68; follow = 60;
      this.cutReady = this.shotT > 8;
    } else if (mode === 'heli' || mode === 'overhead') {
      const r = mode === 'overhead' ? 16 : 60;
      const a = H + Math.sin(this.time * 0.08) * 0.7;
      pos = new THREE.Vector3(target.x - Math.sin(a) * r, target.y + (mode === 'overhead' ? 36 : 34), target.z - Math.cos(a) * r);
      fov = mode === 'overhead' ? 48 : 36; follow = 1.6;
      this.cutReady = this.shotT > 10;
    } else {
      // TV: hold a trackside post while the car is in its coverage; pan & zoom smoothly
      const s = R ? R.s : this.car.q.s;
      const post = R ? (R.post = R.post || this.postFor(s, null)) : this.postFor(s, this.tvPost);
      if (post !== this.tvPost && !R) { this.tvPost = post; this.camInit = false; this.cutReady = this.shotT > 4; this.shotT = 0; }
      pos = new THREE.Vector3(post.x, post.y, post.z);
      const dist = pos.distanceTo(target);
      fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(6.5 / Math.max(dist, 1))), 5, 50);
      follow = 1e9; // locked tripod
    }
    if (!this.camInit) { this.camPos.copy(pos); this.camLook.copy(target); cam.fov = fov; this.camInit = true; }
    else this.camPos.lerp(pos, follow > 1e6 ? 1 : damp(follow, dt));
    // smooth pan with slight lead in the direction of travel
    const lookTarget = target.clone().addScaledVector(fwd, mode === 'tv' ? 3 : 2);
    this.camLook.lerp(lookTarget, damp(mode === 'tv' ? 6 : 12, dt));
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook.x, this.camLook.y + 0.6, this.camLook.z);
    cam.fov += (fov - cam.fov) * damp(2.2, dt);
    cam.updateProjectionMatrix();
  }

  // --------------------------------------------------------------- review room
  openReview(inc) {
    const t1 = Math.min(this.replay.end, inc.time + 4);
    const t0 = Math.max(this.replay.start, inc.time - 6);
    this.review = { inc, t0, t1, t: t0, speed: 0.5, playing: true, angle: 'tv', target: inc.cars[0], s: inc.s, post: null };
    this.camInit = false;
    audio.silence();
  }

  closeReview() {
    this.review = null;
    this.camInit = false;
    // meshes snap back to live on the next sync
  }

  updateReview(dt) {
    const R = this.review;
    if (R.playing) {
      R.t += dt * R.speed;
      if (R.t >= R.t1) { R.t = R.t0; }
    }
    const F = this.field;
    const pose = [0, 0, 0, 0, 0];
    F.cars.forEach((r, k) => {
      const p = this.replay.pose(k, R.t, pose);
      if (!p) return;
      r.poser = r.poser || new CarPoser();
      r.poser.apply(r.mesh, this.T, p[0], p[2], p[3], r.car.hint, dt, false);
      const w = r.mesh.userData.wheels;
      if (w) { w[0].steer.rotation.y = w[1].steer.rotation.y = p[4]; }
    });
    const tgt = R.angle === 'carB' && R.inc.cars[1] ? R.inc.cars[1] : R.inc.cars[0];
    this.mesh = tgt.mesh;
    this.car = tgt.car;
    const k = F.cars.indexOf(tgt);
    const p = this.replay.pose(k, R.t, pose);
    if (p) { this.visHeading = p[3]; R.s = this.T.query(p[0], p[2], tgt.car.hint).s; }
    this.time += dt;
    this.updateCamera(dt);
    this.world.followShadow(this.mesh.position);
  }

  timing() {}
}
