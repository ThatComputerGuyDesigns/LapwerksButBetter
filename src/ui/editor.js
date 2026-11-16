// Track Studio: draw a loop freehand, watch it morph into a circuit, then
// refine control points, width, elevation, banking and scenery.
import { strokeToControlPoints, catmullRomClosed, resamplePolyline, polylineLength, findCrossings, convexHull } from '../track/spline.js';
import { buildTrack } from '../track/track.js';
import { computeRacingLine, speedProfile } from '../track/racingLine.js';
import { makeCarParams } from '../physics/carSetup.js';
import { PRESETS } from '../track/presets.js';
import { clamp, lerp, rng, formatTime } from '../core/math.js';
import { audio } from '../audio/audio.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export class TrackEditor {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.def = null;
    this.history = [];
    this.view = { cx: 0, cz: 0, scale: 0.6 }; // px per meter
    this.mode = 'draw';
    this.stroke = null;
    this.morph = null;
    this.preview = null;
    this.drag = null;
    this.hover = -1;
    this.build();
  }

  build() {
    const r = this.root;
    r.innerHTML = '';
    r.classList.add('editor');
    this.canvas = el('canvas', 'editor-canvas');
    r.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    const top = el('div', 'editor-top glass');
    top.innerHTML = `
      <button class="icon-btn back" data-act="back" title="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="ed-title"><span class="eyebrow">Track Studio</span><input class="ed-name" maxlength="40" spellcheck="false" /></div>
      <div class="seg" role="tablist">
        <button data-mode="draw" class="on"><svg viewBox="0 0 24 24"><path d="M4 20c4-1 6-3 8-7s4-7 8-8"/></svg>Draw</button>
        <button data-mode="edit"><svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.2"/><circle cx="12" cy="8" r="2.2"/><circle cx="19" cy="14" r="2.2"/><path d="M7.5 16.5l3-6.5M13.8 9.4l3.8 3.4"/></svg>Shape</button>
      </div>
      <div class="ed-actions">
        <button class="icon-btn" data-act="undo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24"><path d="M9 7H4V2M4.5 7A8 8 0 1 1 6 17"/></svg></button>
        <button class="icon-btn" data-act="reverse" title="Reverse direction"><svg viewBox="0 0 24 24"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg></button>
        <button class="icon-btn" data-act="random" title="Random circuit"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9" cy="15" r="1.2"/></svg></button>
        <button class="icon-btn" data-act="clear" title="Clear"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>
      </div>`;
    r.appendChild(top);

    const side = el('div', 'editor-side glass');
    side.innerHTML = `
      <div class="ed-stats">
        <div><span class="k">Length</span><span class="v" data-s="len">—</span></div>
        <div><span class="k">Corners</span><span class="v" data-s="corners">—</span></div>
        <div><span class="k">Elevation</span><span class="v" data-s="elev">—</span></div>
        <div><span class="k">Est. lap</span><span class="v" data-s="lap">—</span></div>
      </div>
      <canvas class="ed-profile" width="560" height="120" title="Elevation profile"></canvas>
      <label class="slider"><span>Track width <b data-o="width"></b></span><input type="range" min="9" max="20" step="0.5" data-p="width"></label>
      <label class="slider"><span>Elevation <b data-o="hills"></b></span><input type="range" min="0" max="1" step="0.05" data-p="hills"></label>
      <label class="slider"><span>Banking <b data-o="banking"></b></span><input type="range" min="0" max="1" step="0.05" data-p="banking"></label>
      <div class="row-btns">
        <button class="chip" data-act="reroll">Reshape hills</button>
      </div>
      <div class="field"><span>Scenery</span>
        <div class="seg small" data-theme-seg>
          <button data-theme="golden">Golden hour</button><button data-theme="midday">Midday</button><button data-theme="dusk">Dusk</button>
        </div>
      </div>
      <div class="field"><span>Start from</span>
        <div class="templates"></div>
      </div>
      <div class="ed-warn" hidden></div>
      <button class="btn primary big" data-act="build"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>Build &amp; drive</button>
      <button class="btn ghost" data-act="save">Save to my circuits</button>`;
    r.appendChild(side);
    this.side = side;

    const hint = el('div', 'editor-hint', '<b>Draw a loop</b> with your mouse, finger or pen. Lift to finish — we close it, smooth it and build the circuit.');
    r.appendChild(hint);
    this.hintEl = hint;

    const tpl = side.querySelector('.templates');
    for (const p of PRESETS) {
      const b = el('button', 'tpl', `<canvas width="88" height="60"></canvas><span>${p.name}</span>`);
      b.addEventListener('click', () => { audio.click(); this.loadDef({ ...p, id: 'custom-' + Date.now().toString(36), name: p.name + ' (copy)' }, true); });
      tpl.appendChild(b);
      drawThumb(b.querySelector('canvas'), p.points);
    }

    top.querySelector('.ed-name').addEventListener('input', (e) => { if (this.def) this.def.name = e.target.value; });
    top.addEventListener('click', (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) this.setMode(m.dataset.mode);
      const a = e.target.closest('[data-act]');
      if (a) this.action(a.dataset.act);
    });
    side.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) this.action(a.dataset.act);
      const t = e.target.closest('[data-theme]');
      if (t && this.def) { this.def.theme = t.dataset.theme; this.syncPanel(); audio.click(); }
    });
    side.querySelectorAll('input[type=range]').forEach((inp) => {
      inp.addEventListener('input', () => {
        if (!this.def) return;
        this.def[inp.dataset.p] = parseFloat(inp.value);
        this.syncPanel(false);
        this.schedulePreview();
      });
      inp.addEventListener('change', () => this.pushHistory());
    });

    // pointer handling
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('dblclick', (e) => this.onDouble(e));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.deleteAt(e); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wz] = this.toWorld(e.offsetX, e.offsetY);
      const k = Math.exp(-e.deltaY * 0.0015);
      this.view.scale = clamp(this.view.scale * k, 0.12, 4);
      const [nx, nz] = this.toWorld(e.offsetX, e.offsetY);
      this.view.cx += wx - nx; this.view.cz += wz - nz;
    }, { passive: false });
    this.pointers = new Map();
    window.addEventListener('keydown', (this.onKey = (e) => {
      if (!this.active) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); this.action('undo'); }
    }));
    window.addEventListener('resize', () => this.resize());
  }

  open(def) {
    this.active = true;
    this.root.hidden = false;
    this.resize();
    if (def) this.loadDef(JSON.parse(JSON.stringify(def)), true);
    else this.clear();
    const loop = () => {
      if (!this.active) return;
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  close() { this.active = false; this.root.hidden = true; }

  resize() {
    this.dirty = true;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.dpr = dpr;
  }

  // ---------- coordinate helpers
  toWorld(px, py) {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    return [(px - this.drawCenterX(w)) / this.view.scale + this.view.cx, (py - h / 2) / this.view.scale + this.view.cz];
  }
  toScreen(x, z) {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    return [(x - this.view.cx) * this.view.scale + this.drawCenterX(w), (z - this.view.cz) * this.view.scale + h / 2];
  }
  drawCenterX(w) {
    const sideW = this.side.offsetWidth && window.innerWidth > 820 ? this.side.offsetWidth + 24 : 0;
    return (w - sideW) / 2;
  }

  fitView() {
    if (!this.def) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of this.def.points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const sideW = window.innerWidth > 820 ? this.side.offsetWidth + 24 : 0;
    const availW = w - sideW - 80, availH = h - 200;
    this.view.scale = clamp(Math.min(availW / (maxX - minX + 60), availH / (maxZ - minZ + 60)), 0.12, 3);
    this.view.cx = (minX + maxX) / 2;
    this.view.cz = (minZ + maxZ) / 2 - 20 / this.view.scale;
  }

  setMode(m) {
    this.mode = m;
    this.root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    this.canvas.style.cursor = m === 'draw' ? 'crosshair' : 'default';
    this.updateHint();
  }

  updateHint() {
    if (!this.def) {
      this.hintEl.innerHTML = '<b>Draw a loop</b> with your mouse, finger or pen. Lift to finish — we close it, smooth it and build the circuit.';
      this.hintEl.hidden = false;
    } else if (this.mode === 'edit') {
      this.hintEl.innerHTML = '<b>Drag</b> points to reshape · <b>double-click</b> the track to add a point · <b>right-click</b> a point to remove it';
      this.hintEl.hidden = false;
    } else {
      this.hintEl.innerHTML = 'Draw again to start over, or switch to <b>Shape</b> to fine-tune.';
      this.hintEl.hidden = false;
    }
  }

  // ---------- state
  clear() {
    this.dirty = true;
    this.def = null;
    this.preview = null;
    this.morph = null;
    this.view = { cx: 0, cz: 0, scale: 0.55 };
    this.syncPanel();
    this.setMode('draw');
  }

  loadDef(def, fit) {
    this.def = { width: 13, hills: 0.4, banking: 0.35, seed: 7, theme: 'golden', ...def };
    if (!this.def.id) this.def.id = 'custom-' + Date.now().toString(36);
    if (fit) this.fitView();
    this.pushHistory();
    this.rebuildPreview();
    this.syncPanel();
    this.setMode(this.mode);
  }

  pushHistory() {
    if (!this.def) return;
    this.history.push(JSON.stringify(this.def));
    if (this.history.length > 60) this.history.shift();
  }

  action(a) {
    audio.click();
    if (a === 'back') this.app.showHome();
    else if (a === 'undo') {
      if (this.history.length > 1) {
        this.history.pop();
        this.def = JSON.parse(this.history[this.history.length - 1]);
        this.rebuildPreview(); this.syncPanel();
      } else if (this.history.length === 1) { this.history.pop(); this.clear(); }
    } else if (a === 'clear') { this.pushHistory(); this.clear(); }
    else if (a === 'reverse' && this.def) { this.def.points.reverse(); this.pushHistory(); this.rebuildPreview(); }
    else if (a === 'random') this.loadDef({ ...randomTrack(Date.now() & 0xffff), id: 'custom-' + Date.now().toString(36) }, true);
    else if (a === 'reroll' && this.def) { this.def.seed = (this.def.seed * 7 + 13) % 997; this.pushHistory(); this.rebuildPreview(); }
    else if (a === 'save' && this.def) { this.app.saveTrack(this.def); this.app.toast('Saved to My circuits'); }
    else if (a === 'build' && this.def) { this.app.buildAndReveal(this.def); }
  }

  syncPanel(full = true) {
    const d = this.def;
    const s = this.side;
    s.querySelectorAll('input[type=range]').forEach((inp) => { if (d && full) inp.value = d[inp.dataset.p]; inp.disabled = !d; });
    const o = (k, v) => { const e = s.querySelector(`[data-o=${k}]`); if (e) e.textContent = v; };
    o('width', d ? `${d.width} m` : '');
    o('hills', d ? `${Math.round(d.hills * 100)}%` : '');
    o('banking', d ? `${Math.round(d.banking * 100)}%` : '');
    s.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('on', d && b.dataset.theme === d.theme));
    s.querySelector('[data-act=build]').disabled = !d;
    s.querySelector('[data-act=save]').disabled = !d;
    const name = this.root.querySelector('.ed-name');
    if (full) name.value = d ? d.name || 'My Circuit' : 'New circuit';
    name.disabled = !d;
    if (!d) {
      for (const k of ['len', 'corners', 'elev', 'lap']) s.querySelector(`[data-s=${k}]`).textContent = '—';
      s.querySelector('.ed-warn').hidden = true;
      const pc = s.querySelector('.ed-profile');
      pc.getContext('2d').clearRect(0, 0, pc.width, pc.height);
    }
  }

  schedulePreview() {
    clearTimeout(this.pvTimer);
    this.pvTimer = setTimeout(() => this.rebuildPreview(), 60);
  }

  rebuildPreview() {
    this.dirty = true;
    if (!this.def || this.def.points.length < 4) { this.preview = null; return; }
    try {
      const T = buildTrack(this.def);
      const line = computeRacingLine(T, { iterations: 300 });
      const prof = speedProfile(T, line, makeCarParams(this.app.setup));
      this.preview = { T, line, prof };
      this.dirty = true;
      const s = this.side;
      s.querySelector('[data-s=len]').textContent = `${(T.length / 1000).toFixed(2)} km`;
      s.querySelector('[data-s=corners]').textContent = `${T.corners.length}`;
      s.querySelector('[data-s=elev]').textContent = `${(T.bounds.maxY - T.bounds.minY).toFixed(0)} m`;
      s.querySelector('[data-s=lap]').textContent = formatTime(prof.lapTime * 1.05);
      const warn = s.querySelector('.ed-warn');
      const msgs = [];
      if (T.length < 900) msgs.push('Short circuit — consider drawing a bigger loop.');
      if (T.crossings.length) msgs.push(`${T.crossings.length} crossing${T.crossings.length > 1 ? 's' : ''} → automatic flyover${T.crossings.length > 1 ? 's' : ''}.`);
      warn.hidden = !msgs.length;
      warn.textContent = msgs.join(' ');
      this.drawProfile(T);
    } catch (err) {
      console.warn(err);
      this.preview = null;
    }
  }

  drawProfile(T) {
    const c = this.side.querySelector('.ed-profile');
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const { minY, maxY } = T.bounds;
    const span = Math.max(maxY - minY, 6);
    const pts = [];
    for (let k = 0; k <= 140; k++) {
      const i = Math.floor((k / 140) * (T.N - 1));
      pts.push([(k / 140) * W, H - 14 - ((T.py[i] - minY) / span) * (H - 34)]);
    }
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(255,106,43,0.55)');
    grad.addColorStop(1, 'rgba(255,106,43,0.02)');
    g.beginPath();
    g.moveTo(0, H);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(W, H);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    g.beginPath();
    pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = '#ff7a3d';
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.font = '600 20px "Inter Variable", system-ui';
    g.fillText(`${span.toFixed(0)} m`, 8, 24);
  }

  // ---------- pointer
  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (this.pointers.size === 2) {
      // pinch / pan
      this.stroke = null; this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), scale: this.view.scale, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cx: this.view.cx, cz: this.view.cz };
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) { this.pan = { x: e.offsetX, y: e.offsetY, cx: this.view.cx, cz: this.view.cz }; return; }
    if (e.button !== 0) return;
    if (this.mode === 'draw') {
      this.stroke = [this.toWorld(e.offsetX, e.offsetY)];
      this.morph = null;
    } else if (this.def) {
      const i = this.pick(e.offsetX, e.offsetY);
      if (i >= 0) this.drag = { i };
      else this.pan = { x: e.offsetX, y: e.offsetY, cx: this.view.cx, cz: this.view.cz };
    }
  }

  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      this.view.scale = clamp(this.pinch.scale * (d / this.pinch.d), 0.12, 4);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.view.cx = this.pinch.cx - (mid[0] - this.pinch.mid[0]) / this.view.scale;
      this.view.cz = this.pinch.cz - (mid[1] - this.pinch.mid[1]) / this.view.scale;
      return;
    }
    if (this.pan) {
      this.view.cx = this.pan.cx - (e.offsetX - this.pan.x) / this.view.scale;
      this.view.cz = this.pan.cz - (e.offsetY - this.pan.y) / this.view.scale;
      return;
    }
    if (this.stroke) {
      const p = this.toWorld(e.offsetX, e.offsetY);
      const last = this.stroke[this.stroke.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.view.scale > 2) this.stroke.push(p);
      // also capture coalesced events for smooth strokes
      return;
    }
    if (this.drag) {
      this.def.points[this.drag.i] = this.toWorld(e.offsetX, e.offsetY);
      this.dragDirty = true;
      this.schedulePreview();
      return;
    }
    if (this.mode === 'edit' && this.def) this.hover = this.pick(e.offsetX, e.offsetY);
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.pan = null;
    if (this.drag) { this.drag = null; this.pushHistory(); this.rebuildPreview(); return; }
    if (!this.stroke) return;
    const stroke = this.stroke;
    this.stroke = null;
    const ctrl = strokeToControlPoints(stroke);
    if (!ctrl) {
      if (stroke.length > 3) this.app.toast('Draw a bigger loop — at least a few hundred meters.');
      return;
    }
    const prev = this.def;
    const def = {
      id: prev?.id || 'custom-' + Date.now().toString(36),
      name: prev?.name && !/copy\)$/.test(prev.name) ? prev.name : 'My Circuit',
      width: prev?.width ?? 13, hills: prev?.hills ?? 0.4, banking: prev?.banking ?? 0.35,
      seed: prev?.seed ?? Math.floor(Math.random() * 900), theme: prev?.theme ?? 'golden', points: ctrl,
    };
    // morph animation: raw stroke → smooth circuit
    const smooth = catmullRomClosed(ctrl, 16);
    const target = resamplePolyline(smooth, polylineLength(smooth, true) / 240, true).slice(0, 240);
    const src = resamplePolyline(stroke, Math.max(polylineLength(stroke) / 239, 0.5)).slice(0, 240);
    while (src.length < target.length) src.push(src[src.length - 1]);
    // align phase: rotate target so it starts nearest to the stroke start
    let best = 0, bd = Infinity;
    target.forEach((p, k) => { const d = Math.hypot(p[0] - src[0][0], p[1] - src[0][1]); if (d < bd) { bd = d; best = k; } });
    const tgt = target.slice(best).concat(target.slice(0, best));
    this.morph = { src, tgt, t0: performance.now() };
    audio.beep(660, 0.1, 0.12, 'triangle');
    setTimeout(() => audio.beep(990, 0.16, 0.12, 'triangle'), 160);
    this.loadDef(def, false);
  }

  onDouble(e) {
    if (this.mode !== 'edit' || !this.def) return;
    const [x, z] = this.toWorld(e.offsetX, e.offsetY);
    // insert after the closest segment
    const P = this.def.points;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const d = distToSeg([x, z], a, b);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd * this.view.scale > 40) return;
    P.splice(bi + 1, 0, [x, z]);
    this.pushHistory();
    this.rebuildPreview();
  }

  deleteAt(e) {
    if (!this.def || this.def.points.length <= 5) return;
    const i = this.pick(e.offsetX, e.offsetY);
    if (i < 0) return;
    this.def.points.splice(i, 1);
    this.pushHistory();
    this.rebuildPreview();
  }

  pick(px, py) {
    if (!this.def) return -1;
    let bi = -1, bd = 16;
    this.def.points.forEach(([x, z], i) => {
      const [sx, sy] = this.toScreen(x, z);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  }

  // ---------- rendering
  draw() {
    // only repaint when something changed (keeps the studio cheap on mobile)
    const v = this.view;
    const sig = `${v.cx},${v.cz},${v.scale},${this.mode},${this.hover},${this.canvas.width},${this.canvas.height}`;
    if (!this.dirty && !this.morph && !this.stroke && !this.drag && sig === this.lastSig) return;
    this.lastSig = sig;
    this.dirty = false;
    const g = this.ctx;
    const dpr = this.dpr;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // blueprint background
    const bg = g.createRadialGradient(W * 0.45, H * 0.45, 50, W * 0.5, H * 0.5, Math.max(W, H) * 0.8);
    bg.addColorStop(0, '#16202b');
    bg.addColorStop(1, '#0b0f15');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    this.drawGrid(g, W, H);

    const now = performance.now();
    if (this.morph) {
      const t = clamp((now - this.morph.t0) / 900, 0, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      if (t < 1) {
        const pts = this.morph.src.map((p, k) => [lerp(p[0], this.morph.tgt[k][0], e), lerp(p[1], this.morph.tgt[k][1], e)]);
        g.lineCap = 'round'; g.lineJoin = 'round';
        this.pathWorld(g, pts, true);
        g.strokeStyle = `rgba(255,122,61,${0.9})`;
        g.lineWidth = lerp(3, Math.max(4, (this.def?.width || 13) * this.view.scale), e);
        g.shadowColor = 'rgba(255,106,43,0.8)'; g.shadowBlur = 18 * (1 - e) + 4;
        g.stroke();
        g.shadowBlur = 0;
        return;
      }
      this.morph = null;
      this.dirty = true;
    }
    if (this.preview) this.drawTrack(g, this.preview, now);
    if (this.stroke && this.stroke.length > 1) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      this.pathWorld(g, this.stroke, false);
      g.strokeStyle = '#ff7a3d';
      g.lineWidth = 3.5;
      g.shadowColor = 'rgba(255,106,43,0.9)'; g.shadowBlur = 14;
      g.stroke();
      g.shadowBlur = 0;
      // closing hint
      const a = this.stroke[0], b = this.stroke[this.stroke.length - 1];
      const [ax, ay] = this.toScreen(a[0], a[1]), [bx, by] = this.toScreen(b[0], b[1]);
      g.setLineDash([6, 8]);
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(bx, by); g.lineTo(ax, ay); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(ax, ay, 5, 0, Math.PI * 2); g.fill();
    }
    this.drawScale(g, W, H);
  }

  drawGrid(g, W, H) {
    const s = this.view.scale;
    let step = 50;
    while (step * s < 28) step *= 2;
    const [x0, z0] = this.toWorld(0, 0), [x1, z1] = this.toWorld(W, H);
    g.lineWidth = 1;
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      const [sx] = this.toScreen(x, 0);
      g.strokeStyle = x % (step * 5) === 0 ? 'rgba(120,170,220,0.13)' : 'rgba(120,170,220,0.055)';
      g.beginPath(); g.moveTo(Math.round(sx) + 0.5, 0); g.lineTo(Math.round(sx) + 0.5, H); g.stroke();
    }
    for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) {
      const [, sy] = this.toScreen(0, z);
      g.strokeStyle = z % (step * 5) === 0 ? 'rgba(120,170,220,0.13)' : 'rgba(120,170,220,0.055)';
      g.beginPath(); g.moveTo(0, Math.round(sy) + 0.5); g.lineTo(W, Math.round(sy) + 0.5); g.stroke();
    }
  }

  drawScale(g, W, H) {
    const s = this.view.scale;
    let m = 100;
    if (m * s > 200) m = 50;
    if (m * s < 60) m = 250;
    if (m * s < 60) m = 500;
    const x = 28, y = H - 34;
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x, y); g.lineTo(x + m * s, y); g.lineTo(x + m * s, y - 5); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = '600 12px "Inter Variable", system-ui';
    g.fillText(`${m} m`, x + 4, y - 9);
  }

  pathWorld(g, pts, closed) {
    g.beginPath();
    pts.forEach(([x, z], k) => {
      const [sx, sy] = this.toScreen(x, z);
      if (k) g.lineTo(sx, sy); else g.moveTo(sx, sy);
    });
    if (closed) g.closePath();
  }

  drawTrack(g, { T, line, prof }, now) {
    const s = this.view.scale;
    const N = T.N;
    const pts = [];
    for (let i = 0; i < N; i++) pts.push([T.px[i], T.pz[i]]);
    g.lineCap = 'round'; g.lineJoin = 'round';
    // runoff glow
    this.pathWorld(g, pts, true);
    g.strokeStyle = 'rgba(80,140,90,0.18)';
    g.lineWidth = (T.width + 26) * s;
    g.stroke();
    // kerbs: draw road slightly wider with red/white dashes where kerbs
    g.lineWidth = (T.width + 3) * s;
    g.strokeStyle = '#e9e9e4';
    this.pathWorld(g, pts, true); g.stroke();
    // kerb runs (two batched paths: red and white alternating)
    g.lineCap = 'butt';
    g.lineWidth = (T.width + 3) * s;
    for (const parity of [0, 1]) {
      g.beginPath();
      for (let i = parity; i < N; i += 2) {
        if (!T.kerb[i]) continue;
        const j = (i + 1) % N;
        const [ax, ay] = this.toScreen(T.px[i], T.pz[i]), [bx, by] = this.toScreen(T.px[j], T.pz[j]);
        g.moveTo(ax, ay); g.lineTo(bx, by);
      }
      g.strokeStyle = parity ? '#d4202a' : '#f2f2ee';
      g.stroke();
    }
    g.lineCap = 'round';
    // asphalt, tinted by elevation (bucketed into a few batched paths)
    g.lineCap = 'round';
    g.lineWidth = T.width * s;
    const buckets = 6;
    for (let bk = 0; bk < buckets; bk++) {
      g.beginPath();
      for (let i = 0; i < N; i++) {
        const h = (T.py[i] - T.bounds.minY) / Math.max(T.bounds.maxY - T.bounds.minY, 1);
        if (Math.min(buckets - 1, Math.floor(h * buckets)) !== bk) continue;
        const j = (i + 1) % N;
        const [ax, ay] = this.toScreen(T.px[i], T.pz[i]), [bx, by] = this.toScreen(T.px[j], T.pz[j]);
        g.moveTo(ax, ay); g.lineTo(bx, by);
      }
      g.strokeStyle = `hsl(215, 10%, ${26 + (bk / (buckets - 1)) * 16}%)`;
      g.stroke();
    }
    // bridges
    for (const c of T.crossings) {
      const i = c.upper;
      g.lineWidth = (T.width + 4) * s;
      g.strokeStyle = '#a8a59d';
      g.beginPath();
      for (let k = -14; k <= 14; k++) {
        const q = (i + k + N) % N;
        const [x, y] = this.toScreen(T.px[q], T.pz[q]);
        if (k === -14) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.lineWidth = T.width * s;
      g.strokeStyle = 'hsl(215, 10%, 40%)';
      g.stroke();
    }
    // racing line, coloured by what the car is doing (batched by colour)
    g.lineWidth = Math.max(1.5, 0.6 * s);
    const cols = ['rgba(80,240,140,0.7)', 'rgba(255,200,60,0.85)', 'rgba(255,70,60,0.85)'];
    for (let ci = 0; ci < 3; ci++) {
      g.beginPath();
      for (let i = 0; i < N; i += 2) {
        const dv = prof.v[(i + 8) % N] - prof.v[i];
        const c = dv < -1.2 ? 2 : dv < -0.25 ? 1 : 0;
        if (c !== ci) continue;
        const j = (i + 2) % N;
        const [ax, ay] = this.toScreen(line.x[i], line.z[i]), [bx, by] = this.toScreen(line.x[j], line.z[j]);
        g.moveTo(ax, ay); g.lineTo(bx, by);
      }
      g.strokeStyle = cols[ci];
      g.stroke();
    }
    // start / finish
    {
      const [x, y] = this.toScreen(T.px[0], T.pz[0]);
      const ang = Math.atan2(T.tz[0], T.tx[0]);
      g.save(); g.translate(x, y); g.rotate(ang);
      const w = T.width * s, cell = Math.max(2, w / 8);
      for (let a = 0; a < 8; a++) for (let b = 0; b < 2; b++) {
        g.fillStyle = (a + b) % 2 ? '#111' : '#fff';
        g.fillRect(b * cell - cell, -w / 2 + a * (w / 8), cell, w / 8);
      }
      g.restore();
      // direction arrow
      const k = 18;
      const [x2, y2] = this.toScreen(T.px[k], T.pz[k]);
      const a2 = Math.atan2(T.tz[k], T.tx[k]);
      g.save(); g.translate(x2, y2); g.rotate(a2);
      g.fillStyle = '#ff7a3d';
      g.beginPath(); g.moveTo(10, 0); g.lineTo(-6, -7); g.lineTo(-2, 0); g.lineTo(-6, 7); g.closePath(); g.fill();
      g.restore();
    }
    // corner labels
    g.font = '700 12px "Saira Variable", system-ui';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    T.corners.forEach((c, k) => {
      const i = c.apex;
      const off = -c.dir * (T.width / 2 + 28 / s);
      const [x, y] = this.toScreen(T.px[i] + T.nx[i] * off, T.pz[i] + T.nz[i] * off);
      g.fillStyle = 'rgba(12,16,22,0.85)';
      g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = '#fff';
      g.fillText(`${k + 1}`, x, y + 0.5);
    });
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    // control points in edit mode
    if (this.mode === 'edit') {
      const P = this.def.points;
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.lineWidth = 1;
      this.pathWorld(g, P, true); g.stroke();
      P.forEach(([x, z], k) => {
        const [sx, sy] = this.toScreen(x, z);
        g.fillStyle = k === this.hover || this.drag?.i === k ? '#ff7a3d' : '#ffffff';
        g.beginPath(); g.arc(sx, sy, k === this.hover ? 7 : 5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1.5; g.stroke();
      });
    }
    void now;
  }

  destroy() { window.removeEventListener('keydown', this.onKey); }
}

function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2, 0, 1);
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

export function drawThumb(c, points, color = '#ff7a3d') {
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const dense = catmullRomClosed(points, 8);
  for (const [x, z] of dense) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const s = Math.min((W - 10) / (maxX - minX), (H - 10) / (maxZ - minZ));
  const ox = (W - (maxX - minX) * s) / 2, oz = (H - (maxZ - minZ) * s) / 2;
  g.clearRect(0, 0, W, H);
  g.beginPath();
  dense.forEach(([x, z], k) => { const sx = ox + (x - minX) * s, sy = oz + (z - minZ) * s; if (k) g.lineTo(sx, sy); else g.moveTo(sx, sy); });
  g.closePath();
  g.lineJoin = 'round';
  g.strokeStyle = color;
  g.lineWidth = 2.2;
  g.stroke();
}

export { randomTrack } from '../track/generator.js';
import { randomTrack } from '../track/generator.js';
