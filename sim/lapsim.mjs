// Headless lap simulator: runs the real vehicle model with the AI driver on
// every preset circuit and reports lap times + handling telemetry.
//   npm run sim                → table for all presets with the default car
//   npm run sim -- --all-cars  → every body × compound
//   npm run sim -- --svg       → also writes sim/out/<track>.svg plots
import { buildTrack } from '../src/track/track.js';
import { computeRacingLine, speedProfile } from '../src/track/racingLine.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams, BODIES } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { AIDriver } from '../src/physics/driver.js';
import { formatTime } from '../src/core/math.js';
import fs from 'node:fs';

const args = new Set(process.argv.slice(2));

export function runLap(track, setup, { assists = 'pro', laps = 2, pace = 1, dt = 1 / 240, record = false } = {}) {
  const params = makeCarParams(setup);
  const line = computeRacingLine(track);
  const prof = speedProfile(track, line, params);
  const car = new Vehicle(params, track);
  car.assists = { ...ASSIST_PRESETS[assists], autoShift: true };
  const ai = new AIDriver(track, line, prof, { pace });
  car.reset(track.length - 30, line.offset[track.N - 15]);
  let lastS = car.q.s, lapStart = null, lapTimes = [];
  let t = 0, maxLat = 0, maxLong = 0, minLong = 0, maxSpeed = 0, offs = 0, spins = 0, impacts = 0;
  let maxBeta = 0, sumTemp = 0, nTemp = 0, wasOff = false, wasSpin = false;
  const trace = [];
  const limit = (track.length / 8) * (laps + 1) + 60;
  while (t < limit && lapTimes.length < laps) {
    const inp = ai.control(car);
    car.step(dt, inp);
    t += dt;
    const s = car.q.s;
    if (lastS > track.length * 0.8 && s < track.length * 0.2) {
      if (lapStart !== null) lapTimes.push(t - lapStart);
      lapStart = t;
    }
    lastS = s;
    if (lapStart !== null) {
      maxLat = Math.max(maxLat, Math.abs(car.ay) / 9.81);
      maxLong = Math.max(maxLong, car.ax / 9.81);
      minLong = Math.min(minLong, car.ax / 9.81);
      maxSpeed = Math.max(maxSpeed, car.u);
      const beta = Math.abs(Math.atan2(car.v, Math.max(Math.abs(car.u), 1)));
      maxBeta = Math.max(maxBeta, beta);
      const spin = beta > 0.5;
      if (spin && !wasSpin) spins++;
      wasSpin = spin;
      if (car.offTrack && !wasOff) offs++;
      wasOff = car.offTrack;
      if (car.lastImpact > 1) { impacts++; car.lastImpact = 0; }
      for (const w of car.wheels) { sumTemp += w.temp; nTemp++; }
      if (record && Math.round(t * 240) % 24 === 0) trace.push([car.x, car.z, car.u]);
    }
  }
  return {
    lapTimes, best: lapTimes.length ? Math.min(...lapTimes) : null,
    theoretical: prof.lapTime, maxLat, maxLong, minLong, maxSpeed,
    offs, spins, impacts, maxBeta, avgTemp: sumTemp / Math.max(nTemp, 1), trace, line, prof,
  };
}

function svg(track, res, file) {
  const b = track.bounds, pad = 40;
  const W = b.maxX - b.minX + pad * 2, H = b.maxZ - b.minZ + pad * 2;
  const tx = (x) => (x - b.minX + pad).toFixed(1), tz = (z) => (z - b.minZ + pad).toFixed(1);
  let p = '';
  for (let i = 0; i <= track.N; i++) { const k = i % track.N; p += `${i ? 'L' : 'M'}${tx(track.px[k])},${tz(track.pz[k])}`; }
  let lp = '';
  for (let i = 0; i <= track.N; i++) { const k = i % track.N; lp += `${i ? 'L' : 'M'}${tx(res.line.x[k])},${tz(res.line.z[k])}`; }
  let tr = '';
  res.trace.forEach(([x, z], i) => (tr += `${i ? 'L' : 'M'}${tx(x)},${tz(z)}`));
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W / 2}" height="${H / 2}" style="background:#1d2b1f">
<path d="${p}" fill="none" stroke="#555" stroke-width="${track.width}" stroke-linejoin="round"/>
<path d="${lp}" fill="none" stroke="#4fc3f7" stroke-width="1.2"/>
<path d="${tr}" fill="none" stroke="#ff7043" stroke-width="1.2" stroke-dasharray="4 3"/>
<circle cx="${tx(track.px[0])}" cy="${tz(track.pz[0])}" r="6" fill="#fff"/></svg>`;
  fs.mkdirSync('sim/out', { recursive: true });
  fs.writeFileSync(file, out);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const bodies = args.has('--all-cars') ? Object.keys(BODIES) : ['gt'];
  const compounds = args.has('--all-cars') ? ['street', 'sport', 'slick'] : ['sport'];
  const assists = args.has('--casual') ? 'casual' : args.has('--sport') ? 'sport' : 'pro';
  const rows = [];
  for (const preset of PRESETS) {
    const t0 = Date.now();
    const track = buildTrack(preset);
    for (const body of bodies) for (const compound of compounds) {
      const res = runLap(track, { body, compound }, { assists, record: args.has('--svg') });
      rows.push({
        track: preset.name, car: `${body}/${compound}`, len: `${(track.length / 1000).toFixed(2)}km`,
        lap: formatTime(res.best), ideal: formatTime(res.theoretical),
        vmax: `${(res.maxSpeed * 3.6).toFixed(0)}km/h`, latG: res.maxLat.toFixed(2), brkG: (-res.minLong).toFixed(2), accG: res.maxLong.toFixed(2),
        offs: res.offs, spins: res.spins, hits: res.impacts, beta: `${(res.maxBeta * 57.3).toFixed(1)}°`, tyre: `${res.avgTemp.toFixed(0)}°C`,
        ms: Date.now() - t0,
      });
      if (args.has('--svg')) svg(track, res, `sim/out/${preset.id}-${body}-${compound}.svg`);
    }
  }
  console.table(rows);
}
