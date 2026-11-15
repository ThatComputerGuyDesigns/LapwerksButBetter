// Regression tests: every build must keep the handling sane and every preset
// circuit lappable. Run with `npm test` (also runs in CI before deploying).
import { buildTrack, buildHeightfield } from '../src/track/track.js';
import { PRESETS } from '../src/track/presets.js';
import { runLap } from './lapsim.mjs';
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

// 3. car ordering: slicks beat street tyres, prototype beats hatch
{
  const T = buildTrack(PRESETS[0]);
  const lap = (s) => runLap(T, s, { assists: 'sport', laps: 2 }).best;
  const street = lap({ body: 'gt', compound: 'street' }), slick = lap({ body: 'gt', compound: 'slick' });
  check(slick < street, `slicks (${formatTime(slick)}) faster than street (${formatTime(street)})`);
  const hatch = lap({ body: 'hatch', compound: 'sport' }), proto = lap({ body: 'proto', compound: 'sport' });
  check(proto < hatch, `prototype (${formatTime(proto)}) faster than hatch (${formatTime(hatch)})`);
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
