// Persistence (localStorage, always wrapped) + compact share codes for tracks.
const NS = 'kerbstone.';

function get(key, fallback) {
  try {
    const v = localStorage.getItem(NS + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function set(key, val) {
  try { localStorage.setItem(NS + key, JSON.stringify(val)); return true; } catch { return false; }
}

export const store = {
  get, set,
  tracks() { return get('tracks', []); },
  saveTrack(def) {
    const list = this.tracks().filter((t) => t.id !== def.id);
    list.unshift({ ...def, savedAt: Date.now() });
    set('tracks', list.slice(0, 60));
  },
  deleteTrack(id) { set('tracks', this.tracks().filter((t) => t.id !== id)); },
  carKey(setup) {
    return [setup.body, setup.compound, Math.round(setup.powerScale * 100), Math.round(setup.weightScale * 100), Math.round(setup.downforce * 100), setup.drivetrain || ''].join('-');
  },
  getBest(trackKey, setup) { return get(`best.${trackKey}.${this.carKey(setup)}`, null); },
  setBest(trackKey, setup, best) {
    // keep ghost data reasonably small
    set(`best.${trackKey}.${this.carKey(setup)}`, best);
    const idx = get('bestIndex', {});
    const cur = idx[trackKey];
    if (!cur || best.time < cur.time) idx[trackKey] = { time: best.time, car: setup.body };
    set('bestIndex', idx);
  },
  bestForTrack(trackKey) { return get('bestIndex', {})[trackKey] || null; },
};

/** Stable key for a track definition (shape + parameters). */
export function trackHash(def) {
  const s = JSON.stringify([def.points.map((p) => [Math.round(p[0]), Math.round(p[1])]), def.width, def.hills, def.banking, def.seed]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// ---------------- share codes: zig-zag varint deltas → base64url
function zz(n) { return n >= 0 ? n * 2 : -n * 2 - 1; }
function unzz(n) { return n & 1 ? -(n + 1) / 2 : n / 2; }
function pushVar(arr, n) { while (n >= 0x80) { arr.push((n & 0x7f) | 0x80); n >>>= 7; } arr.push(n); }
function readVar(bytes, o) { let n = 0, s = 0, b; do { b = bytes[o.i++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return n >>> 0; }

const THEMES = ['golden', 'midday', 'dusk'];

export function encodeTrack(def) {
  const bytes = [1]; // version
  pushVar(bytes, Math.round(def.width * 2));
  pushVar(bytes, Math.round(def.hills * 100));
  pushVar(bytes, Math.round(def.banking * 100));
  pushVar(bytes, def.seed | 0);
  pushVar(bytes, Math.max(0, THEMES.indexOf(def.theme)));
  pushVar(bytes, def.points.length);
  let px = 0, pz = 0;
  for (const [x, z] of def.points) {
    const ix = Math.round(x), iz = Math.round(z);
    pushVar(bytes, zz(ix - px)); pushVar(bytes, zz(iz - pz));
    px = ix; pz = iz;
  }
  const name = new TextEncoder().encode((def.name || '').slice(0, 40));
  pushVar(bytes, name.length);
  bytes.push(...name);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTrack(code) {
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const o = { i: 0 };
    const ver = bytes[o.i++];
    if (ver !== 1) return null;
    const width = readVar(bytes, o) / 2;
    const hills = readVar(bytes, o) / 100;
    const banking = readVar(bytes, o) / 100;
    const seed = readVar(bytes, o);
    const theme = THEMES[readVar(bytes, o)] || 'golden';
    const n = readVar(bytes, o);
    if (n < 4 || n > 400) return null;
    const points = [];
    let px = 0, pz = 0;
    for (let k = 0; k < n; k++) {
      px += unzz(readVar(bytes, o)); pz += unzz(readVar(bytes, o));
      points.push([px, pz]);
    }
    const nl = readVar(bytes, o);
    const name = new TextDecoder().decode(bytes.slice(o.i, o.i + nl)) || 'Shared Circuit';
    return { id: 'shared-' + trackHash({ points, width, hills, banking, seed }), name, width, hills, banking, seed, theme, points };
  } catch {
    return null;
  }
}
