// Headless Race Control session: an all-AI field with incident detection,
// flags and a safety-car period. Verifies the director tools behave.
import { buildTrack } from '../src/track/track.js';
import { computeRacingLine } from '../src/track/racingLine.js';
import { PRESETS } from '../src/track/presets.js';
import { RaceField } from '../src/game/rivals.js';
import { RaceControl } from '../src/game/raceControl.js';
import { formatTime } from '../src/core/math.js';
import { setGripLevel } from '../src/physics/carSetup.js';

export function controlRace(preset = PRESETS[0], { cars = 10, laps = 6, drama = 0.7, body = 'gt3', sc = true, grip = 'real' } = {}) {
  setGripLevel(grip);
  const T = buildTrack(preset);
  const line = computeRacingLine(T);
  const stub = { userData: { sync() {} }, position: { set() {} }, quaternion: { copy() { return this; }, multiply() { return this; } } };
  const S = { T, line, setup: { body, compound: 'slick' }, world: { content: { add() {}, remove() {} } }, makeMesh: () => stub, lapsDone: 0, lap: { start: null } };
  const F = new RaceField(S, { laps, rivals: cars, difficulty: 'hard', rivalBodies: ['gt3', 'hyper', 'rs'], spectator: true, drama, paceSpread: [0.9, 1.0] });
  F.control = new RaceControl(F);
  F.resetGrid();
  const RC = F.control;
  const dt = 1 / 240;
  let t = 0, scStart = null, scOrder = null, passesUnderSC = 0, minGapSC = Infinity;
  while (t < 60 * 20) {
    F.step(dt, t, true);
    t += dt;
    const leader = F.order()[0];
    if (sc && !scStart && leader.lapsDone >= 2) { RC.setFlag('sc'); scStart = t; scOrder = F.order().map((r) => r.name).join(); }
    if (scStart && RC.flag === 'sc') {
      if (t - scStart > 40 && !RC.scEnding) RC.setFlag('green');
      const o = F.order();
      if (Math.round(t * 240) % 120 === 0) {
        const cur = o.map((r) => r.name).join();
        if (t - scStart > 8 && cur !== scOrder) { passesUnderSC++; scOrder = cur; }
        for (let k = 1; k < o.length; k++) { let g = o[k - 1].car.q.s - o[k].car.q.s; if (g < 0) g += T.length; if (t - scStart > 25) minGapSC = Math.min(minGapSC, g); }
      }
    }
    if (F.cars.every((r) => r.finished != null)) break;
  }
  const byType = {};
  for (const i of RC.incidents) byType[i.type] = (byType[i.type] || 0) + 1;
  return { t, byType, incidents: RC.incidents, standings: F.standings(), passesUnderSC, minGapSC, scDone: RC.flag === 'green', finished: F.cars.every((r) => r.finished != null), RC, F };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const drama of [0.4, 0.9]) {
    const r = controlRace(PRESETS[+process.argv[2] || 0], { drama });
    console.log(`drama ${drama}: finished=${r.finished} t=${formatTime(r.t)} incidents=${JSON.stringify(r.byType)} SC passes=${r.passesUnderSC} SC min gap=${r.minGapSC.toFixed(1)}m SC ended=${r.scDone}`);
    console.log('  ' + r.standings.map((x, i) => `${i + 1}.${x.name.split(' ')[1]}(${x.car})`).join(' '));
    console.log('  expected:', r.incidents.filter((i) => i.expected).slice(0, 6).map((i) => `${i.type}/${i.severity}${i.fault ? '/fault ' + i.fault.name.split(' ')[1] : '/racing inc'}→${i.expected}`).join('; '));
  }
}
