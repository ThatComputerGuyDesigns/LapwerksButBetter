// Small, dependency-free math helpers shared by the simulation and the renderer.
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const wrap = (i, n) => ((i % n) + n) % n;
export const TAU = Math.PI * 2;
export const angleWrap = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
/** Exponential approach factor that is frame-rate independent. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Deterministic PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in 2D (deterministic, tileless). */
export function makeNoise2D(seed = 1) {
  const r = rng(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) val[i] = r() * 2 - 1;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const n = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const v00 = val[perm[X + perm[Y]]];
    const v10 = val[perm[X + 1 + perm[Y]]];
    const v01 = val[perm[X + perm[Y + 1]]];
    const v11 = val[perm[X + 1 + perm[Y + 1]]];
    const u = fade(xf), v = fade(yf);
    return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
  };
  n.fbm = (x, y, oct = 4) => {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) {
      s += a * n(x * f, y * f);
      f *= 2.03;
      a *= 0.5;
    }
    return s;
  };
  return n;
}

export function formatTime(t) {
  if (t == null || !isFinite(t)) return '–:––.–––';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
export function formatDelta(d) {
  if (d == null || !isFinite(d)) return '';
  return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(3);
}
