// Builds a fully described circuit from a compact track definition.
// Everything here is pure data so the physics, the AI, the lap simulator
// (Node) and the renderer all agree on exactly the same surface.
import { clamp, lerp, smoothstep, makeNoise2D, TAU, rng } from '../core/math.js';
import { catmullRomClosed, resamplePolyline, findCrossings, enforceMinRadius, signedArea } from './spline.js';

export const KERB_W = 1.5;
export const RUNOFF = 15;
export const SURF = { ASPHALT: 0, KERB: 1, GRASS: 2, GRAVEL: 3 };
export const SURF_GRIP = [1.0, 0.92, 0.62, 0.5];
export const SURF_DRAG = [0, 0.004, 0.035, 0.11]; // rolling resistance coefficient added

/**
 * def = { name, points:[[x,z]...], width, hills (0..1), banking (0..1), seed, theme }
 */
export function buildTrack(def) {
  const width = clamp(def.width ?? 13, 8, 24);
  const hills = clamp(def.hills ?? 0.4, 0, 1);
  const banking = clamp(def.banking ?? 0.4, 0, 1);
  const seed = def.seed ?? 7;
  const half = width / 2;

  let ctrl = def.points.map((p) => [p[0], p[1]]);
  ctrl = enforceMinRadius(ctrl, Math.max(12, width * 1.1));
  const dense = catmullRomClosed(ctrl, 32);
  const DS = 2;
  let pts = resamplePolyline(dense, DS, true);
  let N = pts.length;

  // ----- tangents, normals, curvature (sign: + = left turn)
  const tx = new Float32Array(N), tz = new Float32Array(N), nx = new Float32Array(N), nz = new Float32Array(N);
  const tangentsFrom = (P) => {
    for (let i = 0; i < N; i++) {
      const a = P[(i - 1 + N) % N], b = P[(i + 1) % N];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      tx[i] = dx / l; tz[i] = dz / l;
      nx[i] = tz[i]; nz[i] = -tx[i];
    }
  };
  tangentsFrom(pts);
  let curv = new Float32Array(N);
  const computeCurv = () => {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N, k = (i - 1 + N) % N;
      // d(tangent)/ds projected on left normal
      const dtx = tx[j] - tx[k], dtz = tz[j] - tz[k];
      curv[i] = (dtx * nx[i] + dtz * nz[i]) / (2 * DS);
    }
  };
  computeCurv();
  curv = smoothArr(curv, 3);

  // ----- choose start/finish on the longest straight, rotate arrays so s=0 there
  let best = { len: 0, end: 0 };
  {
    let run = 0;
    for (let k = 0; k < N * 2; k++) {
      const i = k % N;
      if (Math.abs(curv[i]) < 1 / 260) run++;
      else run = 0;
      if (run > best.len && run <= N) best = { len: run, end: i };
    }
  }
  const startIdx = (best.end - Math.floor(best.len * 0.45) + N) % N;
  pts = rotate(pts, startIdx);
  tangentsFrom(pts);
  computeCurv();
  curv = smoothArr(curv, 3);

  const L = N * DS;
  const sArr = new Float32Array(N);
  for (let i = 0; i < N; i++) sArr[i] = i * DS;

  // ----- elevation: periodic, gradient-limited multi-sine profile
  const R = rng(seed * 9973 + 17);
  const y = new Float32Array(N);
  if (hills > 0) {
    const maxGrade = 0.085 * hills + 0.01;
    const terms = [];
    for (let k = 1; k <= 5; k++) terms.push({ k, ph: R() * TAU, a: (0.5 + R()) / k });
    // scale so the max gradient is maxGrade
    let gmax = 0;
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let h = 0, g = 0;
      for (const t of terms) {
        const w = (TAU * t.k) / L;
        h += t.a * Math.sin(w * sArr[i] + t.ph);
        g += t.a * w * Math.cos(w * sArr[i] + t.ph);
      }
      raw[i] = h;
      gmax = Math.max(gmax, Math.abs(g));
    }
    let scale = maxGrade / gmax;
    let range = 0;
    { let mn = Infinity, mx = -Infinity; for (let i = 0; i < N; i++) { mn = Math.min(mn, raw[i]); mx = Math.max(mx, raw[i]); } range = (mx - mn) * scale; }
    const maxRange = 8 + 34 * hills;
    if (range > maxRange) scale *= maxRange / range;
    for (let i = 0; i < N; i++) y[i] = raw[i] * scale;
    // flatten the start/finish straight a little
    const y0 = avgAround(y, 0, 20);
    for (let i = 0; i < N; i++) {
      const d = Math.min(sArr[i], L - sArr[i]);
      y[i] = lerp(y0, y[i], smoothstep(30, 140, d));
    }
  }

  // ----- flyovers for self-crossings
  const coarseStep = 4;
  const coarse = [];
  for (let i = 0; i < N; i += coarseStep) coarse.push(pts[i]);
  const crossings = findCrossings(coarse, 12).map((c) => ({
    i: Math.round((c.i + c.ti) * coarseStep) % N,
    j: Math.round((c.j + c.tj) * coarseStep) % N,
    x: c.x,
    z: c.z,
  }));
  const deck = new Uint8Array(N);
  for (const c of crossings) {
    const need = 8.5;
    const diff = y[c.j] - y[c.i];
    const raise = diff >= 0 ? c.j : c.i;
    c.upper = raise; c.lower = raise === c.j ? c.i : c.j;
    const span = Math.ceil((half + RUNOFF + 14) / DS);
    for (let k = -span; k <= span; k++) deck[(raise + k + N) % N] = 1;
    if (Math.abs(diff) >= need) continue;
    const amount = need - Math.abs(diff);
    const sigma = 70;
    for (let k = 0; k < N; k++) {
      let ds = Math.abs(sArr[k] - sArr[raise]);
      ds = Math.min(ds, L - ds);
      y[k] += amount * Math.exp(-(ds * ds) / (2 * sigma * sigma));
    }
  }
  const ySm = smoothArr(y, 6);
  y.set(ySm);

  // ----- banking (radians, + means left edge higher)
  let bank = new Float32Array(N);
  const maxBank = 0.15 * banking;
  for (let i = 0; i < N; i++) bank[i] = -clamp(curv[i] * 38, -1, 1) * maxBank;
  bank = smoothArr(bank, 10);

  // ----- grade
  const grade = new Float32Array(N);
  for (let i = 0; i < N; i++) grade[i] = (y[(i + 1) % N] - y[(i - 1 + N) % N]) / (2 * DS);

  // ----- kerbs and gravel
  const kerb = new Uint8Array(N);
  const gravelL = new Uint8Array(N), gravelR = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (Math.abs(curv[i]) > 1 / 150) {
      for (let k = -7; k <= 9; k++) kerb[(i + k + N) % N] = 1;
    }
    if (Math.abs(curv[i]) > 1 / 95) {
      const outsideRight = curv[i] > 0;
      for (let k = -4; k <= 16; k++) {
        const j = (i + k + N) % N;
        if (outsideRight) gravelR[j] = 1;
        else gravelL[j] = 1;
      }
    }
  }

  // ----- runoff clearance where sections of the circuit run close together
  const runL = new Float32Array(N).fill(RUNOFF), runR = new Float32Array(N).fill(RUNOFF);
  const grid = makeSampleGrid(pts, 40);
  const gapSamples = Math.ceil((RUNOFF * 2 + width * 2) / DS) + 8;
  for (let i = 0; i < N; i++) {
    const cx = pts[i][0], cz = pts[i][1];
    grid.forNear(cx, cz, RUNOFF + width + 10, (j) => {
      let gap = Math.abs(i - j);
      gap = Math.min(gap, N - gap);
      if (gap < gapSamples) return;
      if (Math.abs(y[i] - y[j]) > 4.5) return; // passes over/under: no conflict
      const dx = pts[j][0] - cx, dz = pts[j][1] - cz;
      const e = dx * tx[i] + dz * tz[i];
      const d = dx * nx[i] + dz * nz[i];
      if (Math.abs(e) > half + RUNOFF) return;
      const allowed = Math.abs(d) - half - 3 - half; // keep 3m from other road edge
      if (d > 0) runL[i] = Math.min(runL[i], Math.max(0, allowed));
      else runR[i] = Math.min(runR[i], Math.max(0, allowed));
    });
  }
  for (let i = 0; i < N; i++) if (deck[i]) { runL[i] = Math.min(runL[i], 2.2); runR[i] = Math.min(runR[i], 2.2); }
  const runLs = minSmooth(runL, 6), runRs = minSmooth(runR, 6);
  const wallL = new Uint8Array(N), wallR = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    wallL[i] = runLs[i] >= (deck[i] ? 1.5 : 3) ? 1 : 0;
    wallR[i] = runRs[i] >= (deck[i] ? 1.5 : 3) ? 1 : 0;
    if (deck[i]) { gravelL[i] = 0; gravelR[i] = 0; }
  }

  // ----- bounds
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    minX = Math.min(minX, pts[i][0]); maxX = Math.max(maxX, pts[i][0]);
    minZ = Math.min(minZ, pts[i][1]); maxZ = Math.max(maxZ, pts[i][1]);
    minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]);
  }

  const px = new Float32Array(N), pz = new Float32Array(N);
  for (let i = 0; i < N; i++) { px[i] = pts[i][0]; pz[i] = pts[i][1]; }

  const track = {
    def: { ...def, width, hills, banking, seed },
    name: def.name || 'Untitled Circuit',
    N, DS, length: L, width, half,
    px, py: y, pz, tx, tz, nx, nz, curv, bank, grade, s: sArr,
    kerb, gravelL, gravelR, runL: runLs, runR: runRs, wallL, wallR, deck,
    crossings,
    bounds: { minX, maxX, minZ, maxZ, minY, maxY },
    clockwise: signedArea(pts) > 0,
    grid,
  };
  track.noise = makeNoise2D(seed * 31 + 5);
  track.meanY = y.reduce((a, v) => a + v, 0) / N;
  track.baseHeight = (x, z) => baseTerrain(track, x, z);
  track.query = (x, z, hint) => queryTrack(track, x, z, hint);
  track.heightfield = null; // built lazily (renderer/physics)
  track.corners = detectCorners(track);
  return track;
}

function avgAround(arr, i, r) {
  const N = arr.length;
  let s = 0;
  for (let k = -r; k <= r; k++) s += arr[(i + k + N) % N];
  return s / (2 * r + 1);
}

function rotate(arr, k) {
  return arr.slice(k).concat(arr.slice(0, k));
}

export function smoothArr(a, r) {
  const N = a.length;
  const out = new Float32Array(N);
  let acc = 0;
  for (let k = -r; k <= r; k++) acc += a[(k + N) % N];
  for (let i = 0; i < N; i++) {
    out[i] = acc / (2 * r + 1);
    acc += a[(i + r + 1) % N] - a[(i - r + N) % N];
  }
  return out;
}

function minSmooth(a, r) {
  const N = a.length;
  const m = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = Infinity;
    for (let k = -r * 2; k <= r * 2; k++) v = Math.min(v, a[(i + k + N) % N]);
    m[i] = v;
  }
  return smoothArr(m, r);
}

/** Uniform bucket grid over centerline samples for fast spatial lookups. */
export function makeSampleGrid(pts, cell) {
  const map = new Map();
  const key = (gx, gz) => gx * 73856093 ^ gz * 19349663;
  pts.forEach((p, i) => {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
    let b = map.get(k);
    if (!b) map.set(k, (b = []));
    b.push(i);
  });
  return {
    forNear(x, z, r, fn) {
      const g0x = Math.floor((x - r) / cell), g1x = Math.floor((x + r) / cell);
      const g0z = Math.floor((z - r) / cell), g1z = Math.floor((z + r) / cell);
      for (let gx = g0x; gx <= g1x; gx++)
        for (let gz = g0z; gz <= g1z; gz++) {
          const b = map.get(key(gx, gz));
          if (b) for (const i of b) fn(i);
        }
    },
  };
}

/** Natural terrain far from the circuit (gentle hills rising to a ridge). */
function baseTerrain(track, x, z) {
  const n = track.noise;
  const b = track.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const rx = (b.maxX - b.minX) / 2 + 250, rz = (b.maxZ - b.minZ) / 2 + 250;
  const e = Math.hypot((x - cx) / rx, (z - cz) / rz); // ~1 at the edge of the play area
  const base = track.meanY;
  const hillsN = n.fbm(x / 420, z / 420, 4) * 14 + n(x / 90, z / 90) * 1.5;
  const ridge = smoothstep(0.9, 2.6, e) * (90 + 120 * (n.fbm(x / 700 + 9, z / 700, 3) + 0.5));
  return base - 1.5 + hillsN * (0.4 + 0.6 * smoothstep(0.4, 1.2, e)) + ridge;
}

/**
 * Nearest-sample query. `hint` keeps the search local (so bridges and
 * crossings resolve to the section the car is actually on).
 */
export function queryTrack(T, x, z, hint = -1) {
  const N = T.N;
  let bi = -1, bd = Infinity;
  if (hint >= 0) {
    for (let k = -24; k <= 24; k++) {
      const i = (hint + k + N) % N;
      const dx = x - T.px[i], dz = z - T.pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; bi = i; }
    }
    if (bd > 60 * 60) bi = -1;
  }
  if (bi < 0) {
    bd = Infinity;
    T.grid.forNear(x, z, 80, (i) => {
      const dx = x - T.px[i], dz = z - T.pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; bi = i; }
    });
    if (bi < 0) {
      for (let i = 0; i < N; i++) {
        const dx = x - T.px[i], dz = z - T.pz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; bi = i; }
      }
    }
  }
  const i = bi;
  const dx = x - T.px[i], dz = z - T.pz[i];
  let e = dx * T.tx[i] + dz * T.tz[i];
  // interpolate toward the neighbour on the side of e
  const j = e >= 0 ? (i + 1) % N : (i - 1 + N) % N;
  const f = clamp(Math.abs(e) / T.DS, 0, 1);
  const lerpA = (A) => A[i] + (A[j] - A[i]) * f;
  const cy = lerpA(T.py), bank = lerpA(T.bank), grade = lerpA(T.grade);
  const ntx = T.nx[i] + (T.nx[j] - T.nx[i]) * f, ntz = T.nz[i] + (T.nz[j] - T.nz[i]) * f;
  const cxp = T.px[i] + (T.px[j] - T.px[i]) * f, czp = T.pz[i] + (T.pz[j] - T.pz[i]) * f;
  const d = (x - cxp) * ntx + (z - czp) * ntz;
  let s = T.s[i] + e;
  if (s < 0) s += T.length;
  if (s >= T.length) s -= T.length;

  const edge = T.half + KERB_W;
  const ad = Math.abs(d);
  const tb = Math.tan(bank);
  const runoff = d >= 0 ? T.runL[i] : T.runR[i];
  const wallDist = T.half + runoff;
  let h, slopeLat, surface;
  if (ad <= edge) {
    h = cy + d * tb;
    slopeLat = tb;
    surface = ad <= T.half ? SURF.ASPHALT : T.kerb[i] ? SURF.KERB : SURF.GRASS;
  } else {
    const he = cy + Math.sign(d) * edge * tb;
    // runoff droops gently toward the terrain beyond the wall line
    const t = smoothstep(wallDist, wallDist + 3, ad);
    h = he - 0.06 * Math.min(ad - edge, 4) / 4 - t * 0.35;
    slopeLat = 0;
    const gravel = d >= 0 ? T.gravelL[i] : T.gravelR[i];
    surface = gravel && ad > edge + 2 ? SURF.GRAVEL : SURF.GRASS;
    if (ad > wallDist + 3 && T.heightfield) {
      h = sampleHeightfield(T.heightfield, x, z);
    }
  }
  // gradient of the surface → normal
  const gx = grade * T.tx[i] + slopeLat * ntx;
  const gz = grade * T.tz[i] + slopeLat * ntz;
  const nl = Math.hypot(gx, 1, gz);
  return {
    i, s, d, e, height: h, surface, bank, grade,
    normal: [-gx / nl, 1 / nl, -gz / nl],
    wallDist,
    wallLeft: T.wallL[i] === 1,
    wallRight: T.wallR[i] === 1,
    runoff,
    tangent: [T.tx[i], T.tz[i]],
    nrm: [ntx, ntz],
    kerb: T.kerb[i] === 1,
  };
}

/** Terrain heightfield: blends exact runoff height near the track into hills. */
export function buildHeightfield(T, { margin = 900, maxRes = 300 } = {}) {
  const b = T.bounds;
  const minX = b.minX - margin, maxX = b.maxX + margin, minZ = b.minZ - margin, maxZ = b.maxZ + margin;
  const sizeX = maxX - minX, sizeZ = maxZ - minZ;
  const cell = Math.max(sizeX, sizeZ) / maxRes;
  const nxs = Math.ceil(sizeX / cell) + 1, nzs = Math.ceil(sizeZ / cell) + 1;
  const h = new Float32Array(nxs * nzs);
  const near = new Float32Array(nxs * nzs); // distance to centerline (for scenery)
  const R = T.half + RUNOFF + 90;
  const N = T.N;
  const win = Math.ceil((R * 2.2) / T.DS);
  for (let gz = 0; gz < nzs; gz++) {
    for (let gx = 0; gx < nxs; gx++) {
      const x = minX + gx * cell, z = minZ + gz * cell;
      let b1 = -1, d1 = Infinity, b2 = -1, d2 = Infinity;
      T.grid.forNear(x, z, R, (i) => {
        const dx = x - T.px[i], dz = z - T.pz[i];
        const dd = dx * dx + dz * dz;
        if (dd < d1) {
          // demote previous best if it belongs to a different section
          if (b1 >= 0) {
            let gap = Math.abs(b1 - i); gap = Math.min(gap, N - gap);
            if (gap > win && d1 < d2) { d2 = d1; b2 = b1; }
          }
          d1 = dd; b1 = i;
        } else if (dd < d2) {
          let gap = Math.abs(b1 - i); gap = Math.min(gap, N - gap);
          if (gap > win) { d2 = dd; b2 = i; }
        }
      });
      const base = T.baseHeight(x, z);
      let val = base;
      let nd = Infinity;
      if (b1 >= 0) {
        const g1 = groundFrom(T, b1, x, z, base);
        nd = g1.ad;
        val = g1.h;
        if (b2 >= 0) {
          const g2 = groundFrom(T, b2, x, z, base);
          if (g2.inZone && !g1.inZone) val = g2.h;
          else if (g2.inZone === g1.inZone) val = Math.min(val, g2.h);
          nd = Math.min(nd, g2.ad);
        }
      }
      h[gz * nxs + gx] = val;
      near[gz * nxs + gx] = nd;
    }
  }
  const hf = { minX, minZ, cell, nx: nxs, nz: nzs, h, near };
  T.heightfield = hf;
  return hf;
}

function groundFrom(T, i, x, z, base) {
  const dx = x - T.px[i], dz = z - T.pz[i];
  const d = dx * T.nx[i] + dz * T.nz[i];
  const ad = Math.abs(d);
  const edge = T.half + KERB_W;
  const tb = Math.tan(T.bank[i]);
  const he = T.py[i] + clamp(d, -edge, edge) * tb;
  const wallDist = T.half + (d >= 0 ? T.runL[i] : T.runR[i]);
  const inZone = ad < wallDist + 2;
  const near = he - 0.45;
  const t = smoothstep(wallDist + 2, wallDist + 80, ad);
  return { h: lerp(near, base, t * t), inZone, ad };
}

export function sampleHeightfield(hf, x, z) {
  const fx = clamp((x - hf.minX) / hf.cell, 0, hf.nx - 1.001);
  const fz = clamp((z - hf.minZ) / hf.cell, 0, hf.nz - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ux = fx - ix, uz = fz - iz;
  const H = hf.h, w = hf.nx;
  const a = H[iz * w + ix], b = H[iz * w + ix + 1], c = H[(iz + 1) * w + ix], d = H[(iz + 1) * w + ix + 1];
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

/** Find corners for UI numbering & braking boards. */
function detectCorners(T) {
  const N = T.N;
  const out = [];
  let inCorner = false, start = 0, peak = 0, peakI = 0, dir = 0;
  for (let k = 0; k <= N; k++) {
    const i = k % N;
    const c = Math.abs(T.curv[i]);
    if (!inCorner && c > 1 / 170) {
      inCorner = true; start = i; peak = c; peakI = i; dir = Math.sign(T.curv[i]);
    } else if (inCorner) {
      if (c > peak) { peak = c; peakI = i; }
      if (c < 1 / 240 || Math.sign(T.curv[i]) !== dir) {
        inCorner = false;
        out.push({ start, apex: peakI, end: i, radius: 1 / peak, dir });
      }
    }
  }
  return out;
}
