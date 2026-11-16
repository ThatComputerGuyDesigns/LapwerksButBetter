// Race field: AI rivals on the same physics as the player, overtaking /
// following logic, car-to-car contact, running order and the finish.
import * as THREE from 'three';
import { Vehicle, ASSIST_PRESETS } from '../physics/vehicle.js';
import { AIDriver } from '../physics/driver.js';
import { makeCarParams, PAINTS } from '../physics/carSetup.js';
import { speedProfile } from '../track/racingLine.js';
import { createCar, disposeCar } from '../car/carModel.js';
import { clamp, angleWrap, rng } from '../core/math.js';

const NAMES = ['M. Okafor', 'L. Brandt', 'S. Varga', 'J. Takeda', 'R. Moreau', 'A. Lindqvist', 'C. Duarte', 'E. Novak', 'P. Rossetti', 'K. Adeyemi', 'T. Halloran', 'N. Ivanova'];
const PACE = { easy: [0.84, 0.9], medium: [0.91, 0.955], hard: [0.965, 1.0] };

export class RaceField {
  constructor(session, { laps = 3, rivals = 5, difficulty = 'medium' } = {}) {
    this.s = session;
    this.T = session.T;
    this.laps = laps;
    this.difficulty = difficulty;
    this.cars = [];
    const R = rng((Date.now() & 0xffff) + 3);
    const setup = session.setup;
    const paints = PAINTS.map((p) => p.color).filter((c) => c !== setup.paint);
    const [p0, p1] = PACE[difficulty] || PACE.medium;
    const names = NAMES.slice().sort(() => R() - 0.5);
    for (let k = 0; k < rivals; k++) {
      const st = { ...setup, paint: paints[k % paints.length], accent: k % 2 ? '#f2f2f2' : '#111318', number: 10 + Math.floor(R() * 80), livery: ['stripes', 'band', 'split', 'none'][k % 4] };
      const params = makeCarParams(st);
      const car = new Vehicle(params, this.T);
      car.assists = { ...ASSIST_PRESETS.casual, autoShift: true };
      const profile = speedProfile(this.T, session.line, params);
      // spread the field: faster drivers start further back
      const pace = p0 + (p1 - p0) * (k / Math.max(1, rivals - 1)) + (R() - 0.5) * 0.01;
      const ai = new AIDriver(this.T, session.line, profile, { pace });
      const mesh = session.makeMesh ? session.makeMesh(st) : createCar(st);
      session.world.content.add(mesh);
      this.cars.push({ name: names[k % names.length], car, ai, mesh, setup: st, basePace: pace, lapsDone: 0, started: false, lastS: 0, finished: null, best: null, lapStart: null, prev: { x: 0, z: 0, h: 0 }, react: 0.08 + R() * 0.3, offset: 0 });
    }
    this.finishOrder = [];
    this.playerFinished = null;
  }

  dispose() {
    for (const r of this.cars) { this.s.world.content.remove(r.mesh); if (!this.s.makeMesh) disposeCar(r.mesh); }
  }

  /** Grid: rivals ahead and behind the player (player starts mid-pack). */
  resetGrid() {
    const T = this.T;
    const n = this.cars.length + 1;
    this.playerSlot = Math.min(n - 1, Math.floor(n * 0.6));
    const slot = (g) => ({ s: T.length - 12 - g * 8.5, lat: (g % 2 ? -1 : 1) * T.half * 0.42 });
    let k = 0;
    for (let g = 0; g < n; g++) {
      if (g === this.playerSlot) continue;
      const r = this.cars[k++];
      const sl = slot(g);
      r.car.reset(sl.s, sl.lat);
      r.lapsDone = 0; r.started = false; r.lastS = r.car.q.s; r.finished = null; r.best = null; r.lapStart = null;
      r.prev = { x: r.car.x, z: r.car.z, h: r.car.heading };
      // hold the grid lane off the line instead of everyone diving for the apex
      r.offset = sl.lat - this.s.line.offset[r.car.hint];
    }
    this.finishOrder = [];
    this.playerFinished = null;
    return slot(this.playerSlot);
  }

  /** Progress in metres from the start of the race (for running order). */
  progressOf(lapsDone, started, s) { return lapsDone * this.T.length + (started ? s : s - this.T.length); }

  playerProgress() {
    const S = this.s;
    return this.progressOf(S.lapsDone, S.lap.start != null, S.car.q.s);
  }

  step(dt, raceTime, running) {
    const T = this.T;
    const all = [{ car: this.s.car, isPlayer: true }, ...this.cars];
    for (const r of this.cars) {
      r.prev.x = r.car.x; r.prev.z = r.car.z; r.prev.h = r.car.heading;
      if (!running || raceTime < r.react) { r.car.step(dt, { throttle: 0, brake: 1, steer: 0, hold: true }); continue; }
      if (r.finished != null) r.ai.pace = 0.75; // cool-down lap
      else r.ai.pace = r.basePace * this.rubberBand(r);
      // traffic: look for a car ahead on our line and pick a side / lift
      const me = r.car;
      let block = null, bestGap = 30;
      for (const o of all) {
        if (o === r || o.car === me) continue;
        let ds = o.car.q.s - me.q.s;
        if (ds < -T.length / 2) ds += T.length;
        if (ds > T.length / 2) ds -= T.length;
        if (ds <= 0 || ds > bestGap) continue;
        const lat = o.car.q.d - me.q.d;
        if (Math.abs(lat) < 2.6) { bestGap = ds; block = { o, ds, lat, dv: me.u - o.car.u }; }
      }
      const i = me.hint;
      const lineOff = this.s.line.offset[i];
      let want = 0;
      if (block) {
        // go to the side with more room relative to the blocker
        const roomL = T.half - 1.2 - block.o.car.q.d, roomR = block.o.car.q.d + T.half - 1.2;
        const side = roomL > roomR ? 1 : -1;
        want = clamp(block.o.car.q.d + side * 2.8 - lineOff, -T.half * 1.6, T.half * 1.6);
        if (block.ds < 9 && block.dv > -1 && Math.min(roomL, roomR) < 2.4) r.ai.pace *= 0.93; // can't get by: follow
      }
      r.offset += (want - r.offset) * Math.min(1, dt * (raceTime < 5 ? 0.25 : 1.6));
      r.ai.offset = r.offset;
      // gap keeping: never drive into the back of the car ahead
      r.ai.speedCap = Infinity;
      if (block) {
        const safe = 5 + Math.max(0, block.dv) * 0.9;
        if (block.ds < safe + 10 && Math.abs(r.offset - want) > 0.8) r.ai.speedCap = block.o.car.u + (block.ds - safe) * 0.6;
        else if (block.ds < safe) r.ai.speedCap = block.o.car.u + (block.ds - safe) * 0.8;
      }
      const cmd = r.ai.control(me);
      me.step(dt, cmd);
      this.lapLogic(r, raceTime);
    }
    this.collide(all);
  }

  rubberBand(r) {
    if (this.difficulty === 'hard') return 1;
    const gap = this.progressOf(r.lapsDone, r.started, r.car.q.s) - this.playerProgress();
    const k = this.difficulty === 'easy' ? 0.05 : 0.025;
    return 1 - clamp(gap / 300, -1, 1) * k;
  }

  lapLogic(r, raceTime) {
    const T = this.T;
    const s = r.car.q.s;
    if (r.lastS > T.length * 0.75 && s < T.length * 0.25) {
      if (!r.started) { r.started = true; r.lapStart = raceTime; }
      else {
        const lt = raceTime - r.lapStart;
        r.best = r.best == null ? lt : Math.min(r.best, lt);
        r.lapStart = raceTime;
        r.lapsDone++;
        if (r.lapsDone >= this.laps && r.finished == null) { r.finished = raceTime; this.finishOrder.push(r); }
      }
    }
    r.lastS = s;
  }

  /** Simple two-circle car bodies with impulse response. */
  collide(all) {
    const bodies = all.map((o) => {
      const c = o.car, p = c.p;
      const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
      const half = (p.body.length || 4.5) * 0.3;
      return { c, pts: [[c.x + fx * half, c.z + fz * half], [c.x - fx * half, c.z - fz * half]], r: (p.body.width || 1.9) * 0.5 };
    });
    for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
      const A = bodies[a], B = bodies[b];
      if (Math.abs(A.c.x - B.c.x) > 8 || Math.abs(A.c.z - B.c.z) > 8) continue;
      for (const pa of A.pts) for (const pb of B.pts) {
        const dx = pa[0] - pb[0], dz = pa[1] - pb[1];
        const d = Math.hypot(dx, dz), min = A.r + B.r;
        if (d >= min || d < 1e-4) continue;
        const nx = dx / d, nz = dz / d, pen = min - d;
        const mA = A.c.p.mass, mB = B.c.p.mass;
        const wA = mB / (mA + mB), wB = mA / (mA + mB);
        A.c.x += nx * pen * wA; A.c.z += nz * pen * wA;
        B.c.x -= nx * pen * wB; B.c.z -= nz * pen * wB;
        const va = A.c.worldVel(), vb = B.c.worldVel();
        const vn = (va[0] - vb[0]) * nx + (va[1] - vb[1]) * nz;
        if (vn >= 0) continue;
        const j = (-(1 + 0.25) * vn) / (1 / mA + 1 / mB);
        A.c.setWorldVel(va[0] + (j / mA) * nx, va[1] + (j / mA) * nz);
        B.c.setWorldVel(vb[0] - (j / mB) * nx, vb[1] - (j / mB) * nz);
        // off-centre hits add a little yaw
        const tA = (pa[0] - A.c.x) * nz - (pa[1] - A.c.z) * nx;
        const tB = (pb[0] - B.c.x) * nz - (pb[1] - B.c.z) * nx;
        A.c.r += clamp((tA * j) / A.c.p.inertia, -0.6, 0.6) * 0.5;
        B.c.r -= clamp((tB * j) / B.c.p.inertia, -0.6, 0.6) * 0.5;
        A.c.lastImpact = Math.max(A.c.lastImpact, -vn);
        B.c.lastImpact = Math.max(B.c.lastImpact, -vn);
      }
    }
  }

  /** Interpolated visuals for every rival. */
  sync(dt, alpha) {
    const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), qa = new THREE.Quaternion(), qh = new THREE.Quaternion();
    for (const r of this.cars) {
      const c = r.car;
      const x = r.prev.x + (c.x - r.prev.x) * alpha, z = r.prev.z + (c.z - r.prev.z) * alpha;
      const h = r.prev.h + angleWrap(c.heading - r.prev.h) * alpha;
      const q = c.q;
      r.mesh.position.set(x, c.y, z);
      n.set(q.normal[0], q.normal[1], q.normal[2]);
      qa.setFromUnitVectors(up, n);
      qh.setFromAxisAngle(up, h);
      r.mesh.quaternion.copy(qa.multiply(qh));
      r.mesh.userData.sync(c, dt);
    }
  }

  /** Running order: [{name, isPlayer, progress, ...}] best first. */
  standings() {
    const S = this.s;
    const rows = this.cars.map((r) => ({ name: r.name, isPlayer: false, number: r.setup.number, paint: r.setup.paint, progress: r.finished != null ? 1e9 - r.finished : this.progressOf(r.lapsDone, r.started, r.car.q.s), lapsDone: r.lapsDone, best: r.best, finished: r.finished }));
    const pf = this.playerFinished;
    rows.push({ name: 'You', isPlayer: true, number: S.setup.number, paint: S.setup.paint, progress: pf != null ? 1e9 - pf : this.playerProgress(), lapsDone: S.lapsDone, best: S.raceBest, finished: pf });
    rows.sort((a, b) => b.progress - a.progress);
    return rows;
  }
}
