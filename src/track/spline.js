// Closed centripetal Catmull–Rom splines plus helpers for turning a hand-drawn
// stroke into a clean, drivable loop. Pure functions, no rendering deps.
import { clamp } from '../core/math.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Resample a polyline (open) to evenly spaced points. */
export function resamplePolyline(pts, spacing, closed = false) {
  if (pts.length < 2) return pts.slice();
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [src[0].slice()];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const seg = dist(a, b);
    if (seg < 1e-9) continue;
    let d = spacing - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += spacing;
    }
    carry = seg - (d - spacing);
  }
  if (closed && out.length > 2 && dist(out[out.length - 1], out[0]) < spacing * 0.5) out.pop();
  return out;
}

export function polylineLength(pts, closed = false) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) L += dist(pts[pts.length - 1], pts[0]);
  return L;
}

/** Laplacian smoothing on a closed loop, keeps the shape scale roughly fixed. */
export function smoothClosed(pts, iterations = 2, k = 0.5) {
  let p = pts.map((q) => q.slice());
  const n = p.length;
  for (let it = 0; it < iterations; it++) {
    const q = p.map((v) => v.slice());
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
      q[i][0] = p[i][0] + k * ((a[0] + b[0]) / 2 - p[i][0]);
      q[i][1] = p[i][1] + k * ((a[1] + b[1]) / 2 - p[i][1]);
    }
    // Taubin-style inflation step so the loop does not shrink.
    const r = q.map((v) => v.slice());
    const mu = -k * 1.04;
    for (let i = 0; i < n; i++) {
      const a = q[(i - 1 + n) % n], b = q[(i + 1) % n];
      r[i][0] = q[i][0] + mu * ((a[0] + b[0]) / 2 - q[i][0]);
      r[i][1] = q[i][1] + mu * ((a[1] + b[1]) / 2 - q[i][1]);
    }
    p = r;
  }
  return p;
}

/** Convex hull (monotone chain), returns CCW points. */
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Signed area (positive = counter-clockwise in x/z as drawn on screen). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Convert a freehand stroke (screen-space points already mapped to meters)
 * into a set of control points for a closed circuit.
 */
export function strokeToControlPoints(stroke, { spacing = 45 } = {}) {
  if (stroke.length < 8) return null;
  let pts = resamplePolyline(stroke, 4, false);
  // Close the loop: if the end is far from the start, the closing segment is
  // simply part of the circuit (drawn as a straight that will get smoothed).
  const L = polylineLength(pts, true);
  if (L < 300) return null;
  pts = resamplePolyline(pts, 4, true);
  // light smoothing only removes hand jitter; corners keep their character
  pts = smoothClosed(pts, 3, 0.5);
  const ctrlSpacing = clamp(L / 110, 14, spacing * 0.7);
  pts = resamplePolyline(pts, ctrlSpacing, true);
  return pts;
}

/** Evaluate a closed centripetal Catmull–Rom spline into a dense polyline. */
export function catmullRomClosed(ctrl, perSegment = 24, alpha = 0.5) {
  const n = ctrl.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    const t0 = 0;
    const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-4), alpha);
    const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-4), alpha);
    const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-4), alpha);
    for (let j = 0; j < perSegment; j++) {
      const t = t1 + ((t2 - t1) * j) / perSegment;
      const pt = [0, 0];
      for (let c = 0; c < 2; c++) {
        const A1 = ((t1 - t) / (t1 - t0)) * p0[c] + ((t - t0) / (t1 - t0)) * p1[c];
        const A2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
        const A3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
        const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
        const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
        pt[c] = ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
      }
      out.push(pt);
    }
  }
  return out;
}

/** Find self-intersections of a closed polyline (O(n^2) on a coarse copy). */
export function findCrossings(pts, minGap = 8) {
  const n = pts.length;
  const res = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + minGap; j < n; j++) {
      if ((j + 1) % n === i || n - (j - i) < minGap) continue;
      const c = pts[j], d = pts[(j + 1) % n];
      const r = segIntersect(a, b, c, d);
      if (r) res.push({ i, j, ti: r[0], tj: r[1], x: a[0] + (b[0] - a[0]) * r[0], z: a[1] + (b[1] - a[1]) * r[0] });
    }
  }
  return res;
}

function segIntersect(a, b, c, d) {
  const r0 = b[0] - a[0], r1 = b[1] - a[1];
  const s0 = d[0] - c[0], s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den;
  const u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  if (t >= 0 && t < 1 && u >= 0 && u < 1) return [t, u];
  return null;
}

/**
 * Relax control points so that no corner is tighter than minRadius
 * (prevents undrivable kinks from shaky drawing).
 */
export function enforceMinRadius(ctrl, minRadius = 14, maxIter = 40) {
  let p = ctrl.map((q) => q.slice());
  const n = p.length;
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    const dense = catmullRomClosed(p, 8);
    const m = dense.length;
    for (let i = 0; i < n; i++) {
      // check curvature around control point i using dense samples
      let kmax = 0;
      for (let j = -4; j <= 4; j++) {
        const idx = (i * 8 + j + m) % m;
        const a = dense[(idx - 1 + m) % m], b = dense[idx], c = dense[(idx + 1) % m];
        kmax = Math.max(kmax, Math.abs(curvature3(a, b, c)));
      }
      if (kmax > 1 / minRadius) {
        const a = p[(i - 1 + n) % n], c = p[(i + 1) % n];
        p[i][0] += 0.35 * ((a[0] + c[0]) / 2 - p[i][0]);
        p[i][1] += 0.35 * ((a[1] + c[1]) / 2 - p[i][1]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return p;
}

export function curvature3(a, b, c) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const bcx = c[0] - b[0], bcz = c[1] - b[1];
  const cross = abx * bcz - abz * bcx;
  const la = Math.hypot(abx, abz), lb = Math.hypot(bcx, bcz), lc = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const den = la * lb * lc;
  return den < 1e-9 ? 0 : (2 * cross) / den;
}
