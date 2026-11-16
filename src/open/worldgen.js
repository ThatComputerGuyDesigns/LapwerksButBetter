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
  const addRoad = (id, name, type, ctrl, closed = false) => {
    const dense0 = closed ? catmullRomClosed(ctrl, 12) : catmullOpen(ctrl, 12);
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
  // mountain pass: switchbacks up to the summit and down the far side
  addRoad('pass', 'Summit Pass', 'pass', [[-560, -1060], [-430, -1230], [-640, -1330], [-420, -1450], [-620, -1560], [-330, -1650], L.summit, [120, -1700], [330, -1560], [180, -1440], [420, -1360], [300, -1230], [560, -1120]]);
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
    const win = r.type === 'runway' ? 60 : r.type === 'street' ? 20 : 14;
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
          target[c] = r.h[i] + (r.h[j] - r.h[i]) * t;
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
