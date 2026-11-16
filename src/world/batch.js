// Static batching: merge every non-animated mesh under a root into one mesh
// per material. Cuts draw calls (and shadow-pass draw calls) by 10-50x for
// cars, grandstands, buildings and trackside furniture.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function normalise(geo, hasColor) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (hasColor && !g.attributes.color) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k) || (k === 'color' && !hasColor)) g.deleteAttribute(k);
  g.clearGroups();
  return g;
}

/**
 * Merge static meshes below `root` (relative to root). `keep(mesh)` returning
 * true leaves a mesh alone (animated parts, references held elsewhere).
 */
export function batchStatic(root, keep = () => false) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map();
  const victims = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material) || keep(o)) return;
    // do not reach inside groups that must keep their own transforms
    for (let p = o.parent; p && p !== root; p = p.parent) if (p.userData.noBatch) return;
    const key = o.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, items: [], cast: false, recv: false, order: o.renderOrder });
    const b = buckets.get(key);
    b.items.push(o);
    b.cast ||= o.castShadow;
    b.recv ||= o.receiveShadow;
    victims.push(o);
  });
  let saved = 0;
  for (const b of buckets.values()) {
    if (b.items.length < 2) continue;
    const hasColor = b.items.some((m) => m.geometry.attributes.color);
    const geos = b.items.map((m) => normalise(m.geometry, hasColor).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)));
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    for (const m of b.items) m.parent.remove(m);
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.recv;
    mesh.renderOrder = b.order;
    root.add(mesh);
    saved += b.items.length - 1;
  }
  return saved;
}

export function countDrawables(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}
