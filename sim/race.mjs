// Headless race: the real RaceField (rivals, traffic logic, contact) with an
// AI-driven "player". Checks that races run cleanly and finish.
import { buildTrack } from '../src/track/track.js';
import { computeRacingLine, speedProfile } from '../src/track/racingLine.js';
import { PRESETS } from '../src/track/presets.js';
import { makeCarParams } from '../src/physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../src/physics/vehicle.js';
import { AIDriver } from '../src/physics/driver.js';
import { RaceField } from '../src/game/rivals.js';
import { formatTime } from '../src/core/math.js';

export function race(preset, { laps = 3, rivals = 5, difficulty = 'medium', playerPace = 0.95, body = 'gt' } = {}) {
  const T = buildTrack(preset);
  const line = computeRacingLine(T);
  const setup = { body, compound: 'sport', paint: '#ff5a1f', number: 7 };
  const params = makeCarParams(setup);
  const stub = { userData: { sync() {} }, position: { set() {} }, quaternion: { copy() { return this; }, multiply() { return this; } } };
  const S = { T, line, setup, world: { content: { add() {}, remove() {} } }, makeMesh: () => stub, lapsDone: 0, lap: { start: null }, raceBest: null };
  S.car = new Vehicle(params, T);
  S.car.assists = { ...ASSIST_PRESETS.casual, autoShift: true };
  const ai = new AIDriver(T, line, speedProfile(T, line, params), { pace: playerPace });
  const F = new RaceField(S, { laps, rivals, difficulty });
  const slot = F.resetGrid();
  S.car.reset(slot.s, slot.lat);
  const dt = 1 / 240;
  let t = 0, lastS = S.car.q.s, impacts = 0, spins = 0, overtakes = 0, lastOrder = null, nextSample = 0;
  const spinning = new Map();
  while (t < 60 * 15) {
    S.car.step(dt, ai.control(S.car));
    F.step(dt, t, true);
    t += dt;
    const s = S.car.q.s;
    if (lastS > T.length * 0.75 && s < T.length * 0.25) {
      if (S.lap.start == null) S.lap.start = t; else { S.lapsDone++; if (S.lapsDone >= laps && F.playerFinished == null) F.playerFinished = t; }
    }
    lastS = s;
    for (const c of [S.car, ...F.cars.map((r) => r.car)]) {
      if (c.lastImpact > 1) { impacts++; c.lastImpact = 0; }
      const b = Math.abs(Math.atan2(c.v, Math.max(Math.abs(c.u), 1))) > 0.6;
      if (b && !spinning.get(c)) spins++;
      spinning.set(c, b);
    }
    if (t >= nextSample) {
      nextSample = t + 0.5;
      const order = F.standings().map((x) => x.name).join('|');
      if (lastOrder && order !== lastOrder) {
        const a = lastOrder.split('|'), b = order.split('|');
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { overtakes++; break; }
      }
      lastOrder = order;
    }
    if (F.playerFinished != null && F.cars.every((r) => r.finished != null)) break;
  }
  return { t, standings: F.standings(), impacts, spins, overtakes, allFinished: F.playerFinished != null && F.cars.every((r) => r.finished != null) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const k of [0, 3, 4]) for (const d of ['easy', 'hard']) {
    const r = race(PRESETS[k], { difficulty: d });
    console.log(`${PRESETS[k].name} [${d}] finished=${r.allFinished} t=${formatTime(r.t)} contacts=${r.impacts} spins=${r.spins} overtakes=${r.overtakes} spread=${(r.standings.at(-1).finished - r.standings[0].finished).toFixed(1)}s`);
    console.log('   ' + r.standings.map((x, i) => `${i + 1}.${x.isPlayer ? 'YOU' : x.name.split(' ')[1]} ${x.finished != null ? formatTime(x.finished) : '—'}`).join('  '));
  }
}
