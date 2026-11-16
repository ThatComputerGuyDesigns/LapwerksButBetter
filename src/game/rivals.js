// Race field: AI rivals on the same physics as the player, overtaking /
// following logic, car-to-car contact, running order and the finish.
import * as THREE from 'three';
import { Vehicle, ASSIST_PRESETS } from '../physics/vehicle.js';
import { AIDriver } from '../physics/driver.js';
import { makeCarParams, PAINTS, BODIES } from '../physics/carSetup.js';
import { speedProfile } from '../track/racingLine.js';
import { createCar, disposeCar } from '../car/carModel.js';
import { clamp, angleWrap, rng } from '../core/math.js';
import { CarPoser } from './pose.js';

const NAMES = ['M. Okafor', 'L. Brandt', 'S. Varga', 'J. Takeda', 'R. Moreau', 'A. Lindqvist', 'C. Duarte', 'E. Novak', 'P. Rossetti', 'K. Adeyemi', 'T. Halloran', 'N. Ivanova'];
const PACE = { easy: [0.84, 0.9], medium: [0.91, 0.955], hard: [0.965, 1.0] };

export class RaceField {
  constructor(session, { laps = 3, rivals = 5, difficulty = 'medium', rivalBodies = null, playerSlot = 'mid', duel = false, spectator = false, drama = 0.5, paceSpread = null, roster = null } = {}) {
    this.s = session;
    this.T = session.T;
    this.laps = laps;
    this.difficulty = difficulty;
    this.slotMode = playerSlot;
    this.spectator = spectator; // race control: every car is AI, no player entry
    this.drama = spectator ? drama : 0;
    this.cars = [];
    const R = rng((Date.now() & 0xffff) + 3);
    const setup = session.setup;
    const paints = PAINTS.map((p) => p.color).filter((c) => c !== setup.paint);
    const [p0, p1] = paceSpread || PACE[difficulty] || PACE.medium;
    const names = NAMES.slice().sort(() => R() - 0.5);
    if (roster) rivals = roster.length;
    for (let k = 0; k < rivals; k++) {
      const ro = roster?.[k];
      // mixed field: rivals drive cars from the event's class
      const body = ro ? ro.body : duel ? setup.body : rivalBodies ? rivalBodies[Math.floor(R() * rivalBodies.length)] : setup.body;
      const st = { ...setup, body, compound: rivalBodies ? (BODIES[body]?.compound || setup.compound) : setup.compound, drivetrain: null, paint: ro ? ro.paint : paints[k % paints.length], accent: k % 2 ? '#f2f2f2' : '#111318', number: ro ? ro.number : 10 + Math.floor(R() * 80), livery: ['stripes', 'band', 'split', 'none'][k % 4] };
      if (ro) st.compound = BODIES[body]?.compound || setup.compound;
      const params = makeCarParams(st);
      const car = new Vehicle(params, this.T);
      car.assists = { ...ASSIST_PRESETS.casual, autoShift: true };
      // personality: skill (pace + braking), consistency (mistakes), aggression (racecraft)
      const skill = ro ? ro.skill : duel ? 1 : k / Math.max(1, rivals - 1);
      // drama (race control) lowers consistency and raises aggression
      const pers = { skill, consistency: clamp(0.55 + R() * 0.45 - (drama - 0.5) * 0.5, 0.15, 1), aggression: clamp(0.3 + R() * 0.7 + (drama - 0.5) * 0.4, 0.1, 1) };
      const profile = speedProfile(this.T, session.line, params, { gripScale: 0.9 + 0.07 * skill });
      // spread the field: faster drivers start further back
      const pace = duel ? p1 + 0.01 : p0 + (p1 - p0) * skill + (R() - 0.5) * 0.01;
      const ai = new AIDriver(this.T, session.line, profile, { pace });
      const mesh = session.makeMesh ? session.makeMesh(st) : createCar(st);
      session.world.content.add(mesh);
      this.cars.push({ name: ro ? ro.name : names[k % names.length], car, ai, mesh, setup: st, pers, basePace: pace, lapsDone: 0, started: false, lastS: 0, finished: null, best: null, lapStart: null, prev: { x: 0, z: 0, h: 0 }, react: 0.08 + R() * 0.3 * (1.2 - skill * 0.5), offset: 0, mistake: 0, phase: R() * 10 });
    }
    this.R = R;
    this.finishOrder = [];
    this.playerFinished = null;
  }

  dispose() {
    for (const r of this.cars) { this.s.world.content.remove(r.mesh); if (!this.s.makeMesh) disposeCar(r.mesh); }
  }

  /** Grid: rivals ahead and behind the player (player starts mid-pack). */
  resetGrid() {
    const T = this.T;
    const n = this.cars.length + (this.spectator ? 0 : 1);
    this.playerSlot = this.spectator ? -1 : this.slotMode === 'last' ? n - 1 : this.slotMode === 'front' ? 0 : Math.min(n - 1, Math.floor(n * 0.6));
    this.gridPos = this.playerSlot + 1;
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
    const all = this.allEntries();
    this.slipstream(all);
    this.control?.update(dt);
    for (const r of this.cars) {
      r.prev.x = r.car.x; r.prev.z = r.car.z; r.prev.h = r.car.heading;
      if (!running || raceTime < r.react) { r.car.step(dt, { throttle: 0, brake: 1, steer: 0, hold: true }); continue; }
      if (r.dsq) { r.ai.pace = 0.6; r.ai.speedCap = Infinity; r.car.step(dt, r.ai.control(r.car)); this.lapLogic(r, raceTime); continue; }
      if (r.finished != null) r.ai.pace = 0.75; // cool-down lap
      else {
        // small lap-to-lap variation (less for consistent drivers) + mistakes
        const P = r.pers;
        const wobble = Math.sin(raceTime * 0.23 + r.phase) * 0.012 * (1 - P.consistency);
        r.ai.pace = r.basePace * this.rubberBand(r) * (1 + wobble);
        if (r.mistake > 0) { r.mistake -= dt; r.ai.pace *= 0.86; }
        else if (raceTime > 8 && this.R() < dt * 0.016 * (1 - P.consistency) * (0.5 + this.drama)) {
          r.mistake = 1.2 + this.R();
          r.mistakeSide = this.R() < 0.5 ? -1 : 1;
          // some mistakes are snap oversteer moments (spins), the rest run wide
          r.mistakeSpin = this.R() < 0.2 + this.drama * 0.2 && Math.abs(this.s.line.curv[r.car.hint]) > 1 / 200;
        }
      }
      const ctx = { noPass: false };
      r.ai.speedCap = Infinity;
      this.control?.modifyAI(r, ctx);
      const ctrlCap = r.ai.speedCap;
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
      // running wide: past the white line (track limits) or into the runoff
      let want = r.mistake > 0 && !r.mistakeSpin ? r.mistakeSide * (T.half + 0.6 + this.drama * 1.8) - lineOff : 0;
      // defend: someone close behind before a corner → cover the inside
      if (!block && r.pers.aggression > 0.55 && raceTime > 6) {
        let threat = false;
        for (const o of all) {
          if (o === r || o.car === me) continue;
          let ds = me.q.s - o.car.q.s;
          if (ds < -T.length / 2) ds += T.length;
          if (ds > 0 && ds < 14 && Math.abs(o.car.q.d - me.q.d) < 3.5 && o.car.u > me.u - 1) threat = true;
        }
        if (threat) {
          let k = me.hint, turn = 0;
          for (let m = 10; m < 70; m += 5) { const c = this.s.line.curv[(k + m) % T.N]; if (Math.abs(c) > 1 / 120) { turn = Math.sign(c); break; } }
          if (turn) want = clamp(turn * (T.half - 2.2) - lineOff, -T.half, T.half);
        }
      }
      if (block && ctx.noPass) {
        want = 0; // neutralised: hold station, no overtaking
      } else if (block) {
        // go to the side with more room relative to the blocker and commit
        const roomL = T.half - 1.2 - block.o.car.q.d, roomR = block.o.car.q.d + T.half - 1.2;
        const side = roomL > roomR ? 1 : -1;
        want = clamp(block.o.car.q.d + side * 3.0 - lineOff, -T.half * 1.6, T.half * 1.6);
        if (block.ds < 8 && block.dv > -1 && Math.max(roomL, roomR) < 2.6) r.ai.pace *= 0.95; // genuinely no room: follow
        else if (block.ds < 28) r.ai.pace *= 1 + (0.035 + this.drama * 0.03) * r.pers.aggression; // attack: commit to the move
      }
      // side-by-side racecraft: leave a car's width. The car behind places
      // itself a full width off the other car on its own side; the car ahead
      // holds its lateral position instead of closing the door.
      for (const o of all) {
        if (o === r || o.car === me) continue;
        let ds = o.car.q.s - me.q.s;
        if (ds < -T.length / 2) ds += T.length;
        if (ds > T.length / 2) ds -= T.length;
        const lat = o.car.q.d - me.q.d;
        if (Math.abs(ds) < 6.5 && Math.abs(lat) < 3.0) {
          const mySide = -Math.sign(lat || (me.q.d >= 0 ? -1 : 1));
          const room = mySide > 0 ? T.half - 1.1 - me.q.d : me.q.d + T.half - 1.1;
          if (ds > -1 || room > 1) want = clamp(o.car.q.d + mySide * 3.0, -T.half + 1.0, T.half - 1.0) - lineOff;
          else want = me.q.d - lineOff; // ahead and boxed: hold the line you have
          if (Math.abs(lat) < 2.2 && ds > 0) r.ai.pace *= 0.97; // tuck back rather than rub
        }
      }
      // a mistake overrides racecraft: the car really does run wide
      if (r.mistake > 0 && !r.mistakeSpin) want = r.mistakeSide * (T.half + 0.8 + this.drama * 2) - lineOff;
      r.offset += (want - r.offset) * Math.min(1, dt * (raceTime < 5 ? 0.25 : r.mistake > 0 ? 4 : 2.2));
      r.ai.offset = r.offset;
      r.ai.edge = r.mistake > 0 && !r.mistakeSpin ? -2.8 : 1.1;
      // gap keeping: only lift when actually about to run into the car ahead
      r.ai.speedCap = ctrlCap;
      if (block && (Math.abs(block.lat) < 2.3 || ctx.noPass)) {
        // headway: ~0.25 s at speed plus a closing-speed margin
        // aggressive drivers in a dramatic race leave less margin (more contact)
        const safe = (3 + me.u * 0.17 + Math.max(0, block.dv) * 0.9) * (1 - 0.28 * this.drama * r.pers.aggression * (this.spectator ? 1 : 0));
        if (block.ds < safe || ctx.noPass) r.ai.speedCap = Math.min(r.ai.speedCap, block.o.car.u + (block.ds - (ctx.noPass ? Math.max(safe, 12) : safe)) * 1.2);
        // time-to-collision: the car ahead is braking harder than we are
        const ttc = block.dv > 0.3 ? (block.ds - 2.5) / block.dv : Infinity;
        if (ttc < 1.3) r.ai.speedCap = Math.min(r.ai.speedCap, block.o.car.u - 1 + Math.max(0, ttc) * 1.5);
      }
      const cmd = r.ai.control(me);
      if (r.mistakeSpin && r.mistake > 0) {
        // snap oversteer: aids off for a moment, rear steps out
        if (!r.savedAssists) { r.savedAssists = me.assists; me.assists = { ...ASSIST_PRESETS.pro, autoShift: true }; }
        if (r.mistake > 0.7) { cmd.handbrake = true; cmd.throttle = 1; cmd.steer = clamp(cmd.steer * 2, -1, 1); }
      } else if (r.savedAssists) { me.assists = r.savedAssists; r.savedAssists = null; }
      me.step(dt, cmd);
      this.lapLogic(r, raceTime);
    }
    this.collide(all);
  }

  allEntries() {
    const all = this.spectator ? [...this.cars] : [{ car: this.s.car, isPlayer: true }, ...this.cars];
    if (this.control?.sc) all.push({ car: this.control.sc.car, isSC: true });
    return all;
  }
  entryOf(car) { return this.cars.find((r) => r.car === car) || null; }
  /** Running order of the AI entries (best first). */
  order() {
    return this.cars.slice().sort((a, b) => this.rank(b) - this.rank(a));
  }
  rank(r) {
    if (r.dsq) return -1e12;
    if (r.finished != null) return 1e9 - (r.finished + (r.penalty || 0));
    return this.progressOf(r.lapsDone, r.started, r.car.q.s);
  }
  positionOf(r) { return this.order().indexOf(r) + 1; }

  /** Drafting: a car close behind another gets less drag (up to ~40%). */
  slipstream(all) {
    const T = this.T;
    for (const a of all) {
      let best = 0;
      for (const b of all) {
        if (a === b) continue;
        let ds = b.car.q.s - a.car.q.s;
        if (ds < -T.length / 2) ds += T.length;
        if (ds <= 2 || ds > 32) continue;
        if (Math.abs(b.car.q.d - a.car.q.d) > 1.9) continue;
        best = Math.max(best, 0.42 * (1 - ds / 32));
      }
      a.car.draft = best;
    }
  }

  rubberBand(r) {
    if (this.difficulty === 'hard' || this.spectator) return 1;
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
      for (let ia = 0; ia < 2; ia++) for (let ib = 0; ib < 2; ib++) {
        const pa = A.pts[ia], pb = B.pts[ib];
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
        // the rear-ender: one car's front circle into the other's rear circle
        // (decide which is behind by track position)
        if (this.control) {
          let ds = B.c.q.s - A.c.q.s;
          if (ds < -this.T.length / 2) ds += this.T.length;
          if (ds > this.T.length / 2) ds -= this.T.length;
          const aBehind = ds > 0;
          const rearEnd = ia === 0 && ib === 1 ? aBehind : ia === 1 && ib === 0 ? !aBehind : false;
          if (aBehind) this.control.onContact(A.c, B.c, -vn, rearEnd, rearEnd, true, ia === ib);
          else this.control.onContact(B.c, A.c, -vn, rearEnd, rearEnd, true, ia === ib);
        }
        A.c.lastImpact = Math.max(A.c.lastImpact, -vn);
        B.c.lastImpact = Math.max(B.c.lastImpact, -vn);
      }
    }
  }

  /** Interpolated visuals for every rival. */
  sync(dt, alpha) {
    for (const r of this.cars) {
      const c = r.car;
      const x = r.prev.x + (c.x - r.prev.x) * alpha, z = r.prev.z + (c.z - r.prev.z) * alpha;
      r.visH = r.prev.h + angleWrap(c.heading - r.prev.h) * alpha;
      r.poser = r.poser || new CarPoser();
      r.poser.apply(r.mesh, this.T, x, z, r.visH, c.hint, dt);
      r.mesh.userData.sync(c, dt);
    }
  }

  /** Running order: [{name, isPlayer, progress, ...}] best first. */
  standings() {
    const S = this.s;
    const rows = this.cars.map((r) => ({ entry: r, name: r.name, isPlayer: false, number: r.setup.number, paint: r.setup.paint, car: BODIES[r.setup.body]?.name, progress: this.rank(r), lapsDone: r.lapsDone, best: r.best, finished: r.finished, penalty: r.penalty || 0, warnings: r.warnings || 0, dsq: !!r.dsq }));
    if (this.spectator) { rows.sort((a, b) => b.progress - a.progress); return rows; }
    const pf = this.playerFinished;
    rows.push({ name: 'You', isPlayer: true, number: S.setup.number, paint: S.setup.paint, progress: pf != null ? 1e9 - pf : this.playerProgress(), lapsDone: S.lapsDone, best: S.raceBest, finished: pf });
    rows.sort((a, b) => b.progress - a.progress);
    return rows;
  }
}
