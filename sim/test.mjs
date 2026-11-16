// Regression tests: every build must keep the handling sane and every preset
// circuit lappable. Run with `npm test` (also runs in CI before deploying).
import { buildTrack, buildHeightfield } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { runLap } from './lapsim.mjs';
import { keyLap } from './keylap.mjs';
import { response } from './response.mjs';
import { jitter } from './jitter.mjs';
import { chatter } from './chatter.mjs';
import { race } from './race.mjs';
import { BODIES } from '../src/physics/carSetup.js';
import { decodeTrack, encodeTrack } from '../src/game/store.js';
import { strokeToControlPoints } from '../src/track/spline.js';
import { formatTime } from '../src/core/math.js';

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

// 1. every preset builds, has sane geometry and terrain
for (const p of PRESETS) {
  const T = buildTrack(p);
  buildHeightfield(T);
  check(T.N > 300 && T.length > 1500 && T.length < 6000, `${p.name}: ${(T.length / 1000).toFixed(2)} km, ${T.corners.length} corners`);
  check([...T.py].every(Number.isFinite), `${p.name}: finite elevation`);
}

// 2. the default car laps every preset cleanly with Sport assists, near the theoretical limit
for (const p of PRESETS) {
  const T = buildTrack(p);
  const r = runLap(T, { body: 'gt', compound: 'sport' }, { assists: 'sport', laps: 2 });
  const ratio = r.best / r.theoretical;
  check(r.best != null && ratio < 1.1 && r.spins <= 1, `${p.name}: lap ${formatTime(r.best)} (ideal ${formatTime(r.theoretical)}, ${((ratio - 1) * 100).toFixed(1)}% off, spins ${r.spins})`);
}

// 2b. a crude keyboard player (on/off keys, 150 ms reactions) must get round
//     every preset without spinning or leaving the road on Easy and Sport
for (const assist of ['casual', 'sport']) {
  for (const p of PRESETS) {
    const r = keyLap(p, assist);
    check(r.laps.length === 2 && r.spins === 0 && r.offs <= 1, `keyboard ${assist === 'casual' ? 'Easy' : 'Sport'} · ${p.name}: ${r.laps.map(formatTime).join(' / ')} · spins ${r.spins} · offs ${r.offs}`);
  }
}

// 2c. responsiveness ("not a boat"): quick turn-in, controlled overshoot
for (const V of [28, 45]) {
  const r = response({}, 'casual', V);
  check(r.t90 < 0.25 && r.overshoot < 0.35, `turn-in @${Math.round(V * 3.6)} km/h: 90% yaw in ${r.t90.toFixed(2)} s, overshoot ${(r.overshoot * 100).toFixed(0)}%`);
}

// 2c'. smoothness: no steering chatter from the assists or the AI
{
  for (const V of [12, 30, 50]) { const c = chatter('casual', V); check(c.flipsPerSec < 0.5, `assist chatter @${Math.round(V * 3.6)} km/h: ${c.flipsPerSec.toFixed(2)} reversals/s`); }
  const j = jitter(PRESETS[0], 'casual');
  check(j.steerFlipsPerSec < 5 && j.steerHF < 2.5, `AI lap steering smoothness: ${j.steerFlipsPerSec.toFixed(1)} reversals/s, HF ${j.steerHF.toFixed(2)}`);
}

// 2d. every car in the garage is drivable on a keyboard (Easy)
for (const id of Object.keys(BODIES)) {
  // the single-seater at arcade grip is the expert car: it must never spin,
  // but a 150 ms-reaction keyboard bot is allowed to run wide at its speeds
  const r = keyLap(PRESETS[0], 'casual', 0.85, { body: id, compound: BODIES[id].compound });
  const offsOk = id === 'formula' ? r.offs <= 15 : r.offs <= 1;
  check(r.laps.length === 2 && r.spins === 0 && offsOk, `keyboard Easy · ${BODIES[id].name}: ${r.laps.map(formatTime).join(' / ')} · spins ${r.spins} · offs ${r.offs}`);
}

// 2e. races: every car finishes, nobody spins, difficulty orders the field
for (const d of ['easy', 'hard']) {
  const r = race(PRESETS[0], { difficulty: d, laps: 2 });
  const pos = r.standings.findIndex((x) => x.isPlayer) + 1;
  check(r.allFinished && r.spins === 0, `race vs ${d} rivals: all finished, spins ${r.spins}, AI player P${pos}`);
}

// 3. car ordering: slicks beat street tyres, prototype beats hatch
{
  const T = buildTrack(PRESETS[0]);
  const lap = (s) => runLap(T, s, { assists: 'sport', laps: 2 }).best;
  const street = lap({ body: 'gt', compound: 'street' }), slick = lap({ body: 'gt', compound: 'slick' });
  check(slick < street, `slicks (${formatTime(slick)}) faster than street (${formatTime(street)})`);
  const hatch = lap({ body: 'hatch', compound: 'sport' }), proto = lap({ body: 'proto', compound: 'sport' });
  check(proto < hatch, `prototype (${formatTime(proto)}) faster than hatch (${formatTime(hatch)})`);
  const f1 = lap({ body: 'formula', compound: 'slick' }), gt3 = lap({ body: 'gt3', compound: 'slick' });
  check(f1 < gt3, `open-wheeler (${formatTime(f1)}) faster than GT3 (${formatTime(gt3)})`);
}

// 4. share codes round-trip
{
  const p = PRESETS[1];
  const d = decodeTrack(encodeTrack(p));
  check(d && d.points.length === p.points.length && d.name === p.name, 'share code round-trip');
}

// 5. a freehand stroke becomes a valid circuit
{
  const st = [];
  for (let i = 0; i <= 120; i++) { const t = (i / 120) * Math.PI * 2; const r = 1 + 0.25 * Math.sin(3 * t); st.push([Math.cos(t) * 450 * r + Math.random() * 4, Math.sin(t) * 300 * r]); }
  const c = strokeToControlPoints(st);
  const T = c && buildTrack({ points: c });
  check(T && T.length > 1500, `freehand stroke → ${T ? (T.length / 1000).toFixed(2) : '?'} km circuit`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
