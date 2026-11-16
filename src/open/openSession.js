// Free-roam session in the open world: physics on the world ground query,
// chase cameras (shared with the race session), effects, water and bounds
// recovery, and the world's own per-frame updates (LOD, water, festival).
import * as THREE from 'three';
import { Vehicle, ASSIST_PRESETS } from '../physics/vehicle.js';
import { makeCarParams } from '../physics/carSetup.js';
import { createCar, disposeCar } from '../car/carModel.js';
import { Particles, SkidMarks } from '../game/effects.js';
import { DriveSession } from '../game/drive.js';
import { worldTrack, HALF, cellOf, S_WATER } from './worldgen.js';
import { clamp, angleWrap, damp } from '../core/math.js';
import { audio } from '../audio/audio.js';

const PHYS_DT = 1 / 240;

export class OpenSession {
  constructor(app, W, worldView) {
    this.app = app;
    this.world = app.world;
    this.W = W;
    this.view = worldView;
    this.T = worldTrack(W);
    this.mode = 'open';
    this.setup = app.setup;
    this.params = makeCarParams(this.setup);
    this.car = new Vehicle(this.params, this.T);
    this.car.assists = { ...ASSIST_PRESETS[app.settings.assists] };
    if (app.settings.gearbox === 'manual') this.car.assists.autoShift = false;
    this.mesh = createCar(this.setup);
    this.world.content.add(this.mesh);
    this.particles = new Particles(900);
    this.world.content.add(this.particles.points);
    this.skids = new SkidMarks(6000);
    this.world.content.add(this.skids.mesh);
    this.camMode = app.settings.camera || 'chase';
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camVel = new THREE.Vector3();
    this.orbit = { yaw: 0, pitch: 0.25, dist: 9 };
    this.acc = 0;
    this.time = 0;
    this.state = 'running';
    this.prev = { x: 0, z: 0, h: 0, y: 0 };
    this.tiltQ = new THREE.Quaternion();
    this._v = { y: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(), qa: new THREE.Quaternion(), qh: new THREE.Quaternion(), qt: new THREE.Quaternion() };
    this.spawnAtFestival();
  }

  /** Put the car on a road at (or near) a point, facing along it. */
  placeOnRoad(x, z, preferId) {
    let best = null, bd = Infinity;
    for (const r of this.W.roads) {
      if (preferId && r.id !== preferId) continue;
      if (r.type === 'dirt' && !preferId) continue;
      r.pts.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - z) ** 2; if (d < bd) { bd = d; best = { r, i }; } });
    }
    const { r, i } = best;
    const p = r.pts[i], q = r.pts[Math.min(i + 1, r.pts.length - 1)], o = r.pts[Math.max(i - 1, 0)];
    const hd = Math.atan2(q[0] - o[0], q[1] - o[1]);
    // keep to the right-hand lane
    const off = r.width * 0.22;
    const c = this.car;
    c.x = p[0] + Math.cos(hd) * -off; c.z = p[1] - Math.sin(hd) * -off;
    c.heading = this.headingHint ?? hd;
    this.headingHint = null;
    c.u = c.v = c.r = 0; c.vy = 0; c.airborne = false;
    c.y = this.T.height(c.x, c.z); c.prevGround = c.y;
    for (const w of c.wheels) w.omega = 0;
    this.prev = { x: c.x, z: c.z, h: c.heading, y: c.y };
    this.visInit = false;
    this.camInit = false;
    return r;
  }

  spawnAtFestival() {
    const [fx, fz] = this.W.landmarks.festival;
    this.placeOnRoad(fx, fz - 120, 'north');
  }

  message(text, kind = '', dur = 2) { this.app.openHud?.flash(text, kind, dur); }

  cycleCamera(dir = 1) { DriveSession.prototype.cycleCamera.call(this, dir); }

  update(dt, input) {
    dt = Math.min(dt, 0.05);
    const car = this.car;
    if (this.paused) { this.updateCamera(dt); return; }
    const cmd = input || { throttle: 0, brake: 0, steer: 0 };
    this.time += dt;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= PHYS_DT && steps < 16) {
      this.prev.x = car.x; this.prev.z = car.z; this.prev.h = car.heading; this.prev.y = car.y;
      car.step(PHYS_DT, cmd);
      this.acc -= PHYS_DT;
      steps++;
      if (car.lastLanding) { this.app.openHud?.landing(car.lastLanding); car.lastLanding = null; }
    }
    if (steps === 16) this.acc = 0;

    // water / bounds: rescue the car back to the nearest road
    const c = cellOf(car.x, car.z);
    const deep = this.W.surf[c] === S_WATER && car.y < -0.8;
    if (deep) { this.drown = (this.drown || 0) + dt; car.u *= 0.96; car.v *= 0.96; if (Math.random() < 0.5) this.particles.emit(car.x, 0.2, car.z, (Math.random() - 0.5) * 4, 3 + Math.random() * 3, (Math.random() - 0.5) * 4, 1, 1.4, 0.85, 0.92, 1, 0.5); }
    else this.drown = 0;
    const out = Math.abs(car.x) > HALF - 60 || Math.abs(car.z) > HALF - 60;
    if (this.drown > 1.2 || out) { this.placeOnRoad(car.x, car.z); this.message('BACK ON THE ROAD', '', 1.4); }
    if (input?.reset) { this.placeOnRoad(car.x, car.z); }

    // visuals: interpolate, follow the ground (or the flight path)
    const alpha = clamp(this.acc / PHYS_DT, 0, 1);
    const P = this.prev;
    const vx = P.x + (car.x - P.x) * alpha, vz = P.z + (car.z - P.z) * alpha;
    const vy = P.y + (car.y - P.y) * alpha;
    this.visHeading = P.h + angleWrap(car.heading - P.h) * alpha;
    const vq = this.T.query(vx, vz);
    const V = this._v;
    if (!car.airborne) V.up.set(vq.normal[0], vq.normal[1], vq.normal[2]);
    V.qa.setFromUnitVectors(V.y, V.up);
    V.qh.setFromAxisAngle(V.y, this.visHeading);
    V.qa.multiply(V.qh);
    if (!this.visInit) { this.mesh.quaternion.copy(V.qa); this.visInit = true; this.tiltQ.identity(); }
    else {
      V.qt.setFromAxisAngle(V.y, this.visHeading);
      this.tiltQ.slerp(V.qa.clone().multiply(V.qt.invert()), damp(car.airborne ? 3 : 14, dt));
      this.mesh.quaternion.copy(this.tiltQ).multiply(V.qh);
    }
    this.mesh.position.set(vx, vy, vz);
    this.mesh.userData.sync(car, dt);
    this.effects(dt);
    this.updateCamera(dt);
    this.world.followShadow(this.mesh.position);
    this.view.update(dt, this.world.camera);
    audio.update(car, { interior: this.camMode === 'hood' || this.camMode === 'bumper' });
  }

  dispose() {
    for (const o of [this.mesh]) if (o) { this.world.content.remove(o); disposeCar(o); }
    this.world.content.remove(this.particles.points);
    this.world.content.remove(this.skids.mesh);
    audio.silence();
  }
}

// shared camera rig + tyre effects from the race session
OpenSession.prototype.updateCamera = DriveSession.prototype.updateCamera;
OpenSession.prototype.effects = DriveSession.prototype.effects;
