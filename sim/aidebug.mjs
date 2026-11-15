import { buildTrack } from '../src/track/track.js';
import { computeRacingLine, speedProfile } from '../src/track/racingLine.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { AIDriver } from '../src/physics/driver.js';
const track = buildTrack(PRESETS[+process.argv[2]||0]);
const params = makeCarParams({});
const line = computeRacingLine(track);
const prof = speedProfile(track, line, params);
const car = new Vehicle(params, track);
car.assists = { ...ASSIST_PRESETS[process.argv[3]||'pro'], autoShift: true };
const ai = new AIDriver(track, line, prof);
car.reset(track.length-30, line.offset[track.N-15]);
const dt=1/240; let hist=[];
for (let k=0;k<240*90;k++){
  const inp=ai.control(car); car.step(dt,inp);
  const beta=Math.atan2(car.v,Math.max(Math.abs(car.u),1));
  hist.push(`t ${(k*dt).toFixed(2)} s ${car.q.s.toFixed(0)} d ${car.q.d.toFixed(1)} off ${line.offset[car.hint].toFixed(1)} u ${car.u.toFixed(1)} vt ${prof.v[car.hint].toFixed(1)} β ${(beta*57.3).toFixed(1)} r ${car.r.toFixed(2)} δ ${(car.steer*57.3).toFixed(1)} in thr ${inp.throttle.toFixed(2)} brk ${inp.brake.toFixed(2)} st ${inp.steer.toFixed(2)} g ${car.gear} kR ${car.wheels[2].slipRatio.toFixed(2)} aR ${(car.wheels[2].slipAngle*57.3).toFixed(1)} aF ${(car.wheels[0].slipAngle*57.3).toFixed(1)} surf ${car.wheels.map(w=>w.surface).join('')}`);
  if (Math.abs(beta)>0.5){ console.log(hist.slice(-720).filter((_,i)=>i%24==0).join('\n')); break; }
}
