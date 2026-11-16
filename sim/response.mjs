// Turn-in response metrics: how quickly the car answers a steering key.
// "Boat" = slow yaw build-up, big overshoot, lots of roll/slip. Lower is better.
import { buildTrack } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { clamp } from '../src/core/math.js';
import { KEYBOARD } from '../src/game/input.js';

export function response(setup = {}, assist = 'casual', V = 28) {
  const T = buildTrack({ ...PRESETS[2], hills: 0, banking: 0 });
  const car = new Vehicle(makeCarParams(setup), T);
  car.assists = { ...ASSIST_PRESETS[assist], autoShift: true };
  car.surfaceAt = () => 0; car.collide = () => {};
  car.reset(0, 0);
  car.u = V; for (const w of car.wheels) { w.omega = V / car.p.wheelR; w.temp = car.p.tire.optTemp; }
  const dt = 1 / 240; let s = 0, iE = 0;
  const rows = [];
  for (let t = 0; t < 4; t += dt) {
    const target = t > 0.2 ? 1 : 0;
    const v = Math.max(0, car.speed);
    const rate = target === 0 ? KEYBOARD.rateOut : KEYBOARD.rateIn / (1 + v / KEYBOARD.rateV);
    s += clamp(target - s, -rate * dt, rate * dt);
    const e = V - car.u; iE += e * dt;
    car.step(dt, { throttle: clamp(e * 0.8 + iE * 0.4, 0, 1), brake: 0, steer: s });
    rows.push([t, car.r, car.ay, Math.atan2(car.v, car.u)]);
  }
  // reference: yaw rate 1.5 s after the input (speed bleeds off at huge g)
  const rEnd = rows.find((r) => r[0] >= 1.7)[1];
  const t90 = rows.find((r) => r[0] > 0.2 && Math.abs(r[1]) >= 0.9 * Math.abs(rEnd))?.[0] - 0.2;
  const tg = rows.find((r) => r[0] > 0.2 && Math.abs(r[2]) >= 4.9)?.[0] - 0.2;
  const peak = Math.max(...rows.filter((r) => r[0] < 1.7).map((r) => Math.abs(r[1])));
  return { t90, tHalfG: tg, overshoot: peak / Math.abs(rEnd) - 1, latG: Math.abs(rows[rows.length - 1][2]) / 9.81, beta: Math.max(...rows.map((r) => Math.abs(r[3]))) * 57.3 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const a of ['casual', 'sport', 'pro']) for (const V of [15, 28, 45]) {
    const r = response({}, a, V);
    console.log(`${a.padEnd(7)} ${String(V * 3.6 | 0).padStart(3)}km/h  yaw90% ${r.t90?.toFixed(2)}s  0.5g ${r.tHalfG?.toFixed(2)}s  overshoot ${(r.overshoot * 100).toFixed(0)}%  latG ${r.latG.toFixed(2)}  slip ${r.beta.toFixed(1)}°`);
  }
}
