// Turns the pure track description into renderable geometry: road, kerbs,
// runoff, gravel traps, barriers, bridges, start gantry, pit building,
// grandstands and trackside dressing.
import * as THREE from 'three';
import { KERB_W, RUNOFF } from '../track/track.js';
import { clamp, lerp, smoothstep, rng } from '../core/math.js';
import * as TX from './textures.js';

const up = new THREE.Vector3(0, 1, 0);

function edgeHeight(T, i, d) {
  const edge = T.half + KERB_W;
  const tb = Math.tan(T.bank[i]);
  return T.py[i] + clamp(d, -edge, edge) * tb;
}

/** Height of the runoff surface (identical to the physics query). */
function runoffHeight(T, i, d) {
  const edge = T.half + KERB_W;
  const ad = Math.abs(d);
  if (ad <= edge) return T.py[i] + d * Math.tan(T.bank[i]);
  const he = edgeHeight(T, i, d);
  const wallDist = T.half + (d >= 0 ? T.runL[i] : T.runR[i]);
  const t = smoothstep(wallDist, wallDist + 3, ad);
  return he - (0.06 * Math.min(ad - edge, 4)) / 4 - t * 0.35;
}

function pos(T, i, d, h) {
  return [T.px[i] + T.nx[i] * d, h, T.pz[i] + T.nz[i] * d];
}

class GeoBuilder {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.idx = []; this.hasColor = false; }
  get count() { return this.p.length / 3; }
  vert(p, uv, c) {
    this.p.push(p[0], p[1], p[2]);
    this.uv.push(uv[0], uv[1]);
    if (c) { this.c.push(c[0], c[1], c[2]); this.hasColor = true; } else this.c.push(1, 1, 1);
    return this.count - 1;
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, b, d, c); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.hasColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Generic strip along runs of samples where `on(i)` is true. */
function stripAlong(T, on, profile, opts = {}) {
  const B = new GeoBuilder();
  const N = T.N;
  const cols = profile(0).length;
  let prevRow = null;
  for (let k = 0; k <= N; k++) {
    const i = k % N;
    const active = on(i) || (k > 0 && on((k - 1) % N) && opts.extendEnd);
    if (!active) { prevRow = null; continue; }
    const pr = profile(i);
    const row = pr.map((pt, c) => B.vert(pos(T, i, pt.d, pt.h), [opts.u ? opts.u(i, k, pt) : T.s[i] / 4, pt.v ?? c / (cols - 1)], pt.color));
    if (prevRow) {
      for (let c = 0; c < cols - 1; c++) {
        if (opts.flip) B.quad(prevRow[c + 1], prevRow[c], row[c + 1], row[c]);
        else B.quad(prevRow[c], prevRow[c + 1], row[c], row[c + 1]);
      }
    }
    prevRow = row;
  }
  return B.build();
}

export function buildTrackScene(T, line) {
  const group = new THREE.Group();
  group.name = 'track';
  const N = T.N;
  const R = rng(T.def.seed * 13 + 1);

  // ---------------- road
  const asphalt = TX.asphaltTextures();
  const roadMat = new THREE.MeshStandardMaterial({
    map: asphalt.map, roughnessMap: asphalt.roughnessMap, normalMap: asphalt.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: 0, vertexColors: true,
  });
  {
    const M = 12;
    const B = new GeoBuilder();
    const rows = [];
    for (let k = 0; k <= N; k++) {
      const i = k % N;
      const tb = Math.tan(T.bank[i]);
      const off = line ? line.offset[i] : 0;
      const patch = 0.92 + 0.08 * T.noise(T.s[i] / 40 + 3, 0.5);
      const row = [];
      for (let c = 0; c <= M; c++) {
        const d = -T.half + (c / M) * T.width;
        const groove = Math.exp(-(((d - off) / 1.5) ** 2));
        const shade = patch * (1 - 0.2 * groove) * (1 - 0.08 * Math.exp(-(((d - off + 0.85) / 0.35) ** 2)) - 0.08 * Math.exp(-(((d - off - 0.85) / 0.35) ** 2)));
        row.push(B.vert(pos(T, i, d, T.py[i] + d * tb), [(k * T.DS) / (T.width / 2), c / M], [shade, shade, shade]));
      }
      rows.push(row);
    }
    for (let k = 0; k < N; k++) for (let c = 0; c < M; c++) B.quad(rows[k][c + 1], rows[k][c], rows[k + 1][c + 1], rows[k + 1][c]);
    const geo = B.build();
    const road = new THREE.Mesh(geo, roadMat);
    road.receiveShadow = true;
    road.name = 'road';
    group.add(road);
    group.userData.road = road;
  }

  // ---------------- kerbs (raised, striped)
  const kerbMat = new THREE.MeshStandardMaterial({ map: TX.kerbTexture(), roughness: 0.55, metalness: 0 });
  for (const side of [1, -1]) {
    const geo = stripAlong(
      T, (i) => T.kerb[i] === 1,
      (i) => {
        const base = (d) => T.py[i] + d * Math.tan(T.bank[i]);
        const d0 = side * T.half, d1 = side * (T.half + KERB_W * 0.45), d2 = side * (T.half + KERB_W);
        return [
          { d: d0, h: base(d0) + 0.004, v: 0 },
          { d: d1, h: base(d1) + 0.07, v: 0.5 },
          { d: d2, h: base(d2) + 0.035, v: 0.95 },
          { d: d2 + side * 0.15, h: base(d2) - 0.04, v: 1 },
        ];
      },
      { u: (i) => T.s[i] / 3, flip: side > 0 },
    );
    const m = new THREE.Mesh(geo, kerbMat);
    m.receiveShadow = true;
    group.add(m);
  }

  // ---------------- runoff grass (mowed stripes run along the circuit)
  const grassT = TX.grassTextures();
  const runoffTex = TX.runoffGrassTexture();
  const runoffMat = new THREE.MeshStandardMaterial({ map: runoffTex, normalMap: grassT.normalMap, roughness: 0.95, metalness: 0, color: 0xffffff });
  for (const side of [1, -1]) {
    const geo = stripAlong(
      T, () => true,
      (i) => {
        const edge = T.half + KERB_W;
        const wall = Math.max(T.half + (side > 0 ? T.runL[i] : T.runR[i]), edge + 0.6);
        const ds = [T.half - 0.05, edge, lerp(edge, wall, 0.35), lerp(edge, wall, 0.7), wall, wall + 1.5, wall + 3.2];
        return ds.map((ad) => ({ d: side * ad, h: runoffHeight(T, i, side * ad) - (ad < edge + 0.01 ? 0.02 : 0), v: ad / 16 }));
      },
      { u: (i) => T.s[i] / 16, flip: side > 0 },
    );
    const m = new THREE.Mesh(geo, runoffMat);
    m.receiveShadow = true;
    group.add(m);
  }

  // ---------------- gravel traps
  const gravelT = TX.gravelTextures();
  const gravelMat = new THREE.MeshStandardMaterial({ map: gravelT.map, normalMap: gravelT.normalMap, roughness: 1, metalness: 0 });
  for (const side of [1, -1]) {
    const arr = side > 0 ? T.gravelL : T.gravelR;
    const geo = stripAlong(
      T, (i) => arr[i] === 1,
      (i) => {
        const edge = T.half + KERB_W;
        const wall = T.half + (side > 0 ? T.runL[i] : T.runR[i]);
        const a = edge + 2, b = Math.max(a + 0.5, wall - 0.6);
        return [a - 0.6, a, lerp(a, b, 0.5), b, b + 0.4].map((ad, c) => ({
          d: side * ad, h: runoffHeight(T, i, side * ad) + (c === 0 || c === 4 ? -0.03 : 0.035), v: ad / 5,
        }));
      },
      { u: (i) => T.s[i] / 5, flip: side > 0 },
    );
    const m = new THREE.Mesh(geo, gravelMat);
    m.receiveShadow = true;
    group.add(m);
  }

  // ---------------- barriers (steel guard rail, concrete on bridges)
  const steel = new THREE.MeshStandardMaterial({ color: 0xc7ccd3, metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.85, metalness: 0 });
  const postPositions = [];
  for (const side of [1, -1]) {
    const wallArr = side > 0 ? T.wallL : T.wallR;
    const rail = stripAlong(
      T, (i) => wallArr[i] === 1 && !T.deck[i],
      (i) => {
        const w = (T.half + (side > 0 ? T.runL[i] : T.runR[i])) * side;
        const h = runoffHeight(T, i, w - side * 0.2);
        const inset = -side * 0.0;
        return [
          { d: w + inset, h: h + 0.42, v: 0 },
          { d: w - side * 0.08, h: h + 0.52, v: 0.3 },
          { d: w, h: h + 0.6, v: 0.5 },
          { d: w - side * 0.08, h: h + 0.68, v: 0.7 },
          { d: w, h: h + 0.78, v: 1 },
        ];
      },
      { u: (i) => T.s[i] / 4, flip: side > 0 },
    );
    const rm = new THREE.Mesh(rail, steel);
    rm.castShadow = true; rm.receiveShadow = true;
    group.add(rm);
    // concrete parapets on bridge decks
    const para = stripAlong(
      T, (i) => wallArr[i] === 1 && T.deck[i] === 1,
      (i) => {
        const w = (T.half + (side > 0 ? T.runL[i] : T.runR[i])) * side;
        const h = runoffHeight(T, i, w - side * 0.3);
        return [
          { d: w - side * 0.05, h: h - 0.2, v: 0 },
          { d: w, h: h + 0.95, v: 0.3 },
          { d: w + side * 0.35, h: h + 1.0, v: 0.6 },
          { d: w + side * 0.4, h: h - 1.4, v: 1 },
        ];
      },
      { u: (i) => T.s[i] / 4, flip: side > 0 },
    );
    const pm = new THREE.Mesh(para, concrete);
    pm.castShadow = true; pm.receiveShadow = true;
    group.add(pm);
    for (let i = 0; i < N; i += 2) {
      if (!wallArr[i] || T.deck[i]) continue;
      const w = (T.half + (side > 0 ? T.runL[i] : T.runR[i])) * side + side * 0.12;
      const p = pos(T, i, w, runoffHeight(T, i, w - side * 0.3));
      postPositions.push(p);
    }
  }
  {
    const postGeo = new THREE.BoxGeometry(0.12, 0.85, 0.12);
    postGeo.translate(0, 0.38, 0);
    const posts = new THREE.InstancedMesh(postGeo, steel, postPositions.length);
    const m4 = new THREE.Matrix4();
    postPositions.forEach((p, k) => { m4.makeTranslation(p[0], p[1], p[2]); posts.setMatrixAt(k, m4); });
    posts.castShadow = true;
    group.add(posts);
  }

  // ---------------- bridge decks: slab underside + pillars
  if (T.crossings.length && T.heightfield) {
    const slab = stripAlong(
      T, (i) => T.deck[i] === 1,
      (i) => {
        const wl = T.half + T.runL[i] + 0.4, wr = -(T.half + T.runR[i] + 0.4);
        const hl = runoffHeight(T, i, wl - 0.5), hr = runoffHeight(T, i, wr + 0.5);
        return [
          { d: wl, h: hl - 0.3, v: 0 }, { d: wl, h: hl - 1.6, v: 0.2 },
          { d: wr, h: hr - 1.6, v: 0.8 }, { d: wr, h: hr - 0.3, v: 1 },
        ];
      },
      { u: (i) => T.s[i] / 6, flip: true },
    );
    const sm = new THREE.Mesh(slab, concrete);
    sm.castShadow = true; sm.receiveShadow = true;
    group.add(sm);
    const pillarGeo = new THREE.CylinderGeometry(0.7, 0.85, 1, 20);
    pillarGeo.translate(0, 0.5, 0);
    const mats = [];
    for (let i = 0; i < N; i += 7) {
      if (!T.deck[i]) continue;
      for (const side of [1, -1]) {
        const d = side * (T.half - 1);
        const [x, yTop, z] = pos(T, i, d, runoffHeight(T, i, d) - 1.6);
        // don't plant a pillar on the road below
        let blocked = false;
        T.grid.forNear(x, z, T.half + 6, (j) => {
          let gap = Math.abs(i - j); gap = Math.min(gap, N - gap);
          if (gap > 30 && Math.hypot(T.px[j] - x, T.pz[j] - z) < T.half + 4) blocked = true;
        });
        if (blocked) continue;
        const g = sampleHF(T.heightfield, x, z);
        const hgt = yTop - g + 0.5;
        if (hgt < 1.2) continue;
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, g - 0.5, z), new THREE.Quaternion(), new THREE.Vector3(1, hgt, 1)));
      }
    }
    if (mats.length) {
      const pillars = new THREE.InstancedMesh(pillarGeo, concrete, mats.length);
      mats.forEach((m, k) => pillars.setMatrixAt(k, m));
      pillars.castShadow = true; pillars.receiveShadow = true;
      group.add(pillars);
    }
  }

  // ---------------- start / finish line + grid slots
  {
    const chk = TX.checkerTexture();
    const mat = new THREE.MeshStandardMaterial({ map: chk, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
    const geo = new THREE.PlaneGeometry(T.width, 1.6);
    chk.repeat.set(T.width / 3.2, 1);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    const h = T.py[0] + 0.012;
    m.position.set(T.px[0], h, T.pz[0]);
    m.rotation.z = Math.atan2(T.tx[0], T.tz[0]) + Math.PI / 2;
    m.receiveShadow = true;
    // align: plane local X → track normal
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(T.nx[0], 0, T.nz[0]));
    m.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    group.add(m);
    const slotMat = new THREE.MeshBasicMaterial({ color: 0xf2f2ea, polygonOffset: true, polygonOffsetFactor: -2, transparent: true, opacity: 0.85 });
    for (let g = 0; g < 8; g++) {
      const s = T.length - 12 - g * 8;
      const i = Math.floor(s / T.DS) % N;
      const lat = (g % 2 ? -1 : 1) * T.half * 0.45;
      const slot = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.22), slotMat);
      const [x, , z] = pos(T, i, lat, 0);
      slot.position.set(x, T.py[i] + lat * Math.tan(T.bank[i]) + 0.012, z);
      slot.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(T.nx[i], 0, T.nz[i]))).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      group.add(slot);
    }
  }

  // ---------------- start gantry with lights
  const gantry = buildGantry(T);
  group.add(gantry);
  group.userData.startLights = gantry.userData.lights;

  // ---------------- pit building + grandstand on the main straight
  group.add(buildPaddock(T));

  // ---------------- trackside boards before heavy braking zones
  if (line) group.add(buildBrakingBoards(T, line));
  group.add(buildAdBoards(T, R));

  group.traverse((o) => { if (o.isMesh && o.receiveShadow === false) o.receiveShadow = true; });
  return group;
}

export function sampleHF(hf, x, z) {
  const fx = clamp((x - hf.minX) / hf.cell, 0, hf.nx - 1.001);
  const fz = clamp((z - hf.minZ) / hf.cell, 0, hf.nz - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ux = fx - ix, uz = fz - iz;
  const H = hf.h, w = hf.nx;
  return lerp(lerp(H[iz * w + ix], H[iz * w + ix + 1], ux), lerp(H[(iz + 1) * w + ix], H[(iz + 1) * w + ix + 1], ux), uz);
}

function frameAt(T, i) {
  // basis: x = left normal, y = up, z = tangent
  const m = new THREE.Matrix4();
  const X = new THREE.Vector3(T.nx[i], 0, T.nz[i]);
  const Z = new THREE.Vector3(T.tx[i], 0, T.tz[i]);
  m.makeBasis(X, up, Z);
  return m;
}

function buildGantry(T) {
  const g = new THREE.Group();
  const i = 2;
  const span = T.half + 2.2;
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0.7, roughness: 0.4 });
  const h = T.py[i];
  const height = 7.2;
  for (const side of [1, -1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.6, height + 1, 0.6), darkMetal);
    p.position.set(side * span, h + (height + 1) / 2 - 0.5, 0);
    p.castShadow = true;
    g.add(p);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.6, 1.5, 0.7), darkMetal);
  beam.position.set(0, h + height, 0);
  beam.castShadow = true;
  g.add(beam);
  const banner = TX.bannerTexture('KERBSTONE', '#101216', '#ffffff', '#ff5a1f', 1024, 96);
  for (const dir of [1, -1]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, 1.25), new THREE.MeshStandardMaterial({ map: banner, roughness: 0.5, emissive: 0xffffff, emissiveMap: banner, emissiveIntensity: 0.25 }));
    b.position.set(0, h + height, dir * 0.36);
    if (dir < 0) b.rotation.y = Math.PI;
    g.add(b);
  }
  // 5 start lights facing oncoming cars (cars approach from -z)
  const lights = [];
  const lensOff = new THREE.MeshStandardMaterial({ color: 0x1a0505, emissive: 0xff1a10, emissiveIntensity: 0, roughness: 0.3 });
  for (let k = 0; k < 5; k++) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.5), darkMetal);
    housing.position.set((k - 2) * 1.0, h + height - 1.5, -0.1);
    g.add(housing);
    const mat = lensOff.clone();
    for (const yy of [0.3, -0.3]) {
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24), mat);
      lens.position.set((k - 2) * 1.0, h + height - 1.5 + yy, -0.36);
      lens.rotation.y = Math.PI;
      g.add(lens);
    }
    lights.push(mat);
  }
  g.userData.lights = lights;
  g.applyMatrix4(frameAt(T, i));
  g.position.add(new THREE.Vector3(T.px[i], 0, T.pz[i]));
  return g;
}

function buildPaddock(T) {
  const g = new THREE.Group();
  const N = T.N;
  // pick the side with the most room along the first 120 m
  let roomL = Infinity, roomR = Infinity;
  for (let k = -30; k < 60; k++) {
    const i = (k + N) % N;
    roomL = Math.min(roomL, T.runL[i]);
    roomR = Math.min(roomR, T.runR[i]);
  }
  const R = rng(5);
  // ---- pit building
  const pitSide = roomR >= roomL ? -1 : 1;
  if (Math.max(roomL, roomR) >= 10) {
    const wall = new THREE.MeshStandardMaterial({ color: 0xb8b4ad, roughness: 0.75 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x223040, roughness: 0.08, metalness: 0.2, clearcoat: 1, envMapIntensity: 1.4 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.4 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.6, metalness: 0.3 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.4, emissive: 0xff5a1f, emissiveIntensity: 0.15 });
    for (let k = -18; k < 40; k += 6) {
      const i = (k + N) % N;
      const room = pitSide > 0 ? T.runL[i] : T.runR[i];
      const d = pitSide * (T.half + room + 9);
      const p = pos(T, i, d, 0);
      const base = runoffHeight(T, i, pitSide * (T.half + room)) - 0.4;
      const unit = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(12, 9, 11.6), wall);
      body.position.y = 4.5; body.castShadow = true; body.receiveShadow = true;
      unit.add(body);
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.1, 4.2, 9.6), doorMat);
      door.position.set(-pitSide * 6.02, 2.1, 0);
      unit.add(door);
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 11.2), glass);
      win.position.set(-pitSide * 6.05, 6.6, 0);
      unit.add(win);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.25, 11.6), accent);
      stripe.position.set(-pitSide * 6.07, 4.75, 0);
      unit.add(stripe);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(15, 0.5, 11.8), roofMat);
      roof.position.set(-pitSide * 1.5, 9.25, 0);
      roof.castShadow = true;
      unit.add(roof);
      unit.applyMatrix4(frameAt(T, i));
      unit.position.set(p[0], base, p[2]);
      g.add(unit);
    }
  }
  // ---- grandstand opposite
  const gsSide = -pitSide;
  const room = gsSide > 0 ? roomL : roomR;
  if (room >= 8) {
    const crowd = TX.crowdTexture();
    const seatMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.85 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.7, roughness: 0.4 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide });
    for (let k = -10; k < 40; k += 14) {
      const i = (k + N) % N;
      const rm = gsSide > 0 ? T.runL[i] : T.runR[i];
      const d = gsSide * (T.half + rm + 4);
      const p = pos(T, i, d, 0);
      const base = runoffHeight(T, i, gsSide * (T.half + rm)) - 0.4;
      const st = new THREE.Group();
      const tiers = 10;
      for (let t = 0; t < tiers; t++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 27.5), seatMat);
        step.position.set(gsSide * (t * 1.1 + 0.6), 0.9 + t * 0.62, 0);
        step.castShadow = true; step.receiveShadow = true;
        crowd.repeat.set(1, 1);
        st.add(step);
      }
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, 9, 27.5), steelMat);
      back.position.set(gsSide * (tiers * 1.1 + 0.6), 4.5, 0);
      back.castShadow = true;
      st.add(back);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(tiers * 1.1 + 3, 0.3, 28), roofMat);
      roof.position.set(gsSide * (tiers * 1.1 / 2), 10.6, 0);
      roof.rotation.z = gsSide * 0.08;
      roof.castShadow = true;
      st.add(roof);
      for (const zz of [-13, 0, 13]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 10.5, 10), steelMat);
        col.position.set(gsSide * (tiers * 1.1 + 0.6), 5.2, zz);
        st.add(col);
      }
      st.applyMatrix4(frameAt(T, i));
      st.position.set(p[0], base, p[2]);
      g.add(st);
    }
  }
  void R;
  return g;
}

function buildBrakingBoards(T, line) {
  const g = new THREE.Group();
  const N = T.N;
  const v = line.profile ? line.profile.v : null;
  if (!v) return g;
  const boardMat = (txt) => new THREE.MeshStandardMaterial({ map: TX.bannerTexture(txt, '#f4f4f0', '#111111', '#d4202a', 256, 256), roughness: 0.6 });
  const mats = { 150: boardMat('150'), 100: boardMat('100'), 50: boardMat('50') };
  const postMat = new THREE.MeshStandardMaterial({ color: 0x777b82, metalness: 0.6, roughness: 0.4 });
  let last = -9999;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const startBraking = v[i] - v[(i + 6) % N] > 6 && v[(i - 1 + N) % N] <= v[i] + 0.05;
    if (!startBraking || i - last < 60) continue;
    if (v[i] < 30) continue;
    last = i;
    const corner = T.curv[(i + 40) % N];
    const side = corner > 0 ? -1 : 1; // outside of the coming corner
    for (const dist of [150, 100, 50]) {
      const k = (i - Math.round(dist / T.DS) + Math.round(0 / T.DS) + N) % N;
      const room = side > 0 ? T.runL[k] : T.runR[k];
      if (room < 4) continue;
      const d = side * (T.half + Math.min(room - 1.5, 6));
      const p = pos(T, k, d, runoffHeight(T, k, d));
      const b = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 0.06), [postMat, postMat, postMat, postMat, postMat, mats[dist]]);
      panel.position.y = 1.6;
      panel.castShadow = true;
      b.add(panel);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), postMat);
      post.position.y = 0.6;
      b.add(post);
      b.applyMatrix4(frameAt(T, k));
      b.rotateY(Math.PI);
      b.position.set(p[0], p[1], p[2]);
      g.add(b);
    }
    void j;
  }
  return g;
}

const BRANDS = [
  ['VELO FUEL', '#0d3b66', '#ffffff', '#f4d35e'],
  ['NORTHGRIP TYRES', '#111214', '#f5f5f5', '#18a558'],
  ['ARCWAVE AUDIO', '#5b2a86', '#ffffff', '#ff7ab6'],
  ['KERBSTONE', '#ff5a1f', '#111111', '#111111'],
  ['HALCYON WATCHES', '#f1efe9', '#1d1d1d', '#b08d57'],
  ['MERIDIAN OIL', '#0e7c7b', '#ffffff', '#ffd166'],
];

function buildAdBoards(T, R) {
  const g = new THREE.Group();
  const N = T.N;
  const legs = new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.5, roughness: 0.5 });
  for (let i = 0; i < N; i += 1) {
    if (i % 37 !== 0) continue;
    if (Math.abs(T.curv[i]) > 1 / 200) continue;
    const side = R() > 0.5 ? 1 : -1;
    const wallArr = side > 0 ? T.wallL : T.wallR;
    if (!wallArr[i] || T.deck[i]) continue;
    const room = side > 0 ? T.runL[i] : T.runR[i];
    const d = side * (T.half + room + 0.9);
    const [bg, fg, acc] = BRANDS[Math.floor(R() * BRANDS.length)].slice(1);
    const name = BRANDS.find((b) => b[1] === bg)[0];
    const tex = TX.bannerTexture(name, bg, fg, acc, 1024, 128);
    const board = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.25), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
    panel.position.y = 1.35;
    board.add(panel);
    const back = new THREE.Mesh(new THREE.BoxGeometry(10.1, 1.35, 0.08), legs);
    back.position.set(0, 1.35, side * 0.05 * 0 + 0.05);
    board.add(back);
    panel.position.z = -0.0;
    board.applyMatrix4(frameAt(T, i));
    // face the track: plane normal (+z local) must point toward -side * normal
    board.rotateY(side > 0 ? -Math.PI / 2 : Math.PI / 2);
    const p = pos(T, i, d, runoffHeight(T, i, d - side * 0.9));
    board.position.set(p[0], p[1], p[2]);
    board.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(board);
  }
  return g;
}

export function buildRacingLineMesh(T, line, profile) {
  const B = new GeoBuilder();
  const N = T.N;
  const rows = [];
  for (let k = 0; k <= N; k++) {
    const i = k % N;
    const dv = profile.v[(i + 8) % N] - profile.v[i];
    let c;
    if (dv < -1.2) c = [1, 0.18, 0.12];
    else if (dv < -0.25) c = [1, 0.78, 0.15];
    else c = [0.2, 0.95, 0.45];
    const off = line.offset[i];
    const tb = Math.tan(T.bank[i]);
    const row = [-0.22, 0.22].map((dd) => {
      const d = off + dd;
      return B.vert(pos(T, i, d, T.py[i] + d * tb + 0.02), [0, 0], c);
    });
    rows.push(row);
  }
  for (let k = 0; k < N; k++) B.quad(rows[k][1], rows[k][0], rows[k + 1][1], rows[k + 1][0]);
  const geo = B.build();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 2;
  return m;
}

export { RUNOFF };
