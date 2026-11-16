// Renderer, sky, sun, image-based lighting, terrain and vegetation.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { buildHeightfield } from '../track/track.js';
import { makeGradePass, makeClouds } from './post.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { radialTexture } from './textures.js';
import { rng, smoothstep, clamp } from '../core/math.js';
import * as TX from './textures.js';
import { envOf } from '../track/environments.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { setAniso, terrainMaterial } from './realtex.js';

export const THEMES = {
  golden: { name: 'Golden Hour', elevation: 21, azimuth: 235, turbidity: 4.5, rayleigh: 1.8, mie: 0.0025, sun: 0xffdcb4, sunI: 2.7, hemiSky: 0xbcd3ff, hemiGround: 0x5a4a32, hemiI: 0.6, fog: 0xb9b3aa, exposure: 0.5, envI: 0.9, clouds: 0.5 },
  midday: { name: 'Midday', elevation: 55, azimuth: 160, turbidity: 2.6, rayleigh: 1.1, mie: 0.0022, sun: 0xfff6e8, sunI: 3.1, hemiSky: 0xcfe2ff, hemiGround: 0x4b5a3a, hemiI: 0.5, fog: 0xc6cbc6, exposure: 0.42, envI: 1.0, clouds: 0.42 },
  dusk: { name: 'Dusk', elevation: 7, azimuth: 280, turbidity: 6, rayleigh: 2.6, mie: 0.004, sun: 0xffa47a, sunI: 2.1, hemiSky: 0x9aa8d6, hemiGround: 0x3b2c2a, hemiI: 0.6, fog: 0x978896, exposure: 0.68, envI: 0.85, clouds: 0.38 },
};

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.quality = 'high';
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    TX.setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    setAniso(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 6000);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    // sky dome
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    this.scene.add(this.sky);
    this.clouds = makeClouds();
    this.scene.add(this.clouds);
    // sun lens flare (subtle)
    this.flareLight = new THREE.PointLight(0xffffff, 0, 0);
    const flare = new Lensflare();
    flare.addElement(new LensflareElement(radialTexture('rgba(255,244,220,0.45)', 'rgba(255,200,120,0)', 256), 150, 0, new THREE.Color(1, 0.95, 0.85)));
    flare.addElement(new LensflareElement(radialTexture('rgba(255,210,150,0.18)', 'rgba(255,180,100,0)', 128), 70, 0.45));
    flare.addElement(new LensflareElement(radialTexture('rgba(160,200,255,0.12)', 'rgba(120,160,255,0)', 128), 110, 0.7));
    flare.addElement(new LensflareElement(radialTexture('rgba(255,230,190,0.1)', 'rgba(255,200,140,0)', 128), 50, 0.95));
    this.flareLight.add(flare);
    this.scene.add(this.flareLight);
    this.sunDir = new THREE.Vector3();

    // lights
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 3.5; // soft penumbra (PCF)
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
    this.scene.add(this.hemi);

    this.content = new THREE.Group();
    this.scene.add(this.content);

    this.setupComposer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setupComposer() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    // ground-truth ambient occlusion: contact shading where surfaces meet
    // (cars on the road, barriers, kerbs, grandstands) — high quality only
    this.gtao = new GTAOPass(this.scene, this.camera, size.x, size.y, undefined, { radius: 0.9, distanceExponent: 1.6, thickness: 2, scale: 1.25, samples: 12, distanceFallOff: 1 }, { radiusExponent: 1.6, rings: 2, samples: 12 });
    this.gtao.blendIntensity = 0.85;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.12, 0.3, 5.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = makeGradePass();
    this.composer.addPass(this.grade);
  }

  setQuality(q) {
    this.quality = q;
    this.maxPR = Math.min(window.devicePixelRatio, q === 'ultra' ? 2 : q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1);
    this.resScale = this.resScale ?? 1;
    this.renderer.setPixelRatio(this.maxPR * this.resScale);
    this.renderer.shadowMap.enabled = q !== 'low';
    const sm = q === 'ultra' || q === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.bloom.enabled = q !== 'low';
    this.gtao.enabled = q === 'ultra'; // ambient occlusion: opt-in, costly
    this.resize();
  }

  /** Dynamic resolution: scale the render size without touching quality tiers. */
  setResScale(k) {
    k = Math.max(0.5, Math.min(1, k));
    if (Math.abs(k - (this.resScale ?? 1)) < 0.02) return;
    this.resScale = k;
    this.renderer.setPixelRatio((this.maxPR || 1) * k);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
  }

  setTheme(key) {
    this.sky.visible = true; this.clouds.visible = true;
    if (!this.hdrCache?.[key]) this.scene.background = null;
    const t = (this.theme = THEMES[key] || THEMES.golden);
    this.themeKey = key in THEMES ? key : 'golden';
    const u = this.sky.material.uniforms;
    u.turbidity.value = t.turbidity;
    u.rayleigh.value = t.rayleigh;
    u.mieCoefficient.value = t.mie;
    u.mieDirectionalG.value = 0.7;
    const phi = THREE.MathUtils.degToRad(90 - t.elevation);
    const theta = THREE.MathUtils.degToRad(t.azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sun.color.set(t.sun);
    this.sun.intensity = t.sunI;
    this.hemi.color.set(t.hemiSky);
    this.hemi.groundColor.set(t.hemiGround);
    this.hemi.intensity = t.hemiI;
    this.renderer.toneMappingExposure = t.exposure;
    const cu = this.clouds.material.uniforms;
    cu.sunDir.value.copy(this.sunDir);
    cu.sunCol.value.set(t.sun).lerp(new THREE.Color(1, 1, 1), 0.1).multiplyScalar(0.82);
    cu.shade.value.set(t.fog).multiplyScalar(0.75);
    cu.cover.value = t.clouds ?? 0.45;
    this.scene.fog = new THREE.FogExp2(new THREE.Color(t.fog).multiplyScalar(0.92), 0.00012);
    // image based lighting from the sky
    const envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(1000);
    Object.assign(sky2.material.uniforms.sunPosition.value, this.sunDir);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) sky2.material.uniforms[k].value = u[k].value;
    envScene.add(sky2);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 32), new THREE.MeshBasicMaterial({ color: t.hemiGround }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -20;
    envScene.add(ground);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = t.envI;
    this.loadHDRSky(this.themeKey);
  }

  /**
   * Photographed sky (CC0 HDRI): visible backdrop + image-based lighting.
   * The sun light is placed where the sun is in the photo so shadows match.
   */
  async loadHDRSky(key) {
    const token = (this.skyToken = (this.skyToken || 0) + 1);
    const base = import.meta.env?.BASE_URL || './';
    try {
      this.skyMeta ||= await (await fetch(base + 'assets/sky/skies.json')).json();
      const meta = this.skyMeta[key];
      if (!meta) return;
      this.hdrCache ||= {};
      const tex = this.hdrCache[key] || (this.hdrCache[key] = await new RGBELoader().loadAsync(base + `assets/sky/${key}.hdr`));
      if (token !== this.skyToken) return;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      // exposure: put the sky's median brightness at a pleasant mid-grey
      const look = { midday: 0.2, golden: 0.2, dusk: 0.17 }[key] ?? 0.2;
      const exposure = look / meta.median;
      this.renderer.toneMappingExposure = exposure;
      this.scene.background = tex;
      this.scene.backgroundIntensity = 1;
      this.scene.backgroundBlurriness = 0;
      if (this.hdrEnv) this.hdrEnv.dispose();
      this.hdrEnv = this.pmrem.fromEquirectangular(tex);
      this.scene.environment = this.hdrEnv.texture;
      this.scene.environmentIntensity = 1;
      this.sky.visible = false;
      this.clouds.visible = false;
      // sun direction from the brightest point of the photo (three.js equirect mapping)
      const phi = (meta.sunAzimuthU - 0.5) * Math.PI * 2;
      const el = THREE.MathUtils.degToRad(Math.max(meta.sunElevation, 6));
      this.sunDir.set(Math.cos(phi) * Math.cos(el), Math.sin(el), Math.sin(phi) * Math.cos(el)).normalize();
      // direct sun strength relative to the sky (low suns are weaker and warmer)
      const t = this.theme;
      this.sun.color.set(t.sun);
      this.sun.intensity = ({ midday: 5.2, golden: 3.4, dusk: 2.6 }[key] ?? 4) / exposure * 0.2;
      this.hemi.intensity = 0.25;
      const h = meta.horizon;
      // fog in the same linear radiance as the horizon, so distant land melts into the sky
      const fog = new THREE.Color(h[0], h[1], h[2]).multiplyScalar(0.92);
      this.scene.fog = new THREE.FogExp2(fog, this.fogDensity ?? 0.00012);
      this.hdrActive = key;
    } catch (err) {
      console.warn('HDR sky unavailable, using the procedural sky', err);
    }
  }

  /** Keep the shadow frustum centred on the action. */
  followShadow(target) {
    const d = this.sunDir;
    this.sun.position.set(target.x + d.x * 300, target.y + d.y * 300, target.z + d.z * 300);
    this.sun.target.position.copy(target);
    // texel snapping to avoid shimmering
    const sc = this.sun.shadow.camera;
    const texel = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
    this.sun.position.x = Math.round(this.sun.position.x / texel) * texel;
    this.sun.position.z = Math.round(this.sun.position.z / texel) * texel;
    this.sun.target.position.x = Math.round(target.x / texel) * texel;
    this.sun.target.position.z = Math.round(target.z / texel) * texel;
  }

  clearContent() {
    for (const c of [...this.content.children]) {
      this.content.remove(c);
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
  }

  /** Per-frame cosmetic updates (clouds drift, speed blur). */
  tick(dt, speed = 0) {
    this.clouds.material.uniforms.time.value += dt;
    if (this.grassUniforms) this.grassUniforms.time.value += dt;
    this.clouds.position.copy(this.camera.position);
    this.flareLight.position.copy(this.camera.position).addScaledVector(this.sunDir, 4000);
    this.grade.uniforms.speed.value += ((speed > 45 ? Math.min((speed - 45) / 40, 1) : 0) - this.grade.uniforms.speed.value) * Math.min(1, dt * 3);
  }

  render() {
    if (this.quality === 'low') this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
}

/** Terrain mesh from the heightfield with grass + dirt blending via vertex colors. */
export function buildTerrain(T) {
  const hf = T.heightfield || buildHeightfield(T);
  const geo = new THREE.BufferGeometry();
  const nx = hf.nx, nz = hf.nz;
  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const col = new Float32Array(nx * nz * 3);
  const n = T.noise;
  const E = envOf(T.env);
  const [gr, gg, gb] = E.ground;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const k = z * nx + x;
    const wx = hf.minX + x * hf.cell, wz = hf.minZ + z * hf.cell;
    const h = hf.h[k];
    pos[k * 3] = wx; pos[k * 3 + 1] = h; pos[k * 3 + 2] = wz;
    uv[k * 2] = wx / 9; uv[k * 2 + 1] = wz / 9;
    // colour variation: dry patches, darker lush near water courses, rock high up
    const dry = smoothstep(0.1, 0.5, n.fbm(wx / 160 + 11, wz / 160, 3));
    const lush = smoothstep(0.0, 0.4, -n.fbm(wx / 300, wz / 300 + 7, 3));
    const rock = smoothstep(18, 55, h - T.meanY) * 0.8;
    let r = 1, g = 1, b = 1;
    r = r * (1 - dry * 0.15) + dry * 0.28; g = g * (1 - dry * 0.2) + dry * 0.12; b *= 1 - dry * 0.35;
    r *= 1 - lush * 0.18; g *= 1 - lush * 0.08; b *= 1 - lush * 0.2;
    r = r * (1 - rock) + 1.25 * rock; g = g * (1 - rock) + 0.95 * rock; b = b * (1 - rock) + 0.9 * rock;
    col[k * 3] = r * gr; col[k * 3 + 1] = g * gg; col[k * 3 + 2] = b * gb;
  }
  const idx = [];
  for (let z = 0; z < nz - 1; z++) for (let x = 0; x < nx - 1; x++) {
    const a = z * nx + x, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // photo-scanned splat material: vertex colour R = dirt weight
  for (let k = 0; k < nx * nz; k++) { col[k * 3] = E.road === 'gravel' ? 0.35 : 0; col[k * 3 + 1] = 0; col[k * 3 + 2] = 0; }
  geo.attributes.color.needsUpdate = true;
  const mat = terrainMaterial({ sandTint: E.sand ? 1 : null, grassTint: E.ground, snowLevel: T.meanY + 220 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  // distant horizon skirt so the world never ends abruptly
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1, 2, 64, 1),
    new THREE.MeshStandardMaterial({ color: E.sand ? new THREE.Color(...E.sand).multiplyScalar(0.8) : new THREE.Color(0x4f6a3a).multiply(new THREE.Color(gr, gg, gb)), roughness: 1 }),
  );
  const cx = (T.bounds.minX + T.bounds.maxX) / 2, cz = (T.bounds.minZ + T.bounds.maxZ) / 2;
  const rIn = Math.min(hf.nx, hf.nz) * hf.cell * 0.48;
  ring.geometry = new THREE.RingGeometry(rIn, 6000, 64, 1);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cx, T.meanY + 60, cz);
  const grp = new THREE.Group();
  grp.add(mesh, ring);
  return grp;
}

/** Instanced trees, clustered by noise, kept off the circuit. */
export function buildVegetation(T, { density = 1 } = {}) {
  const hf = T.heightfield;
  const R = rng(T.def.seed * 101 + 7);
  const n = T.noise;
  const E = envOf(T.env);
  density *= E.trees.density;
  const conifer = coniferGeometry();
  const broad = E.trees.palm ? palmGeometry() : broadleafGeometry();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.35 });
  const listC = [], listB = [];
  const minClear = T.half + 15 + 10;
  const tries = Math.floor(9000 * density);
  for (let k = 0; k < tries; k++) {
    const gx = R() * (hf.nx - 1), gz = R() * (hf.nz - 1);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const near = hf.near[iz * hf.nx + ix];
    if (near < minClear) continue;
    const x = hf.minX + gx * hf.cell, z = hf.minZ + gz * hf.cell;
    const cluster = n.fbm(x / 220 + 40, z / 220 - 13, 3);
    const p = clamp(0.15 + cluster * 1.6, 0, 0.95) * smoothstep(minClear, minClear + 30, near);
    if (R() > p) continue;
    const h = sampleHF(hf, x, z);
    if (h - T.meanY > 80) continue;
    const s = 0.75 + R() * 0.7;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, h - 0.3, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * Math.PI * 2),
      new THREE.Vector3(s, s * (0.85 + R() * 0.35), s),
    );
    const pine = E.trees.palm ? false : E.trees.pine > 0.6 ? R() < E.trees.pine + 0.1 : cluster > 0.12 || R() < E.trees.pine * 0.55;
    (pine ? listC : listB).push(m);
  }
  const g = new THREE.Group();
  // split into 220 m tiles so the renderer can frustum-cull (and skip
  // shadow-casting for) whole groups of trees you are not looking at
  const TILE = 420;
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  for (const [geo, list] of [[conifer, listC], [broad, listB]]) {
    const tiles = new Map();
    for (const m of list) {
      v.setFromMatrixPosition(m);
      const key = `${Math.floor(v.x / TILE)},${Math.floor(v.z / TILE)}`;
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(m);
    }
    for (const items of tiles.values()) {
      const im = new THREE.InstancedMesh(geo, mat, items.length);
      items.forEach((m, i) => {
        im.setMatrixAt(i, m);
        // per-tree tint: hue and value drift so a forest isn't one flat colour
        c.setRGB(0.8 + R() * 0.35, 0.82 + R() * 0.3, 0.7 + R() * 0.25);
        im.setColorAt(i, c);
      });
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    }
  }
  return g;
}

function sampleHF(hf, x, z) {
  const fx = clamp((x - hf.minX) / hf.cell, 0, hf.nx - 1.001);
  const fz = clamp((z - hf.minZ) / hf.cell, 0, hf.nz - 1.001);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ux = fx - ix, uz = fz - iz;
  const H = hf.h, w = hf.nx;
  const a = H[iz * w + ix], b = H[iz * w + ix + 1], c = H[(iz + 1) * w + ix], d = H[(iz + 1) * w + ix + 1];
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}

function colorize(geo, rgb, jitter = 0, R = Math.random) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = 1 + (R() - 0.5) * jitter;
    c[i * 3] = rgb[0] * j; c[i * 3 + 1] = rgb[1] * j; c[i * 3 + 2] = rgb[2] * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

function displace(geo, amt, seed) {
  const n = new THREE.Vector3();
  const R = rng(seed);
  const p = geo.attributes.position;
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    n.fromBufferAttribute(p, i);
    const key = `${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}`;
    let o = map.get(key);
    if (o === undefined) { o = 1 + (R() - 0.5) * amt; map.set(key, o); }
    p.setXYZ(i, n.x * o, n.y * (1 + (o - 1) * 0.5), n.z * o);
  }
  geo.computeVertexNormals();
  return geo;
}

function mergeGeos(list) {
  // minimal merge (position, normal, color) – avoids pulling extra addons
  let total = 0;
  const prepared = list.map((g) => { const ng = g.index ? g.toNonIndexed() : g; total += ng.attributes.position.count; return ng; });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of prepared) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

export function palmGeometry() {
  // curved trunk + drooping fronds
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 7, 7, 6);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) { const y = tp.getY(i) + 3.5; tp.setX(i, tp.getX(i) + 0.05 * y * y * 0.12); }
  trunk.translate(0, 3.5, 0);
  colorize(trunk, [0.45, 0.36, 0.25]);
  parts.push(trunk);
  for (let k = 0; k < 7; k++) {
    const leaf = new THREE.ConeGeometry(0.5, 3.6, 4, 1);
    leaf.scale(1, 1, 0.25);
    leaf.translate(0, 1.8, 0);
    leaf.rotateZ(1.95);
    leaf.rotateY((k / 7) * Math.PI * 2);
    leaf.translate(0.3, 7, 0);
    colorize(leaf, [0.28, 0.48, 0.2]);
    parts.push(leaf);
  }
  return mergeGeos(parts);
}

export function coniferGeometry() {
  const R = rng(3);
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 3, 7);
  trunk.translate(0, 1.5, 0);
  parts.push(colorize(trunk, [0.3, 0.2, 0.13], 0.1, R));
  const tiers = [[3.0, 4.6, 1.4], [2.4, 4.0, 3.8], [1.7, 3.4, 6.0], [1.0, 2.6, 8.0]];
  for (const [r, h, y] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 9, 2);
    displace(cone, 0.18, Math.floor(y * 10));
    cone.translate(0, y + h / 2, 0);
    parts.push(colorize(cone, [0.07, 0.14, 0.05], 0.3, R));
  }
  return mergeGeos(parts);
}

export function broadleafGeometry() {
  const R = rng(8);
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.25, 0.4, 3.6, 7);
  trunk.translate(0, 1.8, 0);
  parts.push(colorize(trunk, [0.32, 0.24, 0.17], 0.1, R));
  const blobs = [[0, 5.2, 0, 2.8], [1.4, 4.4, 0.6, 1.9], [-1.2, 4.6, -0.7, 2.0], [0.2, 6.6, -0.3, 1.9]];
  for (const [x, y, z, r] of blobs) {
    const s = new THREE.IcosahedronGeometry(r, 1);
    displace(s, 0.35, Math.floor(x * 7 + y * 13));
    s.translate(x, y, z);
    parts.push(colorize(s, [0.2, 0.33, 0.12], 0.3, R));
  }
  return mergeGeos(parts);
}
