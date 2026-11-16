// Photo-scanned CC0 materials (ambientCG) and the terrain splat material.
// Textures load asynchronously; materials are usable immediately and sharpen
// when the images arrive.
import * as THREE from 'three';

const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || './';
const loader = typeof document !== 'undefined' ? new THREE.TextureLoader() : null;
const cache = new Map();
let aniso = 8;
export const setAniso = (a) => { aniso = a; };

function tex(path, srgb) {
  if (cache.has(path)) return cache.get(path);
  const t = loader.load(BASE + path);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(path, t);
  return t;
}

/** {map, normalMap, orm} for a material id (orm: R = AO, G = roughness). */
export function pbr(id) {
  return {
    map: tex(`assets/tex/${id}_c.jpg`, true),
    normalMap: tex(`assets/tex/${id}_n.jpg`, false),
    orm: tex(`assets/tex/${id}_r.jpg`, false),
  };
}

/** A standard material using a scanned set; repeat = metres per tile is set by UVs. */
export function pbrMaterial(id, opts = {}) {
  const t = pbr(id);
  const m = new THREE.MeshStandardMaterial({
    map: t.map, normalMap: t.normalMap, roughnessMap: t.orm, aoMap: t.orm,
    roughness: 1, metalness: 0, aoMapIntensity: 0.8, ...opts,
  });
  if (opts.normalScale != null) m.normalScale = new THREE.Vector2(opts.normalScale, opts.normalScale);
  return m;
}

/**
 * Terrain splat material: grass on the flats (two grasses mixed by large
 * noise), meadow/soil patches, cliff rock on slopes (tri-planar), sand near
 * the water line and dirt where vertex colour R says so (trails, shoulders).
 * Each layer is sampled at two scales to hide tiling.
 */
export function terrainMaterial({ sandLevel = -1e9, waterLevel = -1e9, snowLevel = 1e9, sandTint = null, grassTint = [1, 1, 1] } = {}) {
  const g = pbr('grass'), g2 = pbr('grass2'), me = pbr('meadow'), ro = pbr('rock'), sa = pbr('sand'), di = pbr('dirt');
  const mat = new THREE.MeshStandardMaterial({ map: g.map, normalMap: g.normalMap, roughness: 0.95, metalness: 0, vertexColors: true, envMapIntensity: 0.7 });
  mat.normalScale = new THREE.Vector2(0.9, 0.9);
  const U = {
    tGrass2: { value: g2.map }, tMeadow: { value: me.map }, tRock: { value: ro.map }, tSand: { value: sa.map }, tDirt: { value: di.map },
    tRockN: { value: ro.normalMap },
    uSand: { value: sandLevel }, uWater: { value: waterLevel }, uSnow: { value: snowLevel },
    uGrassTint: { value: new THREE.Vector3(...grassTint) },
    uSandAll: { value: sandTint ? 1 : 0 },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNorm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNorm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNorm;
        uniform sampler2D tGrass2, tMeadow, tRock, tSand, tDirt, tRockN;
        uniform float uSand, uWater, uSnow, uSandAll; uniform vec3 uGrassTint;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
        vec3 tex2s(sampler2D t, vec2 p, float k){ return mix(texture2D(t, p * 0.11).rgb, texture2D(t, p * 0.027).rgb, k); }
        vec3 triRock(vec3 p, vec3 n){ vec3 b = pow(abs(n), vec3(4.0)); b /= (b.x + b.y + b.z);
          return texture2D(tRock, p.zy * 0.06).rgb * b.x + texture2D(tRock, p.xz * 0.06).rgb * b.y + texture2D(tRock, p.xy * 0.06).rgb * b.z; }`)
      .replace('#include <map_fragment>', `
        vec2 wp = vWPos.xz;
        float n1 = vn(wp * 0.008) * 0.6 + vn(wp * 0.031) * 0.4;
        float n2 = vn(wp * 0.0035 + 17.0);
        float k = smoothstep(0.3, 0.7, vn(wp * 0.02 + 3.0));
        vec3 grass = mix(texture2D(map, wp * 0.12).rgb, texture2D(map, wp * 0.031).rgb, k * 0.6);
        vec3 grassB = tex2s(tGrass2, wp, k);
        vec3 col = mix(grass, grassB, smoothstep(0.35, 0.75, n2)) * uGrassTint;
        // meadow / bare soil patches
        col = mix(col, tex2s(tMeadow, wp, k) * 0.85, smoothstep(0.66, 0.86, n1) * 0.55);
        // dirt where painted (vertex colour R) — trails, verges, under trees
        col = mix(col, tex2s(tDirt, wp, k), clamp(vColor.r, 0.0, 1.0));
        // sand by the water
        float sandW = max(1.0 - smoothstep(uSand - 1.0, uSand + 1.8 + n1 * 2.0, vWPos.y), uSandAll);
        col = mix(col, tex2s(tSand, wp, k), sandW * (1.0 - vColor.r));
        // rock on steep ground and high up
        float slope = 1.0 - vWNorm.y;
        float rockW = smoothstep(0.24, 0.42, slope + (n1 - 0.5) * 0.12);
        col = mix(col, triRock(vWPos, vWNorm), rockW);
        // snow caps
        col = mix(col, vec3(0.86, 0.88, 0.92), smoothstep(uSnow, uSnow + 25.0, vWPos.y + n1 * 30.0) * (1.0 - rockW * 0.6));
        diffuseColor.rgb *= col;`)
      .replace('#include <color_fragment>', '');
  };
  mat.customProgramCacheKey = () => `terrain-real-${sandLevel}-${sandTint ? 1 : 0}`;
  return mat;
}
