// Controller chatter with perfectly smooth input (should be ~0).
import { buildTrack } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
export function chatter(assist = 'casual', V = 30, steer = 0.6, body = 'gt') {
  const T = buildTrack({ ...PRESETS[2], hills: 0, banking: 0 });
  const car = new Vehicle(makeCarParams({ body }), T);
  car.assists = { ...ASSIST_PRESETS[assist], autoShift: true };
  car.surfaceAt = () => 0; car.collide = () => {};
  car.reset(0, 0); car.u = V; for (const w of car.wheels) { w.omega = V / car.p.wheelR; w.temp = 85; }
  const dt = 1 / 240; let iE = 0, flips = 0, hf = 0, n = 0; const hs = [];
  for (let t = 0; t < 6; t += dt) {
    const e = V - car.u; iE += e * dt;
    const s = Math.min(1, t / 0.5) * steer;
    car.step(dt, { throttle: Math.max(0, Math.min(1, e * 0.8 + iE * 0.4)), brake: 0, steer: s });
    if (t < 2) continue;
    hs.push(car.steer);
    const k = hs.length;
    if (k > 2) {
      const a = hs[k - 1] - hs[k - 2], b = hs[k - 2] - hs[k - 3];
      if (Math.sign(a) !== Math.sign(b) && Math.abs(a) > 1e-4) flips++;
      hf += Math.abs(a - b); n++;
    }
  }
  return { flipsPerSec: flips / 4, hf: (hf / n) * 1e4 };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const a of ['casual', 'pro']) for (const V of [12, 30, 50]) console.log(a, V, JSON.stringify(chatter(a, V)));
}
