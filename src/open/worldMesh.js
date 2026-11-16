// Open world visuals: chunked terrain on scanned materials, water, road
// ribbons with real markings, forests with near/far LOD, the town, the
// festival site (stage, tents, flags, Ferris wheel), airfield and lighthouse.
import * as THREE from 'three';
import { terrainMaterial, pbr, pbrMaterial } from '../world/realtex.js';
import { coniferGeometry, broadleafGeometry, palmGeometry } from '../world/environment.js';
import { batchStatic } from '../world/batch.js';
import { sampleGrid, cellOf, SEA, HALF, CELL, NCELL, S_WATER, S_SAND } from './worldgen.js';
import { rng, clamp, smoothstep, makeNoise2D } from '../core/math.js';
import { Batcher, placeBuilding, bakeFacade } from './kit.js';

export function buildOpenWorld(W, kit = null, renderer = null) {
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

  // ------------------------------------------------------------ roadside: reflector posts + chevrons on bends
  {
    const postGeo = new THREE.BoxGeometry(0.12, 1.0, 0.12); postGeo.translate(0, 0.5, 0);
    const chevGeo = new THREE.PlaneGeometry(0.9, 0.7); chevGeo.translate(0, 1.35, 0);
    const legGeo = new THREE.BoxGeometry(0.06, 1.1, 0.06); legGeo.translate(0, 0.55, 0);
    const posts = [], chevs = [], legs = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    for (const r of W.roads) {
      if (r.type === 'dirt' || r.type === 'street' || r.type === 'runway') continue;
      const P = r.pts, M = P.length;
      for (let i = 0; i < M - 1; i += 1) {
        const p = P[i], n2 = P[i + 1];
        const tx = n2[0] - p[0], tz = n2[1] - p[1], tl = Math.hypot(tx, tz) || 1;
        const nx = tz / tl, nz = -tx / tl; // right-hand normal
        const yaw = Math.atan2(tx, tz);
        const b = r.bank ? r.bank[i] : 0;
        if (i % 10 === 0) for (const sd of [1, -1]) {
          const d = r.width / 2 + 1.4;
          const x = p[0] + nx * d * sd, z = p[1] + nz * d * sd;
          q.setFromAxisAngle(Y, yaw);
          posts.push(new THREE.Matrix4().compose(new THREE.Vector3(x, hAt(x, z), z), q.clone(), one));
        }
        // chevrons on the outside of tight bends (bank sign tells the outside)
        if (Math.abs(b) > 0.045 && i % 4 === 0) {
          const sd = b > 0 ? 1 : -1;
          const d = r.width / 2 + 3;
          const x = p[0] + nx * d * sd, z = p[1] + nz * d * sd;
          q.setFromAxisAngle(Y, yaw - sd * Math.PI / 2 + Math.PI);
          const mtx = new THREE.Matrix4().compose(new THREE.Vector3(x, hAt(x, z), z), q.clone(), new THREE.Vector3(sd, 1, 1));
          chevs.push(mtx); legs.push(mtx);
        }
      }
    }
    const pc = document.createElement('canvas'); pc.width = 16; pc.height = 64;
    const pg = pc.getContext('2d'); pg.fillStyle = '#f2f2ee'; pg.fillRect(0, 0, 16, 64); pg.fillStyle = '#111'; pg.fillRect(0, 6, 16, 10); pg.fillStyle = '#ff9a1a'; pg.fillRect(0, 8, 16, 6);
    const postTex = new THREE.CanvasTexture(pc); postTex.colorSpace = THREE.SRGBColorSpace;
    const cc = document.createElement('canvas'); cc.width = 128; cc.height = 96;
    const cg = cc.getContext('2d'); cg.fillStyle = '#111'; cg.fillRect(0, 0, 128, 96); cg.fillStyle = '#ffd23f';
    for (const o of [-18, 22]) { cg.beginPath(); cg.moveTo(30 + o, 12); cg.lineTo(64 + o, 48); cg.lineTo(30 + o, 84); cg.lineTo(48 + o, 84); cg.lineTo(82 + o, 48); cg.lineTo(48 + o, 12); cg.closePath(); cg.fill(); }
    const chevTex = new THREE.CanvasTexture(cc); chevTex.colorSpace = THREE.SRGBColorSpace;
    const addIM = (geo, mat, list, shadow) => { if (!list.length) return; const im = new THREE.InstancedMesh(geo, mat, list.length); list.forEach((m, k) => im.setMatrixAt(k, m)); im.castShadow = shadow; im.computeBoundingSphere(); root.add(im); };
    addIM(postGeo, new THREE.MeshStandardMaterial({ map: postTex, roughness: 0.6 }), posts, false);
    addIM(chevGeo, new THREE.MeshStandardMaterial({ map: chevTex, roughness: 0.5, side: THREE.DoubleSide, emissive: 0x222200, emissiveIntensity: 0.2 }), chevs, false);
    addIM(legGeo, new THREE.MeshStandardMaterial({ color: 0x555a60, metalness: 0.6, roughness: 0.4 }), legs, false);
  }

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
  root.add(kit && renderer ? buildTownKit(W, R, hAt, kit, renderer) : buildTown(W, R, hAt));
  const fest = buildFestival(W, R, hAt);
  root.add(fest.group);
  updaters.push(fest.update);
  root.add(buildAirfield(W, hAt));
  root.add(buildLighthouse(W, hAt));

  // ------------------------------------------------------------ grass that follows the camera
  const grass = buildGrassPatch(W, hAt);
  root.add(grass.mesh);

  return {
    group: root,
    update(dt, cam) {
      for (const u of updaters) u(dt);
      forest.lod(cam);
      grass.update(dt, cam);
    },
  };
}

/** A disc of dense grass tufts re-seeded around the camera as it moves. */
function buildGrassPatch(W, hAt) {
  const COUNT = 26000, RAD = 48, STEP = 0.55;
  // tuft: seven thin blades fanning out, dark at the root → sunlit tip
  const pos = [], col = [], idx = [];
  for (let b = 0; b < 7; b++) {
    const a = (b / 7) * Math.PI * 2 + b, ca = Math.cos(a), sa = Math.sin(a), v0 = pos.length / 3;
    const lean = 0.08 + (b % 3) * 0.05, h = 0.32 + (b % 4) * 0.07, w = 0.025;
    const ox = ca * 0.06, oz = sa * 0.06;
    const pts = [[-w, 0, 0], [w, 0, 0], [0, h, lean]];
    for (const [x, y, l] of pts) { pos.push(ox + ca * l * (y / h) - sa * x, y, oz + sa * l * (y / h) + ca * x); const t = y / h; col.push(0.07 + t * 0.2, 0.13 + t * 0.26, 0.03 + t * 0.07); }
    idx.push(v0, v0 + 1, v0 + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, envMapIntensity: 0.6 });
  const uniforms = { time: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.time = uniforms.time;
    sh.vertexShader = 'uniform float time;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      vec4 wp = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float sway = sin(time * 1.6 + wp.x * 0.21 + wp.z * 0.17) * 0.6 + sin(time * 2.7 + wp.x * 0.43) * 0.3;
      transformed.x += sway * 0.22 * position.y; transformed.z += sway * 0.12 * position.y;
      float dist = length(wp.xyz - cameraPosition);
      transformed *= 1.0 - smoothstep(${(RAD - 16).toFixed(1)}, ${(RAD - 2).toFixed(1)}, dist);`);
  };
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const hash = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); };
  let lx = 1e9, lz = 1e9;
  const reseed = (cx, cz) => {
    let k = 0;
    const gx = Math.round(cx / STEP), gz = Math.round(cz / STEP), n = Math.ceil(RAD / STEP);
    for (let j = -n; j <= n && k < COUNT; j++) for (let i = -n; i <= n && k < COUNT; i++) {
      const X = gx + i, Z = gz + j;
      const h1 = hash(X, Z);
      if (h1 < 0.38) continue; // natural gaps
      const x = (X + hash(X + 31, Z) - 0.5) * STEP, z = (Z + hash(X, Z + 57) - 0.5) * STEP;
      if ((x - cx) ** 2 + (z - cz) ** 2 > RAD * RAD) continue;
      const c = cellOf(x, z);
      if (W.surf[c] !== 2) continue;
      const Lm = W.landmarks;
      if (Math.abs(x - Lm.town[0]) < 320 && Math.abs(z - Lm.town[1]) < 290) continue;
      if (Math.hypot(x - Lm.festival[0], z - Lm.festival[1]) < 152) continue;
      const r = W.roadOf[c] >= 0 ? W.roads[W.roadOf[c]] : null;
      if (r && W.dist[c] < r.width / 2 + 1.2) continue;
      const s = 0.8 + h1 * 0.7;
      q.setFromAxisAngle(Y, h1 * 40);
      m4.compose(v.set(x, hAt(x, z) - 0.03, z), q, sc.set(s, s * (0.7 + hash(X + 5, Z + 9) * 0.9), s));
      mesh.setMatrixAt(k++, m4);
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
  };
  return {
    mesh,
    update(dt, cam) {
      uniforms.time.value += dt;
      // seed ahead of the camera so the grass is where you are looking
      const fx = cam.position.x, fz = cam.position.z;
      if ((fx - lx) ** 2 + (fz - lz) ** 2 > 64) { lx = fx; lz = fz; reseed(fx, fz); }
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
    if (kinds.conifer.length + kinds.broad.length > 30000) break;
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.45 });
  // roadside tree lines: avenues along the country roads
  for (const r of W.roads) {
    if (r.type === 'street' || r.type === 'runway' || r.type === 'dirt') continue;
    for (let i = 2; i < r.pts.length - 2; i += 3) {
      const p = r.pts[i], n2 = r.pts[i + 1];
      const tx = n2[0] - p[0], tz = n2[1] - p[1], tl = Math.hypot(tx, tz) || 1;
      if (n.fbm(p[0] / 300 + 9, p[1] / 300, 2) < -0.05) continue; // open stretches with views
      for (const sd of [1, -1]) {
        if (R() < 0.45) continue;
        const d = r.width / 2 + 7 + R() * 9;
        const x = p[0] + (tz / tl) * d * sd, z = p[1] - (tx / tl) * d * sd;
        const c = cellOf(x, z);
        if (W.surf[c] === S_WATER || W.surf[c] === S_SAND || W.dist[c] < r.width / 2 + 5) continue;
        if (Math.hypot(x - L.festival[0], z - L.festival[1]) < 230 || (Math.abs(x - L.town[0]) < 330 && Math.abs(z - L.town[1]) < 300)) continue;
        const h = hAt(x, z);
        (h > 110 || z < -700 ? kinds.conifer : kinds.broad).push([x, h, z]);
      }
    }
  }
  // round, soft shading: normals radiate from the crown instead of per-facet
  const soft = (geo, cy, flat) => {
    const p = geo.attributes.position, nn = geo.attributes.normal, v3 = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < 2.6) continue; // trunk keeps its normals
      v3.set(p.getX(i), (p.getY(i) - cy) * flat, p.getZ(i)).normalize();
      v3.y = v3.y * 0.6 + 0.4; v3.normalize();
      nn.setXYZ(i, v3.x, v3.y, v3.z);
    }
    return geo;
  };
  const geos = {
    conifer: [soft(coniferGeometry(), 5, 0.35), soft(simpleConifer(), 5, 0.35)],
    broad: [soft(broadleafGeometry(), 4.6, 1), soft(simpleBroad(), 4.6, 1)],
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
          const s = 1.25 + R() * 1.0;
          q.setFromAxisAngle(Y, R() * 6.28);
          m4.compose(v.set(x, y - 0.3, z), q, sc.set(s, s * (0.85 + R() * 0.4), s));
          im.setMatrixAt(i, m4);
          col.setRGB(0.6 + R() * 0.45, 0.72 + R() * 0.38, 0.5 + R() * 0.3);
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

/**
 * Town from the scanned facade kit: every building is a box wrapped in a
 * facade texture baked from the real kit, and along Main Street and Fourth
 * Avenue the ground floors are the full 3D kit (doors, shopfronts, depth).
 */
function buildTownKit(W, R, hAt, kit, renderer) {
  const g = new THREE.Group();
  const T0 = W.landmarks.town;
  const y0 = W.townH;
  // pavement
  {
    const pave = pbrMaterial('asphalt', { color: 0xb8b4ac });
    for (const k of ['map', 'normalMap', 'roughnessMap']) { pave[k] = pave[k].clone(); pave[k].repeat.set(90, 80); pave[k].needsUpdate = true; }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(620, 560), pave);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(T0[0], y0 + 0.03, T0[1]);
    ground.receiveShadow = true;
    g.add(ground);
  }
  // baked facade variants (window style × plaster tint)
  const styles = [
    ['wall_window_centered_large_01', 'window_centered_large_01'],
    ['wall_window_centered_double_01', 'window_centered_double_01'],
    ['wall_window_centered_small_01', 'window_centered_small_01'],
    ['wall_window_offset_small_01', 'window_offset_small_01'],
  ];
  const tints = [0xffffff, 0xe2e9ff, 0xfff2dc, 0xcfdbe4, 0xf4e6d2, 0xdcd4cc];
  const facades = [];
  for (let k = 0; k < 6; k++) {
    const st = styles[k % styles.length];
    const map = bakeFacade(renderer, kit, { wall: st[0], win: st[1], tint: tints[k] });
    facades.push({ mat: new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0.0 }), tint: new THREE.Color(tints[k]), style: st });
  }
  const roofMat = pbrMaterial('asphalt', { color: 0x6b6d70 });
  const parapetMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c8, roughness: 0.8 });
  const B = new Batcher(kit);
  const FLOOR = 3.5;
  const mainZ = T0[1], mainX = T0[0]; // Main Street (z) and Fourth Avenue (x)
  for (let i = -3; i < 3; i++) for (let j = -3; j < 3; j++) {
    const bx = T0[0] + (i + 0.5) * 95, bz = T0[1] + (j + 0.5) * 85;
    for (let k = 0; k < 4; k++) {
      const sx = k % 2 ? 1 : -1, sz = k < 2 ? 1 : -1;
      const wb = 11 + Math.floor(R() * 2), db = 9 + Math.floor(R() * 2);
      const cx = bx + sx * 19.5, cz = bz + sz * 17;
      const centre = Math.hypot(i + 0.5, j + 0.5);
      const floors = Math.max(2, Math.round(3 + R() * 3 + (centre < 1.6 ? 3 + R() * 3 : 0)));
      const F = facades[Math.floor(R() * facades.length)];
      const W3 = wb * 3, D3 = db * 3;
      // which faces sit on Main Street / Fourth Avenue? side index: 0 +z, 1 +x, 2 -z, 3 -x
      const onMain = [];
      if (Math.abs(cz + D3 / 2 - mainZ) < 14) onMain.push(0);
      if (Math.abs(cz - D3 / 2 - mainZ) < 14) onMain.push(2);
      if (Math.abs(cx + W3 / 2 - mainX) < 14) onMain.push(1);
      if (Math.abs(cx - W3 / 2 - mainX) < 14) onMain.push(3);
      const kitGround = onMain.length > 0 && Math.abs(i + 0.5) < 2.6 && Math.abs(j + 0.5) < 2.6;
      // body: baked facade all the way down; real kit storefronts sit just in front on Main Street
      const top = (floors - 1) * FLOOR + 3;
      const yb = 0;
      const h = top - yb;
      const geo = new THREE.BoxGeometry(W3, h, D3);
      const uv = geo.attributes.uv, pA = geo.attributes.position, nA = geo.attributes.normal;
      for (let v = 0; v < uv.count; v++) {
        const along = Math.abs(nA.getX(v)) > 0.5 ? -pA.getZ(v) * Math.sign(nA.getX(v)) : pA.getX(v) * Math.sign(nA.getZ(v) || 1);
        uv.setXY(v, (along + W3) / 12, (pA.getY(v) + h / 2 + yb) / 7);
      }
      const body = new THREE.Mesh(geo, [F.mat, F.mat, roofMat, roofMat, F.mat, F.mat]);
      body.position.set(cx, y0 + yb + h / 2, cz);
      body.castShadow = true; body.receiveShadow = true;
      g.add(body);
      // parapet / cornice band
      const par = new THREE.Mesh(new THREE.BoxGeometry(W3 + 0.5, 0.9, D3 + 0.5), parapetMat);
      par.position.set(cx, y0 + top + 0.45, cz);
      par.castShadow = true;
      g.add(par);
      if (kitGround) {
        placeBuilding(B, { x: cx, z: cz, y: y0, rot: 0, wb, db, floors: 1, tint: F.tint, R, shop: R() < 0.7, only: onMain, cap: false, inset: 0.06 });
      }
      // rooftop plant
      if (R() < 0.8) {
        const u = new THREE.Mesh(new THREE.BoxGeometry(3 + R() * 5, 1.6 + R() * 1.6, 3 + R() * 5), parapetMat);
        u.position.set(cx + (R() - 0.5) * W3 * 0.5, y0 + top + 1.4, cz + (R() - 0.5) * D3 * 0.5);
        u.castShadow = true;
        g.add(u);
      }
      // fire escapes on the taller side streets
      if (!kitGround && floors >= 4 && R() < 0.35) {
        const xs = cx + sx * (W3 / 2 + 0.75);
        for (let f = 1; f < floors; f++) {
          const m = new THREE.Matrix4().makeRotationY(sx > 0 ? -Math.PI / 2 : Math.PI / 2).setPosition(xs, y0 + f * FLOOR - 0.1, cz);
          B.add('modular_fire_escape_platform_middle', m);
          B.add('modular_fire_escape_railing_middle', m.clone());
          if (f < floors - 1) B.add('modular_fire_escape_stairs', m.clone());
        }
      }
    }
  }
  // bins along Main Street and Fourth Avenue
  for (const r of W.roads.filter((q) => q.id === 'tx0' || q.id === 'tz0')) {
    for (let i = 5; i < r.pts.length - 1; i += 9) {
      const [x, z] = r.pts[i], [x2, z2] = r.pts[i + 1];
      const tx = x2 - x, tz = z2 - z, l = Math.hypot(tx, tz) || 1;
      const nx = tz / l, nz = -tx / l;
      const sd = i % 18 < 9 ? 1 : -1;
      const px = x + nx * (r.width / 2 + 1.6) * sd, pz = z + nz * (r.width / 2 + 1.6) * sd;
      const m = new THREE.Matrix4().makeRotationY(R() * 6.28).setPosition(px, y0 + 0.03, pz);
      B.add('metal_trash_can', m); B.add('metal_trash_can_lid', m.clone());
    }
  }
  g.add(B.build());
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
