// Kerbstone vehicle model.
//
// A 2.5D sim-cade car: full planar rigid-body dynamics (u, v, yaw) driven by
// four independently modelled tires, riding on the 3D track surface (slope and
// banking project gravity into the plane, crest/compression change the load).
//
//  • Combined-slip tire model (normalised Pacejka-style curve, friction ellipse)
//  • Load sensitivity, tire surface temperature (warm-up, overheating)
//  • Dynamic longitudinal + lateral weight transfer with roll-stiffness split
//  • Aero drag & downforce with balance, rolling resistance per surface
//  • Engine torque curve, gearbox, clutch slip at launch, limited-slip diff
//  • Implicit wheel-spin integration for stability at 240 Hz
//  • Assists: ABS, traction control, slip-angle steering assist, auto-shift
import { clamp, sign, lerp, smoothstep } from '../core/math.js';
import { engineTorque, engineBraking } from './carSetup.js';
import { SURF, SURF_GRIP, SURF_DRAG } from '../track/track.js';

const G = 9.81;
const RHO = 1.225;
const AMBIENT = 24;
/** Handling constants (exported so the tuning scripts can sweep them). */
export const TUNE = { rearMu: 1.04, rearAlpha: 0.84, slipLock: 1.5, counterGain: 0.9, escGain: 3, yawFb: 4, ffSlip: 0.4 };

// normalised magic-formula: peak value 1 at s = 1, tends to `slide` for big s
function makeCurve(slide) {
  // choose C so that sin(C·π/2) = slide (C in (1, 2))
  const C = 2 - (2 / Math.PI) * Math.asin(slide);
  const B = Math.tan(Math.PI / (2 * C));
  return { B, C, f: (s) => Math.sin(C * Math.atan(B * s)), slope0: B * C };
}

export const ASSIST_PRESETS = {
  casual: { abs: 1, tcs: 1, steer: 1, stability: 1, autoShift: true, brakeHelp: true, line: true },
  sport: { abs: 1, tcs: 0.7, steer: 0.8, stability: 0.7, autoShift: true, brakeHelp: false, line: true },
  pro: { abs: 0, tcs: 0, steer: 0.3, stability: 0, autoShift: false, brakeHelp: false, line: false },
};

export class Vehicle {
  constructor(params, track) {
    this.p = params;
    this.track = track;
    this.curve = makeCurve(params.tire.slide);
    this.assists = { ...ASSIST_PRESETS.sport };
    this.wheels = [0, 1, 2, 3].map((i) => ({
      front: i < 2,
      left: i % 2 === 0,
      omega: 0,
      temp: AMBIENT + 20,
      core: AMBIENT + 20,
      load: 0,
      slipRatio: 0,
      slipAngle: 0,
      fx: 0, fy: 0,
      slipVel: 0,
      surface: 0,
      brakeMod: 1,
      steer: 0,
      spin: 0, // visual rotation angle
      wear: 0,
    }));
    this.reset();
  }

  reset(s = 0, lateral = 0) {
    const T = this.track;
    const i = Math.floor(s / T.DS) % T.N;
    this.x = T.px[i] + T.nx[i] * lateral;
    this.z = T.pz[i] + T.nz[i] * lateral;
    this.heading = Math.atan2(T.tx[i], T.tz[i]);
    this.u = 0; this.v = 0; this.r = 0;
    this.ax = 0; this.ay = 0; // filtered accelerations (body frame)
    this.axRaw = 0; this.ayRaw = 0;
    this.steer = 0;
    this.gear = 1;
    this.rpm = this.p.engine.idle;
    this.shiftTimer = 0;
    this.throttle = 0; this.brake = 0;
    this.hint = i;
    this.q = T.query(this.x, this.z, i);
    this.y = this.q.height;
    this.tcsCut = 1;
    this.lastImpact = 0;
    this.offTrack = false;
    this.revCut = false;
    this.reverseTimer = 0;
    this.time = 0;
    for (const w of this.wheels) { w.omega = 0; w.brakeMod = 1; }
  }

  get speed() { return Math.hypot(this.u, this.v); }

  /** Driver input → one physics step. input: {throttle, brake, steer (-1..1, + = left), handbrake, shiftUp, shiftDown} */
  step(dt, input) {
    const p = this.p, A = this.assists, W = this.wheels;
    this.time += dt;
    const q = (this.q = this.track.query(this.x, this.z, this.hint));
    this.hint = q.i;
    this.y = q.height;

    // ---------- gearbox
    let thr = clamp(input.throttle || 0, 0, 1);
    let brk = clamp(input.brake || 0, 0, 1);
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const fwdSpeed = this.u;
    if (A.autoShift || this.gear <= 0) this.autoGear(thr, brk, dt);
    if (!A.autoShift) {
      if (input.shiftUp && this.gear < p.gears.length && this.shiftTimer <= 0) { this.gear = Math.max(1, this.gear + 1); this.shiftTimer = p.shiftTime; }
      if (input.shiftDown && this.gear > -1 && this.shiftTimer <= 0) {
        if (this.gear === 1 && fwdSpeed < 2) this.gear = -1;
        else if (this.gear > 1) this.gear--;
        this.shiftTimer = p.shiftTime;
      }
    }
    if (this.gear === -1) {
      // in reverse, pedals swap so "brake" backs you up (arcade-friendly)
      if (A.autoShift) { const t = thr; thr = brk; brk = t; }
    }
    this.throttle = thr; this.brake = brk;

    // ---------- steering (with slip-angle assist)
    const u = this.u, v = this.v, r = this.r;
    const absU = Math.abs(u);
    const steerIn = clamp(input.steer || 0, -1, 1);
    const sm = this.steerMap();
    // input = demand on the tyres: full lock at speed asks for peak front grip,
    // and (with assist) the wheels are referenced to where the front axle is
    // actually travelling, which gives natural, automatic countersteer.
    let target = steerIn * sm.lock + sm.counter;
    // yaw-rate steering assist: input requests a turn rate (up to the grip
    // limit); the wheel angle is solved for it with feedback, so the car can
    // neither over-rotate (automatic countersteer) nor get stuck pushing.
    if (sm.yawW > 0) {
      const ur = Math.max(absU, 1);
      const rd = steerIn * sm.rTarget;
      // feed-forward: kinematic angle + the front slip angle that lateral
      // load will need (so the car turns in immediately instead of waiting
      // for the feedback loop) ; feedback trims the rest
      const ayReq = rd * ur;
      const ff = Math.atan((p.wheelbase * rd) / ur) + p.tire.alphaPeak * TUNE.ffSlip * clamp(ayReq / sm.aMax, -1.2, 1.2);
      const fb = (rd - r) * TUNE.yawFb * 0.26;
      const yawSteer = ff + fb;
      target = lerp(target, yawSteer, sm.yawW);
    }
    target = clamp(target, -p.maxSteer, p.maxSteer);
    const rate = p.steerRate * (steerIn === 0 ? 1.4 : 1);
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);

    // ---------- loads
    const nY = q.normal[1];
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const lefX = Math.cos(this.heading), lefZ = -Math.sin(this.heading);
    // in-plane gravity: g − (g·n)n, projected on the car axes
    const gx = G * nY * (q.normal[0] * fwdX + q.normal[2] * fwdZ);
    const gy = G * nY * (q.normal[0] * lefX + q.normal[2] * lefZ);
    // how the car's axes map onto the track's lateral direction
    const fwdLat = fwdX * q.nrm[0] + fwdZ * q.nrm[1];
    const lefLat = lefX * q.nrm[0] + lefZ * q.nrm[1];
    const m = p.mass;
    const down = 0.5 * RHO * p.aero.clA * u * u;
    const L = p.wheelbase;
    const h = p.cgHeight;
    const staticF = (m * G * nY * p.b) / L + down * p.aero.balance;
    const staticR = (m * G * nY * p.a) / L + down * (1 - p.aero.balance);
    const dLong = (m * this.ax * h) / L;
    let FzF = staticF - dLong, FzR = staticR + dLong;
    const dLatF = (m * this.ay * h * p.rollFront) / p.trackF;
    const dLatR = (m * this.ay * h * (1 - p.rollFront)) / p.trackR;
    W[0].load = FzF / 2 - dLatF; W[1].load = FzF / 2 + dLatF;
    W[2].load = FzR / 2 - dLatR; W[3].load = FzR / 2 + dLatR;
    // kerb chatter
    if (q.surface === SURF.KERB) {
      const ch = Math.sin(this.time * 90) * 0.06;
      W[0].load *= 1 + ch; W[1].load *= 1 - ch;
    }
    for (const w of W) w.load = Math.max(0, w.load);

    // ---------- drivetrain torque
    const ratio = this.gear === -1 ? -p.reverse : this.gear >= 1 ? p.gears[this.gear - 1] : 0;
    const totalRatio = ratio * p.finalDrive;
    const driven = p.drivetrain === 'FWD' ? [0, 1] : p.drivetrain === 'RWD' ? [2, 3] : [0, 1, 2, 3];
    let wheelOmega = 0;
    for (const k of driven) wheelOmega += W[k].omega;
    wheelOmega /= driven.length;
    const wheelRpm = (Math.abs(wheelOmega * totalRatio) * 30) / Math.PI;
    const shifting = this.shiftTimer > 0;
    let engRpm;
    let clutch = 1;
    const launchRpm = p.engine.idle + thr * (p.engine.redline * 0.42);
    if (ratio !== 0 && wheelRpm < launchRpm) {
      engRpm = lerp(wheelRpm, launchRpm, clamp((launchRpm - wheelRpm) / 1500, 0, 1));
      engRpm = Math.max(engRpm, p.engine.idle);
      clutch = clamp(0.35 + wheelRpm / launchRpm, 0.35, 1);
    } else {
      engRpm = Math.max(wheelRpm, p.engine.idle);
    }
    if (ratio === 0 || shifting) engRpm = lerp(this.rpm, p.engine.idle + thr * p.engine.redline * 0.8, 1 - Math.exp(-dt * 6));
    this.rpm = lerp(this.rpm, engRpm, 1 - Math.exp(-dt * 30));
    this.revCut = this.rpm > p.engine.redline + 60;
    // traction control: cut throttle when driven wheels spin up
    let thrEff = thr * this.tcsCut;
    if (this.revCut) thrEff = 0;
    let engT = engineTorque(p.engine, this.rpm) * thrEff - engineBraking(p.engine, this.rpm) * (1 - thrEff) * (this.rpm > p.engine.idle * 1.3 ? 1 : 0);
    if (shifting || ratio === 0) engT = 0;
    const driveT = engT * totalRatio * 0.9 * (engT > 0 ? clutch : 1);

    // diff split (front/rear for AWD, then left/right with LSD locking)
    const torque = [0, 0, 0, 0];
    const splitAxle = (iL, iR, T) => {
      const dw = W[iL].omega - W[iR].omega;
      const lockT = clamp(dw * 60 * (0.15 + p.diffLock * 2.5), -Math.abs(T) * p.diffLock - 120, Math.abs(T) * p.diffLock + 120);
      torque[iL] += T / 2 - lockT;
      torque[iR] += T / 2 + lockT;
    };
    if (p.drivetrain === 'AWD') { splitAxle(0, 1, driveT * 0.4); splitAxle(2, 3, driveT * 0.6); }
    else if (p.drivetrain === 'FWD') splitAxle(0, 1, driveT);
    else splitAxle(2, 3, driveT);

    // brakes (+ assist)
    let bk = brk;
    const brakeT = [0, 0, 0, 0];
    const bt = p.brake.maxTorque * bk;
    brakeT[0] = brakeT[1] = (bt * p.brake.bias) / 2;
    brakeT[2] = brakeT[3] = (bt * (1 - p.brake.bias)) / 2;
    if (input.handbrake) { brakeT[2] += p.brake.handbrake; brakeT[3] += p.brake.handbrake; }

    // ---------- tire forces
    const R = p.wheelR;
    const tire = p.tire;
    const curve = this.curve;
    let Fx = 0, Fy = 0, Mz = 0;
    const ack = this.steer;
    const steerL = ack + (ack * ack * sign(ack)) * 0.18 * (ack > 0 ? 1 : 0.0);
    const steerR = ack + (ack * ack * sign(ack)) * 0.18 * (ack < 0 ? 1 : 0.0);
    const pos = [
      [p.a, p.trackF / 2], [p.a, -p.trackF / 2],
      [-p.b, p.trackR / 2], [-p.b, -p.trackR / 2],
    ];
    let anyLock = false, spinSum = 0;
    let surfaceWorst = 0;
    for (let k = 0; k < 4; k++) {
      const w = W[k];
      const [px, py] = pos[k];
      const d = k === 0 ? steerL : k === 1 ? steerR : 0;
      w.steer = d;
      const cx = u - r * py, cy = v + r * px;
      const cd = Math.cos(d), sd = Math.sin(d);
      const vl = cx * cd + cy * sd;
      const vt = -cx * sd + cy * cd;
      // surface under this wheel (lateral offset from centerline)
      const surf = this.surfaceAt(q, q.d + px * fwdLat + py * lefLat);
      w.surface = surf;
      surfaceWorst = Math.max(surfaceWorst, surf);
      const tempF = this.tempGrip(w.temp);
      const loadF = 1 - 0.08 * (w.load / 3500 - 1);
      const mu = tire.mu * (surf >= 2 ? Math.min(1, SURF_GRIP[surf] * p.offroad) : SURF_GRIP[surf]) * tempF * loadF * (w.front ? 1 : TUNE.rearMu);
      const Fz = w.load;
      const denom = Math.max(Math.abs(vl), 1.0);
      const kp = tire.kappaPeak, ap = tire.alphaPeak * (w.front ? 1 : TUNE.rearAlpha);

      // implicit wheel spin integration
      const slip0 = (w.omega * R - vl) / denom;
      const alpha = Math.atan2(vt, Math.max(Math.abs(vl), 1.5));
      const fl0 = this.tireForces(slip0, alpha, Fz, mu, kp, ap)[0];
      const kLin = (mu * Fz * curve.slope0) / (kp * denom) * R;
      const Ieff = p.wheelInertia + dt * kLin * R;
      const roll = SURF_DRAG[surf] * Fz * R * Math.tanh(w.omega * 2) + 0.012 * Fz * R * Math.tanh(w.omega * 2);
      let om = w.omega + (dt * (torque[k] - fl0 * R - roll)) / Ieff;
      // brakes as coulomb friction toward zero (with ABS modulation)
      let bT = brakeT[k];
      if (A.abs > 0 && bT > 0 && Math.abs(vl) > 3) {
        // EBD: rear axle is held at a smaller slip so it keeps lateral grip
        const lim = w.front ? 0.95 : 0.55 + 0.4 * (1 - Math.min(1, Math.abs(alpha) / ap));
        if (slip0 < -kp * lim) w.brakeMod = Math.max(0.25, w.brakeMod - dt * 14 * A.abs);
        else w.brakeMod = Math.min(1, w.brakeMod + dt * 6);
        bT *= lerp(1, w.brakeMod, A.abs);
      } else w.brakeMod = 1;
      const dB = (dt * bT) / Ieff;
      if (Math.abs(om) <= dB) { om = 0; if (bT > 0 && Math.abs(vl) > 1) anyLock = true; }
      else om -= sign(om) * dB;
      w.omega = om;
      const kappa = (om * R - vl) / denom;
      const [fl, ft] = this.tireForces(kappa, alpha, Fz, mu, kp, ap);
      w.slipRatio = kappa; w.slipAngle = alpha;
      w.fx = fl; w.fy = ft;
      // slip velocity → heat & sound
      const sv = Math.hypot(om * R - vl, vt);
      w.slipVel = sv;
      // temperature (surface tracks fast, core slow)
      const heatIn = (Math.abs(fl) * Math.abs(om * R - vl) + Math.abs(ft) * Math.abs(vt)) * 0.00012 * tire.heat
        + Fz * Math.abs(vl) * 0.000016;
      const cool = (w.temp - AMBIENT) * (0.01 + 0.0009 * Math.abs(vl)) + (w.temp - w.core) * 0.05;
      w.temp = Math.min(160, w.temp + (heatIn - cool) * dt);
      w.core += (w.temp - w.core) * 0.05 * dt;
      w.wear += heatIn * 1e-7 * dt;
      w.spin += om * dt;
      if (driven.includes(k)) spinSum += kappa;
      // to body frame
      const bfx = fl * cd - ft * sd;
      const bfy = fl * sd + ft * cd;
      Fx += bfx; Fy += bfy;
      Mz += px * bfy - py * bfx;
    }
    this.anyLock = anyLock;
    // traction control (smooth throttle modulation)
    const spinAvg = spinSum / driven.length;
    if (A.tcs > 0 && thr > 0) {
      const lim = p.tire.kappaPeak * lerp(2.2, 1.15, A.tcs);
      if (spinAvg > lim) this.tcsCut = Math.max(0.15, this.tcsCut - dt * 9);
      else this.tcsCut = Math.min(1, this.tcsCut + dt * 3);
    } else this.tcsCut = 1;

    // stability assist: gentle yaw damping when the rear lets go
    if (A.stability > 0 && absU > 8) {
      const beta = Math.atan2(v, absU);
      const over = Math.abs(beta) - 0.05;
      if (over > 0 && sign(r) === -sign(beta)) Mz -= r * p.inertia * 2.2 * A.stability * Math.min(over * 6, 1);
    }

    // ESC: cap yaw rate at what the tyres can actually sustain
    if (A.stability > 0 && absU > 6) {
      const rMax = (this.steerMap().aMax / absU) * 1.12;
      const ex = Math.abs(r) - rMax;
      if (ex > 0) Mz -= Math.sign(r) * ex * p.inertia * TUNE.escGain * A.stability / dt * dt * 10;
    }

    // aero + resistance
    const drag = 0.5 * RHO * p.aero.cdA * u * Math.abs(u);
    Fx -= drag;
    Fy -= 0.5 * RHO * p.aero.cdA * 2.5 * v * Math.abs(v);

    // gravity along the slope / banking
    Fx += m * gx;
    Fy += m * gy;

    // ---------- integrate body
    const axB = Fx / m, ayB = Fy / m;
    this.u += (axB + r * v) * dt;
    this.v += (ayB - r * u) * dt;
    this.r += (Mz / p.inertia) * dt;
    // low-speed stiction to stop creeping
    if (absU < 0.3 && thr === 0 && (brk > 0 || input.handbrake)) { this.u *= 0.8; this.v *= 0.8; this.r *= 0.8; }
    // filtered accelerations drive weight transfer (suspension lag ≈ 70 ms)
    this.axRaw = axB - gx; this.ayRaw = ayB - gy;
    const kf = 1 - Math.exp(-dt / 0.045);
    this.ax += (axB - this.ax) * kf;
    this.ay += (ayB - this.ay) * kf;

    this.heading += this.r * dt;
    const vx = fwdX * this.u + lefX * this.v;
    const vz = fwdZ * this.u + lefZ * this.v;
    this.x += vx * dt;
    this.z += vz * dt;
    this.collide(q);
    this.offTrack = Math.abs(q.d) > this.track.half + 1.2;
    this.surface = q.surface;
  }

  /** Steering map shared by player input and the AI. */
  steerMap() {
    const p = this.p, A = this.assists;
    const absU = Math.abs(this.u);
    const ap = p.tire.alphaPeak;
    const down = 0.5 * RHO * p.aero.clA * this.u * this.u;
    const aMax = p.tire.mu * G * (1 + down / (p.mass * G));
    // speed-sensitive lock: full input ≈ kinematic angle for the grip limit
    // plus the peak slip angle (a little more without assists)
    const lock = Math.min(p.maxSteer, Math.atan((p.wheelbase * aMax) / Math.max(absU * absU, 1)) + ap * (TUNE.slipLock - 0.35 * A.steer));
    // countersteer: point the wheels along the slide once the body slips
    const beta = Math.atan2(this.v, Math.max(absU, 1)) * sign(this.u || 1);
    const excess = Math.sign(beta) * Math.max(0, Math.abs(beta) - 0.035);
    const counter = absU > 5 ? excess * TUNE.counterGain * A.steer : 0;
    const rTarget = Math.min(aMax * 0.97 / Math.max(absU, 1), Math.tan(p.maxSteer) * Math.max(absU, 1) / p.wheelbase);
    const yawW = smoothstep(3, 9, absU) * smoothstep(0.45, 0.95, A.steer);
    return { lock, counter, aMax, rTarget, yawW };
  }

  /** Inverse of the steering map: input needed for a wheel angle. */
  steerInputFor(delta) {
    const sm = this.steerMap();
    if (sm.yawW > 0.5) {
      // invert the yaw request approximately: wheel angle → requested turn rate
      const ur = Math.max(Math.abs(this.u), 1);
      return clamp((Math.tan(delta) * ur) / this.p.wheelbase / Math.max(sm.rTarget, 1e-3), -1, 1);
    }
    return clamp((delta - sm.counter) / Math.max(sm.lock, 1e-3), -1, 1);
  }

  surfaceAt(q, d) {
    const T = this.track;
    const ad = Math.abs(d);
    if (ad <= T.half) return SURF.ASPHALT;
    if (ad <= T.half + 1.5) return q.kerb ? SURF.KERB : SURF.GRASS;
    const gravel = d >= 0 ? T.gravelL[q.i] : T.gravelR[q.i];
    return gravel && ad > T.half + 3.5 ? SURF.GRAVEL : SURF.GRASS;
  }

  tempGrip(t) {
    const tp = this.p.tire;
    const x = (t - tp.optTemp) / tp.window;
    return clamp(1 - 0.16 * x * x, 0.78, 1);
  }

  tireForces(kappa, alpha, Fz, mu, kp, ap) {
    const sx = kappa / kp;
    const sy = Math.tan(alpha) / Math.tan(ap);
    const s = Math.hypot(sx, sy);
    if (s < 1e-6) return [0, 0];
    const f = this.curve.f(s) * mu * Fz;
    return [(f * sx) / s, (-f * sy) / s * 1.0];
  }

  autoGear(thr, brk, dt) {
    const p = this.p;
    const u = this.u;
    if (this.gear === -1) {
      if (thr > 0.1 && u > -0.5) { this.gear = 1; this.reverseTimer = 0; }
      return;
    }
    // stopped + holding brake → reverse
    if (Math.abs(u) < 0.6 && brk > 0.5 && thr < 0.05) {
      this.reverseTimer += dt;
      if (this.reverseTimer > 0.45) { this.gear = -1; this.reverseTimer = 0; }
      return;
    }
    this.reverseTimer = 0;
    if (this.shiftTimer > 0) return;
    const g = this.gear;
    const toRpm = (gear) => (Math.abs(u) / p.wheelR) * p.gears[gear - 1] * p.finalDrive * 30 / Math.PI;
    const rpm = Math.max(toRpm(g), this.rpm * (thr > 0.2 ? 1 : 0));
    if (g < p.gears.length && rpm > p.engine.redline * 0.965 && thr > 0.2) {
      this.gear++; this.shiftTimer = p.shiftTime;
    } else if (g > 1) {
      const down = toRpm(g - 1);
      const thresh = brk > 0.1 ? 0.7 : thr > 0.7 ? 0.62 : 0.5;
      if (down < p.engine.redline * thresh) { this.gear--; this.shiftTimer = p.shiftTime * 0.6; }
    }
  }

  collide(q) {
    // walls/barriers at the runoff edge
    const T = this.track;
    const q2 = T.query(this.x, this.z, this.hint);
    const halfW = 0.95;
    const d = q2.d;
    const hasWall = d >= 0 ? q2.wallLeft : q2.wallRight;
    if (!hasWall) return;
    const lim = q2.wallDist - halfW;
    if (Math.abs(d) <= lim) return;
    const nx = q2.nrm[0] * Math.sign(d), nz = q2.nrm[1] * Math.sign(d); // outward
    const pen = Math.abs(d) - lim;
    this.x -= nx * pen; this.z -= nz * pen;
    // world velocity
    const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
    const lefX = Math.cos(this.heading), lefZ = -Math.sin(this.heading);
    let vx = fwdX * this.u + lefX * this.v, vz = fwdZ * this.u + lefZ * this.v;
    const vn = vx * nx + vz * nz;
    if (vn > 0) {
      this.lastImpact = vn;
      // scrub along the barrier: little bounce, friction proportional to the hit
      vx -= vn * nx * 1.18; vz -= vn * nz * 1.18; // restitution 0.18
      const tf = 1 - Math.min(0.35, vn * 0.02);
      vx *= tf; vz *= tf;
      this.u = vx * fwdX + vz * fwdZ;
      this.v = vx * lefX + vz * lefZ;
      // gently turn the car parallel to the wall instead of killing its yaw
      const tx = -nz, tz = nx; // wall tangent
      const along = Math.sign(vx * tx + vz * tz) || 1;
      const want = Math.atan2(tx * along, tz * along);
      let dh = want - this.heading;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      if (Math.abs(dh) < 1.2) this.r = this.r * 0.7 + dh * Math.min(1, vn * 0.15) * 2;
    }
  }

  /** Teleport back to the track at the current distance. */
  recover() {
    const s = this.q ? this.q.s : 0;
    this.reset(s, 0);
  }
}
