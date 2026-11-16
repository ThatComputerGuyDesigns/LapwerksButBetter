// Procedurally generated PBR textures (albedo / roughness / normal) built on
// canvases at startup — no downloads, crisp at any resolution.
import * as THREE from 'three';
import { makeNoise2D, rng } from '../core/math.js';

const cache = new Map();
let maxAniso = 8;
export function setMaxAnisotropy(a) { maxAniso = a; }

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTex(c, { repeat = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Height buffer → tangent-space normal map canvas. */
function normalFromHeight(hbuf, w, h, strength = 2) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = hbuf[y * w + ((x - 1 + w) % w)], r = hbuf[y * w + ((x + 1) % w)];
      const u = hbuf[((y - 1 + h) % h) * w + x], d = hbuf[((y + 1) % h) * w + x];
      let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * w + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Tileable value-noise helper (wraps at period). */
function tileNoise(seed, period) {
  const n = makeNoise2D(seed);
  return (x, y, oct = 4) => {
    // blend 4 offset samples for seamless tiling
    const fx = x / period, fy = y / period;
    const a = n.fbm(x, y, oct), b = n.fbm(x - period, y, oct), c = n.fbm(x, y - period, oct), d = n.fbm(x - period, y - period, oct);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };
}

/**
 * Asphalt with painted edge lines. u runs along the track (repeats), v spans
 * the full road width (0 = right edge, 1 = left edge).
 */
export function asphaltTextures() {
  if (cache.has('asphalt')) return cache.get('asphalt');
  const W = 512, H = 1024; // H across the road
  const R = rng(3);
  const tn = tileNoise(5, 32);
  const albedo = canvas(W, H), rough = canvas(W, H);
  const a = albedo.getContext('2d').createImageData(W, H);
  const r = rough.getContext('2d').createImageData(W, H);
  const hb = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n1 = tn((x / W) * 32, (y / H) * 64, 3);
      const grain = R();
      let v = 50 + n1 * 14 + (grain - 0.5) * 16;
      if (grain > 0.99) v += 26; // bright aggregate
      if (grain < 0.02) v -= 22;
      const i = (y * W + x) * 4;
      a.data[i] = v; a.data[i + 1] = v * 1.01; a.data[i + 2] = v * 1.04; a.data[i + 3] = 255;
      const rv = 205 + (grain - 0.5) * 60 - n1 * 30;
      r.data[i] = r.data[i + 1] = r.data[i + 2] = rv; r.data[i + 3] = 255;
      hb[y * W + x] = grain * 0.6 + n1 * 0.4;
    }
  }
  albedo.getContext('2d').putImageData(a, 0, 0);
  rough.getContext('2d').putImageData(r, 0, 0);
  // painted edge lines (slightly worn)
  const ac = albedo.getContext('2d'), rc = rough.getContext('2d');
  const lineAt = (v0, v1) => {
    const y0 = Math.round(v0 * H), y1 = Math.round(v1 * H);
    for (let x = 0; x < W; x++) {
      const wear = 0.82 + R() * 0.18;
      ac.fillStyle = `rgba(236,236,230,${wear})`;
      ac.fillRect(x, y0, 1, y1 - y0);
      rc.fillStyle = 'rgb(150,150,150)';
      rc.fillRect(x, y0, 1, y1 - y0);
    }
  };
  lineAt(0.012, 0.03);
  lineAt(0.97, 0.988);
  const res = {
    map: toTex(albedo),
    roughnessMap: toTex(rough, { srgb: false }),
    normalMap: toTex(normalFromHeight(hb, W, H, 1.2), { srgb: false }),
  };
  cache.set('asphalt', res);
  return res;
}

export function kerbTexture() {
  if (cache.has('kerb')) return cache.get('kerb');
  const W = 256, H = 64;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = i ? '#f2f2ee' : '#d4202a';
    ctx.fillRect(i * W / 2, 0, W / 2, H);
  }
  // darker grooves & grime
  const R = rng(9);
  for (let k = 0; k < 900; k++) {
    ctx.fillStyle = `rgba(30,25,25,${R() * 0.12})`;
    ctx.fillRect(R() * W, R() * H, 2 + R() * 6, 1 + R() * 2);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, H - 6, W, 6);
  const t = toTex(c);
  cache.set('kerb', t);
  return t;
}

export function grassTextures() {
  if (cache.has('grass')) return cache.get('grass');
  const W = 512, H = 512;
  const tn = tileNoise(12, 16);
  const R = rng(4);
  const c = canvas(W, H);
  const img = c.getContext('2d').createImageData(W, H);
  const hb = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const n = tn((x / W) * 16, (y / H) * 16, 4);
    const g = R();
    const i = (y * W + x) * 4;
    const k = 0.85 + n * 0.35 + (g - 0.5) * 0.25;
    img.data[i] = 62 * k; img.data[i + 1] = 104 * k; img.data[i + 2] = 40 * k; img.data[i + 3] = 255;
    hb[y * W + x] = g * 0.7 + n * 0.3;
  }
  c.getContext('2d').putImageData(img, 0, 0);
  const res = { map: toTex(c), normalMap: toTex(normalFromHeight(hb, W, H, 1.5), { srgb: false }) };
  cache.set('grass', res);
  return res;
}

/** Mowed stripes for the runoff (u along track). */
export function runoffGrassTexture() {
  if (cache.has('runoffGrass')) return cache.get('runoffGrass');
  const W = 512, H = 256;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const base = grassTextures().map.image;
  ctx.drawImage(base, 0, 0, W, H);
  ctx.drawImage(base, 0, 0, W, H);
  // soft mowing bands (gradient edges, low contrast: no checkerboard)
  for (let i = 0; i < 2; i++) {
    const g = ctx.createLinearGradient((i * W) / 2, 0, ((i + 1) * W) / 2, 0);
    g.addColorStop(0, 'rgba(255,255,210,0)');
    g.addColorStop(0.5, i ? 'rgba(255,255,210,0.045)' : 'rgba(0,25,0,0.045)');
    g.addColorStop(1, 'rgba(255,255,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect((i * W) / 2, 0, W / 2, H);
  }
  const t = toTex(c);
  cache.set('runoffGrass', t);
  return t;
}

export function gravelTextures() {
  if (cache.has('gravel')) return cache.get('gravel');
  const W = 512, H = 512;
  const R = rng(17);
  const c = canvas(W, H);
  const img = c.getContext('2d').createImageData(W, H);
  const hb = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const g = R();
    const i = (y * W + x) * 4;
    const k = 0.75 + g * 0.45;
    img.data[i] = 176 * k; img.data[i + 1] = 158 * k; img.data[i + 2] = 128 * k; img.data[i + 3] = 255;
    hb[y * W + x] = g;
  }
  c.getContext('2d').putImageData(img, 0, 0);
  const res = { map: toTex(c), normalMap: toTex(normalFromHeight(hb, W, H, 4), { srgb: false }) };
  cache.set('gravel', res);
  return res;
}

export function checkerTexture() {
  const c = canvas(128, 32);
  const ctx = c.getContext('2d');
  for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) {
    ctx.fillStyle = (x + y) % 2 ? '#111' : '#eee';
    ctx.fillRect(x * 8, y * 8, 8, 8);
  }
  const t = toTex(c);
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** Banner / advertising board texture with original fictional brands. */
export function bannerTexture(text, bg = '#0f1115', fg = '#ffffff', accent = '#ff5a1f', w = 1024, h = 128) {
  const key = `banner:${text}:${bg}:${fg}:${accent}:${w}`;
  if (cache.has(key)) return cache.get(key);
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = accent;
  ctx.fillRect(0, h - h * 0.12, w, h * 0.12);
  ctx.font = `800 ${Math.round(h * 0.56)}px "Saira Variable", "Inter Variable", system-ui, sans-serif`;
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h * 0.46);
  const t = toTex(c, { repeat: false });
  cache.set(key, t);
  return t;
}

export function crowdTexture() {
  if (cache.has('crowd')) return cache.get('crowd');
  const W = 512, H = 256;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(0, 0, W, H);
  const R = rng(77);
  const cols = ['#e04b3a', '#f0c419', '#2e86de', '#ffffff', '#1b1b1b', '#ff8a3d', '#5fbf6a', '#c0c4cc', '#7d4cdb'];
  for (let row = 0; row < 16; row++) {
    for (let k = 0; k < 64; k++) {
      if (R() < 0.12) continue;
      const x = k * 8 + R() * 3, y = row * 16 + 4 + R() * 3;
      ctx.fillStyle = cols[Math.floor(R() * cols.length)];
      ctx.fillRect(x, y + 4, 6, 8);
      ctx.fillStyle = '#e8c4a0';
      ctx.fillRect(x + 1.5, y, 3, 4);
    }
  }
  const t = toTex(c);
  cache.set('crowd', t);
  return t;
}

/** Soft radial gradient sprite (smoke, contact shadow). */
export function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128) {
  const key = `radial:${inner}:${outer}`;
  if (cache.has(key)) return cache.get(key);
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = toTex(c, { repeat: false });
  cache.set(key, t);
  return t;
}

/** Car livery: paint + stripes + race number, mapped on the lofted body UVs. */
export function liveryTexture(setup) {
  const W = 1024, H = 512;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = setup.paint;
  ctx.fillRect(0, 0, W, H);
  const acc = setup.accent || '#111';
  // v: 0 bottom, .25 left side, .5 top, .75 right side ; u: 0 rear → 1 front
  ctx.fillStyle = acc;
  if (setup.livery === 'stripes') {
    // twin stripes over the top, stopping short of the nose where the
    // section tightens
    ctx.fillRect(0, H * 0.47, W * 0.9, H * 0.022);
    ctx.fillRect(0, H * 0.508, W * 0.9, H * 0.022);
  } else if (setup.livery === 'band') {
    ctx.fillRect(0, H * 0.205, W, H * 0.035);
    ctx.fillRect(0, H * 0.76, W, H * 0.035);
  } else if (setup.livery === 'split') {
    ctx.fillRect(0, 0, W, H * 0.2);
    ctx.fillRect(0, H * 0.8, W, H * 0.2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, H * 0.2, W, H * 0.008);
    ctx.fillRect(0, H * 0.792, W, H * 0.008);
  }
  // panel lines: door shut lines, bonnet / boot seams, sill line
  ctx.strokeStyle = 'rgba(0,0,0,0.42)';
  ctx.lineWidth = 2;
  const vy = (v) => H * (1 - v); // canvas y for texture v (flipY)
  for (const [va, vb] of [[0.1, 0.36], [0.64, 0.9]]) {
    for (const u of [0.36, 0.62]) { ctx.beginPath(); ctx.moveTo(W * u, vy(va)); ctx.lineTo(W * u, vy(vb)); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(W * 0.2, vy(va)); ctx.lineTo(W * 0.8, vy(va)); ctx.stroke();
  }
  for (const u of [0.8, 0.13]) { ctx.beginPath(); ctx.moveTo(W * u, vy(0.37)); ctx.lineTo(W * u, vy(0.63)); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (const u of [0.362, 0.622]) { ctx.beginPath(); ctx.moveTo(W * u, vy(0.12)); ctx.lineTo(W * u, vy(0.34)); ctx.stroke(); }

  // number roundels on both doors
  const num = String(setup.number ?? 7);
  for (const v of [0.25, 0.75]) {
    const cx = W * 0.47, cy = H * v;
    ctx.save();
    ctx.translate(cx, cy);
    // texture v runs around the body: mirror per side so it reads correctly
    if (v < 0.5) ctx.scale(1, -0.5);
    else ctx.scale(-1, 0.5);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, 44, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = '800 58px "Saira Variable", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, 0, 1);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}
