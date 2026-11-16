// Procedural circuit generator (pure; used by the studio, career and tests).
import { catmullRomClosed, polylineLength, findCrossings, convexHull } from './spline.js';
import { clamp, rng } from '../core/math.js';

/**
 * Procedural circuit generator: random points → convex hull → displaced
 * midpoints (creates hairpins/complexes) → spacing + corner-angle relaxation
 * → scaled to a real-world length. Produces flowing, varied, non-crossing
 * layouts with genuine straights.
 */
export function randomTrack(seed, attempt = 0) {
  const R = rng(seed * 7919 + attempt * 104729 + 1);
  const W = 1000, H = 640;
  const pts = [];
  for (let i = 0; i < 18; i++) pts.push([R() * W - W / 2, R() * H - H / 2]);
  let hull = convexHull(pts);
  for (let pass = 0; pass < 2; pass++) {
    const out = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      out.push(a);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < (pass ? 260 : 160)) continue;
      // hull is CCW, so (-dz, dx) points inward: bias toward deep incursions
      const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
      const r = R();
      const disp = r < 0.25 ? 0 : (pass ? (R() - 0.5) * 0.3 : (R() * 0.85 - 0.15)) * len; // some edges stay straight
      const t = 0.35 + R() * 0.3;
      out.push([a[0] + (b[0] - a[0]) * t + nx * disp, a[1] + (b[1] - a[1]) * t + nz * disp]);
    }
    hull = out;
  }
  // relax: keep points apart and open up corners tighter than ~55°
  for (let it = 0; it < 40; it++) {
    for (let i = 0; i < hull.length; i++) for (let j = i + 1; j < hull.length; j++) {
      const dx = hull[j][0] - hull[i][0], dz = hull[j][1] - hull[i][1];
      const d = Math.hypot(dx, dz);
      if (d < 140 && d > 1e-6) { const k = (140 - d) / d / 2; hull[i][0] -= dx * k; hull[i][1] -= dz * k; hull[j][0] += dx * k; hull[j][1] += dz * k; }
    }
    const n = hull.length;
    for (let i = 0; i < n; i++) {
      const a = hull[(i - 1 + n) % n], b = hull[i], c = hull[(i + 1) % n];
      const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const ang = Math.acos(clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9), -1, 1));
      if (ang < 0.95) { b[0] += ((a[0] + c[0]) / 2 - b[0]) * 0.3; b[1] += ((a[1] + c[1]) / 2 - b[1]) * 0.3; }
    }
  }
  // scale to a target length
  const target = 2600 + R() * 2200;
  const L = polylineLength(catmullRomClosed(hull, 8), true);
  const k = target / L;
  const points = hull.map(([x, z]) => [x * k, z * k]);
  const crossings = findCrossings(catmullRomClosed(points, 6), 8);
  if (crossings.length && attempt < 12) return randomTrack(seed, attempt + 1);
  const names = ['Saltmarsh', 'Ironvale', 'Cobalt Bay', 'Redcliff', 'Larkspur', 'Hollow Ridge', 'Northgate', 'Emberfield', 'Quarry Run', 'Silverbeck', 'Ashford Downs', 'Kingsmere', 'Falcon Point', 'Westbrook', 'Coldwater'];
  return {
    name: `${names[Math.floor(R() * names.length)]} ${['Circuit', 'Raceway', 'Park', 'Ring', 'GP'][Math.floor(R() * 5)]}`,
    width: 11 + Math.round(R() * 6), hills: Math.round(R() * 10) / 10, banking: Math.round(R() * 6) / 10,
    seed: Math.floor(R() * 900), theme: ['golden', 'midday', 'dusk'][Math.floor(R() * 3)], points,
  };
}
