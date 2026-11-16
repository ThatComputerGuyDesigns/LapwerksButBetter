// Final-image grading pass (after tone mapping): gentle S-curve contrast,
// saturation, warm/cool split toning, vignette and a radial speed blur.
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export function makeGradePass() {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      speed: { value: 0 },
      vignette: { value: 0.32 },
      saturation: { value: 1.12 },
      contrast: { value: 1.1 },
      warmth: { value: 0.015 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float speed, vignette, saturation, contrast, warmth; varying vec2 vUv;
      void main(){
        vec2 c = vUv - 0.5;
        vec3 col = texture2D(tDiffuse, vUv).rgb;
        if (speed > 0.001) {
          // radial blur, strongest at the edges, none in the centre
          float k = speed * 0.035 * smoothstep(0.12, 0.7, length(c));
          vec3 acc = col;
          for (int i = 1; i < 7; i++) acc += texture2D(tDiffuse, vUv - c * k * float(i) / 6.0).rgb;
          col = acc / 7.0;
        }
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, saturation);
        col = (col - 0.5) * contrast + 0.5;
        // split tone: warm highlights, slightly cool shadows
        col += vec3(warmth, warmth * 0.4, -warmth) * smoothstep(0.35, 1.0, l);
        col += vec3(-0.01, 0.0, 0.015) * (1.0 - smoothstep(0.0, 0.35, l));
        float v = smoothstep(0.85, 0.25, length(c * vec2(1.0, 0.85)));
        col *= mix(1.0 - vignette, 1.0, v);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`,
  });
}

/** Procedural cloud dome lit by the sun. */
export function makeClouds() {
  const geo = new THREE.SphereGeometry(4500, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const mat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(1, 0.9, 0.8) }, cover: { value: 0.45 }, shade: { value: new THREE.Color(0.55, 0.6, 0.7) } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float time, cover; uniform vec3 sunDir, sunCol, shade; varying vec3 vDir;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * n(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
      void main(){
        if (vDir.y < 0.01) discard;
        vec2 uv = vDir.xz / (vDir.y + 0.12) * 1.6 + vec2(time * 0.004, time * 0.0015);
        float d = fbm(uv);
        float m = smoothstep(cover, cover + 0.28, d);
        float lit = clamp(0.55 + 0.6 * (fbm(uv + sunDir.xz * 0.08) - d) * -3.0, 0.0, 1.0);
        vec3 col = mix(shade, sunCol, lit);
        float fade = smoothstep(0.01, 0.18, vDir.y);
        gl_FragColor = vec4(col, m * fade * 0.85);
      }`,
    transparent: true, depthWrite: false, fog: false, side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}
