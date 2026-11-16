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
    this.state = 'countdown';
    this.countdown = 4.2;
  }

  dispose() {
    if (this.scMesh) { this.world.content.remove(this.scMesh); disposeCar(this.scMesh); }
    this.mesh = this.playerMesh;
    super.dispose();
  }

  // --------------------------------------------------------------- cameras
  buildCameraPosts() {
    const T = this.T;
    this.posts = [];
    let side = 1;
    for (let s = 0; s < T.length; s += 85) {
      const i = Math.floor(s / T.DS) % T.N;
      const room = side > 0 ? T.runL[i] : T.runR[i];
      const d = side * (T.half + Math.min(room, 15) + 5);
      this.posts.push({ s, x: T.px[i] + T.nx[i] * d, z: T.pz[i] + T.nz[i] * d, y: T.py[i] + 5 + (Math.abs(T.curv[i]) > 1 / 150 ? 3 : 0) });
      side = -side;
    }
  }

  postFor(s) {
    const T = this.T;
    // the post just ahead of the car (or slightly behind) — classic TV coverage
    let best = this.posts[0], bd = Infinity;
    for (const p of this.posts) {
      let ds = p.s - s;
      if (ds < -T.length / 2) ds += T.length;
      if (ds > T.length / 2) ds -= T.length;
      const score = ds < -35 ? Infinity : Math.abs(ds - 45);
      if (score < bd) { bd = score; best = p; }
    }
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
    this.app.rcui?.incidentsChanged();
    // the director cuts to fresh action
    if (this.autoDirector && inc.cars[0]) { this.setFocus(inc.cars[0]); this.directorT = 6; }
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
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYS_DT && steps < 16) {
        F.step(PHYS_DT, this.raceTime, true);
        this.raceTime += PHYS_DT;
        this.acc -= PHYS_DT;
        steps++;
      }
      if (steps === 16) this.acc = 0;
      const cars = F.cars.map((r) => r.car);
      cars.push(this.rc.sc ? this.rc.sc.car : null);
      this.replay.record(this.raceTime, cars);
      if (this.state === 'running' && F.cars.every((r) => r.finished != null || r.dsq)) {
        this.state = 'finished';
        setTimeout(() => this.app.onControlFinish?.(this), 1500);
      }
    }
    // director: cut between battles
    this.directorT -= dt;
    if (this.autoDirector && this.directorT <= 0 && this.state === 'running') {
      const o = F.order();
      let best = o[0], gap = Infinity;
      for (let k = 1; k < o.length; k++) {
        let g = o[k - 1].car.q.s - o[k].car.q.s;
        if (g < 0) g += this.T.length;
        if (g < gap && !o[k].dsq) { gap = g; best = o[k]; }
      }
      this.setFocus(best);
      this.directorT = 9 + Math.random() * 6;
      if (Math.random() < 0.35) this.camMode = ['tv', 'tv', 'chase', 'heli', 'onboard'][Math.floor(Math.random() * 5)];
    }
    // visuals
    const alpha = this.state === 'running' ? clamp(this.acc / PHYS_DT, 0, 1) : 1;
    F.sync(dt, alpha);
    if (this.rc.sc && this.scMesh) this.poseMesh(this.scMesh, this.rc.sc, alpha, dt);
    if (this.scMesh) this.scMesh.userData.lightBar.emissiveIntensity = Math.sin(this.time * 12) > 0 ? 4 : 0.5;
    const r = this.focus;
    this.visHeading = r.prev.h + angleWrap(r.car.heading - r.prev.h) * alpha;
    this.effects(dt);
    this.updateCamera(dt);
    this.world.followShadow(this.mesh.position);
    audio.update(this.car, { interior: this.camMode === 'onboard' });
  }

  poseMesh(mesh, e, alpha, dt) {
    const c = e.car;
    const x = e.prev.x + (c.x - e.prev.x) * alpha, z = e.prev.z + (c.z - e.prev.z) * alpha;
    const h = e.prev.h + angleWrap(c.heading - e.prev.h) * alpha;
    mesh.position.set(x, c.y, z);
    mesh.rotation.set(0, h, 0);
    mesh.userData.sync(c, dt);
  }

  updateCamera(dt) {
    const mode = this.review ? this.review.angle : this.camMode;
    const cam = this.world.camera;
    const target = this.mesh.position;
    if (mode === 'chase' || mode === 'carA' || mode === 'carB') { const m = this.camMode; this.camMode = 'chase'; super.updateCamera(dt); this.camMode = m; return; }
    if (mode === 'onboard') { const m = this.camMode; this.camMode = 'hood'; super.updateCamera(dt); this.camMode = m; return; }
    let pos;
    let fov = 40;
    if (mode === 'heli' || mode === 'overhead') {
      const H = this.visHeading ?? this.car.heading;
      const t = this.time * 0.15;
      const r = mode === 'overhead' ? 18 : 55;
      pos = new THREE.Vector3(target.x - Math.sin(H + Math.sin(t) * 0.6) * r, target.y + (mode === 'overhead' ? 38 : 32), target.z - Math.cos(H + Math.sin(t) * 0.6) * r);
      fov = mode === 'overhead' ? 50 : 38;
    } else {
      // TV: trackside post, zoom to keep the car a constant size on screen
      const s = this.review ? this.review.s : this.car.q.s;
      const p = this.postFor(this.review ? s : s);
      pos = new THREE.Vector3(p.x, p.y, p.z);
      const dist = pos.distanceTo(target);
      fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(7 / Math.max(dist, 1))), 6, 55);
    }
    if (!this.camInit || this.review) { this.camPos.copy(pos); this.camInit = true; }
    else if (mode === 'tv') { if (this.camPos.distanceTo(pos) > 1) this.camPos.copy(pos); }
    else this.camPos.lerp(pos, damp(3, dt));
    cam.position.copy(this.camPos);
    this.camLook.lerp(target, this.camInit ? damp(10, dt) : 1);
    if (this.camLook.distanceTo(target) > 30) this.camLook.copy(target);
    cam.lookAt(this.camLook.x, this.camLook.y + 0.6, this.camLook.z);
    cam.fov += (fov - cam.fov) * damp(mode === 'tv' ? 8 : 3, dt);
    cam.updateProjectionMatrix();
  }

  // --------------------------------------------------------------- review room
  openReview(inc) {
    const t1 = Math.min(this.replay.end, inc.time + 4);
    const t0 = Math.max(this.replay.start, inc.time - 6);
    this.review = { inc, t0, t1, t: t0, speed: 0.5, playing: true, angle: 'tv', target: inc.cars[0], s: inc.s };
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
      r.mesh.position.set(p[0], p[1], p[2]);
      r.mesh.rotation.set(0, p[3], 0);
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
