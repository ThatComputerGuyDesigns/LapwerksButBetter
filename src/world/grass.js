// Instanced 3D grass tufts along the circuit verges, swaying in the wind and
// fading out with distance. Tiled for frustum culling.
import * as THREE from 'three';
import { KERB_W } from '../track/track.js';
import { rng, smoothstep, clamp, lerp } from '../core/math.js';

function tuftGeometry() {
  // three crossed, slightly bent blades with a base→tip colour gradient
  const pos = [], col = [], idx = [];
  const base = [0.16, 0.27, 0.1], tip = [0.55, 0.68, 0.3];
  for (let b = 0; b < 3; b++) {
    const ang = (b / 3) * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const w = 0.22, h = 0.55;
    const v0 = pos.length / 3;
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      const width = w * (1 - t * 0.85);
      const bend = t * t * 0.18;
      for (const side of [-1, 1]) {
        pos.push(ca * side * width + sa * bend, t * h, sa * side * width - ca * bend);
        const c = base.map((v, i) => lerp(v, tip[i], t));
        col.push(...c);
      }
    }
    for (let k = 0; k < 3; k++) {
      const a = v0 + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // point normals up so the tufts shade like a lawn rather than paper cards
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.3, 1, n.getZ(i) * 0.3);
  return g;
}

export function buildGrass(T, sampleHeight, { density = 1 } = {}) {
  const R = rng(T.def.seed * 31 + 9);
  const N = T.N;
  const items = [];
  const per = Math.round(14 * density);
  for (let i = 0; i < N; i++) {
    for (const side of [1, -1]) {
      const gravel = side > 0 ? T.gravelL[i] : T.gravelR[i];
      const wall = T.half + (side > 0 ? T.runL[i] : T.runR[i]);
      const edge = T.half + KERB_W + 0.4;
      for (let k = 0; k < per; k++) {
        // inside the runoff (not on gravel) and on the verge beyond the barrier
        const outside = R() < 0.45;
        let ad = outside ? wall + 1.2 + R() * 22 : edge + R() * Math.max(0, wall - edge - 0.4);
        if (!outside && gravel && ad > edge + 1.5) continue;
        if (!outside && R() < 0.35) continue;
        const e = (R() - 0.5) * T.DS;
        const d = side * ad;
        const x = T.px[i] + T.nx[i] * d + T.tx[i] * e, z = T.pz[i] + T.nz[i] * d + T.tz[i] * e;
        const y = sampleHeight(i, d, x, z, outside);
        if (y == null) continue;
        const s = 0.42 + R() * 0.55;
        items.push([x, y - 0.02, z, R() * Math.PI, s, outside]);
      }
    }
  }
  const geo = tuftGeometry();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const uniforms = { time: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.time = uniforms.time;
    sh.vertexShader = 'uniform float time;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      vec4 wp = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float sway = sin(time * 1.7 + wp.x * 0.13 + wp.z * 0.11) * 0.5 + sin(time * 2.9 + wp.x * 0.37) * 0.25;
      transformed.x += sway * 0.12 * position.y * position.y * 3.0;
      transformed.z += sway * 0.06 * position.y * position.y * 3.0;
      // shrink away with distance so far tufts cost nothing visually
      float dist = length(wp.xyz - cameraPosition);
      transformed *= 1.0 - smoothstep(55.0, 85.0, dist);
    `);
  };
  const TILE = 260;
  const tiles = new Map();
  for (const it of items) {
    const key = `${Math.floor(it[0] / TILE)},${Math.floor(it[2] / TILE)}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(it);
  }
  const g = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  for (const list of tiles.values()) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, y, z, rot, s, outside], k) => {
      q.setFromAxisAngle(Y, rot);
      sc.set(s, s * (outside ? 1.3 : 0.8), s);
      m.compose(p.set(x, y, z), q, sc);
      im.setMatrixAt(k, m);
      c.setHSL(0.24 + R() * 0.05, 0.35, 0.36 + R() * 0.14);
      im.setColorAt(k, c.multiplyScalar(1.05));
    });
    im.computeBoundingSphere();
    im.receiveShadow = true;
    g.add(im);
  }
  g.userData.uniforms = uniforms;
  g.userData.count = items.length;
  return g;
}
export { smoothstep, clamp };
