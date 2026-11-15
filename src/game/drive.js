// A driving session on a built track: physics stepping, camera rig, lap
// timing (sectors, live delta, track limits), ghost of your best lap,
// particles, skid marks, start lights and the AI attract mode.
import * as THREE from 'three';
import { Vehicle, ASSIST_PRESETS } from '../physics/vehicle.js';
import { AIDriver } from '../physics/driver.js';
import { makeCarParams } from '../physics/carSetup.js';
import { speedProfile } from '../track/racingLine.js';
import { createCar, disposeCar } from '../car/carModel.js';
import { Particles, SkidMarks } from './effects.js';
import { buildRacingLineMesh } from '../world/trackMesh.js';
import { clamp, lerp, angleWrap, damp } from '../core/math.js';
import { audio } from '../audio/audio.js';
import { RaceField } from './rivals.js';

const PHYS_DT = 1 / 240;
export const CAMERAS = ['chase', 'near', 'hood', 'bumper', 'orbit'];

export class DriveSession {
  constructor(app, { mode = 'race', race = null } = {}) {
    this.app = app;
    this.world = app.world;
    this.T = app.track;
    this.line = app.line;
    this.mode = mode; // race | attract
    this.setup = app.setup;
    this.params = makeCarParams(this.setup);
    this.profile = speedProfile(this.T, this.line, this.params);
    this.line.profile = this.profile;
    this.car = new Vehicle(this.params, this.T);
    this.car.assists = { ...ASSIST_PRESETS[app.settings.assists] };
    if (app.settings.gearbox === 'manual') this.car.assists.autoShift = false;
    this.ai = new AIDriver(this.T, this.line, this.profile, { pace: mode === 'attract' ? 0.9 : 1 });
    this.mesh = createCar(this.setup);
    this.world.content.add(this.mesh);
    this.ghostMesh = null;
    this.particles = new Particles(700);
    this.world.content.add(this.particles.points);
    this.skids = new SkidMarks(4000);
    this.world.content.add(this.skids.mesh);
    this.lineMesh = buildRacingLineMesh(this.T, this.line, this.profile);
    this.lineMesh.visible = mode === 'race' && this.car.assists.line && app.settings.showLine !== false;
    this.world.content.add(this.lineMesh);
    this.camMode = app.settings.camera || 'chase';
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camVel = new THREE.Vector3();
    this.orbit = { yaw: 0, pitch: 0.25, dist: 9 };
    this.acc = 0;
    this.time = 0;
    this.paused = false;
    this.lap = this.newLapState();
    this.prev = { x: 0, z: 0, h: 0 };
    this.tiltQ = new THREE.Quaternion();
    this._v = { y: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(), qa: new THREE.Quaternion(), qh: new THREE.Quaternion(), qt: new THREE.Quaternion() };
    this.trackKey = app.trackKey();
    this.best = app.store.getBest(this.trackKey, this.setup) || null; // {time, splits:[...], ghost:[...], sectors}
    this.lastLap = null;
    this.lapsDone = 0;
    this.msgs = [];
    this.raceCfg = mode === 'race' ? race : null;
    this.field = this.raceCfg ? new RaceField(this, this.raceCfg) : null;
    this.resetToGrid();
  }

  newLapState() {
    return { start: null, t: 0, invalid: false, sectorTimes: [], splits: new Float32Array(this.T.N).fill(NaN), ghost: [], lastS: 0, sector: 0 };
  }

  resetToGrid() {
    const T = this.T;
    const sGrid = T.length - 14;
    const i = Math.floor(sGrid / T.DS);
    if (this.field) {
      const slot = this.field.resetGrid();
      this.car.reset(slot.s, slot.lat);
    } else this.car.reset(sGrid, this.mode === 'attract' ? this.line.offset[i] : T.half * 0.45);
    this.lapsDone = 0;
    this.raceBest = null;
    this.goTime = null;
    for (const w of this.car.wheels) { w.temp = 45; w.core = 40; }
    this.lap = this.newLapState();
    this.lap.lastS = this.car.q.s;
    this.state = this.mode === 'attract' ? 'running' : 'countdown';
    this.countdown = 4.2;
    this.skids.reset();
    this.camPos.set(0, 0, 0);
    this.camInit = false;
    this.prev = { x: this.car.x, z: this.car.z, h: this.car.heading };
    this.visInit = false;
    this.tiltQ = new THREE.Quaternion();
    if (this.best?.ghost?.length) this.ensureGhost();
  }

  ensureGhost() {
    if (this.ghostMesh) return;
    const g = createCar({ ...this.setup, paint: '#9fd8ff', livery: 'none' });
    g.traverse((o) => {
      if (o.isMesh) {
        o.material = new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.22, depthWrite: false });
        o.castShadow = false;
      }
    });
    g.visible = false;
    this.ghostMesh = g;
    this.world.content.add(g);
  }

  dispose() {
    for (const o of [this.mesh, this.ghostMesh]) if (o) { this.world.content.remove(o); disposeCar(o); }
    this.field?.dispose();
    this.world.content.remove(this.particles.points, this.skids.mesh, this.lineMesh);
    this.particles.points.geometry.dispose();
    this.skids.mesh.geometry.dispose();
    this.lineMesh.geometry.dispose();
    audio.silence();
  }

  message(text, kind = '', dur = 2.2) { this.app.hud?.flash(text, kind, dur); }

  cycleCamera(dir = 1) {
    const i = CAMERAS.indexOf(this.camMode);
    this.camMode = CAMERAS[(i + dir + CAMERAS.length) % CAMERAS.length];
    this.app.settings.camera = this.camMode === 'orbit' ? this.app.settings.camera : this.camMode;
    this.app.saveSettings();
    this.camInit = false;
  }

  update(dt, input) {
    dt = Math.min(dt, 0.05);
    const car = this.car;
    const T = this.T;
    let cmd = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    if (this.mode === 'attract' || this.state === 'finished') { this.ai.pace = this.state === 'finished' ? 0.75 : this.ai.pace; cmd = this.ai.control(car); }
    else if (input) cmd = input;

    if (this.paused) { this.updateCamera(dt); return; }
    this.time += dt;

    // ----- countdown / start lights
    const lights = this.app.trackGroup?.userData.startLights;
    if (this.state === 'countdown') {
      this.countdown -= dt;
      cmd = { ...cmd, brake: Math.max(cmd.brake, 0.6), throttle: cmd.throttle }; // hold on the brakes, allow revving
      const lit = clamp(Math.floor((4.2 - this.countdown) / 0.7), 0, 5);
      if (lights) lights.forEach((m, k) => (m.emissiveIntensity = k < lit ? 6 : 0));
      if (lit !== this.litPrev && lit > 0 && lit <= 5) audio.beep(520, 0.14, 0.22);
      this.litPrev = lit;
      if (this.countdown <= 0) {
        this.state = 'running';
        if (lights) lights.forEach((m) => (m.emissiveIntensity = 0));
        audio.beep(1040, 0.35, 0.28);
        this.message('GO', 'go', 1);
        // the lap timer starts when you first cross the line
        this.goTime = this.time;
      }
      // keep the car still but let the engine rev
      const thr = cmd.throttle;
      car.step(PHYS_DT, { throttle: 0, brake: 1, steer: cmd.steer });
      this.field?.step(PHYS_DT, 0, false);
      car.rpm = lerp(car.rpm, car.p.engine.idle + thr * car.p.engine.redline * 0.75, 1 - Math.exp(-dt * 8));
      car.throttle = thr;
    } else {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= PHYS_DT && steps < 16) {
        // remember the previous physics pose for render interpolation
        this.prev.x = car.x; this.prev.z = car.z; this.prev.h = car.heading;
        car.step(PHYS_DT, cmd);
        this.field?.step(PHYS_DT, this.time - (this.goTime ?? this.time), true);
        this.acc -= PHYS_DT;
        steps++;
      }
      if (steps === 16) this.acc = 0;
      this.timing();
      // Easy: if the car is stuck off the road or facing backwards, put it back
      if (this.mode === 'race' && this.app.settings.assists === 'casual') {
        const T2 = this.T;
        const backwards = Math.cos(car.heading - Math.atan2(T2.tx[car.hint], T2.tz[car.hint])) < -0.3;
        const stuck = car.speed < 3 && (Math.abs(car.q.d) > T2.half + 2 || backwards);
        this.stuckT = stuck ? (this.stuckT || 0) + dt : 0;
        if (this.stuckT > 2.5) { car.recover(); this.stuckT = 0; this.message('BACK ON TRACK', '', 1); }
      }
    }

    // ----- visuals: interpolate between the last two physics states so motion
    // is perfectly smooth at any refresh rate (60/120/144 Hz)
    const alpha = this.state === 'running' ? clamp(this.acc / PHYS_DT, 0, 1) : 1;
    const P = this.prev;
    const vx = P.x + (car.x - P.x) * alpha, vz = P.z + (car.z - P.z) * alpha;
    this.visHeading = P.h + angleWrap(car.heading - P.h) * alpha;
    const vq = this.T.query(vx, vz, car.hint);
    const V = this._v;
    V.up.set(vq.normal[0], vq.normal[1], vq.normal[2]);
    V.qa.setFromUnitVectors(V.y, V.up);
    V.qh.setFromAxisAngle(V.y, this.visHeading);
    V.qa.multiply(V.qh);
    // smooth the surface tilt (sample-to-sample normal changes) but never the heading
    if (!this.visInit) { this.mesh.quaternion.copy(V.qa); this.visY = vq.height; this.visInit = true; }
    else {
      V.qt.setFromAxisAngle(V.y, this.visHeading);
      this.tiltQ.slerp(V.qa.clone().multiply(V.qt.invert()), damp(18, dt));
      this.mesh.quaternion.copy(this.tiltQ).multiply(V.qh);
    }
    this.visY += (vq.height - this.visY) * damp(30, dt);
    if (Math.abs(vq.height - this.visY) > 0.5) this.visY = vq.height;
    this.mesh.position.set(vx, this.visY, vz);
    this.mesh.userData.sync(car, dt);
    this.field?.sync(dt, alpha);
    this.effects(dt);
    this.updateGhost();
    this.updateCamera(dt);
    this.world.followShadow(this.mesh.position);
    if (this.mode === 'race') audio.update(car, { interior: this.camMode === 'hood' || this.camMode === 'bumper' });
    else audio.silence();
  }

  timing() {
    if (this.mode !== 'race') return;
    const car = this.car, T = this.T, L = this.lap;
    const s = car.q.s;
    const t = this.time - (L.start ?? this.time);
    // track limits: all four wheels beyond the white line + kerb
    if (Math.abs(car.q.d) > T.half + 1.6 && !L.invalid && L.start != null) {
      L.invalid = true;
      this.message('TRACK LIMITS · LAP INVALID', 'warn', 2.4);
    }
    // splits for live delta
    const i = car.q.i;
    if (L.start != null && isNaN(L.splits[i])) L.splits[i] = t;
    // ghost record at a fixed 30 Hz
    if (L.start != null) {
      L.ghostNext = L.ghostNext ?? 0;
      while (t >= L.ghostNext) { L.ghost.push(car.x, car.y, car.z, car.heading); L.ghostNext += 1 / 30; }
    }
    // sector crossings
    const sec = Math.floor((s / T.length) * 3);
    if (L.start != null && sec !== L.sector && sec === L.sector + 1) {
      L.sectorTimes.push(t);
      L.sector = sec;
      const bestSec = this.best?.sectors?.[sec - 1];
      const prevBase = sec >= 2 ? L.sectorTimes[sec - 2] : 0;
      const prevBest = sec >= 2 ? this.best?.sectors?.[sec - 2] : 0;
      if (bestSec != null) {
        const mine = t - prevBase, theirs = bestSec - (prevBest || 0);
        this.app.hud?.sector(sec, mine - theirs);
      }
    }
    // line crossing
    if (L.lastS > T.length * 0.75 && s < T.length * 0.25) {
      if (L.start != null) this.completeLap(t);
      this.lap = this.newLapState();
      this.lap.start = this.time;
    }
    this.lap.lastS = s;
  }

  completeLap(t) {
    const L = this.lap;
    const lapTime = t;
    this.lapsDone++;
    const valid = !L.invalid;
    if (this.raceCfg) {
      this.raceBest = this.raceBest == null ? lapTime : Math.min(this.raceBest, lapTime);
      if (this.lapsDone >= this.raceCfg.laps && this.state !== 'finished') {
        const raceTime = this.time - this.goTime;
        this.field.playerFinished = raceTime;
        this.state = 'finished';
        const pos = this.field.standings().findIndex((r) => r.isPlayer) + 1;
        this.message(pos === 1 ? 'YOU WIN!' : `FINISHED P${pos}`, pos === 1 ? 'best' : 'go', 4);
        audio.beep(pos === 1 ? 1568 : 988, 0.4, 0.25);
        setTimeout(() => this.app.onRaceFinish?.(this), 2500);
      }
    }
    this.lastLap = { time: lapTime, valid };
    L.sectorTimes.push(lapTime);
    if (valid && (!this.best || lapTime < this.best.time)) {
      const ghost = this.recordGhost();
      this.best = { time: lapTime, sectors: L.sectorTimes.slice(0, 3), splits: Array.from(L.splits), ghost };
      this.app.store.setBest(this.trackKey, this.setup, this.best);
      this.ensureGhost();
      this.message(`NEW BEST  ${fmt(lapTime)}`, 'best', 3);
      audio.beep(1320, 0.18, 0.2); setTimeout(() => audio.beep(1760, 0.25, 0.2), 140);
    } else if (!valid && !L.standing) {
      this.message(`LAP ${fmt(lapTime)} · INVALID`, 'warn', 2.5);
    } else {
      this.message(`LAP ${fmt(lapTime)}`, '', 2.2);
    }
    this.app.onLap?.(lapTime, valid);
  }

  recordGhost() {
    // re-sample the recorded ghost into fixed 1/30 s frames by distance order
    return this.lap.ghost.slice();
  }

  /** Live delta vs best at the current position. */
  delta() {
    if (!this.best || this.lap.start == null || this.lap.standing) return null;
    const i = this.car.q.i;
    const b = this.best.splits[i];
    const m = this.lap.splits[i];
    if (b == null || isNaN(b) || isNaN(m)) return null;
    return m - b;
  }

  updateGhost() {
    if (!this.ghostMesh || !this.best?.ghost || this.mode !== 'race' || this.app.settings.ghost === false) { if (this.ghostMesh) this.ghostMesh.visible = false; return; }
    if (this.lap.start == null || this.lap.standing) { this.ghostMesh.visible = false; return; }
    const g = this.best.ghost;
    const t = this.time - this.lap.start;
    const f = t * 30;
    const k = Math.floor(f);
    if (k * 4 + 7 >= g.length) { this.ghostMesh.visible = false; return; }
    const u = f - k;
    const x = lerp(g[k * 4], g[k * 4 + 4], u), y = lerp(g[k * 4 + 1], g[k * 4 + 5], u), z = lerp(g[k * 4 + 2], g[k * 4 + 6], u);
    const h = g[k * 4 + 3] + angleWrap(g[k * 4 + 7] - g[k * 4 + 3]) * u;
    this.ghostMesh.visible = true;
    this.ghostMesh.position.set(x, y, z);
    this.ghostMesh.rotation.set(0, h, 0);
    // fade when overlapping the player
    const d = Math.hypot(x - this.car.x, z - this.car.z);
    const op = clamp((d - 2) / 10, 0, 1) * 0.25;
    this.ghostMesh.traverse((o) => { if (o.isMesh) o.material.opacity = op; });
  }

  effects(dt) {
    const car = this.car, p = car.p;
    const fwdX = Math.sin(car.heading), fwdZ = Math.cos(car.heading);
    const lefX = Math.cos(car.heading), lefZ = -Math.sin(car.heading);
    const pos = [[p.a, p.trackF / 2], [p.a, -p.trackF / 2], [-p.b, p.trackR / 2], [-p.b, -p.trackR / 2]];
    const v = new THREE.Vector3();
    for (let k = 0; k < 4; k++) {
      const w = car.wheels[k];
      const [px, py] = pos[k];
      v.set(car.x + fwdX * px + lefX * py, car.y + 0.02, car.z + fwdZ * px + lefZ * py);
      const slip = w.slipVel;
      const intensity = clamp((slip - 2.5) / 8, 0, 1) * clamp(w.load / 3000, 0, 1.2);
      if (w.surface <= 1) this.skids.add(k, v, lefX, lefZ, intensity * 0.6);
      else this.skids.add(k, v, lefX, lefZ, 0);
      const vx = fwdX * car.u + lefX * car.v, vz = fwdZ * car.u + lefZ * car.v;
      if (w.surface <= 1 && intensity > 0.12 && Math.random() < intensity * 1.2) {
        const g = 0.85 + Math.random() * 0.1;
        this.particles.emit(v.x, v.y + 0.25, v.z, vx * 0.15 + (Math.random() - 0.5), 0.6 + Math.random() * 0.6, vz * 0.15 + (Math.random() - 0.5), 0.9, 1.6 + intensity * 1.6, g, g, g, 0.35 * intensity + 0.08);
      }
      if (w.surface >= 2 && car.speed > 6 && Math.random() < clamp(car.speed / 30, 0, 1) * 0.5) {
        const dirt = w.surface === 3 ? [0.62, 0.55, 0.43] : [0.42, 0.38, 0.27];
        this.particles.emit(v.x, v.y + 0.15, v.z, vx * 0.2 + (Math.random() - 0.5) * 2, 0.8 + Math.random(), vz * 0.2 + (Math.random() - 0.5) * 2, 0.6, 1.1, dirt[0], dirt[1], dirt[2], 0.32);
      }
    }
    this.particles.update(dt);
  }

  updateCamera(dt) {
    const cam = this.world.camera;
    const car = this.car;
    const m = this.mesh;
    const H = this.visHeading ?? car.heading;
    const fwd = new THREE.Vector3(Math.sin(H), 0, Math.cos(H));
    const spd = car.speed;
    const carPos = m.position;
    let desiredPos, look, fov = 58;
    const velDir = new THREE.Vector3(fwd.x * car.u + Math.cos(H) * car.v, 0, fwd.z * car.u - Math.sin(H) * car.v);
    if (velDir.lengthSq() > 4) velDir.normalize(); else velDir.copy(fwd);
    // chase cams look along a blend of heading and velocity (shows slides)
    // camera yaw follows the car's heading with a short lag (no sideways
    // positional swing — that is what made the car feel like a boat), and
    // leans a little toward the direction of travel when sliding
    const slideYaw = Math.atan2(velDir.x, velDir.z);
    const wantYaw = H + angleWrap(slideYaw - H) * 0.22;
    if (this.camYaw == null || !this.camInit) this.camYaw = wantYaw;
    this.camYaw += angleWrap(wantYaw - this.camYaw) * damp(9, dt);
    const dir = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    switch (this.camMode) {
      case 'near': {
        desiredPos = carPos.clone().addScaledVector(dir, -4.9).add(new THREE.Vector3(0, 1.55, 0));
        look = carPos.clone().addScaledVector(dir, 3).add(new THREE.Vector3(0, 0.85, 0));
        fov = 62 + clamp(spd / 80, 0, 1) * 10;
        break;
      }
      case 'hood': {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(m.quaternion);
        desiredPos = carPos.clone().addScaledVector(fwd, this.mesh.userData.zF * 0.35).addScaledVector(up, 1.12);
        look = desiredPos.clone().addScaledVector(fwd, 20).addScaledVector(up, -0.6);
        fov = 66 + clamp(spd / 80, 0, 1) * 8;
        break;
      }
      case 'bumper': {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(m.quaternion);
        desiredPos = carPos.clone().addScaledVector(fwd, this.mesh.userData.zF + 0.1).addScaledVector(up, 0.45);
        look = desiredPos.clone().addScaledVector(fwd, 20).addScaledVector(up, -0.2);
        fov = 70 + clamp(spd / 80, 0, 1) * 10;
        break;
      }
      case 'orbit': {
        const o = this.orbit;
        if (!this.app.pointerOrbiting) o.yaw += dt * 0.15;
        desiredPos = carPos.clone().add(new THREE.Vector3(Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist, Math.sin(o.pitch) * o.dist + 0.5, Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist));
        look = carPos.clone().add(new THREE.Vector3(0, 0.6, 0));
        fov = 45;
        break;
      }
      default: {
        desiredPos = carPos.clone().addScaledVector(dir, -6.6 - clamp(spd / 70, 0, 1) * 0.9).add(new THREE.Vector3(0, 2.05, 0));
        look = carPos.clone().addScaledVector(dir, 4).add(new THREE.Vector3(0, 0.95, 0));
        fov = 58 + clamp(spd / 80, 0, 1) * 12;
      }
    }
    if (this.mode === 'attract') {
      // cinematic: slow, wide chase that swings around
      const a = this.time * 0.12;
      const side = new THREE.Vector3(Math.cos(car.heading), 0, -Math.sin(car.heading));
      desiredPos = carPos.clone().addScaledVector(dir, -9 + Math.sin(a) * 4).addScaledVector(side, Math.sin(a * 0.7) * 6).add(new THREE.Vector3(0, 3 + Math.sin(a * 0.5) * 1.2, 0));
      look = carPos.clone().add(new THREE.Vector3(0, 0.8, 0));
      fov = 50;
    }
    // keep the camera above the ground
    const gq = this.T.query(desiredPos.x, desiredPos.z, car.hint);
    desiredPos.y = Math.max(desiredPos.y, gq.height + 0.6);
    const rigid = this.camMode === 'hood' || this.camMode === 'bumper';
    if (!this.camInit || rigid) {
      this.camPos.copy(desiredPos);
      this.camLook.copy(look);
      this.camInit = true;
    } else {
      this.camPos.lerp(desiredPos, damp(this.mode === 'attract' ? 2.5 : 22, dt));
      this.camLook.lerp(look, damp(this.mode === 'attract' ? 6 : 30, dt));
    }
    cam.position.copy(this.camPos);
    // subtle shake on kerbs / gravel and at speed
    const shake = (car.surface === 1 ? 0.02 : car.surface >= 2 ? 0.03 : 0) * clamp(spd / 30, 0, 1) + clamp((spd - 50) / 40, 0, 1) * 0.004;
    // smooth, continuous shake (layered sines) — random per-frame jitter reads as stutter
    this.shakeAmp = (this.shakeAmp || 0) + (shake - (this.shakeAmp || 0)) * damp(8, dt);
    if (this.shakeAmp > 1e-4 && this.mode === 'race') {
      const t = this.time;
      cam.position.x += (Math.sin(t * 37.1) + Math.sin(t * 23.7 + 1.3)) * 0.5 * this.shakeAmp;
      cam.position.y += (Math.sin(t * 41.3 + 0.7) + Math.sin(t * 29.9)) * 0.5 * this.shakeAmp;
    }
    cam.lookAt(this.camLook);
    cam.fov += (fov - cam.fov) * damp(3, dt);
    cam.updateProjectionMatrix();
  }
}

function fmt(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
}
