import { buildTrack } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
const track = buildTrack({ ...PRESETS[2], hills: 0, banking: 0 });
const body = process.argv[2] || 'gt';
const V = +(process.argv[3] || 25);
const car = new Vehicle(makeCarParams({ body }), track);
car.assists = { ...ASSIST_PRESETS.pro, steer: 0, autoShift: true };
car.surfaceAt = () => 0; car.collide = () => {};
car.reset(0, 0);
car.u = V; for (const w of car.wheels) w.omega = V / car.p.wheelR;
const dt = 1 / 240; let iE = 0;
for (let k = 0; k < 240 * 24; k++) {
  const t = k * dt;
  const st = Math.min(1, Math.max(0, (t - 2) / 20));
  const e = V - car.u; iE += e * dt;
  const thr = Math.max(0, Math.min(1, e * 0.8 + iE * 0.3));
  car.step(dt, { throttle: thr, brake: e < -2 ? 0.3 : 0, steer: st * 0.35 });
  if (k % 240 === 0) {
    const beta = Math.atan2(car.v, car.u) * 57.3;
    const w = car.wheels;
    console.log(`t ${t.toFixed(0)} st ${(st*0.35).toFixed(2)} δ ${(car.steer*57.3).toFixed(1)}° u ${car.u.toFixed(1)} ay ${(car.ay/9.81).toFixed(2)}g r ${car.r.toFixed(3)} β ${beta.toFixed(1)} αF ${(w[0].slipAngle*57.3).toFixed(1)},${(w[1].slipAngle*57.3).toFixed(1)} αR ${(w[2].slipAngle*57.3).toFixed(1)},${(w[3].slipAngle*57.3).toFixed(1)} Fz ${w.map(x=>x.load.toFixed(0)).join(',')} thr ${thr.toFixed(2)}`);
  }
}
