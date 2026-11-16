// Open world generation (pure — runs in Node for tests). A 4 km island:
// mountains to the north, a coast and beaches to the south, a lake, forest
// to the west, a town to the east, an airfield, and a festival site in the
// middle. Roads are laid first, then carved into the terrain with
// grade limits, so everything drivable is smooth.
import { makeNoise2D, clamp, lerp, smoothstep, rng } from '../core/math.js';
import { catmullRomClosed, resamplePolyline, polylineLength } from '../track/spline.js';

export const SIZE = 4000;
export const CELL = 4;
export const HALF = SIZE / 2;
export const SEA = 0;
export const NCELL = SIZE / CELL + 1;

// surface codes match SURF in track.js (0 asphalt, 2 grass, 3 gravel/sand, 4 dirt) + 5 water
export const S_ASPHALT = 0, S_GRASS = 2, S_SAND = 3, S_DIRT = 4, S_WATER = 5;

export const ROAD_TYPES = {
  highway: { width: 15, grade: 0.07, surf: S_ASPHALT, name: 'Highway' },
  road: { width: 10, grade: 0.11, surf: S_ASPHALT, name: 'Road' },
  pass: { width: 9, grade: 0.13, surf: S_ASPHALT, name: 'Mountain road' },
  street: { width: 11, grade: 0.06, surf: S_ASPHALT, name: 'Street' },
  runway: { width: 34, grade: 0.01, surf: S_ASPHALT, name: 'Runway' },
  dirt: { width: 8, grade: 0.2, surf: S_DIRT, name: 'Trail' },
};

const catmullOpen = (P, per = 10) => {
  // open Catmull–Rom: duplicate ends
  const ext = [P[0], ...P, P[P.length - 1]];
  const out = [];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    for (let j = 0; j < per; j++) {
      const t = j / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  out.push(P[P.length - 1].slice());
  return out;
};

/**
 * Lay a road the way engineers do: straights and constant-radius arcs.
 * a: heading in radians (direction (cos a, sin a) in x/z). Segments:
 * ['S', length] or ['A', radius, degrees] (+ = turn right/clockwise).
 */
export function pathFromSegments([x, z], a, segs, step = 6) {
  const pts = [[x, z]];
  for (const sg of segs) {
    if (sg[0] === 'S') {
      const n = Math.max(1, Math.round(sg[1] / step));
      for (let i = 0; i < n; i++) { x += Math.cos(a) * (sg[1] / n); z += Math.sin(a) * (sg[1] / n); pts.push([x, z]); }
    } else {
      const R = sg[1], ang = (sg[2] * Math.PI) / 180;
      const n = Math.max(2, Math.round((Math.abs(ang) * R) / step));
      for (let i = 0; i < n; i++) { a += ang / n; x += Math.cos(a) * ((Math.abs(ang) * R) / n); z += Math.sin(a) * ((Math.abs(ang) * R) / n); pts.push([x, z]); }
    }
  }
  return pts;
}

export function generateWorld(seed = 7) {
  const n = makeNoise2D(seed * 13 + 1);
  const R = rng(seed * 101 + 5);
  const N = NCELL;
  const H = new Float32Array(N * N);
  const idx = (ix, iz) => iz * N + ix;
  const wx = (ix) => -HALF + ix * CELL;

  // ---------- landmarks
  const L = {
    festival: [0, 40],
    town: [980, 250],
    lake: [-520, -520],
    airfield: [-1180, 700],
    summit: [-120, -1640],
    beach: [300, 1420],
  };

  // ---------- natural terrain
  const coastZ = (x) => 1430 + 120 * n(x / 700 + 9, 3.1) + 60 * n(x / 230, 7.7);
  const natural = (x, z) => {
    const edge = Math.max(Math.abs(x), Math.abs(z)) / HALF;
    const coast = smoothstep(-60, 120, coastZ(x) - z); // 1 inland, 0 at sea
    const rim = 1 - smoothstep(0.86, 0.99, edge); // the island ends before the map edge
    const land = Math.min(coast, rim);
    const north = smoothstep(-150, -1500, z);
    const ridge = 1 - Math.abs(n.fbm(x / 900 + 3, z / 900 - 2, 5));
    const mount = north * (90 + 300 * ridge * ridge);
    const hills = 22 * n.fbm(x / 520, z / 520, 4) + 8 * n.fbm(x / 140 + 5, z / 140, 3);
    let h = 24 + hills + mount;
    // lake basin
    const dl = Math.hypot(x - L.lake[0], z - L.lake[1]);
    h = lerp(h, -7, 1 - smoothstep(170, 330, dl));
    // gentle plains around the festival and the airfield
    const df = Math.hypot(x - L.festival[0], z - L.festival[1]);
    h = lerp(h, 22 + 4 * n(x / 300, z / 300), (1 - smoothstep(200, 600, df)) * 0.75);
    return lerp(-16 - 10 * (1 - land), h, land);
  };
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) H[idx(ix, iz)] = natural(wx(ix), wx(iz));
  const sampleRaw = (x, z) => sampleGrid(H, x, z);

  // ---------- roads
  const roads = [];
  const addRoad = (id, name, type, ctrl, closed = false, dense = false) => {
    const dense0 = dense ? ctrl : closed ? catmullRomClosed(ctrl, 12) : catmullOpen(ctrl, 12);
    const pts = resamplePolyline(dense0, 4, closed);
    roads.push({ id, name, type, closed, pts, ...ROAD_TYPES[type] });
  };
  // highway loop around the middle of the island
  const loop = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    let rx = 1320 + 140 * n(k * 0.7, 1.3), rz = 1050 + 120 * n(k * 0.7, 4.2);
    let x = Math.cos(a) * rx, z = Math.sin(a) * rz - 60;
    loop.push([x, z]);
  }
  addRoad('loop', 'Ring Highway', 'highway', loop, true);
  // coast road along the beaches (joins the loop at both ends)
  const coast = [];
  for (let x = -1250; x <= 1250; x += 180) coast.push([x, coastZ(x) - 140 - 30 * n(x / 200, 2)]);
  addRoad('coast', 'Coast Road', 'road', [[-1150, 830], ...coast, [1150, 830]]);
  // connect a road end to the nearest point of another road with a smooth link
  const linkTo = (pts, targetId) => {
    const t = roads.find((r) => r.id === targetId);
    const e = pts[pts.length - 1], e0 = pts[pts.length - 2];
    let bi = 0, bd = Infinity;
    t.pts.forEach((p, i) => { const d = Math.hypot(p[0] - e[0], p[1] - e[1]); if (d < bd) { bd = d; bi = i; } });
    const tp = t.pts[bi];
    const dx = e[0] - e0[0], dz = e[1] - e0[1], dl = Math.hypot(dx, dz) || 1;
    const mid = [e[0] + (dx / dl) * Math.min(80, bd * 0.4), e[1] + (dz / dl) * Math.min(80, bd * 0.4)];
    return [...pts, ...resamplePolyline(catmullOpen([e, mid, tp], 10), 6).slice(1)];
  };
  // Summit Pass: proper switchback hairpins up the mountain, then a fast descent
  {
    const P = pathFromSegments([-600, -980], -Math.PI / 2, [
      ['S', 90], ['A', 70, 35], ['S', 60], ['A', 19, -172], ['S', 140], ['A', 19, 172], ['S', 150], ['A', 19, -172], ['S', 140],
      ['A', 90, 60], ['S', 110], ['A', 140, -40], ['S', 90], ['A', 60, 85], ['S', 70], ['A', 45, -95], ['A', 110, 50], ['S', 160], ['A', 200, 25], ['S', 120],
    ]);
    addRoad('pass', 'Summit Pass', 'pass', linkTo(P, 'loop'), false, true);
  }
  // Canyon Run: tight esses and quick sweepers through the western hills
  {
    const P = pathFromSegments([-260, -150], -Math.PI / 2 - 0.3, [
      ['S', 60], ['A', 70, -60], ['A', 85, 105], ['S', 50], ['A', 48, -95], ['A', 130, 45], ['S', 90], ['A', 42, 110], ['A', 60, -125], ['S', 110],
      ['A', 160, 30], ['A', 55, -80], ['S', 70], ['A', 90, 70], ['S', 140],
    ]);
    addRoad('canyon', 'Canyon Run', 'road', linkTo(P, 'loop'), false, true);
  }
  // Lakeside: a flowing loop around the lake
  {
    const L0 = L.lake, P = [];
    for (let k = 0; k < 14; k++) { const a = (k / 14) * Math.PI * 2; const r = 300 + 40 * Math.sin(a * 3 + 1); P.push([L0[0] + Math.cos(a) * r, L0[1] + Math.sin(a) * r * 0.85]); }
    addRoad('lakeside', 'Lakeside Drive', 'road', P, true);
  }
  // Ridge Road: long sweepers and blind crests across the eastern hills
  {
    const P = pathFromSegments([780, -820], -Math.PI / 2 + 0.5, [
      ['S', 120], ['A', 220, -35], ['S', 100], ['A', 180, 55], ['S', 140], ['A', 260, -45], ['A', 120, 70], ['S', 100], ['A', 300, -30], ['S', 160],
    ]);
    addRoad('ridge', 'Ridge Road', 'road', linkTo(P, 'loop'), false, true);
  }
  // cross roads through the festival
  addRoad('north', 'Festival Road', 'road', [[-30, -1120], [60, -800], [-40, -450], [40, -150], [0, 40], [-50, 300], [40, 650], [0, 980]]);
  addRoad('east', 'Town Road', 'road', [[-1360, -40], [-1000, 60], [-650, -60], [-300, 80], [0, 40], [380, 160], [700, 220], [860, 250]]);
  // town grid
  const T0 = L.town;
  for (let k = -3; k <= 3; k++) {
    addRoad(`tx${k}`, `${['Harbour', 'Mill', 'Market', 'Main', 'Church', 'Station', 'Ridge'][k + 3]} Street`, 'street', [[T0[0] - 300, T0[1] + k * 85], [T0[0] + 300, T0[1] + k * 85]]);
    addRoad(`tz${k}`, `${['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh'][k + 3]} Avenue`, 'street', [[T0[0] + k * 95, T0[1] - 270], [T0[0] + k * 95, T0[1] + 270]]);
  }
  // airfield runway + taxiway
  const A = L.airfield;
  addRoad('runway', 'Airfield Runway', 'runway', [[A[0], A[1] - 620], [A[0], A[1] + 520]]);
  addRoad('taxi', 'Airfield Access', 'road', [[A[0] + 30, A[1] - 300], [A[0] + 200, A[1] - 380], [-1000, 60]]);
  // forest trails (dirt): a scramble loop and two wandering trails
  const dloop = [];
  for (let k = 0; k < 11; k++) { const a = (k / 11) * Math.PI * 2; const r = 300 + 90 * n(k, 9); dloop.push([-1180 + Math.cos(a) * r, -620 + Math.sin(a) * r * 0.8]); }
  addRoad('scramble', 'Timber Scramble', 'dirt', dloop, true);
  addRoad('trail1', 'Ridge Trail', 'dirt', [[-880, -520], [-760, -780], [-820, -1000], [-640, -1060]]);
  addRoad('trail2', 'Lakeside Trail', 'dirt', [[-1480, -620], [-1560, -300], [-1380, -80], [-1360, -40]]);

  // ---------- road heights: follow the land, smoothed and grade-limited
  for (const r of roads) {
    const P = r.pts, M = P.length;
    let h = P.map(([x, z]) => Math.max(sampleRaw(x, z), SEA + 2.5));
    const win = r.type === 'runway' ? 60 : r.type === 'street' ? 20 : r.type === 'highway' ? 12 : r.type === 'dirt' ? 4 : 6;
    for (let pass = 0; pass < 3; pass++) {
      const o = new Float32Array(M);
      for (let i = 0; i < M; i++) {
        let s = 0, c = 0;
        for (let k = -win; k <= win; k++) {
          let j = i + k;
          if (r.closed) j = (j + M) % M; else if (j < 0 || j >= M) continue;
          s += h[j]; c++;
        }
        o[i] = s / c;
      }
      h = Array.from(o);
    }
    const g = r.grade * 4;
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < M; i++) h[i] = clamp(h[i], h[i - 1] - g, h[i - 1] + g);
      for (let i = M - 2; i >= 0; i--) h[i] = clamp(h[i], h[i + 1] - g, h[i + 1] + g);
    }
    r.h = Float32Array.from(h);
    r.length = polylineLength(P, r.closed);
    // superelevation: bank corners (tan of the cross slope, + = outside raised)
    const turn = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const a0 = P[r.closed ? (i - 3 + M) % M : Math.max(0, i - 3)], a1 = P[i], a2 = P[r.closed ? (i + 3) % M : Math.min(M - 1, i + 3)];
      const t1x = a1[0] - a0[0], t1z = a1[1] - a0[1], t2x = a2[0] - a1[0], t2z = a2[1] - a1[1];
      const cross = t1x * t2z - t1z * t2x, l = Math.hypot(t1x, t1z) * Math.hypot(t2x, t2z) || 1;
      const ang = Math.asin(clamp(cross / l, -1, 1)); // turning per ~12 m
      const curv = ang / 12;
      const maxB = r.type === 'highway' ? 0.05 : r.type === 'pass' ? 0.09 : r.type === 'road' ? 0.07 : 0;
      turn[i] = clamp(curv * 7, -1, 1) * maxB;
    }
    r.bank = new Float32Array(M);
    for (let i = 0; i < M; i++) { let sum = 0, c = 0; for (let k = -6; k <= 6; k++) { let j = i + k; if (r.closed) j = (j + M) % M; else if (j < 0 || j >= M) continue; sum += turn[j]; c++; } r.bank[i] = sum / c; }
    // kicker jumps on the trails
    r.jumps = [];
    if (r.type === 'dirt' && M > 120) {
      for (const f of [0.3, 0.72]) {
        const ci = Math.floor(M * f);
        r.jumps.push(ci);
        for (let k = -10; k <= 3; k++) { const j = (ci + k + M) % M; const up = k <= 0 ? (k + 10) / 10 : Math.max(0, 1 - k / 1.5); r.h[j] += 2.3 * up * up; }
      }
    }
  }
  // town and festival are flat plates
  const townH = sampleRaw(T0[0], T0[1]);
  const festH = sampleRaw(L.festival[0], L.festival[1]);
  for (const r of roads) if (r.type === 'street') r.h.fill(townH);

  // ---------- carve roads + plates into the terrain; build surface map
  const dist = new Float32Array(N * N).fill(1e9);
  const target = new Float32Array(N * N);
  const reach = new Float32Array(N * N);
  const surf = new Uint8Array(N * N);
  const roadOf = new Int16Array(N * N).fill(-1);
  roads.forEach((r, ri) => {
    const half = r.width / 2, R2 = half + 34;
    const P = r.pts, M = P.length;
    for (let i = 0; i < M; i++) {
      const [x, z] = P[i];
      const ix0 = Math.max(0, Math.floor((x - R2 + HALF) / CELL)), ix1 = Math.min(N - 1, Math.ceil((x + R2 + HALF) / CELL));
      const iz0 = Math.max(0, Math.floor((z - R2 + HALF) / CELL)), iz1 = Math.min(N - 1, Math.ceil((z + R2 + HALF) / CELL));
      const j = r.closed ? (i + 1) % M : Math.min(i + 1, M - 1);
      const [bx, bz] = P[j];
      const sx = bx - x, sz = bz - z, sl = sx * sx + sz * sz || 1;
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
        const cx = wx(ix), cz = wx(iz);
        const t = clamp(((cx - x) * sx + (cz - z) * sz) / sl, 0, 1);
        const d = Math.hypot(cx - (x + sx * t), cz - (z + sz * t));
        const c = idx(ix, iz);
        if (d < dist[c]) {
          dist[c] = d;
          // lateral side: + = right of travel; bank raises the outside of the turn
          const side = Math.sign(sx * (cz - z) - sz * (cx - x)) || 1;
          const bank = r.bank ? r.bank[i] : 0;
          target[c] = r.h[i] + (r.h[j] - r.h[i]) * t + side * Math.min(d, half + 2) * bank;
          reach[c] = half;
          roadOf[c] = ri;
        }
      }
    }
  });
  const plates = [
    { c: L.festival, r: 170, h: festH },
    { c: T0, r: 380, h: townH, square: true },
    { c: A, r: 0, h: null },
  ];
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const c = idx(ix, iz), x = wx(ix), z = wx(iz);
    let h = H[c];
    for (const p of plates) {
      if (!p.r) continue;
      const d = p.square ? Math.max(Math.abs(x - p.c[0]), Math.abs(z - p.c[1])) : Math.hypot(x - p.c[0], z - p.c[1]);
      h = lerp(h, p.h, 1 - smoothstep(p.r, p.r + 90, d));
    }
    if (dist[c] < 1e8) {
      const w = 1 - smoothstep(reach[c] + 1.5, reach[c] + 32, dist[c]);
      h = lerp(h, target[c] - 0.05, w);
    }
    H[c] = h;
    // surfaces
    let s = S_GRASS;
    if (h < SEA - 0.4) s = S_WATER;
    else if (h < SEA + 2.2 && z > 600) s = S_SAND;
    if (dist[c] <= reach[c] + 0.6) s = roads[roadOf[c]].surf;
    surf[c] = s;
  }

  return { seed, H, surf, dist, roadOf, roads, landmarks: L, townH, festH, N, CELL, HALF, SIZE, R };
}

/** Bilinear sample of a world grid. */
export function sampleGrid(G, x, z) {
  const fx = clamp((x + HALF) / CELL, 0, NCELL - 1.001), fz = clamp((z + HALF) / CELL, 0, NCELL - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), ux = fx - ix, uz = fz - iz;
  const i = iz * NCELL + ix;
  return (G[i] * (1 - ux) + G[i + 1] * ux) * (1 - uz) + (G[i + NCELL] * (1 - ux) + G[i + NCELL + 1] * ux) * uz;
}
export function cellOf(x, z) {
  const ix = clamp(Math.round((x + HALF) / CELL), 0, NCELL - 1), iz = clamp(Math.round((z + HALF) / CELL), 0, NCELL - 1);
  return iz * NCELL + ix;
}

/**
 * The physics "track" for the open world: terrain height, slope normal and
 * surface under any point. No walls; the vehicle model asks for per-wheel
 * surfaces with surfaceXZ.
 */
export function worldTrack(W) {
  const q = { i: 0, s: 0, d: 0, e: 0, height: 0, surface: 2, bank: 0, grade: 0, normal: [0, 1, 0], wallDist: 1e9, wallLeft: false, wallRight: false, runoff: 1e9, tangent: [0, 1], nrm: [1, 0], kerb: false };
  const T = {
    open: true,
    N: 1, DS: 2, length: 1e9, half: 1e6, width: 2e6,
    px: [0], pz: [0], tx: [0], tz: [1], nx: [1], nz: [0], gravelL: [0], gravelR: [0], kerb: [0], runL: [1e9], runR: [1e9],
    height: (x, z) => sampleGrid(W.H, x, z),
    surfaceXZ: (x, z) => {
      const s = W.surf[cellOf(x, z)];
      return s === S_WATER ? S_DIRT : s;
    },
    query(x, z) {
      const h = sampleGrid(W.H, x, z);
      const e = 1.5;
      const hx = sampleGrid(W.H, x + e, z) - sampleGrid(W.H, x - e, z);
      const hz = sampleGrid(W.H, x, z + e) - sampleGrid(W.H, x, z - e);
      const gx = hx / (2 * e), gz = hz / (2 * e);
      const nl = Math.hypot(gx, 1, gz);
      q.height = h;
      q.normal[0] = -gx / nl; q.normal[1] = 1 / nl; q.normal[2] = -gz / nl;
      const s = W.surf[cellOf(x, z)];
      q.surface = s === S_WATER ? S_DIRT : s;
      q.water = s === S_WATER ? SEA - h : 0;
      return q;
    },
  };
  return T;
}
