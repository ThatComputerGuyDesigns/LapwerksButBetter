// User-placed trackside objects (Studio "Place" tool) and environment
// set dressing (city blocks for street circuits, cones for drift).
import * as THREE from 'three';
import { rng, clamp } from '../core/math.js';
import { crowdTexture } from './textures.js';
import { envOf } from '../track/environments.js';

const sampleHF = (hf, x, z) => {
  const fx = clamp((x - hf.minX) / hf.cell, 0, hf.nx - 1.001), fz = clamp((z - hf.minZ) / hf.cell, 0, hf.nz - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz), ux = fx - ix, uz = fz - iz, H = hf.h, w = hf.nx;
  return (H[iz * w + ix] * (1 - ux) + H[iz * w + ix + 1] * ux) * (1 - uz) + (H[(iz + 1) * w + ix] * (1 - ux) + H[(iz + 1) * w + ix + 1] * ux) * uz;
};

let M = null;
function mats() {
  if (M) return M;
  M = {
    steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.7, roughness: 0.4 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf0f0ee, roughness: 0.45, side: THREE.DoubleSide }),
    seats: new THREE.MeshStandardMaterial({ map: crowdTexture(), roughness: 0.85 }),
    water: new THREE.MeshStandardMaterial({ color: 0x1d4a5e, roughness: 0.06, metalness: 0.3, envMapIntensity: 1.6 }),
    shore: new THREE.MeshStandardMaterial({ color: 0x8a7b5c, roughness: 1 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 0.6 }),
    cone: new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 0.85, flatShading: true }),
    pine: new THREE.MeshStandardMaterial({ color: 0x1e3a22, roughness: 0.85, flatShading: true }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 0.9 }),
    blimp: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4, metalness: 0.1 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.5 }),
  };
  M.glass = new THREE.MeshPhysicalMaterial({ color: 0x8fa6bb, roughness: 0.1, metalness: 0.4, envMapIntensity: 1.3 });
  M.buildings = [0xb8b2a6, 0x9a9690, 0xc9c1b0, 0x7f8790, 0xa89a88].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));
  return M;
}

const box = (w, h, d, m) => { const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); g.castShadow = true; g.receiveShadow = true; return g; };

function grandstand(m) {
  const st = new THREE.Group();
  for (let t = 0; t < 9; t++) {
    const step = box(1.2, 0.6, 28, m.seats);
    step.position.set(t * 1.1, 0.9 + t * 0.62, 0);
    st.add(step);
  }
  const roof = box(12, 0.25, 29, m.white);
  roof.position.set(4.6, 9.6, 0);
  st.add(roof);
  for (const z of [-13, 0, 13]) { const c = box(0.3, 9.6, 0.3, m.steel); c.position.set(10, 4.8, z); st.add(c); }
  return st;
}

function building(m, R, h = 10 + R() * 26) {
  const g = new THREE.Group();
  const w = 12 + R() * 14, d = 12 + R() * 14;
  const body = box(w, h, d, m.buildings[Math.floor(R() * m.buildings.length)]);
  body.position.y = h / 2;
  g.add(body);
  // window bands
  for (let y = 3; y < h - 1; y += 3.4) {
    const band = box(w + 0.1, 1.2, d + 0.1, m.glass);
    band.position.y = y;
    band.castShadow = false;
    g.add(band);
  }
  const cap = box(w * 0.4, 1.5, d * 0.4, m.steel);
  cap.position.y = h + 0.75;
  g.add(cap);
  return g;
}

function treeCluster(m, R, palms) {
  const g = new THREE.Group();
  for (let k = 0; k < (palms ? 5 : 9); k++) {
    const t = new THREE.Group();
    const a = R() * Math.PI * 2, r = R() * (palms ? 7 : 12);
    if (palms) {
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 7, 6), m.trunk);
      tr.position.y = 3.5; tr.rotation.z = (R() - 0.5) * 0.2; t.add(tr);
      for (let f = 0; f < 7; f++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.45, 3.4, 4), m.leaf);
        leaf.scale.z = 0.25;
        leaf.position.set(Math.cos(f) * 1.3, 6.8, Math.sin(f) * 1.3);
        leaf.rotation.set(0, -f, 1.9);
        t.add(leaf);
      }
    } else {
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 3, 6), m.trunk);
      tr.position.y = 1.5; t.add(tr);
      const pine = R() < 0.5;
      const crown = pine ? new THREE.Mesh(new THREE.ConeGeometry(2.6, 8, 8), m.pine) : new THREE.Mesh(new THREE.IcosahedronGeometry(2.8, 1), m.leaf);
      crown.position.y = pine ? 6.5 : 5;
      t.add(crown);
    }
    const s = 0.8 + R() * 0.5;
    t.scale.setScalar(s);
    t.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    t.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(t);
  }
  return g;
}

function lake(m) {
  const g = new THREE.Group();
  const shore = new THREE.Mesh(new THREE.CircleGeometry(42, 40), m.shore);
  shore.rotation.x = -Math.PI / 2; shore.position.y = 0.05; shore.receiveShadow = true;
  const water = new THREE.Mesh(new THREE.CircleGeometry(38, 40), m.water);
  water.rotation.x = -Math.PI / 2; water.position.y = 0.25;
  g.add(shore, water);
  g.scale.set(1, 1, 0.7);
  return g;
}

function tower(m) {
  const g = new THREE.Group();
  const pole = box(0.5, 24, 0.5, m.steel); pole.position.y = 12; g.add(pole);
  const head = box(4, 1.6, 0.5, m.steel); head.position.y = 24; g.add(head);
  for (let k = -1; k <= 1; k++) { const l = box(1, 0.6, 0.12, m.lamp); l.position.set(k * 1.3, 24, 0.3); l.castShadow = false; g.add(l); }
  return g;
}

function cones(m, R) {
  const g = new THREE.Group();
  for (let k = 0; k < 8; k++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 10), m.cone);
    c.position.set((k - 3.5) * 1.4, 0.35, (R() - 0.5) * 0.6);
    c.castShadow = true;
    g.add(c);
  }
  return g;
}

function tyreStack(m) {
  const g = new THREE.Group();
  for (let x = -1; x <= 1; x++) for (let y = 0; y < 3 - Math.abs(x); y++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.14, 8, 16), m.tyre);
    t.rotation.x = Math.PI / 2; t.position.set(x * 0.75, 0.14 + y * 0.28, 0); t.castShadow = true;
    g.add(t);
  }
  return g;
}

function marquee(m) {
  const g = new THREE.Group();
  const roof = new THREE.Mesh(new THREE.ConeGeometry(8, 3.4, 4), m.white);
  roof.position.y = 5.2; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
  g.add(roof);
  for (const [x, z] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) { const p = box(0.2, 3.6, 0.2, m.steel); p.position.set(x, 1.8, z); g.add(p); }
  const band = box(10.2, 0.6, 10.2, m.accent); band.position.y = 3.5; g.add(band);
  return g;
}

function blimp(m) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 14), m.blimp);
  body.scale.set(3.2, 1, 1); body.castShadow = true;
  const fin = box(2.4, 3, 0.2, m.accent); fin.position.set(-11.5, 1.6, 0);
  const fin2 = box(2.4, 0.2, 3, m.accent); fin2.position.set(-11.5, 0, 0);
  const gond = box(3, 1.2, 1.4, m.steel); gond.position.y = -4.2;
  g.add(body, fin, fin2, gond);
  g.position.y = 70;
  return g;
}

export function buildPlacedObjects(T) {
  const g = new THREE.Group();
  g.name = 'objects';
  const hf = T.heightfield;
  if (!hf) return g;
  const m = mats();
  const R = rng((T.def.seed || 1) * 37 + 11);
  const E = envOf(T.env);
  const place = (obj, x, z, rot = 0) => {
    obj.position.x = x; obj.position.z = z;
    obj.position.y += sampleHF(hf, x, z) - 0.2;
    obj.rotation.y = rot;
    g.add(obj);
  };
  for (const o of T.def.objects || []) {
    let obj = null;
    switch (o.type) {
      case 'stand': obj = grandstand(m); break;
      case 'trees': obj = treeCluster(m, R, false); break;
      case 'palms': obj = treeCluster(m, R, true); break;
      case 'lake': obj = lake(m); break;
      case 'building': obj = building(m, R); break;
      case 'tower': obj = tower(m); break;
      case 'cones': obj = cones(m, R); break;
      case 'tyres': obj = tyreStack(m); break;
      case 'marquee': obj = marquee(m); break;
      case 'blimp': obj = blimp(m); break;
      default: break;
    }
    if (obj) place(obj, o.x, o.z, o.rot || 0);
  }
  // street circuits: city blocks behind the walls
  if (E.city) {
    const N = T.N;
    for (let i = 0; i < N; i += 18) {
      for (const side of [1, -1]) {
        if (R() < 0.25) continue;
        const room = side > 0 ? T.runL[i] : T.runR[i];
        const d = side * (T.half + room + 14 + R() * 10);
        const x = T.px[i] + T.nx[i] * d, z = T.pz[i] + T.nz[i] * d;
        const near = hf.near[Math.floor(clamp((z - hf.minZ) / hf.cell, 0, hf.nz - 1)) * hf.nx + Math.floor(clamp((x - hf.minX) / hf.cell, 0, hf.nx - 1))];
        if (near < T.half + 20) continue;
        place(building(m, R), x, z, Math.atan2(T.tx[i], T.tz[i]));
      }
    }
  }
  // drift circuits: cone gates at the apexes
  if (E.cones) {
    for (const c of T.corners || []) {
      const i = c.apex, side = T.curv[i] > 0 ? 1 : -1;
      const d = side * (T.half + 2.5);
      place(cones(m, R), T.px[i] + T.nx[i] * d, T.pz[i] + T.nz[i] * d, Math.atan2(T.tx[i], T.tz[i]) + Math.PI / 2);
    }
  }
  return g;
}
