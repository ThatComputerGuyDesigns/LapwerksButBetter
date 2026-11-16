// Challenge modes: the Daily Challenge (same track, car and conditions for
// everyone that day), Endless (survive random circuits on three lives) and
// AI Championships (a fixed rival roster over several rounds, with points).
import { randomTrack } from '../track/generator.js';
import { ENVIRONMENTS } from '../track/environments.js';
import { BODIES } from '../physics/carSetup.js';
import { rng } from '../core/math.js';

export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

const DAILY_CARS = ['gt3', 'formula', 'rs', 'jdm', 'proto', 'hatch', 'gt', 'hyper', 'rally', 'muscle'];
const DAILY_ENVS = ['gp', 'forest', 'desert', 'street', 'gp', 'drift', 'forest', 'speedway'];
const THEMES = ['golden', 'midday', 'dusk'];

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const seedOf = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** The Daily Challenge for a date: deterministic, so every player gets the same one. */
export function dailyChallenge(key = dayKey()) {
  const seed = seedOf('kerbstone-daily-' + key);
  const R = rng(seed % 100000);
  const env = DAILY_ENVS[Math.floor(R() * DAILY_ENVS.length)];
  const body = DAILY_CARS[Math.floor(R() * DAILY_CARS.length)];
  const E = ENVIRONMENTS[env];
  const t = randomTrack(seed % 100000);
  const def = { ...t, id: 'daily-' + key, name: `Daily · ${t.name}`, env, theme: THEMES[Math.floor(R() * 3)], width: E.defaults.width, hills: E.defaults.hills, banking: E.defaults.banking };
  return { key, def, body, laps: 3 };
}

// ---------------------------------------------------------------- endless
export function endlessRound(state) {
  const R = rng((state.seed + state.round * 7919) % 100000);
  const env = DAILY_ENVS[Math.floor(R() * DAILY_ENVS.length)];
  const E = ENVIRONMENTS[env];
  const t = randomTrack(Math.floor(R() * 1e6));
  const def = { ...t, id: `endless-${state.seed}-${state.round}`, env, theme: THEMES[Math.floor(R() * 3)], width: E.defaults.width, hills: E.defaults.hills, banking: E.defaults.banking };
  // rivals get faster every round
  const difficulty = state.round < 3 ? 'easy' : state.round < 7 ? 'medium' : 'hard';
  const need = state.round < 2 ? 3 : state.round < 6 ? 2 : 1; // finish position needed to survive
  return { def, difficulty, need, rivals: 5, laps: 2 };
}
export const newEndless = () => ({ seed: Math.floor(Math.random() * 90000), round: 0, lives: 3, score: 0, history: [] });

// ---------------------------------------------------------------- championships
export const SERIES = {
  hatch: { name: 'Hot Hatch Trophy', bodies: ['hatch', 'jdm'] },
  club: { name: 'Club Sports Cup', bodies: ['gt', 'muscle', 'rs', 'jdm'] },
  gt: { name: 'GT World Series', bodies: ['gt3', 'rs', 'hyper'] },
  proto: { name: 'Prototype Endurance', bodies: ['proto', 'hyper'] },
  formula: { name: 'Grand Prix World Championship', bodies: ['formula'] },
};
const ROSTER = [
  ['M. Okafor', '#1f6feb'], ['L. Brandt', '#e9edf2'], ['S. Varga', '#0f5c3a'], ['J. Takeda', '#b3121c'], ['R. Moreau', '#14224a'],
  ['A. Lindqvist', '#e8d21d'], ['C. Duarte', '#0f8a8c'], ['E. Novak', '#2a2d33'], ['P. Rossetti', '#c0392b'], ['K. Adeyemi', '#8e44ad'], ['T. Halloran', '#d35400'],
];

/**
 * Create a championship. tracks: array of circuit definitions (one per round).
 */
export function newChampionship({ series = 'gt', tracks, laps = 3, rivals = 7, difficulty = 'medium', playerBody }) {
  const S = SERIES[series] || SERIES.gt;
  const R = rng(Math.floor(Math.random() * 1e5));
  const roster = ROSTER.slice().sort(() => R() - 0.5).slice(0, rivals).map(([name, paint], k) => ({
    name, paint, number: 2 + k * 7 + Math.floor(R() * 5),
    body: S.bodies[Math.floor(R() * S.bodies.length)],
    skill: k / Math.max(1, rivals - 1),
  }));
  return {
    id: 'ch-' + Date.now().toString(36), series, name: S.name, laps, difficulty, rivals,
    body: playerBody && S.bodies.includes(playerBody) ? playerBody : S.bodies[0],
    rounds: tracks.map((d) => ({ def: d, result: null })),
    roster, points: Object.fromEntries([['You', 0], ...roster.map((r) => [r.name, 0])]),
    round: 0, done: false,
  };
}

/** Record a finished round (order = names, finishing order). Returns awarded points. */
export function recordRound(ch, order, fastest) {
  const awarded = {};
  order.forEach((name, k) => {
    const p = (POINTS[k] || 0) + (name === fastest && k < 10 ? 1 : 0);
    ch.points[name] = (ch.points[name] || 0) + p;
    awarded[name] = p;
  });
  ch.rounds[ch.round].result = { order, fastest, awarded };
  ch.round++;
  if (ch.round >= ch.rounds.length) ch.done = true;
  return awarded;
}

export function standings(ch) {
  return Object.entries(ch.points)
    .map(([name, pts]) => ({ name, pts, wins: ch.rounds.filter((r) => r.result?.order[0] === name).length, isPlayer: name === 'You', paint: ch.roster.find((r) => r.name === name)?.paint }))
    .sort((a, b) => b.pts - a.pts || b.wins - a.wins);
}

export { BODIES };
