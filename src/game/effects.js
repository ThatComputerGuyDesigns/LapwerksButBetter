// Tyre smoke / dust particles and skid marks.
import * as THREE from 'three';
import { radialTexture } from '../world/textures.js';

export class Particles {
  constructor(max = 600) {
    this.max = max;
    this.n = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)') }, scale: { value: 600 }, fogColor: { value: new THREE.Color() } },
      vertexShader: `attribute float size; attribute vec4 color; varying vec4 vC; uniform float scale;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vC;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC.rgb, vC.a * t.a); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.cursor = 0;
  }

  emit(x, y, z, vx, vy, vz, size, life, r, g, b, a) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b, a], i * 4);
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha0[i] = a;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.col[i * 4 + 3] = 0; continue; }
      this.life[i] -= dt;
      const f = Math.max(this.life[i] / this.maxLife[i], 0);
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 1 - dt * 1.5; this.vel[i * 3 + 2] *= 1 - dt * 1.5;
      this.size[i] += dt * 2.2;
      this.col[i * 4 + 3] = this.alpha0[i] * f * f;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
  }

  setScale(h) { this.points.material.uniforms.scale.value = h * 0.9; }
}

export class SkidMarks {
  constructor(maxSegs = 3000) {
    this.max = maxSegs;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxSegs * 4 * 3);
    this.col = new Float32Array(maxSegs * 4 * 4);
    const idx = new Uint32Array(maxSegs * 6);
    for (let s = 0; s < maxSegs; s++) {
      const v = s * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6);
    }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.cursor = 0;
    this.last = [null, null, null, null];
  }

  reset() {
    this.col.fill(0);
    this.mesh.geometry.attributes.color.needsUpdate = true;
    this.last = [null, null, null, null];
  }

  /** Add a mark for wheel k at world point p (Vector3) with lateral dir (x,z). */
  add(k, p, sideX, sideZ, intensity, width = 0.24) {
    const prev = this.last[k];
    const l = { x: p.x + sideX * width / 2, y: p.y + 0.02, z: p.z + sideZ * width / 2, rx: p.x - sideX * width / 2, rz: p.z - sideZ * width / 2, a: intensity };
    if (prev && intensity > 0.02) {
      const dx = l.x - prev.x, dz = l.z - prev.z;
      if (dx * dx + dz * dz < 0.09) return; // wait until it moved ~30cm
      if (dx * dx + dz * dz < 16) {
        const s = this.cursor;
        this.cursor = (this.cursor + 1) % this.max;
        const P = this.pos, C = this.col, o = s * 12, c = s * 16;
        P.set([prev.x, prev.y, prev.z, prev.rx, prev.y, prev.rz, l.x, l.y, l.z, l.rx, l.y, l.rz], o);
        C.set([1, 1, 1, prev.a, 1, 1, 1, prev.a, 1, 1, 1, l.a, 1, 1, 1, l.a], c);
        const g = this.mesh.geometry;
        g.attributes.position.needsUpdate = true;
        g.attributes.color.needsUpdate = true;
      }
    }
    this.last[k] = intensity > 0.02 ? l : null;
  }
}
