import { buildTrack } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
const track = buildTrack(PRESETS[2]);
const car = new Vehicle(makeCarParams({}), track);
car.assists = { ...ASSIST_PRESETS[process.argv[2]||'pro'], autoShift:true };
car.reset(0,0);
const dt=1/240;
for (let k=0;k<240*8;k++){
  const t=k*dt;
  const inp = { throttle: t<5?1:0, brake: t>=5?1:0, steer: 0 };
  car.step(dt, inp);
  if (k%60===0){
    const w=car.wheels;
    console.log(t.toFixed(2), 'u',car.u.toFixed(2),'v',car.v.toFixed(2),'r',car.r.toFixed(3),'g',car.gear,'rpm',car.rpm.toFixed(0),
     'kap',w.map(x=>x.slipRatio.toFixed(2)).join(','),'Fz',w.map(x=>x.load.toFixed(0)).join(','),'T',w.map(x=>x.temp.toFixed(0)).join(','), 'ax',car.ax.toFixed(2));
  }
}
