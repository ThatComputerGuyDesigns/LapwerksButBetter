// Jank detector: drives a lap with the AI and measures high-frequency chatter
// in steering angle, yaw rate, ride height and body orientation — the things
// that make a car look/feel jittery even when lap times are fine.
import { buildTrack } from '../src/track/track.js';
import { computeRacingLine, speedProfile } from '../src/track/racingLine.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { AIDriver } from '../src/physics/driver.js';

export function jitter(preset = PRESETS[0], assist = 'casual', body = 'gt') {
  const T = buildTrack(preset);
  const p = makeCarParams({ body });
  const line = computeRacingLine(T);
  const prof = speedProfile(T, line, p);
  const car = new Vehicle(p, T);
  car.assists = { ...ASSIST_PRESETS[assist], autoShift: true };
  const ai = new AIDriver(T, line, prof, { pace: 0.95 });
  car.reset(T.length - 20, 0);
  const dt = 1 / 240;
  const hp = (prev, cur, prev2) => cur - 2 * prev + prev2; // 2nd difference = HF content
  let n = 0, sd = 0, sr = 0, sy = 0, sn = 0, flips = 0;
  let h = null;
  for (let t = 0; t < 60; t += dt) {
    car.step(dt, ai.control(car));
    // sample at 60 Hz like a renderer
    if (Math.round(t / dt) % 4) continue;
    const s = { d: car.steer, r: car.r, y: car.y, nx: car.q.normal[0], nz: car.q.normal[2], gear: car.gear };
    if (h && h[0] && h[1]) {
      sd += Math.abs(hp(h[1].d, s.d, h[0].d)); sr += Math.abs(hp(h[1].r, s.r, h[0].r));
      sy += Math.abs(hp(h[1].y, s.y, h[0].y)); sn += Math.abs(hp(h[1].nx, s.nx, h[0].nx)) + Math.abs(hp(h[1].nz, s.nz, h[0].nz));
      if (Math.sign(s.d - h[1].d) !== Math.sign(h[1].d - h[0].d) && Math.abs(s.d - h[1].d) > 0.002) flips++;
      n++;
    }
    h = h ? [h[1], s] : [null, s];
  }
  return { steerHF: (sd / n) * 1000, yawHF: (sr / n) * 1000, heightHF: (sy / n) * 1000, normalHF: (sn / n) * 1000, steerFlipsPerSec: flips / 60 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const a of ['casual', 'sport', 'pro']) {
    const r = jitter(PRESETS[+process.argv[2] || 0], a);
    console.log(a.padEnd(7), Object.entries(r).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  '));
  }
}
