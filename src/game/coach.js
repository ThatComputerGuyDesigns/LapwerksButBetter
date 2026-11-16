// Coach: lap telemetry analysis for in-game laps and real-world GPS sessions.
// Pure functions (testable in Node): parsing, lap splitting, distance-aligned
// comparison, corner detection, gains/losses and written insights.
import { clamp } from '../core/math.js';

/** In-game telemetry rows → lap channels. Row: [s,t,kmh,thr,brk,steer,gear,rpm,latG,lonG,x,z] */
export function lapFromGame(lap) {
  const R = lap.tele || [];
  const ch = { t: [], v: [], thr: [], brk: [], steer: [], gear: [], rpm: [], lat: [], lon: [], x: [], z: [] };
  for (const r of R) {
    ch.t.push(r[1]); ch.v.push(r[2]); ch.thr.push(r[3]); ch.brk.push(r[4]); ch.steer.push(r[5]); ch.gear.push(r[6]); ch.rpm.push(r[7]);
    ch.lat.push(r[8]); ch.lon.push(r[9]); ch.x.push(r[10]); ch.z.push(r[11]);
  }
  return finishLap({ ...ch, time: lap.time, valid: lap.valid, n: lap.n, source: 'game', inputs: true });
}

function finishLap(L) {
  // cumulative distance from positions (robust for both sources)
  const d = [0];
  for (let i = 1; i < L.x.length; i++) d.push(d[i - 1] + Math.hypot(L.x[i] - L.x[i - 1], L.z[i] - L.z[i - 1]));
  L.d = d;
  L.length = d[d.length - 1] || 0;
  return L;
}

// ---------------------------------------------------------------- GPS sessions
const parseTime = (s) => { const v = Date.parse(s); return Number.isFinite(v) ? v / 1000 : NaN; };

/** GPX / CSV with timestamps → [{t, lat, lon, ele, kmh}] (kmh may be NaN). */
export function parseSession(text) {
  const pts = [];
  if (/<gpx|<trkpt/i.test(text)) {
    const re = /<trkpt([^>]*)>([\s\S]*?)<\/trkpt>/gi;
    let m;
    while ((m = re.exec(text))) {
      const attrs = m[1], body = m[2];
      const lat = +(attrs.match(/lat=["']([-\d.]+)/) || [])[1], lon = +(attrs.match(/lon=["']([-\d.]+)/) || [])[1];
      const time = parseTime((body.match(/<time>([^<]+)<\/time>/i) || [])[1]);
      const ele = +((body.match(/<ele>([-\d.]+)<\/ele>/i) || [])[1] ?? NaN);
      const spd = +((body.match(/<(?:\w+:)?speed>([-\d.]+)<\/(?:\w+:)?speed>/i) || [])[1] ?? NaN);
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ t: time, lat, lon, ele, kmh: Number.isFinite(spd) ? spd * 3.6 : NaN });
    }
  } else {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const head = lines[0].toLowerCase().split(/[,;\t]/).map((h) => h.trim().replace(/"/g, ''));
    const col = (re) => head.findIndex((h) => re.test(h));
    const ci = { t: col(/^(time|timestamp|utc|date)/), lat: col(/^lat/), lon: col(/^(lon|lng|long)/), ele: col(/^(ele|alt)/), spd: col(/speed|kmh|km\/h|mph/) };
    const mph = ci.spd >= 0 && /mph/.test(head[ci.spd]);
    const ms = ci.spd >= 0 && /m\/s|mps/.test(head[ci.spd]);
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(/[,;\t]/).map((v) => v.trim().replace(/"/g, ''));
      const lat = parseFloat(c[ci.lat]), lon = parseFloat(c[ci.lon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      let t = ci.t >= 0 ? (/^[\d.]+$/.test(c[ci.t]) ? parseFloat(c[ci.t]) : parseTime(c[ci.t])) : NaN;
      if (t > 1e11) t /= 1000; // epoch ms
      let kmh = ci.spd >= 0 ? parseFloat(c[ci.spd]) : NaN;
      if (mph) kmh *= 1.609; else if (ms) kmh *= 3.6;
      pts.push({ t, lat, lon, ele: ci.ele >= 0 ? parseFloat(c[ci.ele]) : NaN, kmh });
    }
  }
  if (pts.length && !pts.some((p) => Number.isFinite(p.t))) throw new Error('The file has no timestamps — Coach needs time to measure laps.');
  return pts.filter((p) => Number.isFinite(p.t));
}

/** Project and split a GPS session into laps at a start/finish gate. */
export function lapsFromSession(pts, { gateIndex = 0, minLap = 300 } = {}) {
  if (pts.length < 30) throw new Error('Not enough GPS points in that file.');
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon0 = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110540;
  const P = pts.map((p) => ({ x: (p.lon - lon0) * kx, z: -(p.lat - lat0) * kz, t: p.t, ele: p.ele, kmh: p.kmh }));
  // gate: perpendicular to the direction of travel at the chosen point
  let g = Math.min(gateIndex, P.length - 3);
  let j = g + 1;
  while (j < P.length - 1 && Math.hypot(P[j].x - P[g].x, P[j].z - P[g].z) < 8) j++;
  const hx = P[j].x - P[g].x, hz = P[j].z - P[g].z, hl = Math.hypot(hx, hz) || 1;
  const dir = [hx / hl, hz / hl], gate = [P[g].x, P[g].z];
  const side = (p) => (p.x - gate[0]) * dir[0] + (p.z - gate[1]) * dir[1];
  // the gate point itself opens the first lap
  const crossings = [{ i: g, f: 0, t: P[g].t }];
  let travelled = 0;
  for (let i = g + 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    travelled += Math.hypot(b.x - a.x, b.z - a.z);
    const sa = side(a), sb = side(b);
    if (sa < 0 && sb >= 0 && travelled >= minLap) {
      const f = sa / (sa - sb);
      const cx = a.x + (b.x - a.x) * f, cz = a.z + (b.z - a.z) * f;
      const lateral = Math.abs((cx - gate[0]) * -dir[1] + (cz - gate[1]) * dir[0]);
      if (lateral < 25) { crossings.push({ i, f, t: a.t + (b.t - a.t) * f }); travelled = 0; }
    }
  }
  const laps = [];
  for (let k = 0; k + 1 < crossings.length; k++) {
    const c0 = crossings[k], c1 = crossings[k + 1];
    const seg = P.slice(c0.i, c1.i + 1);
    const L = { t: [], v: [], x: [], z: [], ele: [] };
    for (const p of seg) { L.t.push(p.t - c0.t); L.x.push(p.x); L.z.push(p.z); L.ele.push(p.ele); }
    finishLap(L);
    // speed: from the logger if present, else from positions (smoothed)
    const v = seg.map((p, i) => {
      if (Number.isFinite(p.kmh)) return p.kmh;
      const a = seg[Math.max(0, i - 1)], b = seg[Math.min(seg.length - 1, i + 1)];
      return (Math.hypot(b.x - a.x, b.z - a.z) / Math.max(b.t - a.t, 1e-3)) * 3.6;
    });
    L.v = smooth(v, 2);
    L.time = c1.t - c0.t;
    L.n = k + 1;
    L.valid = true;
    L.source = 'gps';
    L.inputs = false;
    laps.push(L);
  }
  if (!laps.length) throw new Error('No complete laps found. Make sure the file covers at least one full lap past the start line.');
  // discard out-laps / in-laps far slower than the median
  const med = laps.map((l) => l.time).sort((a, b) => a - b)[Math.floor(laps.length / 2)];
  for (const l of laps) if (l.time > med * 1.35) l.valid = false;
  return laps;
}

function smooth(a, r) {
  return a.map((_, i) => { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const v = a[i + k]; if (v != null && Number.isFinite(v)) { s += v; n++; } } return n ? s / n : a[i]; });
}

// ---------------------------------------------------------------- analysis
/** Sample a lap channel at fractional distance positions (0..1 of its own length). */
function sampler(L, key) {
  const d = L.d, a = L[key];
  return (frac) => {
    const target = frac * L.length;
    let lo = 0, hi = d.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (d[mid] <= target) lo = mid; else hi = mid; }
    const span = d[hi] - d[lo] || 1;
    const f = clamp((target - d[lo]) / span, 0, 1);
    return a[lo] + (a[hi] - a[lo]) * f;
  };
}

/** Compare lap B against reference lap A on a common distance grid. */
export function compareLaps(A, B, { step = 2 } = {}) {
  const N = Math.max(50, Math.floor(A.length / step));
  const at = (L, key) => sampler(L, key);
  const tA = at(A, 't'), tB = at(B, 't'), vA = at(A, 'v'), vB = at(B, 'v');
  const xA = at(A, 'x'), zA = at(A, 'z');
  const G = { d: [], delta: [], vA: [], vB: [], x: [], z: [] };
  const extra = A.inputs && B.inputs ? ['thr', 'brk', 'steer', 'gear'] : [];
  for (const k of extra) { G[k + 'A'] = []; G[k + 'B'] = []; }
  const ex = extra.map((k) => [k, at(A, k), at(B, k)]);
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    G.d.push(f * A.length);
    G.delta.push(tB(f) - tA(f));
    G.vA.push(vA(f)); G.vB.push(vB(f));
    G.x.push(xA(f)); G.z.push(zA(f));
    for (const [k, a, b] of ex) { G[k + 'A'].push(a(f)); G[k + 'B'].push(b(f)); }
  }
  G.N = N;
  G.corners = findCorners(G);
  for (const c of G.corners) {
    c.delta = G.delta[c.exit] - G.delta[c.entry];
    let mA = Infinity, mB = Infinity;
    for (let i = c.entry; i <= c.exit; i++) { mA = Math.min(mA, G.vA[i]); mB = Math.min(mB, G.vB[i]); }
    c.minA = mA; c.minB = mB;
    c.brakeA = brakePoint(G.vA, c); c.brakeB = brakePoint(G.vB, c);
  }
  // sectors in thirds of distance
  G.sectors = [0, 1, 2].map((k) => {
    const i0 = Math.floor((k / 3) * N), i1 = Math.floor(((k + 1) / 3) * N);
    return G.delta[i1] - G.delta[i0];
  });
  G.insights = insights(G, A, B);
  return G;
}

/** Corners from the reference path curvature. */
function findCorners(G) {
  const N = G.N, out = [];
  const head = [];
  for (let i = 0; i <= N; i++) {
    const a = Math.max(0, i - 3), b = Math.min(N, i + 3);
    head.push(Math.atan2(G.z[b] - G.z[a], G.x[b] - G.x[a]));
  }
  const ds = (G.d[N] - G.d[0]) / N;
  const curv = head.map((h, i) => {
    if (i < 4 || i > N - 4) return 0;
    let dh = head[i + 3] - head[i - 3];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return dh / (6 * ds);
  });
  let inC = false, s0 = 0, peak = 0, apex = 0;
  for (let i = 0; i <= N; i++) {
    const c = Math.abs(curv[i]);
    if (!inC && c > 1 / 120) { inC = true; s0 = i; peak = c; apex = i; }
    else if (inC) {
      if (c > peak) { peak = c; apex = i; }
      if (c < 1 / 220) {
        inC = false;
        if ((i - s0) * ds > 12) out.push({ n: out.length + 1, apex, entry: Math.max(0, s0 - Math.round(70 / ds)), exit: Math.min(N, i + Math.round(40 / ds)), radius: 1 / peak, dir: curv[apex] > 0 ? 'L' : 'R' });
      }
    }
  }
  return out;
}

function brakePoint(v, c) {
  // walk back from the slowest point while the speed keeps rising
  let mi = c.apex, m = Infinity;
  for (let i = c.entry; i <= c.exit; i++) if (v[i] < m) { m = v[i]; mi = i; }
  let b = mi;
  while (b > 0 && v[b - 1] > v[b] + 0.05) b--;
  return b;
}

function insights(G, A, B) {
  const out = [];
  const total = G.delta[G.N];
  const ds = G.d[G.N] / G.N;
  const name = (c) => `Turn ${c.n}`;
  const losses = G.corners.filter((c) => c.delta > 0.05).sort((a, b) => b.delta - a.delta);
  const gains = G.corners.filter((c) => c.delta < -0.05).sort((a, b) => a.delta - b.delta);
  if (Math.abs(total) < 0.01) out.push('These two laps are virtually identical.');
  else out.push(`Lap ${B.n} is ${Math.abs(total).toFixed(2)} s ${total > 0 ? 'slower' : 'faster'} than lap ${A.n}.`);
  for (const c of losses.slice(0, 3)) {
    const why = [];
    const brakeDiff = (c.brakeA - c.brakeB) * ds; // + = B braked earlier
    if (brakeDiff > 6) why.push(`braked ${Math.round(brakeDiff)} m earlier`);
    if (c.minB < c.minA - 2) why.push(`${Math.round(c.minA - c.minB)} km/h less minimum speed`);
    const exitA = G.vA[c.exit], exitB = G.vB[c.exit];
    if (exitB < exitA - 3) why.push(`${Math.round(exitA - exitB)} km/h slower on exit`);
    out.push(`${name(c)}: lost ${c.delta.toFixed(2)} s${why.length ? ` — ${why.join(', ')}` : ''}.`);
  }
  if (gains.length) out.push(`Best gain: ${name(gains[0])} (${(-gains[0].delta).toFixed(2)} s quicker).`);
  // straight-line speed
  const vmaxA = Math.max(...G.vA), vmaxB = Math.max(...G.vB);
  if (Math.abs(vmaxA - vmaxB) > 4) out.push(`Top speed ${Math.round(vmaxB)} vs ${Math.round(vmaxA)} km/h — ${vmaxB < vmaxA ? 'carry more speed onto the straights' : 'better drive onto the straights'}.`);
  // pedal overlap (in-game laps only)
  if (G.thrB) {
    let coast = 0;
    for (let i = 0; i <= G.N; i++) if (G.thrB[i] < 0.1 && G.brkB[i] < 0.1 && G.vB[i] > 40) coast++;
    const pct = (coast / G.N) * 100;
    if (pct > 8) out.push(`You coasted (no throttle, no brake) for ${pct.toFixed(0)}% of the lap. Commit to one pedal.`);
  }
  return out;
}
