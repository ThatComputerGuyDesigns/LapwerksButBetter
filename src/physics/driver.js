// Autonomous driver: follows the racing line with pure pursuit and tracks the
// speed profile. Powers the lap simulator, rival ghosts and the attract mode.
import { clamp, angleWrap } from '../core/math.js';

export class AIDriver {
  constructor(track, line, profile, { pace = 1.0 } = {}) {
    this.T = track;
    this.line = line;
    this.profile = profile;
    this.pace = pace;
    this.iErr = 0;
  }

  control(car) {
    const T = this.T, L = this.line, N = T.N;
    const i = car.hint;
    const u = Math.max(car.u, 0);
    // lookahead target on the racing line
    const look = 7 + u * 0.42;
    const k = Math.round(look / T.DS);
    const j = (i + k) % N;
    const dx = L.x[j] - car.x, dz = L.z[j] - car.z;
    const ang = angleWrap(Math.atan2(dx, dz) - car.heading);
    const dist = Math.hypot(dx, dz);
    // pure pursuit curvature → front wheel angle; small slip compensation
    const kappa = (2 * Math.sin(-ang)) / Math.max(dist, 1);
    let delta = Math.atan(car.p.wheelbase * kappa * -1);
    const beta = Math.atan2(car.v, Math.max(u, 1));
    delta += beta * 0.85 * (1 - car.assists.steer * 0.9); // steer into the slide (assist does part of it)
    delta += (car.r - u * kappa * -1) * 0.04 * 0; // (reserved: yaw-rate feedback)
    const steer = car.steerInputFor(delta);

    // speed: look slightly ahead (brake reaction)
    const kv = Math.round((4 + u * 0.12) / T.DS);
    let vt = Infinity;
    for (let m = 0; m <= kv; m++) vt = Math.min(vt, this.profile.v[(i + m) % N]);
    vt *= this.pace;
    const err = vt - u;
    let throttle = 0, brake = 0;
    if (err > 0) throttle = clamp(0.35 + err * 0.45, 0, 1);
    else if (err > -1.2) throttle = clamp(0.25 + err * 0.2, 0, 1);
    else brake = clamp(-err * 0.22, 0, 1);
    // trail-brake gently: release as lateral load builds
    const lat = Math.abs(car.ay) / 9.81;
    brake *= clamp(1.25 - lat * 0.7, 0.35, 1);
    if (Math.abs(beta) > 0.1) { throttle *= 0.3; brake *= 0.4; }
    // ease off throttle when the line is diverging (prevents spins on exit)
    if (Math.abs(car.v) > 1.6 && throttle > 0.5) throttle *= 0.75;
    return { throttle, brake, steer, handbrake: false };
  }
}
