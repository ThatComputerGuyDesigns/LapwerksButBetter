// A deliberately crude "keyboard human": on/off keys only, reacting late,
// driving through the real Input smoothing. If this bot can lap, people can.
import { buildTrack } from '../src/track/track.js';
import { computeRacingLine, speedProfile } from '../src/track/racingLine.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { AIDriver } from '../src/physics/driver.js';
import { clamp, formatTime } from '../src/core/math.js';

export function keyLap(preset, assist = 'sport', pace = 0.9) {
  const T = buildTrack(preset);
  const p = makeCarParams({});
  const line = computeRacingLine(T);
  const prof = speedProfile(T, line, p);
  const car = new Vehicle(p, T);
  car.assists = { ...ASSIST_PRESETS[assist], autoShift: true };
  const ai = new AIDriver(T, line, prof, { pace });
  car.reset(T.length - 20, 0);
  const st = { s: 0, thr: 0, brk: 0 };
  const dt = 1 / 240;
  let t = 0, lastS = car.q.s, laps = [], start = null, spins = 0, wasSpin = false, offs = 0, wasOff = false, react = [];
  while (t < 400 && laps.length < 2) {
    // decide keys from what a good driver would want, delayed 150 ms, quantised
    const want = ai.control(car);
    react.push(want);
    const DELAY = +(process.env.DELAY ?? 36);
    const w = react.length > DELAY ? react.shift() : want;
    // humans pulse keys: hold time ∝ how much they want (PWM over ~0.25 s)
    const phase = (t * 4) % 1;
    const left = w.steer > 0.08 && phase < Math.abs(w.steer) * 1.2;
    const right = w.steer < -0.08 && phase < Math.abs(w.steer) * 1.2;
    const up = phase < w.throttle * 1.1 && w.throttle > 0.15, down = w.brake > 0.2;
    let target = (left ? 1 : 0) - (right ? 1 : 0);
    if (process.env.ANALOG_STEER) target = w.steer;
    const RI = +(process.env.RI ?? 5.2), RO = +(process.env.RO ?? 7.5), RV = +(process.env.RV ?? 28), ROV = +(process.env.ROV ?? 1e9);
    const rate = target === 0 || Math.sign(target) !== Math.sign(st.s) ? RO / (1 + car.speed / ROV) : RI / (1 + car.speed / RV);
    st.s += clamp(target - st.s, -rate * dt, rate * dt);
    st.thr += clamp((up ? 1 : 0) - st.thr, -dt * 9, dt * 7);
    st.brk += clamp((down ? 1 : 0) - st.brk, -dt * 12, dt * 9);
    if (process.env.ANALOG_PEDALS) { st.thr = w.throttle; st.brk = w.brake; }
    car.step(dt, { throttle: st.thr, brake: st.brk, steer: st.s });
    t += dt;
    const s = car.q.s;
    if (lastS > T.length * 0.8 && s < T.length * 0.2) { if (start != null) laps.push(t - start); start = t; }
    lastS = s;
    const b = Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 1)));
    if (b > 0.5 && !wasSpin) spins++; wasSpin = b > 0.5;
    if (car.offTrack && !wasOff) offs++; wasOff = car.offTrack;
  }
  return { laps, spins, offs, ideal: prof.lapTime };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assist = process.argv[2] || 'sport';
  for (const pr of PRESETS) {
    const r = keyLap(pr, assist);
    console.log(pr.name.padEnd(22), 'laps', r.laps.map(formatTime).join(' ').padEnd(20), 'ideal', formatTime(r.ideal), 'spins', r.spins, 'offs', r.offs);
  }
}
