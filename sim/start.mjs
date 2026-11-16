// Regression: the countdown hold must never put cars in reverse, and every
// car must move forward off the line.
import { buildTrack } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
export function startCheck(assist = 'casual') {
  const T = buildTrack(PRESETS[0]);
  const car = new Vehicle(makeCarParams({}), T);
  car.assists = { ...ASSIST_PRESETS[assist] };
  car.reset(T.length - 20, 0);
  const s0 = car.q.s;
  const dt = 1 / 240;
  for (let t = 0; t < 4.2; t += dt) car.step(dt, { throttle: 0, brake: 1, steer: 0, hold: true });
  const gearAtGo = car.gear;
  for (let t = 0; t < 2; t += dt) car.step(dt, { throttle: 1, brake: 0, steer: 0 });
  let moved = car.q.s - s0; if (moved < -T.length / 2) moved += T.length;
  return { gearAtGo, moved, u: car.u };
}
if (import.meta.url === `file://${process.argv[1]}`) for (const a of ['casual', 'sport', 'pro']) console.log(a, startCheck(a));
