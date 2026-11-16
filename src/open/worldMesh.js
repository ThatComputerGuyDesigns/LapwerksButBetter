// Open world visuals: chunked terrain on scanned materials, water, road
// ribbons with real markings, forests with near/far LOD, the town, the
// festival site (stage, tents, flags, Ferris wheel), airfield and lighthouse.
import * as THREE from 'three';
import { terrainMaterial, pbr, pbrMaterial } from '../world/realtex.js';
import { coniferGeometry, broadleafGeometry, palmGeometry } from '../world/environment.js';
import { batchStatic } from '../world/batch.js';
import { sampleGrid, cellOf, SEA, HALF, CELL, NCELL, S_WATER, S_SAND } from './worldgen.js';
import { rng, clamp, smoothstep, makeNoise2D } from '../core/math.js';

export function buildOpenWorld(W) {
  const root = new THREE.Group();
  root.name = 'openworld';
  const R = rng(W.seed * 31 + 7);
  const H = W.H;
  const hAt = (x, z) => sampleGrid(H, x, z);
  const updaters = [];

  // ------------------------------------------------------------ terrain
  const tmat = terrainMaterial({ sandLevel: SEA + 2.4, snowLevel: 395 });
  const STEP = 2; // every 2nd cell → 8 m vertices
  const CH = 50; // quads per chunk side → 400 m chunks
  const VN = (NCELL - 1) / STEP; // quads per side (500)
  for (let cz = 0; cz < VN; cz += CH) for (let cx = 0; cx < VN; cx += CH) {
    const nx = Math.min(CH, VN - cx) + 1, nz = Math.min(CH, VN - cz) + 1;
    const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), idx = [];
    let k = 0, allWet = true;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const ix = (cx + i) * STEP, iz = (cz + j) * STEP;
      const c = iz * NCELL + ix;
      const x = -HALF + ix * CELL, z = -HALF + iz * CELL;
      const h = H[c];
      if (h > SEA - 3) allWet = false;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      // dirt weight: trails, road verges
      let dirt = 0;
      const d = W.dist[c], r = W.roadOf[c] >= 0 ? W.roads[W.roadOf[c]] : null;
      if (r) {
        if (r.type === 'dirt') dirt = 1 - smoothstep(r.width / 2 - 0.5, r.width / 2 + 3, d);
        else dirt = 0.7 * (1 - smoothstep(r.width / 2 + 0.5, r.width / 2 + 4, d)) * smoothstep(r.width / 2 - 0.5, r.width / 2 + 0.5, d);
      }
      col[k * 3] = dirt;
      k++;
    }
    if (allWet) continue; // fully under the sea: skip
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c2 = a + nx, d2 = c2 + 1;
      idx.push(a, c2, b, b, c2, d2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, tmat);
    m.receiveShadow = true;
    root.add(m);
  }
  // far ocean floor / horizon skirt
  const skirt = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), new THREE.MeshStandardMaterial({ color: 0x1d3b44, roughness: 1 }));
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.y = -30;
  root.add(skirt);

  // ------------------------------------------------------------ water
  {
    const tex = waterNormals();
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x0f5368, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.86,
      normalMap: tex, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.3, clearcoat: 1, clearcoatRoughness: 0.05,
    });
    tex.repeat.set(220, 220);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000, 1, 1), mat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = SEA;
    water.renderOrder = 2;
    root.add(water);
    updaters.push((dt) => { tex.offset.x += dt * 0.004; tex.offset.y += dt * 0.0025; });
  }

  // ------------------------------------------------------------ roads
  const roadT = pbr('road'), asphT = pbr('asphalt');
  W.roads.forEach((r, ri) => {
    if (r.type === 'dirt') return; // trails are painted into the terrain
    const P = r.pts, M = P.length, half = r.width / 2;
    const across = 4;
    const pos = [], uv = [], idx = [];
    let along = 0;
    for (let i = 0; i <= (r.closed ? M : M - 1); i++) {
      const p = P[i % M], q = P[Math.min(i + 1, M - 1) % M], o = P[Math.max(i - 1, 0) % M];
      let tx = q[0] - o[0], tz = q[1] - o[1];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      if (i > 0) along += Math.hypot(p[0] - P[(i - 1) % M][0], p[1] - P[(i - 1) % M][1]);
      for (let k = 0; k <= across; k++) {
        const f = k / across, d = (f - 0.5) * 2 * half;
        const x = p[0] + tz * d, z = p[1] - tx * d;
        pos.push(x, hAt(x, z) + 0.07 + ri * 0.002, z);
        uv.push(f, along / (r.type === 'runway' ? 30 : r.width));
      }
    }
    const rows = pos.length / 3 / (across + 1);
    for (let i = 0; i < rows - 1; i++) for (let k = 0; k < across; k++) {
      const a = i * (across + 1) + k, b = a + 1, c = a + across + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const t = r.type === 'runway' ? asphT : roadT;
    const mat = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughnessMap: t.orm, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 - ri * 0.05, polygonOffsetUnits: -2 });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    root.add(m);
  });

  // ------------------------------------------------------------ forests (near/far LOD tiles)
  const forest = buildForests(W, R, hAt);
  root.add(forest.group);

  // ------------------------------------------------------------ rocks on steep ground
  {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const n = makeNoise2D(5);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const k = 0.75 + 0.45 * (n(p.getX(i) * 2, p.getZ(i) * 2 + p.getY(i)) * 0.5 + 0.5); p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k); }
    geo.computeVertexNormals();
    const mat = pbrMaterial('rock', { color: 0x8c8780 });
    const list = [];
    for (let k = 0; k < 7000 && list.length < 1400; k++) {
      const x = (R() - 0.5) * 3800, z = (R() - 0.5) * 3800;
      const c = cellOf(x, z);
      if (W.surf[c] === S_WATER || W.dist[c] < 14) continue;
      const h = hAt(x, z), sl = Math.abs(hAt(x + 4, z) - hAt(x - 4, z)) + Math.abs(hAt(x, z + 4) - hAt(x, z - 4));
      if (sl < 3 && R() > 0.06) continue;
      const s = 1 + R() * (sl > 3 ? 6 : 2.5);
      list.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h - s * 0.25, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(R() * 0.5, R() * 6.3, R() * 0.5)), new THREE.Vector3(s, s, s)));
    }
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true; im.receiveShadow = true;
    root.add(im);
  }

  // ------------------------------------------------------------ town, festival, airfield, landmarks
  root.add(buildTown(W, R, hAt));
  const fest = buildFestival(W, R, hAt);
  root.add(fest.group);
  updaters.push(fest.update);
  root.add(buildAirfield(W, hAt));
  root.add(buildLighthouse(W, hAt));

  return {
    group: root,
    update(dt, cam) {
      for (const u of updaters) u(dt);
      forest.lod(cam);
    },
  };
}

// ------------------------------------------------------------------ helpers
function waterNormals() {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const h = new Float32Array(S * S);
  const waves = Array.from({ length: 14 }, (_, k) => ({ kx: Math.round(Math.cos(k * 2.4) * (2 + k)), kz: Math.round(Math.sin(k * 2.4) * (2 + k)), a: 1 / (1 + k * 0.6), p: k * 1.7 }));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(((x * w.kx + y * w.kz) / S) * Math.PI * 2 + w.p);
    h[y * S + x] = v;
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
    const dy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
    const nx = -dx * 0.5, ny = -dy * 0.5, nz = 1, l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function simpleConifer() {
  const g = new THREE.ConeGeometry(2.6, 9, 7, 1);
  g.translate(0, 6, 0);
  const tr = new THREE.CylinderGeometry(0.25, 0.3, 2, 5);
  tr.translate(0, 1, 0);
  return mergeColored([[g, [0.07, 0.14, 0.05]], [tr, [0.3, 0.2, 0.13]]]);
}
function simpleBroad() {
  const g = new THREE.IcosahedronGeometry(3, 0);
  g.translate(0, 5.2, 0);
  const tr = new THREE.CylinderGeometry(0.3, 0.4, 3.4, 5);
  tr.translate(0, 1.7, 0);
  return mergeColored([[g, [0.17, 0.29, 0.1]], [tr, [0.32, 0.24, 0.17]]]);
}
function mergeColored(list) {
  let total = 0;
  const geos = list.map(([g, c]) => { const n = g.index ? g.toNonIndexed() : g; total += n.attributes.position.count; return [n, c]; });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const [g, c] of geos) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < g.attributes.position.count; i++) col.set(c, (o + i) * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function buildForests(W, R, hAt) {
  const n = makeNoise2D(W.seed * 7 + 3);
  const kinds = { conifer: [], broad: [], palm: [] };
  const L = W.landmarks;
  for (let k = 0; k < 140000; k++) {
    const x = (R() - 0.5) * 3900, z = (R() - 0.5) * 3900;
    const c = cellOf(x, z);
    const s = W.surf[c];
    if (s === S_WATER) continue;
    const r = W.roadOf[c] >= 0 ? W.roads[W.roadOf[c]] : null;
    if (r && W.dist[c] < r.width / 2 + 7) continue;
    if (Math.hypot(x - L.festival[0], z - L.festival[1]) < 230) continue;
    if (Math.abs(x - L.town[0]) < 330 && Math.abs(z - L.town[1]) < 300) continue;
    if (Math.abs(x - L.airfield[0]) < 90 && Math.abs(z - L.airfield[1]) < 700) continue;
    const h = hAt(x, z);
    const sl = Math.abs(hAt(x + 4, z) - hAt(x - 4, z)) + Math.abs(hAt(x, z + 4) - hAt(x, z - 4));
    if (sl > 5.5 || h > 300) continue;
    // density: dense western forest, groves elsewhere, sparse on the plains
    const west = smoothstep(-500, -1100, x);
    const north = smoothstep(-300, -900, z);
    const grove = n.fbm(x / 260, z / 260, 3);
    let p = clamp(0.06 + grove * 0.9 + west * 0.7 + north * 0.35, 0, 0.95);
    if (s === S_SAND) { if (R() < 0.18) kinds.palm.push([x, h, z]); continue; }
    if (R() > p * 0.55) continue;
    const coni = north > 0.4 || (west > 0.5 && R() < 0.75) || h > 120;
    (coni ? kinds.conifer : kinds.broad).push([x, h, z]);
    if (kinds.conifer.length + kinds.broad.length > 26000) break;
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.45 });
  const geos = {
    conifer: [coniferGeometry(), simpleConifer()],
    broad: [broadleafGeometry(), simpleBroad()],
    palm: [palmGeometry(), palmGeometry()],
  };
  const TILE = 400;
  const tiles = new Map();
  const group = new THREE.Group();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  for (const [kind, list] of Object.entries(kinds)) {
    const byTile = new Map();
    for (const it of list) {
      const key = `${Math.floor(it[0] / TILE)},${Math.floor(it[2] / TILE)}`;
      if (!byTile.has(key)) byTile.set(key, []);
      byTile.get(key).push(it);
    }
    for (const [key, items] of byTile) {
      const [tx, tz] = key.split(',').map(Number);
      const make = (geo, lod) => {
        const im = new THREE.InstancedMesh(geo, mat, items.length);
        items.forEach(([x, y, z], i) => {
          const s = 0.8 + R() * 0.75;
          q.setFromAxisAngle(Y, R() * 6.28);
          m4.compose(v.set(x, y - 0.3, z), q, sc.set(s, s * (0.85 + R() * 0.4), s));
          im.setMatrixAt(i, m4);
          col.setRGB(0.78 + R() * 0.4, 0.8 + R() * 0.35, 0.68 + R() * 0.3);
          im.setColorAt(i, col);
        });
        im.computeBoundingSphere();
        im.castShadow = lod === 0;
        im.receiveShadow = true;
        im.visible = lod === 1;
        group.add(im);
        return im;
      };
      const t = tiles.get(key) || { cx: (tx + 0.5) * TILE, cz: (tz + 0.5) * TILE, hi: [], lo: [] };
      t.hi.push(make(geos[kind][0], 0));
      t.lo.push(make(geos[kind][1], 1));
      tiles.set(key, t);
    }
  }
  const tileList = [...tiles.values()];
  return {
    group,
    lod(cam) {
      for (const t of tileList) {
        const near = Math.hypot(cam.position.x - t.cx, cam.position.z - t.cz) < 650;
        for (const m of t.hi) m.visible = near;
        for (const m of t.lo) m.visible = !near;
      }
    },
  };
}

function facadeTexture(seed, base, win) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  const r = rng(seed);
  g.fillStyle = base; g.fillRect(0, 0, 256, 512);
  for (let k = 0; k < 400; k++) { g.fillStyle = `rgba(0,0,0,${r() * 0.04})`; g.fillRect(r() * 256, r() * 512, 3 + r() * 20, 2 + r() * 6); }
  const cols = 4, rows = 8;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = 16 + i * 60, y = 18 + j * 62;
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x - 2, y - 2, 44, 42);
    const lit = r();
    g.fillStyle = lit > 0.85 ? '#d8c89a' : `rgb(${40 + lit * 40},${55 + lit * 40},${70 + lit * 50})`;
    g.fillRect(x, y, 40, 38);
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x, y, 40, 6);
    g.fillStyle = win; g.fillRect(x + 19, y, 2, 38);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildTown(W, R, hAt) {
  const g = new THREE.Group();
  const T0 = W.landmarks.town;
  const palettes = [['#c9b9a0', '#3b3b3b'], ['#b98d6a', '#2b2b2b'], ['#d9d4c8', '#444'], ['#8c949c', '#222'], ['#a8604a', '#333'], ['#e2d6bf', '#555']];
  const mats = palettes.map(([b, w], k) => new THREE.MeshStandardMaterial({ map: facadeTexture(k + 3, b, w), roughness: 0.85 }));
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.9 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x5f7d93, roughness: 0.06, metalness: 0.5, envMapIntensity: 1.4 });
  const y0 = W.townH;
  {
    const pave = pbrMaterial('asphalt', { color: 0xb8b4ac });
    for (const k of ['map', 'normalMap', 'roughnessMap']) { pave[k] = pave[k].clone(); pave[k].repeat.set(90, 80); pave[k].needsUpdate = true; }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(620, 560), pave);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(T0[0], y0 + 0.03, T0[1]);
    ground.receiveShadow = true;
    g.add(ground);
  }
  for (let i = -3; i < 3; i++) for (let j = -3; j < 3; j++) {
    const bx = T0[0] + (i + 0.5) * 95, bz = T0[1] + (j + 0.5) * 85;
    const lots = R() < 0.25 ? 1 : 4;
    for (let k = 0; k < lots; k++) {
      const w = lots === 1 ? 66 : 28 + R() * 6, d = lots === 1 ? 56 : 24 + R() * 6;
      const ox = lots === 1 ? 0 : (k % 2 ? 1 : -1) * 19, oz = lots === 1 ? 0 : (k < 2 ? 1 : -1) * 17;
      const centre = Math.hypot(i + 0.5, j + 0.5);
      const h = (lots === 1 ? 14 : 9) + R() * (centre < 1.5 ? 42 : 18);
      const tower = lots === 1 && centre < 1.2 && R() < 0.6;
      const mat = tower ? glass : mats[Math.floor(R() * mats.length)];
      const geo = new THREE.BoxGeometry(w, h, d);
      // facade UVs in metres so windows keep their size
      const uvA = geo.attributes.uv, pA = geo.attributes.position, nA = geo.attributes.normal;
      for (let v = 0; v < uvA.count; v++) {
        const ax = Math.abs(nA.getX(v)) > 0.5 ? pA.getZ(v) : pA.getX(v);
        uvA.setXY(v, ax / 13, (pA.getY(v) + h / 2) / 26);
      }
      const b = new THREE.Mesh(geo, [mat, mat, roofMat, roofMat, mat, mat]);
      b.position.set(bx + ox, y0 + h / 2, bz + oz);
      b.castShadow = true; b.receiveShadow = true;
      g.add(b);
      // rooftop units
      if (R() < 0.7) { const u = new THREE.Mesh(new THREE.BoxGeometry(4 + R() * 6, 2 + R() * 2, 4 + R() * 6), roofMat); u.position.set(bx + ox + (R() - 0.5) * w * 0.4, y0 + h + 1.2, bz + oz + (R() - 0.5) * d * 0.4); g.add(u); }
    }
  }
  // street lights along the avenues
  const pole = new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.6, roughness: 0.4 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2b0, emissiveIntensity: 0.4 });
  for (const r of W.roads.filter((q) => q.type === 'street')) {
    for (let i = 6; i < r.pts.length; i += 10) {
      const [x, z] = r.pts[i], [x2, z2] = r.pts[i + 1] || r.pts[i - 1];
      const tx = x2 - x, tz = z2 - z, l = Math.hypot(tx, tz) || 1;
      const nx = tz / l, nz = -tx / l;
      const px = x + nx * (r.width / 2 + 1.5), pz = z + nz * (r.width / 2 + 1.5);
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 7, 6), pole);
      p.position.set(px, hAt(px, pz) + 3.5, pz);
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 1.2), lamp);
      h.position.set(px - nx * 0.5, hAt(px, pz) + 7, pz - nz * 0.5);
      g.add(p, h);
    }
  }
  batchStatic(g);
  return g;
}

function buildFestival(W, R, hAt) {
  const g = new THREE.Group();
  const [fx, fz] = W.landmarks.festival;
  const y = W.festH;
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5, side: THREE.DoubleSide });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8d939b, metalness: 0.8, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.6 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 0.35, roughness: 0.4 });
  const screen = new THREE.MeshStandardMaterial({ color: 0x0a0d12, emissive: 0x2a64ff, emissiveIntensity: 0.6, roughness: 0.2 });
  const tentCols = [0xff5a1f, 0xffd23f, 0x2a64ff, 0xf2f2ee, 0x3ddc84, 0xe0457b];
  // plaza (asphalt) under the site
  const plaza = new THREE.Mesh(new THREE.CircleGeometry(150, 48), pbrMaterial('asphalt'));
  plaza.material.map.repeat?.set(30, 30);
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(fx, y + 0.04, fz);
  plaza.receiveShadow = true;
  g.add(plaza);
  // main stage with screens
  const stage = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(34, 2, 16), dark);
  deck.position.y = 1;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 18, 24, 1, true, 0, Math.PI), white);
  roof.rotation.z = Math.PI / 2; roof.rotation.y = Math.PI / 2;
  roof.position.set(0, 10, -2);
  roof.scale.set(1, 1, 0.55);
  const scr = new THREE.Mesh(new THREE.BoxGeometry(22, 9, 0.4), screen);
  scr.position.set(0, 9, -6.5);
  stage.add(deck, roof, scr);
  for (const sx of [-1, 1]) { const t = new THREE.Mesh(new THREE.BoxGeometry(2, 20, 2), steel); t.position.set(sx * 17, 10, 4); stage.add(t); }
  stage.position.set(fx - 70, y, fz - 60);
  stage.rotation.y = 0.6;
  g.add(stage);
  // tents
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 1.6 + 2.4, r = 90 + R() * 30;
    const tent = new THREE.Group();
    const top = new THREE.Mesh(new THREE.ConeGeometry(7, 4.5, 4), new THREE.MeshStandardMaterial({ color: tentCols[k % tentCols.length], roughness: 0.6 }));
    top.position.y = 5.6; top.rotation.y = Math.PI / 4;
    const box = new THREE.Mesh(new THREE.BoxGeometry(9.6, 3.6, 9.6), white);
    box.position.y = 1.8;
    tent.add(top, box);
    tent.position.set(fx + Math.cos(a) * r, y, fz + Math.sin(a) * r);
    tent.rotation.y = -a;
    g.add(tent);
  }
  // festival arch over the road entrance
  {
    const arch = new THREE.Group();
    for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(2.2, 14, 2.2), dark); p.position.set(sx * 11, 7, 0); arch.add(p); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(26, 3, 2.4), dark);
    beam.position.y = 14;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(26.2, 0.5, 2.5), orange);
    strip.position.y = 12.6;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(20, 2.4), new THREE.MeshBasicMaterial({ map: signTexture('KERBSTONE FESTIVAL'), transparent: true }));
    sign.position.set(0, 14.1, 1.25);
    const sign2 = sign.clone(); sign2.rotation.y = Math.PI; sign2.position.z = -1.25;
    arch.add(beam, strip, sign, sign2);
    const road = W.roads.find((r) => r.id === 'north');
    let best = road.pts[0], bd = Infinity, bi = 0;
    road.pts.forEach((p, i) => { const d = Math.hypot(p[0] - fx, p[1] - (fz - 170)); if (d < bd) { bd = d; best = p; bi = i; } });
    const nxt = road.pts[bi + 1];
    arch.position.set(best[0], hAt(best[0], best[1]), best[1]);
    arch.rotation.y = Math.atan2(nxt[0] - best[0], nxt[1] - best[1]);
    g.add(arch);
  }
  // flags
  const flagGeo = new THREE.PlaneGeometry(1.4, 4.2, 1, 6);
  flagGeo.translate(0.7, 0, 0);
  const flags = [];
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2, r = 145;
    const px = fx + Math.cos(a) * r, pz = fz + Math.sin(a) * r;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 9, 6), steel);
    pole.position.set(px, y + 4.5, pz);
    const f = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: tentCols[k % tentCols.length], side: THREE.DoubleSide, roughness: 0.7 }));
    f.position.set(px, y + 6.5, pz);
    f.rotation.y = R() * 6;
    g.add(pole, f);
    flags.push(f);
  }
  // Ferris wheel
  const wheel = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(22, 0.35, 8, 64), steel);
  const rim2 = rim.clone(); rim2.position.z = 3;
  wheel.add(rim, rim2);
  const gondolas = [];
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2;
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.25, 22, 0.25), steel);
    sp.geometry.translate(0, 11, 0);
    sp.rotation.z = a;
    wheel.add(sp);
    const gd = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2, 2.6), new THREE.MeshStandardMaterial({ color: tentCols[k % tentCols.length], roughness: 0.5 }));
    gd.userData.a = a;
    wheel.add(gd);
    gondolas.push(gd);
  }
  const lights = new THREE.Mesh(new THREE.TorusGeometry(22.6, 0.15, 6, 96), orange);
  wheel.add(lights);
  const ferris = new THREE.Group();
  ferris.add(wheel);
  wheel.position.y = 26;
  for (const sx of [-1, 1]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 28, 0.8), steel); leg.position.set(sx * 7, 13, 1.5); leg.rotation.z = sx * 0.26; ferris.add(leg); }
  ferris.position.set(fx + 90, y, fz - 40);
  ferris.rotation.y = -0.5;
  g.add(ferris);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  plaza.castShadow = false;
  let t = 0;
  return {
    group: g,
    update(dt) {
      t += dt;
      wheel.rotation.z = t * 0.05;
      for (const gd of gondolas) { const a = gd.userData.a + wheel.rotation.z; gd.position.set(Math.cos(a) * 22, Math.sin(a) * 22 - 1.5, 1.5); gd.rotation.z = -wheel.rotation.z; }
      flags.forEach((f, k) => { f.rotation.y += Math.sin(t * 1.3 + k) * dt * 0.4; });
    },
  };
}

function signTexture(text) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const g = c.getContext('2d');
  g.font = '900 italic 92px "Saira Variable", system-ui';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildAirfield(W, hAt) {
  const g = new THREE.Group();
  const [ax, az] = W.landmarks.airfield;
  const steel = new THREE.MeshStandardMaterial({ color: 0xa9adb3, metalness: 0.7, roughness: 0.45, side: THREE.DoubleSide });
  for (let k = 0; k < 3; k++) {
    const hg = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 40, 24, 1, true, 0, Math.PI), steel);
    hg.rotation.z = Math.PI / 2; hg.rotation.y = Math.PI / 2;
    hg.position.set(ax + 120, hAt(ax + 120, az - 300 + k * 60), az - 300 + k * 60);
    hg.rotation.x = 0;
    g.add(hg);
  }
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.5, 22, 12), new THREE.MeshStandardMaterial({ color: 0xe6e2da, roughness: 0.6 }));
  tower.position.set(ax + 90, hAt(ax + 90, az - 60) + 11, az - 60);
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(5, 4, 4, 12), new THREE.MeshPhysicalMaterial({ color: 0x3a5268, roughness: 0.05, metalness: 0.4 }));
  cab.position.set(ax + 90, hAt(ax + 90, az - 60) + 24, az - 60);
  g.add(tower, cab);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function buildLighthouse(W, hAt) {
  const g = new THREE.Group();
  // on the coast near the east end of the coast road
  const x = 1250, z = 1320, y = Math.max(hAt(x, z), 2);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.6, 26, 20), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.6 }));
  body.position.set(x, y + 13, z);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 3.05, 4, 20), new THREE.MeshStandardMaterial({ color: 0xc8202a, roughness: 0.5 }));
  band.position.set(x, y + 14, z);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 3, 12), new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0b0, emissiveIntensity: 1.2 }));
  lamp.position.set(x, y + 27.5, z);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.4, 20), new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.4, metalness: 0.5 }));
  cap.position.set(x, y + 30.2, z);
  g.add(body, band, lamp, cap);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  return g;
}
