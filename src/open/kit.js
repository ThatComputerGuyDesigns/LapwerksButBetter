// Real 3D assets (CC0, Poly Haven): a modular apartment facade kit and street
// props. Loaded once; pieces are placed through an instancing batcher so a
// whole town costs a few dozen draw calls.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const BASE = import.meta.env?.BASE_URL || './';
const KITS = {
  facade: 'modular_urban_apartments_facade',
  escape: 'modular_fire_escape',
  aircon: 'exterior_aircon_unit',
  bin: 'metal_trash_can',
  hydrant: 'fire_hydrant',
  barrier: 'concrete_road_barrier_02',
  shutter: 'rollershutter_door',
};

let loaded = null;

/** Load every kit; returns { pieces: Map(name → [{geometry, material}]) }. */
export function loadKits() {
  if (loaded) return loaded;
  const loader = new GLTFLoader();
  loaded = Promise.all(Object.values(KITS).map((id) => loader.loadAsync(`${BASE}assets/models/${id}/${id}.gltf`).catch((e) => { console.warn('kit failed', id, e); return null; })))
    .then((gltfs) => {
      const pieces = new Map();
      for (const g of gltfs) {
        if (!g) continue;
        g.scene.traverse((o) => {
          if (!o.isMesh) return;
          // single-material pieces are meshes under the scene root; multi-material
          // pieces are groups (named after the node) holding one mesh per material
          const grouped = o.parent && o.parent !== g.scene && !o.parent.isMesh && o.parent.name;
          const key = grouped ? o.parent.name : o.name;
          if (!pieces.has(key)) pieces.set(key, []);
          if (o.material.map) o.material.map.anisotropy = 8;
          pieces.get(key).push({ geometry: o.geometry, material: o.material });
        });
      }
      return { pieces };
    });
  return loaded;
}

/** Collects placements per piece and builds one InstancedMesh per piece primitive. */
export class Batcher {
  constructor(kit) { this.kit = kit; this.items = new Map(); }
  add(name, matrix, color) {
    if (!this.kit.pieces.has(name)) return false;
    if (!this.items.has(name)) this.items.set(name, []);
    this.items.get(name).push([matrix, color]);
    return true;
  }
  build({ shadows = true } = {}) {
    const g = new THREE.Group();
    for (const [name, list] of this.items) {
      for (const { geometry, material } of this.kit.pieces.get(name)) {
        const im = new THREE.InstancedMesh(geometry, material, list.length);
        list.forEach(([m, c], i) => { im.setMatrixAt(i, m); if (c) im.setColorAt(i, c); });
        im.castShadow = shadows; im.receiveShadow = true;
        im.computeBoundingSphere();
        g.add(im);
      }
    }
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Assemble a building from the facade kit. Footprint wb × db bays (3 m),
 * floors levels; centre (x, z), ground height y, rotation rot.
 */
export function placeBuilding(B, { x, z, y, rot = 0, wb, db, floors, tint, R, shop = false, escape = false, only = null, cap = true, inset = 0 }) {
  const FLOOR = 3.5;
  const hx = (wb * 3) / 2, hz = (db * 3) / 2;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const toWorld = (lx, lz) => new THREE.Vector3(x + lx * cr + lz * sr, 0, z - lx * sr + lz * cr);
  const sides = [
    { n: [0, 1], c: [hx, hz], bays: wb },
    { n: [1, 0], c: [hx, -hz], bays: db },
    { n: [0, -1], c: [-hx, -hz], bays: wb },
    { n: [-1, 0], c: [-hx, hz], bays: db },
  ];
  const m4 = new THREE.Matrix4(), basis = new THREE.Matrix4();
  const pieceAt = (name, side, k, yy, color) => {
    // local x runs along u = n × up, local -z faces outward
    const nW = toWorld(side.n[0], side.n[1]).sub(toWorld(0, 0)).normalize();
    const u = new THREE.Vector3().crossVectors(nW, UP).normalize();
    const c = toWorld(side.c[0], side.c[1]).addScaledVector(nW, inset);
    const o = c.clone().addScaledVector(u, 3 * k + 3);
    basis.makeBasis(u, UP, nW.clone().negate());
    m4.copy(basis).setPosition(o.x, y + yy, o.z);
    B.add(name, m4.clone(), color);
  };
  const windowStyles = [
    ['wall_window_centered_large_01', 'window_centered_large_01'],
    ['wall_window_centered_double_01', 'window_centered_double_01'],
    ['wall_window_centered_small_01', 'window_centered_small_01'],
    ['wall_window_offset_small_01', 'window_offset_small_01'],
  ];
  const style = windowStyles[Math.floor(R() * windowStyles.length)];
  const upper = windowStyles[Math.floor(R() * windowStyles.length)];
  for (const [si, side] of sides.entries()) {
    if (only && !only.includes(si)) continue;
    for (let k = 0; k < side.bays; k++) {
      // ground floor: shopfront doors / plain doors / windows
      const door = shop ? R() < 0.7 : R() < 0.25;
      if (door) {
        const dn = shop ? 'door_centered_large_01' : 'door_centered_small_01';
        pieceAt(shop ? 'wall_door_centered_large_01' : 'wall_door_centered_small_01', side, k, 0, tint);
        pieceAt(dn, side, k, 0);
      } else {
        pieceAt(style[0], side, k, 0, tint);
        pieceAt(style[1], side, k, 0);
      }
      pieceAt('base_standard_01', side, k, 0, tint);
      for (let f = 1; f < floors; f++) {
        const yy = f * FLOOR;
        pieceAt('dado_standard_standard_01', side, k, yy - 0.5, tint);
        const st = f === floors - 1 && R() < 0.5 ? ['wall_window_centered_large_03', 'window_centered_large_03'] : upper;
        pieceAt(st[0], side, k, yy, tint);
        pieceAt(st[1], side, k, yy);
      }
      if (cap) {
        const top = (floors - 1) * FLOOR + 3;
        pieceAt('cornice_standard_standard_01', side, k, top + 0.15, tint);
        pieceAt('crown_standard_standard_01', side, k, top + 0.35, tint);
      }
    }
  }
  // corner piers (cover the seams between facades)
  if (!only) for (const [cx, cz, a] of [[hx, hz, 0], [hx, -hz, Math.PI / 2], [-hx, -hz, Math.PI], [-hx, hz, -Math.PI / 2]]) {
    const p = toWorld(cx, cz);
    for (let f = 0; f < floors; f++) {
      m4.makeRotationY(rot + a + Math.PI).setPosition(p.x, y + f * FLOOR, p.z);
      B.add('wall_pier_corner_01', m4.clone(), tint);
    }
  }
  // fire escape down one side
  if (escape && floors >= 3) {
    const side = sides[1];
    const nW = toWorld(side.n[0], side.n[1]).sub(toWorld(0, 0)).normalize();
    const u = new THREE.Vector3().crossVectors(nW, UP).normalize();
    const c = toWorld(side.c[0], side.c[1]).addScaledVector(u, side.bays * 1.5).addScaledVector(nW, 0.7);
    basis.makeBasis(u.clone().negate(), UP, nW);
    for (let f = 1; f < floors; f++) {
      m4.copy(basis).setPosition(c.x, y + f * FLOOR - 0.1, c.z);
      B.add('modular_fire_escape_platform_middle', m4.clone());
      B.add('modular_fire_escape_railing_middle', m4.clone());
      if (f < floors - 1) B.add('modular_fire_escape_stairs', m4.clone());
    }
  }
  // air-con units hung under some windows
  if (!only) for (const side of sides) for (let f = 1; f < floors; f++) for (let k = 0; k < side.bays; k++) {
    if (R() > 0.12) continue;
    const nW = toWorld(side.n[0], side.n[1]).sub(toWorld(0, 0)).normalize();
    const u = new THREE.Vector3().crossVectors(nW, UP).normalize();
    const p = toWorld(side.c[0], side.c[1]).addScaledVector(u, 3 * k + 1.5).addScaledVector(nW, 0.2);
    basis.makeBasis(u, UP, nW);
    m4.copy(basis).setPosition(p.x, y + f * FLOOR + 0.1, p.z);
    B.add(R() < 0.5 ? 'exterior_aircon_unit' : 'exterior_aircon_unit_rusted', m4.clone());
  }
  return { height: (floors - 1) * FLOOR + 4.1, hx, hz };
}

/**
 * Bake a facade texture from the real kit (4 bays × 2 floors) so whole
 * buildings can be cheap boxes that still look like the scanned facade.
 * Returns a CanvasTexture-like render target texture (colour) tiling every
 * 12 m horizontally and 7 m vertically.
 */
export function bakeFacade(renderer, kit, { wall, win, tint = 0xffffff, size = 1024 }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4036, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-3, 5, -8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff0e0, 0.6);
  fill.position.set(4, -2, -6);
  scene.add(fill);
  const color = new THREE.Color(tint);
  const add = (name, x, y) => {
    for (const { geometry, material } of kit.pieces.get(name) || []) {
      const m = material.clone();
      if (/plaster/i.test(material.name)) m.color.copy(color);
      const mesh = new THREE.Mesh(geometry, m);
      mesh.position.set(x, y, 0);
      scene.add(mesh);
    }
  };
  for (let f = 0; f < 2; f++) for (let k = 0; k < 4; k++) {
    const x = (k + 1) * 3, y = f * 3.5;
    add(wall, x, y); add(win, x, y);
    add('dado_standard_standard_01', x, y + 3);
  }
  // camera looks at the facade from outside (-z), framing 12 m × 7 m
  const cam = new THREE.OrthographicCamera(0, 12, 7, 0, 0.1, 50);
  cam.position.set(12, 0, -10);
  cam.up.set(0, 1, 0);
  cam.lookAt(12, 0, 0);
  // looking along +z the camera's right is world -x: view x 0..12 = world x 12..0,
  // which is the facade as seen from the street
  cam.left = 0; cam.right = 12; cam.top = 7; cam.bottom = 0;
  cam.updateProjectionMatrix();
  const rt = new THREE.WebGLRenderTarget(size, Math.round(size * 7 / 12), { colorSpace: THREE.SRGBColorSpace });
  const prevTM = renderer.toneMapping, prevExp = renderer.toneMappingExposure;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  renderer.toneMapping = prevTM; renderer.toneMappingExposure = prevExp;
  // copy into an ordinary canvas texture so it gets proper mipmaps
  const W = rt.width, H = rt.height, px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  rt.dispose();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
