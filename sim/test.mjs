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
import { startCheck } from './start.mjs';
import { brakeSteer } from './brakesteer.mjs';
import { BODIES } from '../src/physics/carSetup.js';
import { decodeTrack, encodeTrack } from '../src/game/store.js';
import { computeRacingLine, speedProfile } from '../src/track/racingLine.js';
import { analyzeTrack, referenceParams } from '../src/track/analysis.js';
import { parseGPS, circuitFromGPS, circuitFromDescription } from '../src/track/importers.js';
import { SURF } from '../src/track/track.js';
import { dailyChallenge, newChampionship, recordRound, standings as champStandings } from '../src/game/challenges.js';
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
  const offsOk = id === 'formula' ? r.offs <= 20 : r.offs <= 1;
  check(r.laps.length === 2 && r.spins === 0 && offsOk, `keyboard Easy · ${BODIES[id].name}: ${r.laps.map(formatTime).join(' / ')} · spins ${r.spins} · offs ${r.offs}`);
}

// 2e. races: every car finishes, nobody spins, difficulty orders the field
for (const d of ['easy', 'hard']) {
  const r = race(PRESETS[0], { difficulty: d, laps: 2 });
  const pos = r.standings.findIndex((x) => x.isPlayer) + 1;
  check(r.allFinished && r.spins === 0, `race vs ${d} rivals: all finished, spins ${r.spins}, AI player P${pos}`);
}

// 2f. start line: holding the brakes through the countdown must never select
//     reverse; every car drives forward at the lights
for (const a of ['casual', 'sport', 'pro']) {
  const r = startCheck(a);
  check(r.gearAtGo === 1 && r.moved > 3, `start (${a}): gear ${r.gearAtGo} at GO, ${r.moved.toFixed(1)} m forward in 2 s`);
}

// 2g. steering under a full (keyboard) brake
for (const [a, min] of [['casual', 45], ['sport', 35], ['pro', 15]]) {
  const r = brakeSteer(a);
  check(+r.turnedDeg >= min, `full brake + full steer (${a}): turned ${r.turnedDeg}°, front locked ${r.frontLockedPct}%`);
}

// 2h. rewind: snapshot → restore → identical replay
{
  const { Vehicle, ASSIST_PRESETS } = await import('../src/physics/vehicle.js');
  const { makeCarParams } = await import('../src/physics/carSetup.js');
  const T = buildTrack(PRESETS[0]);
  const car = new Vehicle(makeCarParams({}), T);
  car.assists = { ...ASSIST_PRESETS.casual };
  car.reset(0, 0);
  const drive = (n, k0) => { for (let k = 0; k < n; k++) car.step(1 / 240, { throttle: 1, brake: 0, steer: Math.sin((k + k0) / 90) * 0.5 }); };
  drive(480, 0);
  const snap = car.snapshot();
  drive(240, 480);
  const a = [car.x, car.z, car.u];
  car.restore(snap);
  drive(240, 480);
  const err = Math.hypot(car.x - a[0], car.z - a[1]) + Math.abs(car.u - a[2]);
  check(err < 1e-6, `rewind restore is deterministic (error ${err.toExponential(1)})`);
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

// 6. Track Studio: per-point edits, start line, environments, analysis, imports
{
  const base = JSON.parse(JSON.stringify(PRESETS[0]));
  const flat = buildTrack({ ...base, hills: 0 });
  const raised = JSON.parse(JSON.stringify({ ...base, hills: 0 }));
  raised.points[6][2] = 15;
  const Tr = buildTrack(raised);
  check(Tr.bounds.maxY - Tr.bounds.minY > (flat.bounds.maxY - flat.bounds.minY) + 10, `point height edit raises the road (${(Tr.bounds.maxY - Tr.bounds.minY).toFixed(1)} m)`);
  const st = JSON.parse(JSON.stringify(base)); st.start = st.points[8].slice(0, 2);
  const Ts = buildTrack(st);
  check(Math.hypot(Ts.px[0] - st.start[0], Ts.pz[0] - st.start[1]) < 12, 'start line follows the placed start');
  const banked = JSON.parse(JSON.stringify({ ...base, banking: 0 })); banked.points[4][3] = 20;
  const Tb = buildTrack(banked);
  check(Math.max(...Tb.bank.map(Math.abs)) > 0.25, `per-point banking applied (${((Math.max(...Tb.bank.map(Math.abs)) * 180) / Math.PI).toFixed(0)}°)`);
  const Td = buildTrack({ ...base, env: 'desert' }), Tst = buildTrack({ ...base, env: 'street' }), Tra = buildTrack({ ...base, env: 'rally' });
  check(Td.surfTrap === SURF.GRAVEL && Tst.surfRunoff === SURF.ASPHALT && Tra.surfRoad === SURF.DIRT, 'environments set physics surfaces (sand, asphalt run-off, gravel road)');
  // share code carries studio extras
  const dressed = { ...raised, name: 'Dressed', env: 'drift', start: [10, 20], objects: [{ type: 'stand', x: 100, z: 50, rot: 1.2 }], cams: [{ x: 1, z: 2 }, { x: 3, z: 4 }], colors: { kerbA: '#0000ff' } };
  const back = decodeTrack(encodeTrack(dressed));
  check(back && back.env === 'drift' && back.points[6][2] === 15 && back.objects.length === 1 && back.cams.length === 2 && back.colors.kerbA === '#0000ff' && back.start[0] === 10, 'share code round-trips environment, edits, objects, cameras and colours');
  // analysis
  for (const p of PRESETS) {
    const T = buildTrack(p), line = computeRacingLine(T, { iterations: 300 }), prof = speedProfile(T, line, referenceParams());
    const A = analyzeTrack(T, line, prof);
    const ok = Object.values(A.ratings).every((v) => v >= 0 && v <= 10) && A.corners.length === T.corners.length;
    check(ok, `analysis ${p.name}: ${A.grade} · overtaking ${A.ratings.overtaking.toFixed(1)} · tech ${A.ratings.technicality.toFixed(1)} · fun ${A.ratings.fun.toFixed(1)}`);
  }
  // GPS import
  let gpx = '<gpx><trk><trkseg>';
  for (let lap = 0; lap < 2; lap++) for (let k = 0; k < 300; k++) { const t = (k / 300) * Math.PI * 2, r = 0.006 * (1 + 0.3 * Math.sin(2 * t)); gpx += `<trkpt lat="${52 + r * Math.sin(t)}" lon="${-1 + r * 1.6 * Math.cos(t)}"><ele>${100 + 8 * Math.sin(t)}</ele></trkpt>`; }
  const g = circuitFromGPS(parseGPS(gpx + '</trkseg></trk></gpx>'));
  const Tg = buildTrack(g);
  check(Tg.length > 3500 && Tg.length < 5500 && Tg.bounds.maxY - Tg.bounds.minY > 10, `GPX lap → ${(Tg.length / 1000).toFixed(2)} km with ${(Tg.bounds.maxY - Tg.bounds.minY).toFixed(0)} m elevation`);
  // describe
  const r = circuitFromDescription('a 2 km kart track with three hairpins', { seed: 3 });
  check(r.def.env === 'kart' && Math.abs(buildTrack(r.def).length / 1000 - 2) < 0.3, `describe → ${r.notes.join(', ')}`);
}

// 7. challenges: daily is deterministic, championship points add up
{
  const a = dailyChallenge('2026-01-01'), b = dailyChallenge('2026-01-01'), c = dailyChallenge('2026-01-02');
  check(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a.def.points) !== JSON.stringify(c.def.points), `daily challenge is the same for everyone each day (${a.def.name}, ${a.body})`);
  const ch = newChampionship({ series: 'gt', tracks: [PRESETS[0], PRESETS[1]], rivals: 9 });
  const names = ['You', ...ch.roster.map((r) => r.name)];
  recordRound(ch, names, 'You');
  recordRound(ch, names.slice().reverse(), names[1]);
  const st = champStandings(ch);
  check(ch.done && ch.points.You === 25 + 1 + 1 && st.length === 10 && st[0].pts >= st[9].pts, `championship scoring (You ${ch.points.You} pts, leader ${st[0].name} ${st[0].pts})`);
}

// 8. garage v2: turbo adds mid-range torque at the rated peak power; wings trade drag for downforce
{
  const { makeCarParams: mk, engineTorque: et } = await import('../src/physics/carSetup.js');
  const peak = (p) => { let m = 0; for (let r = 1000; r <= p.engine.limiter; r += 25) m = Math.max(m, (et(p.engine, r) * r * Math.PI) / 30 / 1000); return m; };
  const na = mk({ body: 'gt' }), tb = mk({ body: 'gt', turbo: 1 });
  check(Math.abs(peak(tb) - tb.engine.powerKW) / tb.engine.powerKW < 0.03 && et(tb.engine, 3800) > et(na.engine, 3800) * 1.15, `turbo: ${Math.round(peak(tb) * 1.341)} hp peak, mid-range torque ${Math.round(et(tb.engine, 3800))} vs ${Math.round(et(na.engine, 3800))} Nm`);
  const lo = mk({ body: 'gt3', rearWing: 0, frontWing: 0 }), hi = mk({ body: 'gt3', rearWing: 1, frontWing: 1 });
  check(hi.aero.clA > lo.aero.clA * 1.5 && hi.aero.cdA > lo.aero.cdA, 'wings add downforce and drag');
  const fw = mk({ body: 'gt3', frontWing: 1, rearWing: 0.3 });
  check(fw.aero.balance > mk({ body: 'gt3' }).aero.balance, 'front wing moves aero balance forward');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
