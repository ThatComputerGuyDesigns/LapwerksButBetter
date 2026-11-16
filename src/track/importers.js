// Ways to make a circuit without drawing it: a GPS lap (GPX / CSV), a photo
// of a hand-drawn layout, or a written description.
import { strokeToControlPoints, catmullRomClosed, polylineLength, resamplePolyline } from './spline.js';
import { randomTrack } from './generator.js';
import { buildTrack } from './track.js';
import { quickMetrics } from './analysis.js';
import { ENVIRONMENTS } from './environments.js';
import { clamp, rng } from '../core/math.js';

// ---------------------------------------------------------------- GPS
/** Parse GPX or CSV (lat,lon[,ele]) text into [{lat, lon, ele}]. */
export function parseGPS(text) {
  const out = [];
  if (/<gpx|<trkpt|<rtept/i.test(text)) {
    const re = /<(?:trkpt|rtept)[^>]*?lat=["']([-\d.]+)["'][^>]*?lon=["']([-\d.]+)["'][^>]*?(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/gi;
    let m;
    while ((m = re.exec(text))) {
      const ele = m[3] ? +((m[3].match(/<ele>([-\d.]+)<\/ele>/i) || [])[1] ?? NaN) : NaN;
      out.push({ lat: +m[1], lon: +m[2], ele });
    }
    // some exporters put lon before lat
    if (!out.length) {
      const re2 = /<(?:trkpt|rtept)[^>]*?lon=["']([-\d.]+)["'][^>]*?lat=["']([-\d.]+)["']/gi;
      while ((m = re2.exec(text))) out.push({ lat: +m[2], lon: +m[1], ele: NaN });
    }
    return out;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].toLowerCase().split(/[,;\t]/).map((h) => h.trim());
  let li = head.findIndex((h) => /^lat/.test(h)), lo = head.findIndex((h) => /^(lon|lng|long)/.test(h)), el = head.findIndex((h) => /^(ele|alt)/.test(h));
  let start = 1;
  if (li < 0 || lo < 0) { li = 0; lo = 1; el = 2; start = 0; }
  for (let k = start; k < lines.length; k++) {
    const c = lines[k].split(/[,;\t]/);
    const lat = parseFloat(c[li]), lon = parseFloat(c[lo]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push({ lat, lon, ele: el >= 0 ? parseFloat(c[el]) : NaN });
  }
  return out;
}

/**
 * GPS samples → circuit definition. Finds one lap (first return to the
 * start after 400 m), projects to metres, simplifies to control points and
 * carries elevation over as per-point offsets.
 */
export function circuitFromGPS(samples, name = 'GPS Circuit') {
  if (samples.length < 20) throw new Error('Not enough GPS points in that file.');
  const lat0 = samples.reduce((a, p) => a + p.lat, 0) / samples.length;
  const lon0 = samples.reduce((a, p) => a + p.lon, 0) / samples.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110540;
  const P = samples.map((p) => [(p.lon - lon0) * kx, -(p.lat - lat0) * kz, p.ele]);
  // isolate a single lap
  let travelled = 0, end = P.length - 1;
  for (let i = 1; i < P.length; i++) {
    travelled += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    if (travelled > 400 && Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]) < 25) { end = i; break; }
  }
  const lap = P.slice(0, end + 1);
  const L = polylineLength(lap.map((p) => [p[0], p[1]]));
  if (L < 300) throw new Error('That lap is too short to make a circuit (under 300 m).');
  if (L > 25000) throw new Error('That route is longer than 25 km — trim it to a single lap.');
  const ctrl = strokeToControlPoints(lap.map((p) => [p[0], p[1]]));
  if (!ctrl) throw new Error('Could not make a closed loop from that file.');
  // elevation: nearest GPS sample per control point, relative to the mean
  const hasEle = lap.some((p) => Number.isFinite(p[2]));
  if (hasEle) {
    const eles = lap.map((p) => p[2]).filter(Number.isFinite);
    const mean = eles.reduce((a, b) => a + b, 0) / eles.length;
    for (const c of ctrl) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < lap.length; i++) { const d = (lap[i][0] - c[0]) ** 2 + (lap[i][1] - c[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
      const e = lap[bi][2];
      c[2] = Number.isFinite(e) ? Math.round(clamp(e - mean, -40, 40) * 10) / 10 : 0;
    }
  }
  return { name, width: 12, hills: hasEle ? 0 : 0.2, banking: 0.3, seed: 7, theme: 'midday', env: 'gp', points: ctrl };
}

// ---------------------------------------------------------------- photo
/**
 * Hand-drawn circuit photo → circuit. Thresholds the darkest strokes, then
 * walks the drawn line greedily (nearest unvisited ink, preferring to keep
 * going straight) to recover the loop's order.
 */
export function circuitFromImage(img, { lengthKm = 3.5 } = {}) {
  const S = 220;
  const sc = S / Math.max(img.width, img.height);
  const W = Math.max(8, Math.round(img.width * sc)), H = Math.max(8, Math.round(img.height * sc));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  let sum = 0;
  for (let i = 0; i < W * H; i++) { lum[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]; sum += lum[i]; }
  const mean = sum / (W * H);
  let v = 0;
  for (let i = 0; i < W * H; i++) v += (lum[i] - mean) ** 2;
  const sd = Math.sqrt(v / (W * H));
  const thr = mean - Math.max(sd * 1.1, 18);
  // ink cells on a coarse grid
  const C = 3, gw = Math.ceil(W / C), gh = Math.ceil(H / C);
  const ink = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let dark = 0;
    for (let yy = 0; yy < C; yy++) for (let xx = 0; xx < C; xx++) {
      const px = x * C + xx, py = y * C + yy;
      if (px < W && py < H && lum[py * W + px] < thr) dark++;
    }
    // ignore the outer border (photo edges, paper shadows)
    if (dark >= 2 && x > 1 && y > 1 && x < gw - 2 && y < gh - 2) ink.push([x, y]);
  }
  if (ink.length < 30) throw new Error('Could not find a drawn line. Use a dark pen on light paper and fill the frame.');
  if (ink.length > gw * gh * 0.35) throw new Error('The photo is too dark or busy. Try a clean, well-lit photo of just the drawing.');
  // walk the line
  const left = new Set(ink.map((p, i) => i));
  const key = new Map(ink.map((p, i) => [p[0] + ',' + p[1], i]));
  let cur = 0, dir = null;
  const path = [ink[0]];
  left.delete(0);
  for (let guard = 0; guard < ink.length; guard++) {
    const [cx, cy] = ink[cur];
    let best = -1, bs = Infinity;
    for (let r = 1; r <= 5 && best < 0; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const j = key.get(cx + dx + ',' + (cy + dy));
        if (j == null || !left.has(j)) continue;
        const dl = Math.hypot(dx, dy);
        const turn = dir ? 1 - (dx * dir[0] + dy * dir[1]) / dl : 0;
        const score = dl + turn * 1.6;
        if (score < bs) { bs = score; best = j; }
      }
    }
    if (best < 0) break;
    // consume neighbouring ink so a thick line is walked once
    const [bx, by] = ink[best];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = key.get(cx + dx + ',' + (cy + dy)); if (j != null) left.delete(j); }
    left.delete(best);
    const nd = [bx - cx, by - cy], nl = Math.hypot(...nd);
    const nv = [nd[0] / nl, nd[1] / nl];
    dir = dir ? [dir[0] * 0.5 + nv[0] * 0.5, dir[1] * 0.5 + nv[1] * 0.5] : nv;
    const dl = Math.hypot(...dir); dir = [dir[0] / dl, dir[1] / dl];
    path.push(ink[best]);
    cur = best;
  }
  if (path.length < 25) throw new Error('The drawn line has gaps. Draw one continuous loop.');
  const closeGap = Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]);
  if (closeGap > Math.max(gw, gh) * 0.25) throw new Error('Could not follow the loop all the way round. Make sure the line is closed and unbroken.');
  // the walk follows pixel cells, so it is a staircase: resample evenly and
  // smooth hard (closed loop) before it becomes a circuit
  let sm = resamplePolyline(path, 1.5, true);
  for (let pass = 0; pass < 6; pass++) {
    const n = sm.length;
    sm = sm.map((_, i) => {
      let x = 0, y = 0, w = 0;
      for (let k = -3; k <= 3; k++) { const q = sm[(i + k + n) % n], wk = 4 - Math.abs(k); x += q[0] * wk; y += q[1] * wk; w += wk; }
      return [x / w, y / w];
    });
  }
  const Lpx = polylineLength(sm, true);
  const k = (lengthKm * 1000) / Lpx;
  const stroke = sm.map(([x, y]) => [(x - gw / 2) * k, (y - gh / 2) * k]);
  stroke.push(stroke[0].slice());
  const ctrl = strokeToControlPoints(stroke);
  if (!ctrl) throw new Error('Could not make a circuit from that drawing.');
  return { name: 'Sketched Circuit', width: 13, hills: 0.35, banking: 0.3, seed: 21, theme: 'golden', env: 'gp', points: ctrl };
}

// ---------------------------------------------------------------- describe
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1, couple: 2 };

/** Turn plain-language intent into generator targets. */
export function parseDescription(text) {
  const t = ` ${text.toLowerCase()} `;
  const want = { km: null, hairpins: null, fast: null, longest: null, corners: null, env: null, hills: null, banking: null, width: null, theme: null, technical: 0, flowing: 0 };
  const km = t.match(/(\d+(?:\.\d+)?)\s*(km|kilomet)/); if (km) want.km = clamp(+km[1], 1, 9);
  const mi = t.match(/(\d+(?:\.\d+)?)\s*(mi|mile)/); if (mi) want.km = clamp(+mi[1] * 1.609, 1, 9);
  const count = (re) => { const m = t.match(re); if (!m) return null; const n = m[1]; return /\d/.test(n) ? +n : NUM_WORDS[n] ?? 1; };
  const hp = count(/(\d+|one|two|three|four|five|a|an|single|couple of)\s+hairpins?/); if (hp != null) want.hairpins = hp; else if (/hairpin/.test(t)) want.hairpins = 2;
  if (/no hairpins?/.test(t)) want.hairpins = 0;
  const cc = count(/(\d+)\s+(corners|turns)/); if (cc != null) want.corners = cc;
  if (/long straight|drag strip|huge straight|massive straight|top speed|slipstream/.test(t)) want.longest = 900;
  if (/short straight|no straight/.test(t)) want.longest = 250;
  if (/fast|flowing|sweep|high.?speed|quick/.test(t)) { want.fast = 4; want.flowing = 1; }
  if (/technical|tight|twisty|slow|chicane|mickey mouse|kart/.test(t)) { want.technical = 1; want.hairpins = want.hairpins ?? 2; }
  if (/hill|elevation|mountain|crest|climb|rollercoaster|undulat/.test(t)) want.hills = 0.95;
  if (/flat/.test(t)) want.hills = 0.05;
  if (/bank|oval|speedway/.test(t)) want.banking = 0.9;
  if (/narrow/.test(t)) want.width = 10;
  if (/wide/.test(t)) want.width = 16;
  for (const [id, e] of Object.entries(ENVIRONMENTS)) {
    const words = { gp: /grand prix|\bgp\b|formula/, street: /street|city|urban|downtown/, forest: /forest|woods|pine|trees/, desert: /desert|sand|dune|oasis/, rally: /rally|gravel|dirt/, speedway: /speedway|oval/, drift: /drift/, kart: /kart/ }[id];
    if (words && words.test(t)) { want.env = id; break; }
    void e;
  }
  if (/sunset|dusk|evening/.test(t)) want.theme = 'dusk';
  else if (/noon|midday|bright/.test(t)) want.theme = 'midday';
  else if (/golden|morning/.test(t)) want.theme = 'golden';
  if (want.env === 'kart' && want.km == null) want.km = 1.2;
  return want;
}

/**
 * Search the generator for the layout that best matches a description.
 * Returns the definition plus a short explanation of what was matched.
 */
export function circuitFromDescription(text, { tries = 70, seed = Date.now() } = {}) {
  const want = parseDescription(text);
  const R = rng(seed & 0xffff);
  let best = null;
  for (let k = 0; k < tries; k++) {
    let def = randomTrack(Math.floor(R() * 1e6));
    if (want.km) {
      // rescale to the requested length
      const L = polylineLength(catmullRomClosed(def.points, 8), true);
      const s = (want.km * 1000) / L;
      def = { ...def, points: def.points.map(([x, z]) => [x * s, z * s]) };
    }
    if (want.width) def.width = want.width;
    let T;
    try { T = buildTrack(def); } catch { continue; }
    const m = quickMetrics(T);
    let err = 0;
    if (want.km) err += Math.abs(m.km - want.km) * 2;
    if (want.hairpins != null) err += Math.abs(m.hairpins - want.hairpins) * 1.5;
    if (want.corners != null) err += Math.abs(m.corners - want.corners) * 0.6;
    if (want.fast != null) err += Math.max(0, want.fast - m.fast) * 0.8;
    if (want.longest != null) err += Math.abs(m.longest - want.longest) / 150;
    if (want.technical) err += Math.max(0, 12 - m.corners / Math.max(m.km, 0.5) * 2.5) * 0.4;
    if (want.flowing) err += m.hairpins * 0.8;
    if (T.crossings.length) err += 1.5;
    if (!best || err < best.err) best = { def, err, m };
  }
  const d = best.def;
  const E = want.env ? ENVIRONMENTS[want.env] : null;
  if (E) Object.assign(d, { env: want.env, width: want.width ?? E.defaults.width, hills: E.defaults.hills, banking: E.defaults.banking });
  if (want.hills != null) d.hills = want.hills;
  if (want.banking != null) d.banking = want.banking;
  if (want.theme) d.theme = want.theme;
  const m = best.m;
  const notes = [`${m.km.toFixed(2)} km`, `${m.corners} corners`, `${m.hairpins} hairpin${m.hairpins === 1 ? '' : 's'}`, `longest straight ${Math.round(m.longest)} m`];
  if (E) notes.push(E.name);
  return { def: d, notes, want };
}

/** Resample a definition's outline (used when simplifying imported tracks). */
export function simplifyPoints(points, spacing) {
  const dense = catmullRomClosed(points.map((p) => [p[0], p[1]]), 8);
  return resamplePolyline(dense, spacing, true);
}
