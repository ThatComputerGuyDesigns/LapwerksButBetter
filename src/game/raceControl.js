// Race Control: you are the race director / stewards. This module detects
// incidents, runs flags and neutralisations (local yellows, VSC, Safety Car,
// red flag), applies penalties and scores your decisions against what the
// simulation knows really happened.
import { Vehicle, ASSIST_PRESETS } from '../physics/vehicle.js';
import { AIDriver } from '../physics/driver.js';
import { makeCarParams } from '../physics/carSetup.js';
import { speedProfile } from '../track/racingLine.js';
import { clamp } from '../core/math.js';

export const DECISIONS = [
  { id: 'nfa', label: 'No further action', sev: 0 },
  { id: 'warn', label: 'Warning', sev: 1 },
  { id: 'p5', label: '5 s penalty', sev: 2, time: 5 },
  { id: 'p10', label: '10 s penalty', sev: 3, time: 10 },
  { id: 'dt', label: 'Drive-through', sev: 4, time: 22 },
  { id: 'dsq', label: 'Disqualify', sev: 6 },
];

export const FLAGS = {
  green: { label: 'GREEN', color: '#2fd06b' },
  yellow: { label: 'YELLOW', color: '#ffd23f' },
  vsc: { label: 'VSC', color: '#ffb020' },
  sc: { label: 'SAFETY CAR', color: '#ffb020' },
  red: { label: 'RED FLAG', color: '#ff3b30' },
};

let nextId = 1;

export class RaceControl {
  constructor(field) {
    this.F = field;
    this.T = field.T;
    this.flag = 'green';
    this.yellowSectors = new Set();
    this.incidents = [];
    this.log = [];
    this.score = { decisions: 0, correct: 0, points: 0, safety: 100, exposure: 0 };
    this.sc = null; // safety car entry
    this.scEnding = false;
    this.time = 0;
    for (const r of field.cars) { r.penalty = 0; r.warnings = 0; r.limits = 0; r.dsq = false; r.offT = 0; r.stoppedT = 0; r.spinning = false; }
  }

  // ------------------------------------------------------------------ helpers
  lapOf(r) { return Math.max(1, r.lapsDone + (r.started ? 1 : 0)); }
  sectorOf(s) { return Math.min(2, Math.floor((s / this.T.length) * 3)); }

  addIncident(inc) {
    // merge repeats (same type + same cars within 4 s)
    const key = inc.type + ':' + inc.cars.map((c) => c.name).sort().join('|');
    const prev = this.incidents.find((i) => i.key === key && this.time - i.time < 8 && i.status === 'open');
    if (prev) { prev.severity = Math.max(prev.severity, inc.severity); prev.speed = Math.max(prev.speed || 0, inc.speed || 0); return prev; }
    const full = { id: nextId++, key, time: this.time, status: 'open', ...inc };
    full.expected = this.expectedDecision(full);
    this.incidents.unshift(full);
    this.F.onIncident?.(full);
    return full;
  }

  /** What a consistent steward would do (hidden ground truth used for scoring). */
  expectedDecision(i) {
    if (i.type === 'contact') {
      if (!i.fault) return 'nfa'; // racing incident
      if (i.severity >= 3) return i.consequence ? 'dt' : 'p10';
      if (i.severity >= 2) return 'p5';
      return 'warn';
    }
    if (i.type === 'limits') return i.count >= 5 ? 'p5' : 'warn';
    return null; // informational (spin / stopped car) → handled by flags
  }

  // ------------------------------------------------------------------ detection
  onContact(A, B, closing, aFront, bRear, pa, pb) {
    if (closing < 4.5) return; // rubbing / light taps are close racing, not a case
    const ra = this.F.entryOf(A), rb = this.F.entryOf(B);
    if (!ra || !rb) return;
    // fault: the car whose nose hit the other's rear (rear-ender), or the one
    // moving sideways into the other
    let fault = null;
    if (aFront && bRear) fault = ra; else if (!aFront && !bRear && pa && pb) fault = null;
    if (!fault) {
      const la = Math.abs(A.v), lb = Math.abs(B.v);
      if (Math.abs(la - lb) > 1.2) fault = la > lb ? ra : rb;
    }
    if (!fault && bRear === false && aFront === false) fault = null;
    const severity = closing > 9 ? 3 : closing > 6.5 ? 2 : 1;
    const victim = fault === ra ? rb : fault === rb ? ra : null;
    const inc = this.addIncident({
      type: 'contact', title: 'Contact', cars: [ra, rb], fault, victim, severity, speed: closing,
      lap: this.lapOf(ra), s: A.q.s, sector: this.sectorOf(A.q.s),
    });
    // consequence check a few seconds later (did the victim spin / lose places?)
    if (victim && !inc.checkAt) {
      inc.posBefore = this.F.positionOf(victim);
      inc.checkAt = this.time + 5; // consequence check in sim time
    }
  }

  update(dt) {
    this.time += dt;
    for (const inc of this.incidents) {
      if (inc.checkAt && this.time >= inc.checkAt) {
        inc.checkAt = null;
        const v = inc.victim;
        if (v && (v.spinning || v.stoppedT > 0 || this.F.positionOf(v) - inc.posBefore >= 2)) { inc.consequence = true; inc.expected = this.expectedDecision(inc); }
      }
    }
    const T = this.T;
    let danger = 0;
    for (const r of this.F.cars) {
      if (r.dsq) continue;
      const c = r.car;
      const ad = Math.abs(c.q.d);
      // track limits (all four wheels past the kerb, at speed)
      const off = ad > T.half + 1.7 && c.u > 12;
      if (off && r.offT === 0) {
        r.limits++;
        if (r.limits === 3 || r.limits === 5 || (r.limits > 5 && (r.limits - 5) % 3 === 0)) this.addIncident({ type: 'limits', title: 'Track limits', cars: [r], count: r.limits, severity: 1, lap: this.lapOf(r), s: c.q.s, sector: this.sectorOf(c.q.s) });
      }
      r.offT = off ? r.offT + dt : 0;
      // spins
      const beta = Math.abs(Math.atan2(c.v, Math.max(Math.abs(c.u), 1)));
      const spin = beta > 0.75 && c.speed > 6;
      if (spin && !r.spinning) this.addIncident({ type: 'spin', title: 'Spin', cars: [r], severity: 1, lap: this.lapOf(r), s: c.q.s, sector: this.sectorOf(c.q.s) });
      r.spinning = spin;
      // stopped cars (not on the grid / under red)
      const racing = r.started || this.time > 6;
      const stopped = racing && c.speed < 3 && this.flag !== 'red' && r.finished == null;
      r.stoppedT = stopped ? r.stoppedT + dt : 0;
      if (r.stoppedT > 2.5 && !r.stopInc) {
        r.stopInc = this.addIncident({ type: 'stopped', title: ad < T.half + 2 ? 'Car stopped ON TRACK' : 'Car stopped off track', cars: [r], onTrack: ad < T.half + 2, severity: ad < T.half + 2 ? 3 : 1, lap: this.lapOf(r), s: c.q.s, sector: this.sectorOf(c.q.s) });
      }
      if (r.stoppedT === 0 && r.stopInc) { r.stopInc.status = r.stopInc.status === 'open' ? 'cleared' : r.stopInc.status; r.stopInc = null; }
      // marshals recover a car stuck for long (faster under yellow / SC)
      const recoverAfter = this.flag === 'green' ? 14 : 7;
      if (r.stoppedT > recoverAfter) { c.recover(); r.stoppedT = 0; this.say(`Marshals have recovered #${r.setup.number} ${r.name}`); }
      if (r.stopInc) {
        const sector = this.sectorOf(c.q.s);
        const covered = r.stopInc.onTrack ? ['sc', 'vsc', 'red'].includes(this.flag) : this.flag !== 'green' || this.yellowSectors.has(sector);
        if (!covered) danger += r.stopInc.onTrack ? 3 : 1;
      }
    }
    // safety score: uncovered danger costs points over time
    if (danger) { this.score.exposure += dt * danger; this.score.safety = Math.max(0, 100 - this.score.exposure * 2.5); }
    // safety car
    if (this.sc) this.updateSafetyCar(dt);
  }

  // ------------------------------------------------------------------ flags
  setFlag(f, sector) {
    if (f === 'yellow') {
      if (this.yellowSectors.has(sector)) this.yellowSectors.delete(sector); else this.yellowSectors.add(sector);
      this.say(this.yellowSectors.has(sector) ? `Yellow flag, sector ${sector + 1}` : `Sector ${sector + 1} clear`);
      return;
    }
    if (f === 'sc') { if (!this.sc) this.deploySafetyCar(); return; }
    if (f === 'green') {
      if (this.sc) { this.scEnding = true; this.say('Safety car in this lap'); return; }
      this.flag = 'green'; this.yellowSectors.clear(); this.say('Green flag — racing resumes'); return;
    }
    this.flag = f;
    this.say(f === 'vsc' ? 'Virtual Safety Car deployed' : f === 'red' ? 'RED FLAG — session suspended' : f);
  }

  say(text) { this.log.unshift({ t: this.time, text }); if (this.log.length > 60) this.log.pop(); this.F.onMessage?.(text); }

  deploySafetyCar() {
    const F = this.F;
    const leader = F.order()[0];
    const params = makeCarParams({ body: 'gt', compound: 'sport', paint: '#f2f2f2' });
    const car = new Vehicle(params, this.T);
    car.assists = { ...ASSIST_PRESETS.casual, autoShift: true };
    const s = (leader.car.q.s + 140) % this.T.length;
    car.reset(s, this.F.s.line.offset[Math.floor(s / this.T.DS) % this.T.N]);
    car.u = Math.max(20, leader.car.u * 0.8);
    for (const w of car.wheels) w.omega = car.u / params.wheelR;
    const prof = speedProfile(this.T, F.s.line, params);
    this.sc = { car, ai: new AIDriver(this.T, F.s.line, prof, { pace: 0.6 }), setup: { body: 'gt', paint: '#f2f2f2', accent: '#ffb020', number: 0, livery: 'band' }, prev: { x: car.x, z: car.z, h: car.heading }, lastS: car.q.s };
    F.onSafetyCar?.(this.sc, true);
    this.flag = 'sc';
    this.scEnding = false;
    this.say('SAFETY CAR deployed — no overtaking');
  }

  updateSafetyCar(dt) {
    const sc = this.sc;
    sc.prev.x = sc.car.x; sc.prev.z = sc.car.z; sc.prev.h = sc.car.heading;
    sc.ai.pace = this.scEnding ? 0.7 : 0.6;
    sc.car.step(dt, sc.ai.control(sc.car));
    const s = sc.car.q.s;
    // pull in when crossing the line after "in this lap"
    if (this.scEnding && sc.lastS > this.T.length * 0.8 && s < this.T.length * 0.2) {
      this.F.onSafetyCar?.(sc, false);
      this.sc = null;
      this.flag = 'green';
      this.yellowSectors.clear();
      this.say('GREEN FLAG — the safety car is in, racing resumes');
      return;
    }
    sc.lastS = s;
  }

  /** Per-car neutralisation applied by the field each step. */
  modifyAI(r, ctx) {
    const f = this.flag;
    if (f === 'red') { r.ai.speedCap = 0; r.ai.offset = 0; ctx.noPass = true; return; }
    if (f === 'vsc') { r.ai.pace *= 0.62; ctx.noPass = true; }
    if (this.yellowSectors.has(this.sectorOf(r.car.q.s))) { r.ai.pace *= 0.86; ctx.noPass = true; }
    if (f === 'sc') {
      ctx.noPass = true;
      // queue up behind the car ahead in the running order (SC for the leader)
      const order = this.F.order().filter((x) => !x.dsq);
      const k = order.indexOf(r);
      const ahead = k === 0 ? this.sc : order[k - 1];
      if (ahead) {
        let gap = ahead.car.q.s - r.car.q.s;
        if (gap < 0) gap += this.T.length;
        if (gap > this.T.length / 2) gap = 0; // lapped / odd wrap: just follow
        const target = 14;
        r.ai.speedCap = Math.max(0, ahead.car.u + clamp((gap - target) * 0.6, -15, 25));
      }
    }
  }

  // ------------------------------------------------------------------ decisions
  decide(incId, decisionId, target) {
    const inc = this.incidents.find((i) => i.id === incId);
    if (!inc || inc.status === 'decided') return null;
    const d = DECISIONS.find((x) => x.id === decisionId);
    const who = target || inc.fault || inc.cars[0];
    inc.status = 'decided';
    inc.decision = decisionId;
    inc.penalised = decisionId === 'nfa' ? null : who;
    if (decisionId === 'warn') who.warnings++;
    if (d.time) who.penalty += d.time;
    if (decisionId === 'dsq') who.dsq = true;
    // scoring vs the hidden ground truth
    let pts = 0, verdict = 'consistent';
    if (inc.expected) {
      const want = DECISIONS.find((x) => x.id === inc.expected).sev;
      const diff = Math.abs(d.sev - want);
      const rightCar = decisionId === 'nfa' || !inc.fault || who === inc.fault;
      pts = !rightCar ? -60 : diff === 0 ? 100 : diff === 1 ? 50 : diff === 2 ? 0 : -50;
      verdict = !rightCar ? 'wrong driver penalised' : diff === 0 ? 'spot on' : diff === 1 ? 'reasonable' : d.sev > want ? 'too harsh' : 'too lenient';
      this.score.decisions++;
      if (diff <= 1 && rightCar) this.score.correct++;
      this.score.points += pts;
    }
    inc.verdict = verdict;
    inc.points = pts;
    const label = d.label + (who && decisionId !== 'nfa' ? ` — #${who.setup.number} ${who.name}` : '');
    this.say(`Decision (incident ${inc.id}): ${label}`);
    return { verdict, pts };
  }

  /** End-of-race report. */
  report() {
    const open = this.incidents.filter((i) => i.status === 'open' && i.expected);
    const s = this.score;
    const decisionScore = s.decisions ? s.points / s.decisions : 0;
    const total = Math.round(Math.max(0, 50 + decisionScore * 0.4 - open.length * 6) + s.safety * 0.5);
    const grade = total >= 90 ? 'S' : total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 50 ? 'C' : 'D';
    return { total, grade, open: open.length, ...s };
  }
}
