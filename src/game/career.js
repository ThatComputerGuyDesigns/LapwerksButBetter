// Career: championships of events across car classes, credits, XP / levels,
// stars, a car dealership and unlocks. Pure logic + persistence (testable).
import { BODIES } from '../physics/carSetup.js';
import { randomTrack } from '../track/generator.js';

export const CAR_PRICES = {
  hatch: 0, jdm: 18000, rally: 26000, gt: 42000, muscle: 38000, rs: 65000, gt3: 120000, hyper: 210000, proto: 300000, formula: 450000,
};

// Championship ladder. Each event: type, track, laps / target, rewards.
// class = the bodies allowed; rivals are drawn from the same class.
export const TIERS = [
  {
    id: 'rookie', name: 'Rookie Cup', blurb: 'Hot hatches and tuners. Learn the lines.', cls: ['hatch', 'jdm', 'rally'], unlockStars: 0, difficulty: 'easy',
    events: [
      { id: 'r1', type: 'race', name: 'First Grid', track: 'harbor', laps: 2, rivals: 5 },
      { id: 'r2', type: 'trial', name: 'Pinewood Hot Lap', track: 'pinewood', laps: 3 },
      { id: 'r3', type: 'overtake', name: 'Back of the Pack', track: 'ridgeback', laps: 3, rivals: 7 },
      { id: 'r4', type: 'race', name: 'Rookie Finale', track: 'gen:4121', laps: 3, rivals: 7 },
    ],
  },
  {
    id: 'club', name: 'Club Sports', blurb: 'Coupés and sports cars with real power.', cls: ['gt', 'muscle', 'rs', 'jdm'], unlockStars: 7, difficulty: 'medium',
    events: [
      { id: 'c1', type: 'race', name: 'Club Opener', track: 'ridgeback', laps: 3, rivals: 7 },
      { id: 'c2', type: 'duel', name: 'Rival Duel', track: 'twinbridge', laps: 3 },
      { id: 'c3', type: 'trial', name: 'Copperline Flier', track: 'copperline', laps: 3 },
      { id: 'c4', type: 'race', name: 'Club Championship', track: 'gen:907', laps: 4, rivals: 7 },
    ],
  },
  {
    id: 'gt', name: 'GT Masters', blurb: 'Race-bred GT cars and hypercars on slicks.', cls: ['gt3', 'hyper', 'rs'], unlockStars: 16, difficulty: 'medium',
    events: [
      { id: 'g1', type: 'race', name: 'GT Sprint', track: 'harbor', laps: 4, rivals: 7 },
      { id: 'g2', type: 'overtake', name: 'Charge', track: 'pinewood', laps: 4, rivals: 7 },
      { id: 'g3', type: 'trial', name: 'Ridgeback Record', track: 'ridgeback', laps: 3 },
      { id: 'g4', type: 'race', name: 'GT Masters Final', track: 'gen:3303', laps: 5, rivals: 7 },
    ],
  },
  {
    id: 'proto', name: 'Endurance Prototypes', blurb: 'Downforce monsters. Longer races, harder rivals.', cls: ['proto', 'hyper'], unlockStars: 26, difficulty: 'hard',
    events: [
      { id: 'p1', type: 'race', name: 'Night Shift', track: 'copperline', laps: 6, rivals: 7 },
      { id: 'p2', type: 'duel', name: 'Prototype Duel', track: 'harbor', laps: 4 },
      { id: 'p3', type: 'race', name: 'Endurance Final', track: 'gen:5151', laps: 8, rivals: 7 },
    ],
  },
  {
    id: 'gp', name: 'Grand Prix', blurb: 'Open-wheel single-seaters. The top of the ladder.', cls: ['formula'], unlockStars: 34, difficulty: 'hard',
    events: [
      { id: 'f1', type: 'trial', name: 'Qualifying Lap', track: 'pinewood', laps: 3 },
      { id: 'f2', type: 'race', name: 'Grand Prix I', track: 'harbor', laps: 5, rivals: 7 },
      { id: 'f3', type: 'race', name: 'Grand Prix II', track: 'ridgeback', laps: 5, rivals: 7 },
      { id: 'f4', type: 'race', name: 'World Final', track: 'gen:7777', laps: 6, rivals: 7 },
    ],
  },
];

export const EVENT_TYPES = {
  race: { name: 'Race', desc: 'Grid start. Finish on the podium for stars.' },
  trial: { name: 'Time trial', desc: 'Beat the target lap times.' },
  overtake: { name: 'Overtake', desc: 'Start last. Pass as many cars as you can.' },
  duel: { name: 'Duel', desc: 'One rival, faster than you. Beat them.' },
};

const BASE_PAY = [5000, 7000, 10000, 14000, 18000];

export function tierIndexOf(eventId) {
  return TIERS.findIndex((t) => t.events.some((e) => e.id === eventId));
}
export function findEvent(eventId) {
  for (const t of TIERS) for (const e of t.events) if (e.id === eventId) return { tier: t, event: e };
  return null;
}

/** Track definition for an event ('gen:<seed>' = procedurally generated). */
export function eventTrackDef(event, presets) {
  if (event.track.startsWith('gen:')) {
    const seed = +event.track.slice(4);
    const d = randomTrack(seed);
    return { ...d, id: 'career-' + seed };
  }
  return presets.find((p) => p.id === event.track) || presets[0];
}

/** Stars from a result (0..3). */
export function starsFor(event, result) {
  if (event.type === 'trial') {
    if (result.bestLap == null) return 0;
    const [g, s, b] = result.targets;
    return result.bestLap <= g ? 3 : result.bestLap <= s ? 2 : result.bestLap <= b ? 1 : 0;
  }
  if (event.type === 'overtake') {
    const passed = result.gridPos - result.position;
    return result.position <= 1 ? 3 : passed >= 5 ? 2 : passed >= 3 ? 1 : 0;
  }
  if (event.type === 'duel') return result.position === 1 ? 3 : 0;
  return result.position === 1 ? 3 : result.position === 2 ? 2 : result.position === 3 ? 1 : 0;
}

export class Career {
  constructor(store) {
    this.store = store;
    const saved = store.get('career', null);
    this.data = saved || this.fresh();
  }

  fresh() {
    return { credits: 10000, xp: 0, owned: ['hatch'], results: {}, started: Date.now() };
  }

  save() { this.store.set('career', this.data); }
  reset() { this.data = this.fresh(); this.save(); }

  get credits() { return this.data.credits; }
  get level() { return 1 + Math.floor(Math.sqrt(this.data.xp / 400)); }
  get levelProgress() {
    const l = this.level;
    const a = (l - 1) ** 2 * 400, b = l ** 2 * 400;
    return (this.data.xp - a) / (b - a);
  }
  get totalStars() { return Object.values(this.data.results).reduce((s, r) => s + (r.stars || 0), 0); }

  owns(body) { return this.data.owned.includes(body); }
  tierUnlocked(tier) { return this.totalStars >= tier.unlockStars; }
  eventResult(id) { return this.data.results[id] || null; }

  buy(body) {
    const price = CAR_PRICES[body] ?? 0;
    if (this.owns(body)) return { ok: true };
    if (this.data.credits < price) return { ok: false, reason: `Need ${(price - this.data.credits).toLocaleString()} more credits` };
    this.data.credits -= price;
    this.data.owned.push(body);
    this.save();
    return { ok: true };
  }

  /** Apply an event result; returns the rewards earned. */
  record(eventId, result) {
    const found = findEvent(eventId);
    if (!found) return null;
    const { tier, event } = found;
    const ti = TIERS.indexOf(tier);
    const stars = starsFor(event, result);
    const prev = this.data.results[eventId];
    const base = BASE_PAY[ti] || 5000;
    const posPay = event.type === 'trial' ? [0, 0.35, 0.65, 1][stars] : Math.max(0, 1 - (result.position - 1) * 0.15);
    const credits = Math.round((base * posPay + (result.cleanBonus ? base * 0.1 : 0)) / 50) * 50;
    const xp = 100 + stars * 120 + (result.overtakes || 0) * 15;
    const levelBefore = this.level;
    this.data.credits += credits;
    this.data.xp += xp;
    if (!prev || stars > (prev.stars || 0) || (prev.stars === stars && (result.position ?? 99) < (prev.position ?? 99))) {
      this.data.results[eventId] = { stars, position: result.position, bestLap: result.bestLap, at: Date.now() };
    }
    this.save();
    const unlocked = TIERS.filter((t) => this.tierUnlocked(t) && this.totalStars - stars < t.unlockStars).map((t) => t.name);
    return { stars, credits, xp, levelUp: this.level > levelBefore ? this.level : null, unlocked, newBest: !prev || stars > (prev.stars || 0) };
  }

  /** Cars from the event's class that the player owns. */
  eligibleOwned(event) {
    const tier = findEvent(event.id).tier;
    return tier.cls.filter((b) => this.owns(b));
  }
}

export function className(tier) { return tier.cls.map((b) => BODIES[b]?.name).join(' · '); }
