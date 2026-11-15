// Simulates a human on a keyboard: binary keys passed through the real Input
// smoothing, on the real vehicle model. Reports what happens.
import { buildTrack } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { clamp } from '../src/core/math.js';
const assist = process.argv[2] || 'sport';
function mk() {
  const T = buildTrack({ ...PRESETS[2], hills: 0, banking: 0 });
  const car = new Vehicle(makeCarParams({}), T);
  car.assists = { ...ASSIST_PRESETS[assist] };
  car.surfaceAt = () => 0; car.collide = () => {};
  car.reset(0, 0);
  return car;
}
// copy of Input keyboard smoothing
function kb(state, dt, left, right, speed) {
  const target = (left ? 1 : 0) - (right ? 1 : 0);
  const rateIn = 5.2 / (1 + speed / 28), rateOut = 7.5;
  const rate = target === 0 || Math.sign(target) !== Math.sign(state.s) ? rateOut : rateIn;
  state.s += clamp(target - state.s, -rate * dt, rate * dt);
  return state.s;
}
for (const [name, V, holdT] of [['tap 0.3s @90kmh', 25, 0.3], ['hold 1.5s @90kmh', 25, 1.5], ['tap 0.3s @150kmh', 42, 0.3], ['hold 1.5s @150kmh', 42, 1.5], ['hold 3s @50kmh', 14, 3]]) {
  const car = mk();
  car.u = V; for (const w of car.wheels) { w.omega = V / car.p.wheelR; w.temp = 60; }
  car.gear = 3;
  const st = { s: 0 }; const dt = 1 / 240;
  let maxBeta = 0, maxR = 0, t = 0, heading0 = car.heading;
  for (; t < 5; t += dt) {
    const left = t > 0.5 && t < 0.5 + holdT;
    const steer = kb(st, dt, left, false, car.speed);
    car.step(dt, { throttle: car.u < V ? 0.5 : 0.2, brake: 0, steer });
    maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(car.v, Math.abs(car.u))));
    maxR = Math.max(maxR, Math.abs(car.r));
  }
  console.log(name.padEnd(20), 'maxβ', (maxBeta * 57.3).toFixed(1) + '°', 'max yaw', maxR.toFixed(2), 'final u', car.u.toFixed(1), 'Δheading', ((car.heading - heading0) * 57.3).toFixed(0) + '°', 'steer δ peak', (car.p.maxSteer).toFixed(2));
}
