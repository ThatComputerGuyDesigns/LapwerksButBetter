// Open world smoke test: the island generates and a car can drive off from the festival.
import { generateWorld, worldTrack } from '../src/open/worldgen.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { makeCarParams } from '../src/physics/carSetup.js';
export function openDrive() {
  const W = generateWorld(7), T = worldTrack(W);
  const car = new Vehicle(makeCarParams({ body: 'gt' }), T);
  car.assists = { ...ASSIST_PRESETS.casual };
  const r = W.roads.find((q) => q.id === 'north'), i = 200, p = r.pts[i], q = r.pts[i + 1];
  car.x = p[0]; car.z = p[1]; car.heading = Math.atan2(q[0] - p[0], q[1] - p[1]);
  car.y = T.height(car.x, car.z); car.prevGround = car.y; car.vy = 0;
  let air = 0;
  for (let k = 0; k < 240 * 6; k++) { car.step(1 / 240, { throttle: 1, brake: 0, steer: 0 }); if (car.airborne) air++; }
  return { kmh: car.speed * 3.6, air: air / 240, roads: W.roads.length };
}
if (process.argv[1].endsWith('openworld.mjs')) console.log(openDrive());
