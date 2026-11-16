// Track engineering: corner-by-corner analysis, braking zones, straights,
// overtaking spots and the four headline ratings (Overtaking, Technicality,
// Difficulty, Fun). Pure functions; works on a built track + speed profile.
import { clamp } from '../core/math.js';
import { GAMEPLAY, setGripLevel, makeCarParams } from '../physics/carSetup.js';

/** Analysis always uses a fixed reference: a GT3 car on realistic grip. */
export function referenceParams(setup = { body: 'gt3', compound: 'slick' }) {
  const saved = { ...GAMEPLAY };
  setGripLevel('real');
  const p = makeCarParams(setup);
  Object.assign(GAMEPLAY, saved);
  return p;
}

const KINDS = [
  { max: 16, name: 'Hairpin' },
  { max: 30, name: 'Slow' },
  { max: 45, name: 'Medium' },
  { max: 60, name: 'Fast' },
  { max: Infinity, name: 'Flat-out kink' },
];

export function analyzeTrack(T, line, prof) {
  const N = T.N, DS = T.DS, v = prof.v;
  const wrap = (i) => ((i % N) + N) % N;
  const dist = (a, b) => wrap(b - a) * DS; // forward distance a → b

  // ----- straights: runs of low curvature (on the racing line)
  const straights = [];
  {
    const flat = (i) => Math.abs(T.curv[i]) < 1 / 300;
    let s0 = -1;
    let k0 = 0; while (flat(k0) && k0 < N) k0++; // start inside a corner so runs don't wrap-split
    for (let k = 0; k <= N; k++) {
      const i = wrap(k0 + k);
      if (flat(i) && k < N) { if (s0 < 0) s0 = i; }
      else if (s0 >= 0) { const len = dist(s0, i); if (len >= 120) straights.push({ start: s0, end: i, len }); s0 = -1; }
    }
    straights.sort((a, b) => b.len - a.len);
  }
  const straightBefore = (i) => {
    // length of full-throttle-ish track before index i
    let k = 0;
    while (k < N / 2 && Math.abs(T.curv[wrap(i - k - 25)]) < 1 / 260) k++;
    return k * DS;
  };

  // ----- corners
  const corners = T.corners.map((c, n) => {
    // minimum speed around the apex
    let mi = c.apex, vmin = Infinity;
    for (let k = -30; k <= 30; k++) { const i = wrap(c.apex + k); if (v[i] < vmin) { vmin = v[i]; mi = i; } }
    // braking zone: walk back while speed keeps rising
    let b = mi, guard = 0;
    while (v[wrap(b - 1)] >= v[b] - 0.01 && guard++ < 400) b = wrap(b - 1);
    const vEntry = v[b];
    let be = b; guard = 0;
    while (v[be] > vmin + 0.4 && guard++ < 400) be = wrap(be + 1);
    const brakeDist = vEntry - vmin > 1.5 ? dist(b, be) : 0;
    // exit: walk forward until speed stops rising or next brake point
    let e = mi; guard = 0;
    while (v[wrap(e + 1)] > v[e] - 0.01 && guard++ < 400) { e = wrap(e + 1); if (Math.abs(T.curv[e]) < 1 / 400 && dist(mi, e) > 150) break; }
    // turning angle
    let ang = 0;
    for (let i = c.start; i !== c.end; i = wrap(i + 1)) ang += T.curv[i] * DS;
    const angleDeg = Math.abs((ang * 180) / Math.PI);
    const kmh = vmin * 3.6;
    const kind = (KINDS.find((k) => vmin < k.max) || KINDS[KINDS.length - 1]).name;
    const drop = Math.max(0, vEntry - vmin);
    const sb = straightBefore(b);
    // passing potential: big stop after a long straight on a wide road
    const pass = clamp(
      (drop / 45) * 0.45 + clamp(sb / 700, 0, 1) * 0.35 + clamp((T.width - 9) / 9, 0, 1) * 0.12 + clamp(brakeDist / 160, 0, 1) * 0.08,
      0, 1,
    );
    // elevation at the corner (crest/compression feel)
    const dy = T.py[wrap(c.apex + 15)] - T.py[wrap(c.apex - 15)];
    return {
      n: n + 1, start: c.start, apex: c.apex, end: c.end, minI: mi, brakeI: b, exitI: e,
      dir: c.dir > 0 ? 'L' : 'R', radius: c.radius, angleDeg, kind,
      vEntry, vMin: vmin, kmh, brakeDist, straightBefore: sb, pass, dy,
    };
  });

  // ----- elevation, grade
  let maxGrade = 0;
  for (let i = 0; i < N; i++) maxGrade = Math.max(maxGrade, Math.abs(T.grade[i]));
  const elevRange = T.bounds.maxY - T.bounds.minY;
  let maxBank = 0;
  for (let i = 0; i < N; i++) maxBank = Math.max(maxBank, Math.abs(T.bank[i]));

  // ----- ratings (0–10)
  const km = T.length / 1000;
  const nC = corners.length || 1;
  const sortedPass = corners.map((c) => c.pass).sort((a, b) => b - a);
  const top = sortedPass.slice(0, 3);
  const goodZones = corners.filter((c) => c.pass > 0.35).length;
  const avgTop = top.reduce((a, b) => a + b, 0) / Math.max(top.length, 1);
  const overtaking = clamp((top[0] || 0) * 5 + avgTop * 4 + Math.min(goodZones, 4) * 0.55, 0, 10);

  const kindSet = new Set(corners.map((c) => c.kind));
  let changes = 0; // direction changes between consecutive corners close together (chicanes / esses)
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k], b = corners[(k + 1) % corners.length];
    if (a && b && a !== b && a.dir !== b.dir && dist(a.end, b.start) < 80) changes++;
  }
  const density = corners.length / Math.max(km, 0.3);
  const technicality = clamp(density * 0.9 + kindSet.size * 0.9 + changes * 0.5 + clamp(elevRange / 25, 0, 1.5), 0, 10);

  const vAvg = v.reduce((a, b) => a + b, 0) / N;
  const fastCorners = corners.filter((c) => c.vMin > 40).length;
  const narrow = clamp((14 - T.width) / 5, 0, 1);
  const blind = clamp(maxGrade / 0.09, 0, 1);
  const hard = corners.filter((c) => c.brakeDist > 110 || c.vMin > 45).length;
  const difficulty = clamp(2 + hard * 0.55 + narrow * 2 + blind * 1.4 + changes * 0.35 + clamp(vAvg / 60, 0, 1) * 1.2, 0, 10);

  const lenScore = 1 - clamp(Math.abs(km - 3.8) / 3, 0, 1);
  const hairpins = corners.filter((c) => c.kind === 'Hairpin').length;
  const fun = clamp(
    2 + fastCorners * 0.55 + clamp(elevRange / 20, 0, 1.6) + lenScore * 1.6 + kindSet.size * 0.45 + Math.min(goodZones, 3) * 0.45 - Math.max(0, hairpins - 3) * 0.6 - (T.crossings.length ? 0 : 0) + (maxBank > 0.08 ? 0.5 : 0),
    0, 10,
  );
  const overall = (overtaking + technicality + difficulty * 0.6 + fun * 1.4) / 4;

  return {
    corners, straights, km, elevRange, maxGrade, maxBank, vAvg, vMax: Math.max(...v),
    lapTime: prof.lapTime,
    ratings: { overtaking, technicality, difficulty, fun, overall: clamp(overall, 0, 10) },
    grade: overall >= 8 ? 'S' : overall >= 6.8 ? 'A' : overall >= 5.6 ? 'B' : overall >= 4.4 ? 'C' : 'D',
  };
}

/** Cheap metrics for generator search (no racing line). */
export function quickMetrics(T) {
  const hairpins = T.corners.filter((c) => c.radius < 28).length;
  const fast = T.corners.filter((c) => c.radius > 110).length;
  let longest = 0, run = 0;
  for (let k = 0; k < T.N * 2; k++) { if (Math.abs(T.curv[k % T.N]) < 1 / 300) run++; else run = 0; longest = Math.max(longest, Math.min(run, T.N)); }
  return { km: T.length / 1000, corners: T.corners.length, hairpins, fast, longest: longest * T.DS };
}
