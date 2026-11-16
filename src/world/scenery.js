// Scenery that makes a circuit feel like a place: a mountain range on the
// horizon, rocks and bushes, catch fences, floodlight towers, marshal huts
// and corner grandstands. All instanced / merged for performance.
import * as THREE from 'three';
import { rng, clamp, smoothstep } from '../core/math.js';
import { crowdTexture, radialTexture } from './textures.js';
import { envOf } from '../track/environments.js';

const sampleHF = (hf, x, z) => {
  const fx = clamp((x - hf.minX) / hf.cell, 0, hf.nx - 1.001), fz = clamp((z - hf.minZ) / hf.cell, 0, hf.nz - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), ux = fx - ix, uz = fz - iz, H = hf.h, w = hf.nx;
  return (H[iz * w + ix] * (1 - ux) + H[iz * w + ix + 1] * ux) * (1 - uz) + (H[(iz + 1) * w + ix] * (1 - ux) + H[(iz + 1) * w + ix + 1] * ux) * uz;
};

/** Distant mountain ring (vertex-coloured: forest → rock → snow). */
export function buildMountains(T) {
  const n = T.noise;
  const b = T.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const R0 = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 2300;
  const segA = 220, segR = 10;
  const pos = [], col = [], idx = [];
  const M = envOf(T.env).mountains;
  const pal = { alpine: [0x2c4430, 0x5d6169, 0xe8ebf0], desert: [0xb98a58, 0xc9a070, 0xe0c090], city: [0x3a4a3a, 0x60656c, 0x7a7f86], low: [0x3a5236, 0x5d6169, 0x6a6e74] }[M] || [0x2c4430, 0x5d6169, 0xe8ebf0];
  const forest = new THREE.Color(pal[0]), rock = new THREE.Color(pal[1]), snow = new THREE.Color(pal[2]);
  const peak = M === 'alpine' ? 1 : M === 'desert' ? 0.55 : 0.3;
  for (let r = 0; r <= segR; r++) {
    for (let a = 0; a <= segA; a++) {
      const t = (a / segA) * Math.PI * 2;
      const rr = R0 + (r / segR) * 1800;
      const ridge = Math.pow(Math.max(0, n.fbm(Math.cos(t) * 3.1 + 10, Math.sin(t) * 3.1, 5) + 0.35), 1.6);
      const prof = Math.sin((r / segR) * Math.PI); // rises then falls away
      const h = T.meanY - 20 + prof * (140 + ridge * 720) * peak;
      pos.push(cx + Math.cos(t) * rr, h, cz + Math.sin(t) * rr);
      const rel = (h - T.meanY) / (700 * peak);
      const c = forest.clone().lerp(rock, smoothstep(0.15, 0.45, rel)).lerp(snow, smoothstep(0.78, 0.95, rel + (n(t * 9, r) * 0.06)));
      col.push(c.r, c.g, c.b);
    }
  }
  for (let r = 0; r < segR; r++) for (let a = 0; a < segA; a++) {
    const i = r * (segA + 1) + a;
    idx.push(i, i + 1, i + segA + 1, i + 1, i + segA + 2, i + segA + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  m.name = 'mountains';
  return m;
}

/** Rocks and bushes scattered off the circuit. */
export function buildNature(T) {
  const hf = T.heightfield, R = rng(T.def.seed * 7 + 3), n = T.noise;
  const g = new THREE.Group();
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  const p = rockGeo.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = 0.75 + R() * 0.5; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k); }
  rockGeo.computeVertexNormals();
  const bushGeo = new THREE.IcosahedronGeometry(1, 1);
  const rocks = [], bushes = [];
  const minClear = T.half + 15 + 6;
  for (let k = 0; k < 4200; k++) {
    const gx = R() * (hf.nx - 1), gz = R() * (hf.nz - 1);
    const near = hf.near[Math.floor(gz) * hf.nx + Math.floor(gx)];
    if (near < minClear || near > 700) continue;
    const x = hf.minX + gx * hf.cell, z = hf.minZ + gz * hf.cell;
    const y = sampleHF(hf, x, z);
    const isRock = n.fbm(x / 150, z / 150 + 20, 2) > 0.1 || R() < 0.25;
    const s = isRock ? 0.6 + R() * 2.2 : 0.7 + R() * 1.3;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y + (isRock ? -0.2 : 0.3) * s, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(R() * 0.4, R() * 6.3, R() * 0.4)), new THREE.Vector3(s, s * (isRock ? 1 : 0.8), s));
    (isRock ? rocks : bushes).push(m);
  }
  const add = (geo, list, mat, color) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const c = new THREE.Color();
    list.forEach((m, i) => { im.setMatrixAt(i, m); c.set(color).multiplyScalar(0.8 + R() * 0.4); im.setColorAt(i, c); });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    g.add(im);
  };
  add(rockGeo, rocks, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), 0x8a8a86);
  add(bushGeo, bushes, new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }), T.env === 'desert' ? 0x7a7440 : 0x3d5a2a);
  return g;
}

/** Catch fences, floodlight towers, marshal huts and corner grandstands. */
export function buildTrackside(T, line) {
  const g = new THREE.Group();
  const N = T.N;
  const R = rng(T.def.seed * 19 + 1);
  const E = envOf(T.env);
  const edgeY = (i, d) => T.py[i] + Math.sign(d) * (T.half + 1.5) * Math.tan(T.bank[i]) - 0.4;
  const at = (i, d) => [T.px[i] + T.nx[i] * d, T.pz[i] + T.nz[i] * d];

  // ---- catch fences on straights (behind the barrier)
  const fenceTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.strokeStyle = 'rgba(210,215,220,0.9)'; x.lineWidth = 2;
    for (let k = -64; k < 128; k += 16) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k + 64, 64); x.stroke(); x.beginPath(); x.moveTo(k + 64, 0); x.lineTo(k, 64); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  })();
  const fenceMat = new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5, depthWrite: true });
  const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 4.2, 6);
  postGeo.translate(0, 2.1, 0);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8c9198, metalness: 0.7, roughness: 0.4 });
  const posts = [];
  for (const side of E.fences ? [1, -1] : []) {
    const wall = side > 0 ? T.wallL : T.wallR;
    const pts = [], uvs = [], idx = [];
    let run = null;
    const flush = () => {
      if (!run || run.length < 4) { run = null; return; }
      const base = pts.length / 3;
      run.forEach(([x, y, z, u], k) => { pts.push(x, y, z, x, y + 4, z); uvs.push(u / 3, 0, u / 3, 4 / 3); if (k) { const a = base + (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } });
      run = null;
    };
    for (let i = 0; i < N; i += 2) {
      const straight = Math.abs(T.curv[i]) < 1 / 300 && Math.abs(T.curv[(i + 20) % N]) < 1 / 300;
      if (!wall[i] || T.deck[i] || !straight) { flush(); continue; }
      const d = side * (T.half + (side > 0 ? T.runL[i] : T.runR[i]) + 0.5);
      const [x, z] = at(i, d);
      const y = edgeY(i, d) + 0.35;
      run = run || [];
      run.push([x, y, z, i * T.DS]);
      if (i % 4 === 0) posts.push(new THREE.Matrix4().makeTranslation(x, y, z));
    }
    flush();
    if (pts.length) {
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      fg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      fg.setIndex(idx);
      fg.computeVertexNormals();
      g.add(new THREE.Mesh(fg, fenceMat));
    }
  }
  if (posts.length) {
    const im = new THREE.InstancedMesh(postGeo, postMat, posts.length);
    posts.forEach((m, k) => im.setMatrixAt(k, m));
    im.castShadow = true;
    g.add(im);
  }

  // ---- floodlight towers + marshal huts
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.7, roughness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 0.6, roughness: 0.3 });
  const hutMat = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.7 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xd4202a, roughness: 0.6 });
  for (let s = 120; s < T.length; s += E.floodlights ? 380 : 1e9) {
    const i = Math.floor(s / T.DS) % N;
    const side = T.curv[i] > 0 ? -1 : 1;
    const room = side > 0 ? T.runL[i] : T.runR[i];
    if (room < 6) continue;
    const d = side * (T.half + room + 9);
    const [x, z] = at(i, d);
    const y = edgeY(i, d);
    const tower = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 22, 8), towerMat);
    pole.position.y = 11;
    tower.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 0.4), towerMat);
    head.position.set(0, 22, 0);
    tower.add(head);
    for (let k = -1; k <= 1; k++) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.1), lampMat); l.position.set(k * 1, 22, -0.25); tower.add(l); }
    tower.position.set(x, y, z);
    tower.lookAt(T.px[i], y, T.pz[i]);
    tower.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(tower);
    // marshal hut near the barrier
    const d2 = side * (T.half + room + 2.5);
    const [hx, hz] = at((i + 30) % N, d2);
    const hut = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), hutMat);
    body.position.y = 1.1;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 2.6), roofMat);
    roof.position.y = 2.3;
    hut.add(body, roof);
    hut.position.set(hx, edgeY((i + 30) % N, d2), hz);
    hut.rotation.y = Math.atan2(T.tx[i], T.tz[i]);
    hut.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.add(hut);
  }

  // ---- corner grandstands at the biggest braking zones
  if (line?.profile && E.stands) {
    const v = line.profile.v;
    const zones = [];
    for (let i = 0; i < N; i++) {
      const drop = v[i] - v[(i + 40) % N];
      if (drop > 18) zones.push({ i: (i + 40) % N, drop });
    }
    zones.sort((a, b) => b.drop - a.drop);
    const picked = [];
    for (const zz of zones) { if (picked.every((p) => Math.min(Math.abs(p.i - zz.i), N - Math.abs(p.i - zz.i)) > 150)) picked.push(zz); if (picked.length >= E.stands) break; }
    const crowd = crowdTexture();
    const seatMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.85 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.7, roughness: 0.4 });
    const roofMat2 = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.4, side: THREE.DoubleSide });
    for (const z of picked) {
      const i = z.i;
      const side = T.curv[i] > 0 ? -1 : 1;
      const room = side > 0 ? T.runL[i] : T.runR[i];
      if (room < 8) continue;
      const d = side * (T.half + room + 6);
      const [x, zz] = at(i, d);
      const st = new THREE.Group();
      for (let t = 0; t < 8; t++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 22), seatMat);
        step.position.set(side * (t * 1.1 + 0.6), 0.9 + t * 0.62, 0);
        step.castShadow = true; step.receiveShadow = true;
        st.add(step);
      }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(11, 0.25, 23), roofMat2);
      roof.position.set(side * 4.5, 8.8, 0);
      roof.castShadow = true;
      st.add(roof);
      for (const zc of [-10, 10]) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 8.8, 8), steel); c.position.set(side * 9, 4.4, zc); st.add(c); }
      const X = new THREE.Vector3(T.nx[i], 0, T.nz[i]), Z = new THREE.Vector3(T.tx[i], 0, T.tz[i]);
      st.applyMatrix4(new THREE.Matrix4().makeBasis(X, new THREE.Vector3(0, 1, 0), Z));
      st.position.set(x, edgeY(i, d), zz);
      g.add(st);
    }
  }
  void radialTexture; void R;
  return g;
}
