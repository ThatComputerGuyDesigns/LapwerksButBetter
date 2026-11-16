// Full brake + full steer from speed: can the car still turn while braking?
import { buildTrack } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
export function brakeSteer(assist = 'casual', V = 30) {
  const T = buildTrack({ ...PRESETS[2], hills: 0, banking: 0 });
  const car = new Vehicle(makeCarParams({}), T);
  car.assists = { ...ASSIST_PRESETS[assist], autoShift: true };
  car.surfaceAt = () => 0; car.collide = () => {};
  car.reset(0, 0); car.u = V; for (const w of car.wheels) { w.omega = V / car.p.wheelR; w.temp = 85; }
  const h0 = car.heading; const dt = 1 / 240; let locked = 0, n = 0, steer = 0;
  for (let t = 0; t < 3 && car.u > 2; t += dt) {
    steer = Math.min(1, steer + dt * 6);
    car.step(dt, { throttle: 0, brake: 1, steer });
    locked += car.wheels.filter((w) => w.front && Math.abs(w.omega) < 0.5).length / 2; n++;
  }
  return { turnedDeg: ((car.heading - h0) * 57.3).toFixed(0), frontLockedPct: ((locked / n) * 100).toFixed(0), endSpeed: car.u.toFixed(1) };
}
if (import.meta.url === `file://${process.argv[1]}`) for (const a of ['casual', 'sport', 'pro']) console.log(a, JSON.stringify(brakeSteer(a)));
