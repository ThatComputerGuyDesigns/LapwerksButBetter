// Track Studio: draw, place points, generate, describe or import a circuit;
// shape it point by point; dress it with an environment and objects; read
// the engineering analysis; preview it in 3D; export it.
import { strokeToControlPoints, catmullRomClosed, resamplePolyline, polylineLength } from '../track/spline.js';
import { buildTrack } from '../track/track.js';
import { computeRacingLine, speedProfile } from '../track/racingLine.js';
import { PRESETS } from '../track/presets.js';
import { ENVIRONMENTS, OBJECTS, envOf } from '../track/environments.js';
import { analyzeTrack, referenceParams } from '../track/analysis.js';
import { parseGPS, circuitFromGPS, circuitFromImage, circuitFromDescription } from '../track/importers.js';
import { store, encodeTrack } from '../game/store.js';
import { clamp, lerp, formatTime } from '../core/math.js';
import { audio } from '../audio/audio.js';
import { randomTrack } from '../track/generator.js';

export { randomTrack };

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const ICON = {
  select: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
  draw: '<path d="M4 20c4-1 6-3 8-7s4-7 8-8"/>',
  points: '<circle cx="6" cy="17" r="2"/><circle cx="12" cy="7" r="2"/><circle cx="18" cy="15" r="2"/><path d="M7.4 15.3l3.4-6.4M13.7 8.3l3.2 5"/>',
  start: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
  place: '<path d="M12 21s-6-5.5-6-10a6 6 0 1 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  cams: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3z"/>',
  erase: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  generate: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>',
  undo: '<path d="M9 7H4V2M4.5 7A8 8 0 1 1 6 17"/>',
  redo: '<path d="M15 7h5V2M19.5 7A8 8 0 1 0 18 17"/>',
  reverse: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
const TOOLS = [
  ['select', 'Select', 'V', 'Select, drag and reshape points, objects and cameras'],
  ['draw', 'Draw', 'D', 'Draw a circuit freehand'],
  ['points', 'Points', 'P', 'Click to place points one by one'],
  ['start', 'Start line', 'S', 'Click the track to set the start/finish line'],
  ['place', 'Place', 'O', 'Place trackside objects'],
  ['cams', 'TV cams', 'C', 'Place TV camera positions (used by Race Control)'],
  ['erase', 'Delete', 'X', 'Click a point, object or camera to delete it'],
];
const BRUSHES = [0, 40, 90, 180];
const SNAPS = [0, 2, 5, 10];

export class TrackEditor {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.def = null;
    this.undoStack = [];
    this.redoStack = [];
    this.view = { cx: 0, cz: 0, scale: 0.6 };
    this.tool = 'draw';
    this.placeType = 'stand';
    this.sel = null; // { kind: 'point'|'object'|'cam', i }
    this.tab = 'track';
    this.overlay = { line: true, numbers: true, elevation: true, passing: false, underlay: true };
    this.brush = 0;
    this.snap = 0;
    this.underlay = null; // { img, url, widthM, opacity, x, z }
    this.building = null; // points being placed
    this.hover = null;
    this.hiCorner = -1;
    this.pointers = new Map();
    this.build();
  }

  // ================================================================ DOM
  build() {
    const r = this.root;
    r.innerHTML = '';
    r.classList.add('editor', 'studio2');
    this.canvas = el('canvas', 'editor-canvas');
    r.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    const top = el('header', 'st-top');
    top.innerHTML = `
      <button class="icon-btn" data-act="back" title="Back to menu"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="st-title"><span class="eyebrow">Track Studio</span><input class="ed-name" maxlength="40" spellcheck="false" aria-label="Circuit name" /></div>
      <div class="st-cluster">
        <button class="icon-btn" data-act="undo" title="Undo (Ctrl+Z)">${svg('undo')}</button>
        <button class="icon-btn" data-act="redo" title="Redo (Ctrl+Shift+Z)">${svg('redo')}</button>
        <button class="icon-btn" data-act="reverse" title="Reverse direction">${svg('reverse')}</button>
        <button class="icon-btn" data-act="fit" title="Fit to screen (F)">${svg('fit')}</button>
        <div class="st-menu-wrap"><button class="icon-btn" data-act="views" title="Overlays">${svg('layers')}</button>
          <div class="st-menu" hidden>
            <label><input type="checkbox" data-ov="line"> Racing line (speed)</label>
            <label><input type="checkbox" data-ov="numbers"> Corner numbers</label>
            <label><input type="checkbox" data-ov="elevation"> Elevation shading</label>
            <label><input type="checkbox" data-ov="passing"> Overtaking zones</label>
            <label><input type="checkbox" data-ov="underlay"> Trace image</label>
          </div>
        </div>
      </div>
      <span class="st-save" title="Drafts autosave in this browser"></span>
      <button class="btn st-3d" data-act="preview3d">${svg('cube')}3D view</button>
      <button class="btn primary st-drive" data-act="build"><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>Test drive</button>`;
    r.appendChild(top);
    this.top = top;

    const rail = el('nav', 'st-rail');
    rail.innerHTML = TOOLS.map(([id, name, key, tip]) => `<button data-tool="${id}" title="${tip} (${key})">${svg(id)}<span>${name}</span><kbd>${key}</kbd></button>`).join('')
      + `<i class="st-sep"></i>
      <button data-act="generate" title="Generate circuits (G)">${svg('generate')}<span>Generate</span><kbd>G</kbd></button>
      <button data-act="import" title="Import GPS, photo, file or trace image (I)">${svg('import')}<span>Import</span><kbd>I</kbd></button>`;
    r.appendChild(rail);
    this.rail = rail;

    const side = el('aside', 'st-side');
    side.innerHTML = `
      <div class="st-tabs" role="tablist">
        <button data-tab="track" class="on">Track</button><button data-tab="analysis">Analysis</button><button data-tab="export">Export</button>
      </div>
      <div class="st-body"></div>`;
    r.appendChild(side);
    this.side = side;
    this.body = side.querySelector('.st-body');

    this.placeBar = el('div', 'st-place');
    this.placeBar.innerHTML = Object.entries(OBJECTS).map(([k, o]) => `<button data-ptype="${k}"><i>${o.icon}</i>${o.name}</button>`).join('');
    this.placeBar.hidden = true;
    r.appendChild(this.placeBar);

    this.hintEl = el('div', 'st-hint');
    r.appendChild(this.hintEl);

    this.dialog = el('div', 'st-dialog');
    this.dialog.hidden = true;
    r.appendChild(this.dialog);

    this.fileInput = el('input');
    this.fileInput.type = 'file';
    this.fileInput.hidden = true;
    r.appendChild(this.fileInput);

    // --- events
    top.querySelector('.ed-name').addEventListener('input', (e) => { if (this.def) { this.def.name = e.target.value; this.autosave(); } });
    top.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) this.action(a.dataset.act);
    });
    top.querySelectorAll('[data-ov]').forEach((c) => c.addEventListener('change', () => { this.overlay[c.dataset.ov] = c.checked; this.dirty = true; }));
    rail.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tool]');
      if (t) { audio.click(); this.setTool(t.dataset.tool); }
      const a = e.target.closest('[data-act]');
      if (a) this.action(a.dataset.act);
    });
    side.querySelector('.st-tabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      audio.click();
      this.tab = t.dataset.tab;
      this.overlay.passing = this.tab === 'analysis' ? true : this.overlay.passing;
      this.renderPanel();
      this.body.scrollTop = 0;
      this.dirty = true;
    });
    this.body.addEventListener('click', (e) => this.onPanelClick(e));
    this.body.addEventListener('input', (e) => this.onPanelInput(e));
    this.body.addEventListener('change', (e) => { if (e.target.matches('input[type=range], input[type=color], select')) this.commit(); });
    this.body.addEventListener('mouseover', (e) => { const row = e.target.closest('[data-corner]'); const v = row ? +row.dataset.corner : -1; if (v !== this.hiCorner) { this.hiCorner = v; this.dirty = true; } });
    this.placeBar.addEventListener('click', (e) => { const b = e.target.closest('[data-ptype]'); if (b) { audio.click(); this.placeType = b.dataset.ptype; this.syncPlaceBar(); } });
    this.dialog.addEventListener('click', (e) => this.onDialogClick(e));
    this.fileInput.addEventListener('change', () => this.onFile());

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('dblclick', (e) => this.onDouble(e));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.eraseAt(e.offsetX, e.offsetY); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wz] = this.toWorld(e.offsetX, e.offsetY);
      this.view.scale = clamp(this.view.scale * Math.exp(-e.deltaY * 0.0015), 0.06, 6);
      const [nx, nz] = this.toWorld(e.offsetX, e.offsetY);
      this.view.cx += wx - nx; this.view.cz += wz - nz;
    }, { passive: false });
    window.addEventListener('keydown', (this.onKey = (e) => this.key(e)));
    window.addEventListener('resize', () => this.active && this.resize());
  }

  // ================================================================ lifecycle
  open(def) {
    this.active = true;
    this.root.hidden = false;
    this.resize();
    const draft = store.get('studioDraft', null);
    if (def) this.loadDef(JSON.parse(JSON.stringify(def)), true);
    else if (draft?.points?.length >= 4) { this.loadDef(draft, true, false); this.app.toast('Restored your draft'); }
    else this.clear();
    this.setTool(this.def ? 'select' : 'draw');
    this.renderPanel();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.active) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close() { this.active = false; this.root.hidden = true; cancelAnimationFrame(this.raf); }

  resize() {
    this.dirty = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.root.clientWidth || window.innerWidth, h = this.root.clientHeight || window.innerHeight;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.dpr = dpr;
  }

  // ================================================================ coordinates
  get W() { return this.canvas.width / this.dpr; }
  get H() { return this.canvas.height / this.dpr; }
  viewport() {
    // the free drawing area between the rail and the side panel
    const wide = window.innerWidth > 900;
    const l = wide ? 92 : 0, r = wide ? this.side.offsetWidth + 20 : 0;
    return { l, r: this.W - r, t: 70, b: wide ? this.H : this.H * 0.55 };
  }
  toWorld(px, py) {
    const v = this.viewport();
    return [(px - (v.l + v.r) / 2) / this.view.scale + this.view.cx, (py - (v.t + v.b) / 2) / this.view.scale + this.view.cz];
  }
  toScreen(x, z) {
    const v = this.viewport();
    return [(x - this.view.cx) * this.view.scale + (v.l + v.r) / 2, (z - this.view.cz) * this.view.scale + (v.t + v.b) / 2];
  }
  snapPt([x, z]) {
    if (!this.snap) return [x, z];
    return [Math.round(x / this.snap) * this.snap, Math.round(z / this.snap) * this.snap];
  }

  fitView() {
    const P = this.def?.points || this.building;
    if (!P || P.length < 2) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of P) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const v = this.viewport();
    this.view.scale = clamp(Math.min((v.r - v.l - 80) / (maxX - minX + 80), (v.b - v.t - 90) / (maxZ - minZ + 80)), 0.06, 4);
    this.view.cx = (minX + maxX) / 2;
    this.view.cz = (minZ + maxZ) / 2;
    this.dirty = true;
  }

  // ================================================================ state
  clear() {
    this.def = null;
    this.preview = null;
    this.analysis = null;
    this.morph = null;
    this.building = null;
    this.sel = null;
    this.view = { cx: 0, cz: 0, scale: 0.5 };
    this.dirty = true;
    this.syncTop();
    this.renderPanel();
  }

  normalize(def) {
    const E = envOf(def.env);
    const d = { width: E.defaults.width, hills: E.defaults.hills, banking: E.defaults.banking, seed: 7, theme: 'golden', env: 'gp', objects: [], cams: [], ...def };
    d.points = d.points.map((p) => p.slice());
    if (!d.id) d.id = 'custom-' + Date.now().toString(36);
    if (!d.name) d.name = 'My Circuit';
    return d;
  }

  loadDef(def, fit, record = true) {
    if (record && this.def) this.snapshot();
    this.def = this.normalize(def);
    this.sel = null;
    this.building = null;
    if (fit) this.fitView();
    this.rebuildPreview();
    this.syncTop();
    this.renderPanel();
    this.autosave();
  }

  /** Save the current state to the undo stack (call before a change). */
  snapshot() {
    this.undoStack.push(this.def ? JSON.stringify(this.def) : 'null');
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  /** Finish an interactive change (slider release, drag end). */
  commit() {
    if (this.pending) { this.undoStack.push(this.pending); this.redoStack.length = 0; this.pending = null; }
    this.rebuildPreview();
    this.renderPanel();
    this.autosave();
  }
  beginChange() { if (!this.pending) this.pending = this.def ? JSON.stringify(this.def) : 'null'; }

  undo() {
    if (!this.undoStack.length) { this.app.toast('Nothing to undo'); return; }
    this.redoStack.push(this.def ? JSON.stringify(this.def) : 'null');
    this.restore(this.undoStack.pop());
  }
  redo() {
    if (!this.redoStack.length) { this.app.toast('Nothing to redo'); return; }
    this.undoStack.push(this.def ? JSON.stringify(this.def) : 'null');
    this.restore(this.redoStack.pop());
  }
  restore(json) {
    const d = JSON.parse(json);
    if (!d) { const u = this.undoStack, r = this.redoStack; this.clear(); this.undoStack = u; this.redoStack = r; return; }
    this.def = d;
    this.sel = null;
    this.rebuildPreview();
    this.syncTop();
    this.renderPanel();
    this.autosave();
  }

  autosave() {
    clearTimeout(this.saveT);
    const s = this.top.querySelector('.st-save');
    s.textContent = 'Saving…';
    this.saveT = setTimeout(() => {
      if (this.def) store.set('studioDraft', this.def);
      s.textContent = this.def ? 'Draft saved' : '';
    }, 400);
  }

  // ================================================================ actions
  action(a) {
    audio.click();
    const d = this.def;
    switch (a) {
      case 'back': this.app.showHome(); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'fit': this.fitView(); break;
      case 'views': { const m = this.top.querySelector('.st-menu'); m.hidden = !m.hidden; break; }
      case 'reverse': if (d) { this.snapshot(); d.points.reverse(); this.rebuildPreview(); this.renderPanel(); this.autosave(); this.app.toast('Direction reversed'); } break;
      case 'generate': this.openGenerate(); break;
      case 'import': this.openImport(); break;
      case 'build': if (d) { store.set('studioDraft', d); this.app.buildAndReveal(d); } else this.app.toast('Draw or generate a circuit first'); break;
      case 'preview3d': if (d) { store.set('studioDraft', d); this.app.openStudio3D(d); } else this.app.toast('Draw or generate a circuit first'); break;
      case 'save': if (d) { this.app.saveTrack(d); this.app.toast(`Saved “${d.name}” to My circuits`); } break;
      case 'clear': this.snapshot(); this.clear(); store.set('studioDraft', null); break;
      default: break;
    }
  }

  setTool(t) {
    if (this.building && t !== 'points') this.finishBuilding(false);
    this.tool = t;
    if (this.sel && (t === 'draw' || t === 'points')) { this.sel = null; this.renderPanel(); }
    this.rail.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    this.canvas.style.cursor = { draw: 'crosshair', points: 'crosshair', start: 'copy', place: 'copy', cams: 'copy', erase: 'not-allowed' }[t] || 'default';
    this.placeBar.hidden = t !== 'place';
    this.syncPlaceBar();
    this.updateHint();
    this.dirty = true;
  }

  syncPlaceBar() { this.placeBar.querySelectorAll('[data-ptype]').forEach((b) => b.classList.toggle('on', b.dataset.ptype === this.placeType)); }

  updateHint() {
    const H = {
      select: this.def ? '<b>Drag</b> points to reshape · <b>double-click</b> the track to add a point · <b>right-click</b> to delete · drag empty space to pan' : 'Nothing to select yet — <b>Draw</b>, place <b>Points</b> or <b>Generate</b> a circuit',
      draw: '<b>Draw a loop</b> with mouse, finger or pen. Lift to finish — it closes, smooths and builds itself.',
      points: this.building ? `<b>${this.building.length}</b> points · click the first point, double-click or press <b>Enter</b> to close · <b>Esc</b> cancels` : '<b>Click</b> to place points in driving order. Close the loop to finish.',
      start: '<b>Click</b> anywhere on the track to move the start/finish line',
      place: `<b>Click</b> to place: ${OBJECTS[this.placeType].name} · drag it with Select · <b>R</b> rotates`,
      cams: '<b>Click</b> beside the track to place a TV camera. Race Control cuts between them.',
      erase: '<b>Click</b> a point, object or camera to delete it',
    };
    this.hintEl.innerHTML = H[this.tool] || '';
  }

  syncTop() {
    const n = this.top.querySelector('.ed-name');
    n.value = this.def ? this.def.name : 'New circuit';
    n.disabled = !this.def;
    this.top.querySelector('[data-act=build]').disabled = !this.def;
    this.top.querySelector('[data-act=preview3d]').disabled = !this.def;
    this.top.querySelectorAll('[data-ov]').forEach((c) => (c.checked = !!this.overlay[c.dataset.ov]));
  }

  // ================================================================ preview / analysis
  schedulePreview() {
    clearTimeout(this.pvTimer);
    this.pvTimer = setTimeout(() => this.rebuildPreview(true), 50);
  }

  rebuildPreview(light = false) {
    this.dirty = true;
    if (!this.def || this.def.points.length < 4) { this.preview = null; this.analysis = null; return; }
    try {
      const T = buildTrack(this.def);
      const line = computeRacingLine(T, { iterations: light ? 160 : 320 });
      const prof = speedProfile(T, line, referenceParams());
      this.preview = { T, line, prof };
      this.analysis = analyzeTrack(T, line, prof);
      this.warnings = [];
      if (T.length < 800) this.warnings.push('Short circuit — under 800 m.');
      if (T.length > 12000) this.warnings.push('Very long circuit — over 12 km.');
      if (T.crossings.length) this.warnings.push(`${T.crossings.length} crossing${T.crossings.length > 1 ? 's' : ''} → automatic flyover${T.crossings.length > 1 ? 's' : ''}.`);
      if (!light) this.renderPanel();
      else this.updateStatsLive();
    } catch (err) {
      console.warn(err);
      this.preview = null; this.analysis = null;
    }
  }

  // ================================================================ panel
  renderPanel() {
    this.side.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const d = this.def;
    if (!d) {
      this.body.innerHTML = `<div class="st-empty">
        <h3>Start a circuit</h3>
        <p>Draw it freehand, click points, generate one, describe it in words, or import a GPS lap or a photo of a sketch.</p>
        <div class="st-start">
          <button class="st-card" data-tool-pick="draw">${svg('draw')}<b>Draw</b><small>Freehand loop</small></button>
          <button class="st-card" data-tool-pick="points">${svg('points')}<b>Points</b><small>Click to place</small></button>
          <button class="st-card" data-act2="generate">${svg('generate')}<b>Generate</b><small>Or describe it</small></button>
          <button class="st-card" data-act2="import">${svg('import')}<b>Import</b><small>GPS, photo, file</small></button>
        </div>
        <span class="st-lbl">Or start from</span>
        <div class="templates">${PRESETS.map((p) => `<button class="tpl" data-preset="${p.id}"><canvas width="88" height="60"></canvas><span>${p.name}</span></button>`).join('')}</div>
      </div>`;
      this.body.querySelectorAll('[data-preset]').forEach((b) => drawThumb(b.querySelector('canvas'), PRESETS.find((p) => p.id === b.dataset.preset).points));
      return;
    }
    if (this.tab === 'analysis') return this.renderAnalysis();
    if (this.tab === 'export') return this.renderExport();
    this.renderTrackTab();
  }

  statsHTML() {
    const T = this.preview?.T, A = this.analysis;
    const v = (x) => (T ? x : '—');
    return `<div class="ed-stats">
      <div><span class="k">Length</span><span class="v" data-s="len">${v(`${(T?.length / 1000).toFixed(2)} km`)}</span></div>
      <div><span class="k">Corners</span><span class="v" data-s="corners">${v(T?.corners.length)}</span></div>
      <div><span class="k">Elevation</span><span class="v" data-s="elev">${v(`${A?.elevRange.toFixed(0)} m`)}</span></div>
      <div><span class="k">Ref. lap</span><span class="v" data-s="lap">${A ? formatTime(A.lapTime) : '—'}</span></div>
    </div>`;
  }

  updateStatsLive() {
    const T = this.preview?.T, A = this.analysis;
    if (!T) return;
    const s = (k, t) => { const e = this.body.querySelector(`[data-s=${k}]`); if (e) e.textContent = t; };
    s('len', `${(T.length / 1000).toFixed(2)} km`); s('corners', T.corners.length); s('elev', `${A.elevRange.toFixed(0)} m`); s('lap', formatTime(A.lapTime));
    this.drawProfile();
  }

  renderTrackTab() {
    const d = this.def;
    const E = envOf(d.env);
    const sel = this.sel;
    let inspector = '';
    if (sel?.kind === 'point') {
      const p = d.points[sel.i];
      const hasBank = p[3] != null;
      inspector = `<section class="st-insp">
        <header><b>Point ${sel.i + 1}</b><small>of ${d.points.length}</small><button class="chip" data-pa="deselect">Done</button></header>
        <label class="slider"><span>Height offset <b>${(p[2] || 0).toFixed(1)} m</b></span><input type="range" min="-25" max="25" step="0.5" value="${p[2] || 0}" data-pp="2"></label>
        <label class="check"><input type="checkbox" data-pa="bankon" ${hasBank ? 'checked' : ''}> Custom banking at this point</label>
        <label class="slider" ${hasBank ? '' : 'hidden'}><span>Banking <b>${hasBank ? `${(+p[3]).toFixed(0)}°` : ''}</b></span><input type="range" min="-8" max="32" step="1" value="${hasBank ? p[3] : 8}" data-pp="3"></label>
        <div class="row-btns"><button class="chip" data-pa="start">Start line here</button><button class="chip" data-pa="flatten">Reset point</button><button class="chip danger" data-pa="delete">Delete point</button></div>
      </section>`;
    } else if (sel?.kind === 'object') {
      const o = d.objects[sel.i];
      inspector = `<section class="st-insp">
        <header><b>${OBJECTS[o.type]?.name || o.type}</b><button class="chip" data-pa="deselect">Done</button></header>
        <label class="slider"><span>Rotation <b>${Math.round(((o.rot || 0) * 180) / Math.PI)}°</b></span><input type="range" min="0" max="6.283" step="0.05" value="${o.rot || 0}" data-op="rot"></label>
        <div class="row-btns"><button class="chip" data-pa="dup">Duplicate</button><button class="chip danger" data-pa="delete">Delete</button></div>
      </section>`;
    } else if (sel?.kind === 'cam') {
      inspector = `<section class="st-insp"><header><b>TV camera ${sel.i + 1}</b><button class="chip" data-pa="deselect">Done</button></header>
        <p class="st-note">Race Control uses your cameras when you place two or more.</p>
        <div class="row-btns"><button class="chip danger" data-pa="delete">Delete camera</button></div></section>`;
    }
    const col = d.colors || {};
    this.body.innerHTML = `${inspector}
      ${this.statsHTML()}
      <canvas class="ed-profile" width="560" height="120" title="Elevation profile"></canvas>
      ${this.warnings?.length ? `<div class="ed-warn">${this.warnings.join(' ')}</div>` : ''}
      <section><span class="st-lbl">Environment</span>
        <div class="st-envs">${Object.entries(ENVIRONMENTS).map(([id, e]) => `<button data-env="${id}" class="${d.env === id ? 'on' : ''}" title="${e.blurb}"><i class="env-sw env-${id}"></i>${e.name}</button>`).join('')}</div>
        <p class="st-note">${E.blurb}</p>
      </section>
      <section><span class="st-lbl">Time of day</span>
        <div class="seg small">${['golden', 'midday', 'dusk'].map((t) => `<button data-theme="${t}" class="${d.theme === t ? 'on' : ''}">${{ golden: 'Golden hour', midday: 'Midday', dusk: 'Dusk' }[t]}</button>`).join('')}</div>
      </section>
      <section><span class="st-lbl">Geometry</span>
        <label class="slider"><span>Track width <b>${d.width} m</b></span><input type="range" min="8" max="22" step="0.5" value="${d.width}" data-p="width"></label>
        <label class="slider"><span>Natural elevation <b>${Math.round(d.hills * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value="${d.hills}" data-p="hills"></label>
        <label class="slider"><span>Auto banking <b>${Math.round(d.banking * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value="${d.banking}" data-p="banking"></label>
        <div class="row-btns"><button class="chip" data-pa="reroll">Reshape hills</button><button class="chip" data-pa="smooth">Smooth outline</button><button class="chip" data-pa="simplify">Fewer points</button><button class="chip" data-pa="densify">More points</button></div>
      </section>
      <section><span class="st-lbl">Editing</span>
        <div class="st-grid2">
          <label class="field-s"><span>Reshape brush</span><select data-set="brush">${BRUSHES.map((b) => `<option value="${b}" ${this.brush === b ? 'selected' : ''}>${b ? `${b} m` : 'Single point'}</option>`).join('')}</select></label>
          <label class="field-s"><span>Snap to grid</span><select data-set="snap">${SNAPS.map((b) => `<option value="${b}" ${this.snap === b ? 'selected' : ''}>${b ? `${b} m` : 'Off'}</option>`).join('')}</select></label>
        </div>
      </section>
      <section><span class="st-lbl">Colours</span>
        <div class="st-colors">
          <label><input type="color" data-col="road" value="${col.road || '#ffffff'}"><span>Asphalt tint</span></label>
          <label><input type="color" data-col="kerbA" value="${col.kerbA || '#d4202a'}"><span>Kerb</span></label>
          <label><input type="color" data-col="kerbB" value="${col.kerbB || '#f2f2ee'}"><span>Kerb stripe</span></label>
          <label><input type="color" data-col="wall" value="${col.wall || '#b9b6ae'}"><span>Walls</span></label>
        </div>
        <button class="chip" data-pa="resetcol">Reset colours</button>
      </section>
      <section class="st-counts"><span>${d.points.length} points</span><span>${d.objects.length} objects</span><span>${d.cams.length} TV cams</span>${d.start ? '<span>Custom start</span>' : ''}</section>
      <div class="row-btns"><button class="btn ghost" data-pa="save">Save to My circuits</button><button class="btn ghost" data-pa="new">New circuit</button></div>`;
    this.drawProfile();
  }

  renderAnalysis() {
    const A = this.analysis;
    if (!A) { this.body.innerHTML = '<p class="st-note">Analysis appears once the circuit is closed.</p>'; return; }
    const R = A.ratings;
    const bar = (k, v, desc) => `<div class="st-rate"><div><b>${k}</b><small>${desc}</small></div><div class="st-meter"><i style="width:${v * 10}%"></i></div><em>${v.toFixed(1)}</em></div>`;
    const top = [...A.corners].sort((a, b) => b.pass - a.pass).slice(0, 3).filter((c) => c.pass > 0.2);
    this.body.innerHTML = `
      <div class="st-grade"><span class="g g-${A.grade}">${A.grade}</span><div><b>${R.overall.toFixed(1)}</b><small>Track rating · reference GT3 car</small></div></div>
      ${bar('Overtaking', R.overtaking, 'Heavy stops after long straights')}
      ${bar('Technicality', R.technicality, 'Corner variety, density, combinations')}
      ${bar('Difficulty', R.difficulty, 'Commitment, narrowness, blind crests')}
      ${bar('Fun', R.fun, 'Flow, fast corners, elevation, length')}
      <div class="ed-stats st-facts">
        <div><span class="k">Ref. lap</span><span class="v">${formatTime(A.lapTime)}</span></div>
        <div><span class="k">Top speed</span><span class="v">${Math.round(A.vMax * 3.6)} km/h</span></div>
        <div><span class="k">Average</span><span class="v">${Math.round(A.vAvg * 3.6)} km/h</span></div>
        <div><span class="k">Longest straight</span><span class="v">${A.straights[0] ? `${Math.round(A.straights[0].len)} m` : '—'}</span></div>
        <div><span class="k">Max grade</span><span class="v">${(A.maxGrade * 100).toFixed(1)}%</span></div>
        <div><span class="k">Max banking</span><span class="v">${((A.maxBank * 180) / Math.PI).toFixed(0)}°</span></div>
      </div>
      ${top.length ? `<p class="st-note"><b>Best passing spots:</b> ${top.map((c) => `Turn ${c.n}`).join(', ')} — highlighted on the map.</p>` : '<p class="st-note">No strong overtaking spots. A long straight into a slow corner creates one.</p>'}
      <span class="st-lbl">Corners</span>
      <div class="st-corners">
        <div class="st-ch"><span>#</span><span>Type</span><span>Min</span><span>Brake</span><span>Pass</span></div>
        ${A.corners.map((c, k) => `<div class="st-cr" data-corner="${k}"><b>${c.n}</b><span>${c.kind} ${c.dir}</span><span>${Math.round(c.kmh)}</span><span>${c.brakeDist ? `${Math.round(c.brakeDist)} m` : '—'}</span><span class="st-pass"><i style="width:${c.pass * 100}%"></i></span></div>`).join('')}
      </div>
      <span class="st-lbl">Straights</span>
      <div class="st-straights">${A.straights.slice(0, 5).map((s, k) => `<span>S${k + 1} · ${Math.round(s.len)} m</span>`).join('') || '<span>None over 120 m</span>'}</div>`;
  }

  renderExport() {
    const d = this.def;
    const code = encodeTrack(d);
    const url = `${location.origin}${location.pathname}#t=${code}`;
    this.body.innerHTML = `
      <section><span class="st-lbl">Share</span>
        <div class="st-share"><input readonly value="${url}" class="st-url"><button class="btn" data-pa="copy">Copy link</button></div>
        <p class="st-note">Anyone who opens the link gets the full circuit — layout, environment, objects and cameras.</p>
      </section>
      <section><span class="st-lbl">Files</span>
        <div class="st-exports">
          <button class="st-card" data-exp="json"><b>.json</b><small>Kerbstone track file (re-importable)</small></button>
          <button class="st-card" data-exp="glb"><b>.glb</b><small>3D model for Blender & engines</small></button>
          <button class="st-card" data-exp="obj"><b>.obj</b><small>3D mesh, universal</small></button>
          <button class="st-card" data-exp="csv"><b>.csv</b><small>Centreline, width, banking, kerbs</small></button>
          <button class="st-card" data-exp="png"><b>.png</b><small>Track map image</small></button>
        </div>
      </section>
      <div class="row-btns"><button class="btn primary" data-pa="save">Save to My circuits</button></div>`;
  }

  onPanelClick(e) {
    const d = this.def;
    const t = e.target;
    const pick = t.closest('[data-tool-pick]'); if (pick) { audio.click(); this.setTool(pick.dataset.toolPick); return; }
    const a2 = t.closest('[data-act2]'); if (a2) return this.action(a2.dataset.act2);
    const pre = t.closest('[data-preset]');
    if (pre) { audio.click(); const p = PRESETS.find((q) => q.id === pre.dataset.preset); this.loadDef({ ...JSON.parse(JSON.stringify(p)), id: 'custom-' + Date.now().toString(36), name: p.name + ' (copy)' }, true); this.setTool('select'); return; }
    const exp = t.closest('[data-exp]');
    if (exp) { audio.click(); return this.exportAs(exp.dataset.exp); }
    const env = t.closest('[data-env]');
    if (env && d) {
      audio.click();
      this.snapshot();
      d.env = env.dataset.env;
      Object.assign(d, ENVIRONMENTS[d.env].defaults);
      this.rebuildPreview();
      this.autosave();
      this.app.toast(`${ENVIRONMENTS[d.env].name}: scenery, barriers and run-off updated`);
      return;
    }
    const th = t.closest('[data-theme]');
    if (th && d) { audio.click(); this.snapshot(); d.theme = th.dataset.theme; this.renderPanel(); this.autosave(); return; }
    const pa = t.closest('[data-pa]');
    if (!pa || !d) return;
    const act = pa.dataset.pa;
    if (act === 'bankon') return; // handled on change below
    audio.click();
    const sel = this.sel;
    switch (act) {
      case 'deselect': this.sel = null; this.renderPanel(); break;
      case 'delete': this.deleteSel(); break;
      case 'start': this.snapshot(); d.start = d.points[sel.i].slice(0, 2); this.rebuildPreview(); this.autosave(); this.app.toast('Start/finish moved'); break;
      case 'flatten': this.snapshot(); d.points[sel.i].length = 2; this.rebuildPreview(); this.autosave(); break;
      case 'dup': { this.snapshot(); const o = d.objects[sel.i]; d.objects.push({ ...o, x: o.x + 20, z: o.z + 20 }); this.sel = { kind: 'object', i: d.objects.length - 1 }; this.renderPanel(); this.autosave(); break; }
      case 'reroll': this.snapshot(); d.seed = (d.seed * 7 + 13) % 997; this.rebuildPreview(); this.autosave(); break;
      case 'smooth': this.snapshot(); d.points = smoothPoints(d.points); this.rebuildPreview(); this.autosave(); break;
      case 'simplify': if (d.points.length > 8) { this.snapshot(); d.points = respace(d.points, Math.max(6, Math.round(d.points.length * 0.65))); this.sel = null; this.rebuildPreview(); this.autosave(); } break;
      case 'densify': if (d.points.length < 300) { this.snapshot(); d.points = respace(d.points, Math.round(d.points.length * 1.5)); this.sel = null; this.rebuildPreview(); this.autosave(); } break;
      case 'resetcol': this.snapshot(); delete d.colors; this.renderPanel(); this.autosave(); break;
      case 'save': this.action('save'); break;
      case 'new': this.action('clear'); this.setTool('draw'); break;
      case 'copy': {
        const inp = this.body.querySelector('.st-url');
        navigator.clipboard?.writeText(inp.value).then(() => this.app.toast('Link copied'), () => { inp.select(); this.app.toast('Press Ctrl+C to copy'); });
        break;
      }
      default: break;
    }
  }

  onPanelInput(e) {
    const d = this.def;
    const t = e.target;
    if (!d) return;
    if (t.dataset.set) { this[t.dataset.set] = +t.value; this.dirty = true; return; }
    if (t.dataset.pa === 'bankon') {
      this.snapshot();
      const p = d.points[this.sel.i];
      if (t.checked) p[3] = 8; else p.length = Math.min(p.length, 3);
      if (!t.checked && p.length === 3 && !p[2]) p.length = 2;
      this.rebuildPreview(); this.autosave();
      return;
    }
    this.beginChange();
    const out = t.closest('label')?.querySelector('b');
    if (t.dataset.p) {
      d[t.dataset.p] = parseFloat(t.value);
      if (out) out.textContent = t.dataset.p === 'width' ? `${d.width} m` : `${Math.round(d[t.dataset.p] * 100)}%`;
      this.schedulePreview();
    } else if (t.dataset.pp) {
      const p = d.points[this.sel.i];
      const k = +t.dataset.pp;
      while (p.length < k) p.push(k === 3 && p.length === 2 ? 0 : null);
      p[k] = parseFloat(t.value);
      if (out) out.textContent = k === 2 ? `${p[2].toFixed(1)} m` : `${p[3].toFixed(0)}°`;
      this.schedulePreview();
    } else if (t.dataset.op) {
      const o = d.objects[this.sel.i];
      o.rot = parseFloat(t.value);
      if (out) out.textContent = `${Math.round((o.rot * 180) / Math.PI)}°`;
      this.dirty = true;
    } else if (t.dataset.col) {
      d.colors = { ...(d.colors || {}), [t.dataset.col]: t.value };
    }
  }

  drawProfile() {
    const c = this.body.querySelector('.ed-profile');
    const T = this.preview?.T;
    if (!c) return;
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    if (!T) return;
    const { minY, maxY } = T.bounds;
    const span = Math.max(maxY - minY, 6);
    const yOf = (i) => H - 14 - ((T.py[i] - minY) / span) * (H - 34);
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(255,106,43,0.5)');
    grad.addColorStop(1, 'rgba(255,106,43,0.02)');
    g.beginPath(); g.moveTo(0, H);
    for (let k = 0; k <= 200; k++) { const i = Math.floor((k / 200) * (T.N - 1)); g.lineTo((k / 200) * W, yOf(i)); }
    g.lineTo(W, H); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath();
    for (let k = 0; k <= 200; k++) { const i = Math.floor((k / 200) * (T.N - 1)); const x = (k / 200) * W; if (k) g.lineTo(x, yOf(i)); else g.moveTo(x, yOf(i)); }
    g.strokeStyle = '#ff7a3d'; g.lineWidth = 3; g.stroke();
    // control points with edits, and the selected point
    T.ctrlIdx.forEach((i, c2) => {
      const p = this.def.points[c2];
      const on = this.sel?.kind === 'point' && this.sel.i === c2;
      if (!on && !p[2] && p[3] == null) return;
      g.fillStyle = on ? '#fff' : '#ffd23f';
      g.beginPath(); g.arc((i / T.N) * W, yOf(i), on ? 7 : 4, 0, Math.PI * 2); g.fill();
    });
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '600 20px "Inter Variable", system-ui';
    g.fillText(`${span.toFixed(0)} m`, 8, 24);
  }

  // ================================================================ dialogs
  openGenerate() {
    const env = this.def?.env || 'gp';
    this.genSeed = Math.floor(Math.random() * 1e6);
    this.dialog.hidden = false;
    this.dialog.innerHTML = `<div class="st-dlg glass">
      <header><h3>Generate</h3><button class="icon-btn" data-dlg="close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
      <div class="st-describe">
        <input class="st-desc" placeholder="Describe it: “a fast 5 km desert circuit with one long straight and two hairpins”" maxlength="200">
        <button class="btn primary" data-dlg="describe">Create</button>
      </div>
      <p class="st-note st-desc-out">Understands length (km/miles), hairpins, straights, fast/technical, hills, banking, width, environment and time of day.</p>
      <div class="st-alts-head"><span class="st-lbl">Alternative layouts</span><button class="chip" data-dlg="shuffle">Shuffle</button></div>
      <div class="st-alts"></div>
    </div>`;
    this.genEnv = env;
    this.renderAlts();
    setTimeout(() => this.dialog.querySelector('.st-desc')?.focus(), 30);
    this.dialog.querySelector('.st-desc').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.onDialogClick({ target: this.dialog.querySelector('[data-dlg=describe]') }); } });
  }

  renderAlts() {
    const box = this.dialog.querySelector('.st-alts');
    const E = ENVIRONMENTS[this.genEnv];
    this.alts = [];
    for (let k = 0; k < 6; k++) {
      const d = randomTrack(this.genSeed + k * 7919);
      Object.assign(d, { env: this.genEnv, width: E.defaults.width, hills: E.defaults.hills, banking: E.defaults.banking });
      if (this.genEnv === 'kart') d.points = d.points.map(([x, z]) => [x * 0.35, z * 0.35]);
      this.alts.push(d);
    }
    box.innerHTML = this.alts.map((d, k) => {
      const L = polylineLength(catmullRomClosed(d.points, 8), true);
      return `<button class="st-alt" data-alt="${k}"><canvas width="200" height="130"></canvas><b>${d.name}</b><small>${(L / 1000).toFixed(1)} km</small></button>`;
    }).join('');
    box.querySelectorAll('[data-alt]').forEach((b) => drawThumb(b.querySelector('canvas'), this.alts[+b.dataset.alt].points, '#ff7a3d'));
  }

  openImport() {
    this.dialog.hidden = false;
    const u = this.underlay;
    this.dialog.innerHTML = `<div class="st-dlg glass">
      <header><h3>Import</h3><button class="icon-btn" data-dlg="close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
      <div class="st-imports">
        <button class="st-card" data-dlg="gps">${svg('import')}<b>GPS lap</b><small>.gpx or .csv from a lap timer or phone app</small></button>
        <button class="st-card" data-dlg="photo">${svg('draw')}<b>Photo of a sketch</b><small>A circuit drawn in dark pen on paper</small></button>
        <button class="st-card" data-dlg="trace">${svg('layers')}<b>Trace an image</b><small>Satellite screenshot or map as an underlay</small></button>
        <button class="st-card" data-dlg="json">${svg('points')}<b>Track file</b><small>A Kerbstone .json export</small></button>
      </div>
      ${u ? `<section class="st-underlay"><span class="st-lbl">Trace image</span>
        <label class="slider"><span>Image width <b>${u.widthM} m</b></span><input type="range" min="200" max="6000" step="50" value="${u.widthM}" data-ul="widthM"></label>
        <label class="slider"><span>Opacity <b>${Math.round(u.opacity * 100)}%</b></span><input type="range" min="0.1" max="1" step="0.05" value="${u.opacity}" data-ul="opacity"></label>
        <p class="st-note">Tip: zoom your map so a known straight fills the screen, set the width to match, then use <b>Draw</b> or <b>Points</b> over it.</p>
        <button class="chip danger" data-dlg="unlay">Remove image</button></section>` : ''}
      <p class="st-note">Everything is processed in your browser. Nothing is uploaded.</p>
    </div>`;
    this.dialog.querySelectorAll('[data-ul]').forEach((inp) => inp.addEventListener('input', () => {
      this.underlay[inp.dataset.ul] = parseFloat(inp.value);
      inp.closest('label').querySelector('b').textContent = inp.dataset.ul === 'widthM' ? `${inp.value} m` : `${Math.round(inp.value * 100)}%`;
      this.dirty = true;
    }));
  }

  onDialogClick(e) {
    const b = e.target.closest?.('[data-dlg], [data-alt]') || e.target;
    if (e.target === this.dialog) { this.dialog.hidden = true; return; }
    if (b?.dataset?.alt != null) {
      audio.click();
      const d = this.alts[+b.dataset.alt];
      this.loadDef({ ...d, id: 'custom-' + Date.now().toString(36) }, true);
      this.dialog.hidden = true;
      this.setTool('select');
      return;
    }
    const k = b?.dataset?.dlg;
    if (!k) return;
    audio.click();
    if (k === 'close') this.dialog.hidden = true;
    else if (k === 'shuffle') { this.genSeed += 104729; this.renderAlts(); }
    else if (k === 'describe') {
      const text = this.dialog.querySelector('.st-desc').value.trim();
      if (!text) { this.app.toast('Type a description first'); return; }
      const out = this.dialog.querySelector('.st-desc-out');
      out.textContent = 'Searching layouts…';
      setTimeout(() => {
        try {
          const r = circuitFromDescription(text);
          this.loadDef({ ...r.def, id: 'custom-' + Date.now().toString(36) }, true);
          this.dialog.hidden = true;
          this.setTool('select');
          this.app.toast(`Created: ${r.notes.join(' · ')}`);
        } catch (err) { out.textContent = err.message; }
      }, 30);
    } else if (k === 'gps' || k === 'photo' || k === 'trace' || k === 'json') {
      this.fileMode = k;
      this.fileInput.accept = { gps: '.gpx,.csv,.txt,application/gpx+xml', photo: 'image/*', trace: 'image/*', json: '.json,application/json' }[k];
      this.fileInput.value = '';
      this.fileInput.click();
    } else if (k === 'unlay') { this.underlay = null; this.dirty = true; this.openImport(); }
  }

  async onFile() {
    const f = this.fileInput.files?.[0];
    if (!f) return;
    const mode = this.fileMode;
    try {
      if (mode === 'gps') {
        const def = circuitFromGPS(parseGPS(await f.text()), f.name.replace(/\.[^.]+$/, ''));
        this.loadDef(def, true);
        this.app.toast(`Imported GPS lap: ${def.points.length} points${def.points.some((p) => p[2]) ? ', with elevation' : ''}`);
      } else if (mode === 'json') {
        const j = JSON.parse(await f.text());
        if (!Array.isArray(j.points) || j.points.length < 4) throw new Error('That file is not a Kerbstone track.');
        const { format, version, ...def } = j; void format; void version;
        this.loadDef({ ...def, id: 'custom-' + Date.now().toString(36) }, true);
        this.app.toast(`Imported “${def.name || 'circuit'}”`);
      } else {
        const img = await loadImage(f);
        if (mode === 'photo') {
          const def = circuitFromImage(img);
          this.loadDef(def, true);
          this.app.toast('Sketch converted — tidy it up with Select');
        } else {
          this.underlay = { img, widthM: this.underlay?.widthM || 1600, opacity: 0.55, x: this.view.cx, z: this.view.cz };
          this.overlay.underlay = true;
          this.syncTop();
          this.app.toast('Image placed — set its width, then Draw or place Points over it');
          this.openImport();
          return;
        }
      }
      this.dialog.hidden = true;
      this.setTool('select');
    } catch (err) {
      this.app.toast(err.message || 'Import failed');
    }
  }

  async exportAs(kind) {
    const d = this.def;
    if (kind === 'png') {
      const c = document.createElement('canvas');
      c.width = 1600; c.height = 1000;
      drawThumb(c, d.points, '#ff5a1f', 22, '#0d1117');
      const a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = `${(d.name || 'circuit').replace(/[^a-z0-9]+/gi, '_')}.png`;
      a.click();
      return;
    }
    await this.app.exportTrack(d, kind);
  }

  // ================================================================ keyboard
  key(e) {
    if (!this.active || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
    if (mod || e.altKey) return;
    if (!this.dialog.hidden) { if (e.code === 'Escape') this.dialog.hidden = true; return; }
    const tool = TOOLS.find((t) => `Key${t[2]}` === e.code);
    if (tool) { this.setTool(tool[0]); return; }
    switch (e.code) {
      case 'KeyG': this.openGenerate(); break;
      case 'KeyI': this.openImport(); break;
      case 'KeyF': this.fitView(); break;
      case 'Enter': if (this.building) this.finishBuilding(true); break;
      case 'Escape': if (this.building) { this.building = null; this.updateHint(); this.dirty = true; } else if (this.sel) { this.sel = null; this.renderPanel(); this.dirty = true; } break;
      case 'Delete': case 'Backspace': if (this.sel) { e.preventDefault(); this.deleteSel(); } else if (this.building?.length) { this.building.pop(); this.dirty = true; this.updateHint(); } break;
      case 'KeyR': if (this.sel?.kind === 'object') { this.snapshot(); const o = this.def.objects[this.sel.i]; o.rot = ((o.rot || 0) + Math.PI / 12) % (Math.PI * 2); this.renderPanel(); this.dirty = true; this.autosave(); } break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!this.sel) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
        const dz = e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0;
        this.snapshot();
        this.moveSel(dx, dz);
        this.schedulePreview(); this.autosave();
        break;
      }
      default: break;
    }
  }

  // ================================================================ selection helpers
  selItem(s = this.sel) {
    if (!s || !this.def) return null;
    return s.kind === 'point' ? this.def.points[s.i] : s.kind === 'object' ? this.def.objects[s.i] : this.def.cams[s.i];
  }
  moveSel(dx, dz) {
    const it = this.selItem();
    if (!it) return;
    if (Array.isArray(it)) { it[0] += dx; it[1] += dz; } else { it.x += dx; it.z += dz; }
    this.dirty = true;
  }
  deleteSel() {
    const s = this.sel, d = this.def;
    if (!s) return;
    if (s.kind === 'point' && d.points.length <= 4) { this.app.toast('A circuit needs at least 4 points'); return; }
    this.snapshot();
    if (s.kind === 'point') d.points.splice(s.i, 1);
    else if (s.kind === 'object') d.objects.splice(s.i, 1);
    else d.cams.splice(s.i, 1);
    this.sel = null;
    this.rebuildPreview();
    this.autosave();
  }

  /** Hit test: control points, objects and cameras near a screen position. */
  hit(px, py) {
    const d = this.def;
    if (!d) return null;
    let best = null, bd = Infinity;
    const test = (kind, i, x, z, r) => { const [sx, sy] = this.toScreen(x, z); const dd = Math.hypot(sx - px, sy - py); if (dd < Math.max(14, r) && dd < bd) { bd = dd; best = { kind, i }; } };
    d.cams.forEach((c, i) => test('cam', i, c.x, c.z, 4));
    d.objects.forEach((o, i) => test('object', i, o.x, o.z, Math.max(6, (OBJECTS[o.type]?.r || 8) * this.view.scale * 0.6)));
    d.points.forEach((p, i) => test('point', i, p[0], p[1], 0));
    return best;
  }

  /** Nearest centreline sample to a world position. */
  nearestOnTrack(x, z) {
    const T = this.preview?.T;
    if (!T) return null;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < T.N; i++) { const d = (T.px[i] - x) ** 2 + (T.pz[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    return { i: bi, d: Math.sqrt(bd) };
  }

  eraseAt(px, py) {
    const h = this.hit(px, py);
    if (!h) return;
    this.sel = h;
    this.deleteSel();
    audio.click();
  }

  finishBuilding(close) {
    const B = this.building;
    this.building = null;
    if (close && B && B.length >= 4) {
      const prev = this.def;
      this.loadDef({
        id: prev?.id, name: prev?.name || 'My Circuit', env: prev?.env || 'gp', theme: prev?.theme || 'golden',
        width: prev?.width, hills: prev?.hills, banking: prev?.banking, seed: prev?.seed ?? Math.floor(Math.random() * 900),
        objects: prev?.objects || [], cams: prev?.cams || [], colors: prev?.colors, points: B,
      }, false);
      audio.beep(880, 0.14, 0.12, 'triangle');
    } else if (close) this.app.toast('Place at least 4 points to make a circuit');
    this.updateHint();
    this.dirty = true;
  }

  // ================================================================ pointer
  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    this.top.querySelector('.st-menu').hidden = true;
    if (this.pointers.size === 2) {
      this.stroke = null; this.drag = null; this.pan = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), scale: this.view.scale, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cx: this.view.cx, cz: this.view.cz };
      return;
    }
    const px = e.offsetX, py = e.offsetY;
    if (e.button === 1 || (e.button === 0 && (e.altKey || this.spaceDown))) { this.pan = { x: px, y: py, cx: this.view.cx, cz: this.view.cz }; return; }
    if (e.button !== 0) return;
    const w = this.toWorld(px, py);
    switch (this.tool) {
      case 'draw':
        this.stroke = [w];
        this.morph = null;
        break;
      case 'points': {
        if (this.building?.length >= 3) {
          const [fx, fy] = this.toScreen(...this.building[0]);
          if (Math.hypot(fx - px, fy - py) < 16) { this.finishBuilding(true); return; }
        }
        if (!this.building) this.building = [];
        this.building.push(this.snapPt(w));
        audio.beep(560 + this.building.length * 12, 0.05, 0.06, 'triangle');
        this.updateHint();
        this.dirty = true;
        break;
      }
      case 'start': {
        const n = this.nearestOnTrack(...w);
        if (!n || n.d > this.def.width * 2) { this.app.toast('Click on the track'); return; }
        this.snapshot();
        const T = this.preview.T;
        this.def.start = [Math.round(T.px[n.i]), Math.round(T.pz[n.i])];
        this.rebuildPreview(); this.autosave();
        audio.beep(880, 0.1, 0.1, 'triangle');
        break;
      }
      case 'place': case 'cams': {
        if (!this.def) { this.app.toast('Make a circuit first'); return; }
        const n = this.nearestOnTrack(...w);
        const need = this.def.width / 2 + (this.tool === 'cams' ? 4 : (OBJECTS[this.placeType]?.r || 8) * 0.6 + 4);
        if (n && n.d < need) { this.app.toast('Too close to the track — place it further out'); return; }
        this.snapshot();
        const [x, z] = this.snapPt(w);
        if (this.tool === 'cams') { this.def.cams.push({ x: Math.round(x), z: Math.round(z) }); this.sel = { kind: 'cam', i: this.def.cams.length - 1 }; }
        else {
          // face the track by default
          const T = this.preview?.T;
          const rot = T && n ? Math.atan2(T.px[n.i] - x, T.pz[n.i] - z) - Math.PI / 2 : 0;
          this.def.objects.push({ type: this.placeType, x: Math.round(x), z: Math.round(z), rot: ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) });
          this.sel = { kind: 'object', i: this.def.objects.length - 1 };
        }
        audio.beep(700, 0.06, 0.08, 'triangle');
        this.renderPanel(); this.autosave();
        this.dirty = true;
        break;
      }
      case 'erase': this.eraseAt(px, py); break;
      default: { // select
        const h = this.hit(px, py);
        if (h) {
          this.sel = h;
          this.beginChange();
          const it = this.selItem();
          const [ix, iz] = Array.isArray(it) ? it : [it.x, it.z];
          this.drag = { start: w, orig: [ix, iz], moved: false, base: h.kind === 'point' && this.brush ? this.def.points.map((p) => p.slice()) : null };
          this.renderPanel();
        } else {
          if (this.sel) { this.sel = null; this.renderPanel(); }
          this.pan = { x: px, y: py, cx: this.view.cx, cz: this.view.cz };
        }
        this.dirty = true;
      }
    }
  }

  onMove(e) {
    const px = e.offsetX, py = e.offsetY;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, [px, py]);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      this.view.scale = clamp(this.pinch.scale * (d / this.pinch.d), 0.06, 6);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.view.cx = this.pinch.cx - (mid[0] - this.pinch.mid[0]) / this.view.scale;
      this.view.cz = this.pinch.cz - (mid[1] - this.pinch.mid[1]) / this.view.scale;
      return;
    }
    if (this.pan) {
      this.view.cx = this.pan.cx - (px - this.pan.x) / this.view.scale;
      this.view.cz = this.pan.cz - (py - this.pan.y) / this.view.scale;
      return;
    }
    const w = this.toWorld(px, py);
    this.mouse = w;
    if (this.stroke) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs) {
        const p = this.toWorld(ev.offsetX, ev.offsetY);
        const last = this.stroke[this.stroke.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.view.scale > 2) this.stroke.push(p);
      }
      return;
    }
    if (this.drag) {
      const dx = w[0] - this.drag.start[0], dz = w[1] - this.drag.start[1];
      if (!this.drag.moved && Math.hypot(dx, dz) * this.view.scale < 3) return;
      this.drag.moved = true;
      const it = this.selItem();
      const [nx, nz] = this.snapPt([this.drag.orig[0] + dx, this.drag.orig[1] + dz]);
      if (Array.isArray(it)) {
        if (this.drag.base) this.brushMove(this.sel.i, nx - this.drag.orig[0], nz - this.drag.orig[1]);
        else { it[0] = nx; it[1] = nz; }
        this.schedulePreview();
      } else { it.x = nx; it.z = nz; }
      this.dirty = true;
      return;
    }
    if (this.tool === 'points' && this.building) { this.dirty = true; return; }
    if (this.def && (this.tool === 'select' || this.tool === 'erase')) {
      const h = this.hit(px, py);
      const key = h ? h.kind + h.i : '';
      this.dirty = true; // handles brighten near the cursor
      if (key !== this.hoverKey) { this.hoverKey = key; this.hover = h; this.canvas.style.cursor = h ? (this.tool === 'erase' ? 'not-allowed' : 'grab') : this.tool === 'erase' ? 'not-allowed' : 'default'; }
    }
  }

  /** Reshape brush: move a point and drag its neighbours with a smooth falloff. */
  brushMove(i, dx, dz) {
    const P = this.def.points, B = this.drag.base, n = P.length;
    const R = this.brush;
    // arc distance between consecutive control points
    const seg = B.map((p, k) => Math.hypot(B[(k + 1) % n][0] - p[0], B[(k + 1) % n][1] - p[1]));
    P[i][0] = B[i][0] + dx; P[i][1] = B[i][1] + dz;
    for (const dir of [1, -1]) {
      let acc = 0;
      for (let k = 1; k < n / 2; k++) {
        const j = (i + dir * k + n) % n;
        acc += seg[dir > 0 ? (i + (k - 1)) % n : (i - k + n) % n];
        if (acc > R) break;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * acc) / R);
        P[j][0] = B[j][0] + dx * w; P[j][1] = B[j][1] + dz * w;
      }
    }
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.pan = null;
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.commit(); else this.pending = null;
      return;
    }
    if (!this.stroke) return;
    const stroke = this.stroke;
    this.stroke = null;
    const ctrl = strokeToControlPoints(stroke);
    if (!ctrl) { if (stroke.length > 3) this.app.toast('Draw a bigger loop — at least 300 m around'); this.dirty = true; return; }
    const prev = this.def;
    const def = {
      id: prev?.id, name: prev?.name && !/copy\)$/.test(prev.name) ? prev.name : 'My Circuit',
      width: prev?.width, hills: prev?.hills, banking: prev?.banking, env: prev?.env || 'gp', colors: prev?.colors,
      seed: prev?.seed ?? Math.floor(Math.random() * 900), theme: prev?.theme ?? 'golden', objects: prev?.objects || [], cams: prev?.cams || [], points: ctrl,
    };
    // morph animation: raw stroke → smooth circuit
    const smooth = catmullRomClosed(ctrl, 16);
    const target = resamplePolyline(smooth, polylineLength(smooth, true) / 240, true).slice(0, 240);
    const src = resamplePolyline(stroke, Math.max(polylineLength(stroke) / 239, 0.5)).slice(0, 240);
    while (src.length < target.length) src.push(src[src.length - 1]);
    let best = 0, bd = Infinity;
    target.forEach((p, k) => { const d = Math.hypot(p[0] - src[0][0], p[1] - src[0][1]); if (d < bd) { bd = d; best = k; } });
    this.morph = { src, tgt: target.slice(best).concat(target.slice(0, best)), t0: performance.now() };
    audio.beep(660, 0.1, 0.12, 'triangle');
    setTimeout(() => audio.beep(990, 0.16, 0.12, 'triangle'), 160);
    this.loadDef(def, false);
  }

  onDouble(e) {
    if (this.tool === 'points' && this.building) { this.building.pop(); this.finishBuilding(true); return; }
    if (this.tool !== 'select' || !this.def) return;
    const [x, z] = this.toWorld(e.offsetX, e.offsetY);
    const P = this.def.points;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < P.length; i++) { const d = distToSeg([x, z], P[i], P[(i + 1) % P.length]); if (d < bd) { bd = d; bi = i; } }
    if (bd * this.view.scale > 40) return;
    this.snapshot();
    P.splice(bi + 1, 0, this.snapPt([x, z]));
    this.sel = { kind: 'point', i: bi + 1 };
    this.rebuildPreview(); this.autosave();
  }

  // ================================================================ rendering
  draw() {
    const v = this.view;
    const sig = `${v.cx},${v.cz},${v.scale},${this.tool},${this.canvas.width},${this.canvas.height}`;
    if (!this.dirty && !this.morph && !this.stroke && !(this.drag?.moved) && !(this.building && this.mouse) && sig === this.lastSig) return;
    this.lastSig = sig;
    this.dirty = false;
    const g = this.ctx;
    const W = this.W, H = this.H;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = g.createRadialGradient(W * 0.45, H * 0.45, 50, W * 0.5, H * 0.5, Math.max(W, H) * 0.8);
    bg.addColorStop(0, '#15202c');
    bg.addColorStop(1, '#0a0e14');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    this.drawUnderlay(g);
    this.drawGrid(g, W, H);

    const now = performance.now();
    if (this.morph) {
      const t = clamp((now - this.morph.t0) / 850, 0, 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      if (t < 1) {
        const pts = this.morph.src.map((p, k) => [lerp(p[0], this.morph.tgt[k][0], e), lerp(p[1], this.morph.tgt[k][1], e)]);
        g.lineCap = 'round'; g.lineJoin = 'round';
        this.pathWorld(g, pts, true);
        g.strokeStyle = 'rgba(255,122,61,0.9)';
        g.lineWidth = lerp(3, Math.max(4, (this.def?.width || 13) * v.scale), e);
        g.shadowColor = 'rgba(255,106,43,0.8)'; g.shadowBlur = 18 * (1 - e) + 4;
        g.stroke();
        g.shadowBlur = 0;
        return;
      }
      this.morph = null;
      this.dirty = true;
    }
    if (this.preview) this.drawTrack(g, this.preview);
    if (this.def) this.drawItems(g);
    if (this.building) this.drawBuilding(g);
    if (this.stroke && this.stroke.length > 1) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      this.pathWorld(g, this.stroke, false);
      g.strokeStyle = '#ff7a3d'; g.lineWidth = 3.5;
      g.shadowColor = 'rgba(255,106,43,0.9)'; g.shadowBlur = 14;
      g.stroke();
      g.shadowBlur = 0;
      const a = this.stroke[0], b = this.stroke[this.stroke.length - 1];
      const [ax, ay] = this.toScreen(a[0], a[1]), [bx, by] = this.toScreen(b[0], b[1]);
      g.setLineDash([6, 8]); g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(bx, by); g.lineTo(ax, ay); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(ax, ay, 5, 0, Math.PI * 2); g.fill();
    }
    this.drawScale(g, H);
  }

  drawUnderlay(g) {
    const u = this.underlay;
    if (!u || !this.overlay.underlay) return;
    const wM = u.widthM, hM = wM * (u.img.height / u.img.width);
    const [x0, y0] = this.toScreen(u.x - wM / 2, u.z - hM / 2);
    g.globalAlpha = u.opacity;
    g.drawImage(u.img, x0, y0, wM * this.view.scale, hM * this.view.scale);
    g.globalAlpha = 1;
  }

  drawGrid(g, W, H) {
    const s = this.view.scale;
    let step = 50;
    while (step * s < 28) step *= 2;
    const [x0, z0] = this.toWorld(0, 0), [x1, z1] = this.toWorld(W, H);
    g.lineWidth = 1;
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      const [sx] = this.toScreen(x, 0);
      g.strokeStyle = x % (step * 5) === 0 ? 'rgba(120,170,220,0.12)' : 'rgba(120,170,220,0.05)';
      g.beginPath(); g.moveTo(Math.round(sx) + 0.5, 0); g.lineTo(Math.round(sx) + 0.5, H); g.stroke();
    }
    for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) {
      const [, sy] = this.toScreen(0, z);
      g.strokeStyle = z % (step * 5) === 0 ? 'rgba(120,170,220,0.12)' : 'rgba(120,170,220,0.05)';
      g.beginPath(); g.moveTo(0, Math.round(sy) + 0.5); g.lineTo(W, Math.round(sy) + 0.5); g.stroke();
    }
  }

  drawScale(g, H) {
    const s = this.view.scale;
    let m = 100;
    for (const c of [10, 25, 50, 100, 250, 500, 1000, 2000]) { m = c; if (c * s >= 60) break; }
    const x = this.viewport().l + 24, y = H - 26;
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x, y); g.lineTo(x + m * s, y); g.lineTo(x + m * s, y - 5); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = '600 12px "Inter Variable", system-ui';
    g.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, x + 4, y - 9);
  }

  pathWorld(g, pts, closed) {
    g.beginPath();
    for (let k = 0; k < pts.length; k++) {
      const [sx, sy] = this.toScreen(pts[k][0], pts[k][1]);
      if (k) g.lineTo(sx, sy); else g.moveTo(sx, sy);
    }
    if (closed) g.closePath();
  }

  segPath(g, T, from, to, xs = T.px, zs = T.pz) {
    const N = T.N;
    let k = from;
    let [x, y] = this.toScreen(xs[k], zs[k]);
    g.moveTo(x, y);
    for (let n = 0; n < N && k !== to; n++) { k = (k + 1) % N; [x, y] = this.toScreen(xs[k], zs[k]); g.lineTo(x, y); }
  }

  drawTrack(g, { T, line, prof }) {
    const s = this.view.scale;
    const N = T.N;
    const E = envOf(this.def.env);
    const pts = [];
    for (let i = 0; i < N; i++) pts.push([T.px[i], T.pz[i]]);
    g.lineCap = 'round'; g.lineJoin = 'round';
    // run-off band in the environment's colour
    const runCol = { grass: 'rgba(80,140,90,0.2)', asphalt: 'rgba(150,155,160,0.22)', sand: 'rgba(230,200,140,0.25)', dirt: 'rgba(150,120,80,0.25)' }[E.runoff] || 'rgba(80,140,90,0.2)';
    this.pathWorld(g, pts, true);
    g.strokeStyle = runCol; g.lineWidth = (T.width + 24) * s; g.stroke();
    // overtaking zones under the road
    if (this.overlay.passing && this.analysis) {
      for (const c of this.analysis.corners) {
        if (c.pass < 0.3) continue;
        g.beginPath(); this.segPath(g, T, c.brakeI, c.minI);
        g.strokeStyle = `rgba(61,220,132,${0.25 + c.pass * 0.45})`; g.lineWidth = (T.width + 16) * s; g.stroke();
      }
    }
    // kerbs
    const col = this.def.colors || {};
    g.lineWidth = (T.width + 3) * s; g.strokeStyle = col.kerbB || '#e9e9e4';
    this.pathWorld(g, pts, true); g.stroke();
    g.lineCap = 'butt';
    g.beginPath();
    for (let i = 0; i < N; i += 2) {
      if (!T.kerb[i]) continue;
      const j = (i + 1) % N;
      const [ax, ay] = this.toScreen(T.px[i], T.pz[i]), [bx, by] = this.toScreen(T.px[j], T.pz[j]);
      g.moveTo(ax, ay); g.lineTo(bx, by);
    }
    g.strokeStyle = col.kerbA || '#d4202a'; g.stroke();
    g.lineCap = 'round';
    // asphalt (elevation-shaded)
    g.lineWidth = T.width * s;
    const roadL = E.road === 'gravel' ? [42, 30] : [24, 15];
    const buckets = this.overlay.elevation ? 6 : 1;
    for (let bk = 0; bk < buckets; bk++) {
      g.beginPath();
      for (let i = 0; i < N; i++) {
        const h = (T.py[i] - T.bounds.minY) / Math.max(T.bounds.maxY - T.bounds.minY, 1);
        if (buckets > 1 && Math.min(buckets - 1, Math.floor(h * buckets)) !== bk) continue;
        const j = (i + 1) % N;
        const [ax, ay] = this.toScreen(T.px[i], T.pz[i]), [bx, by] = this.toScreen(T.px[j], T.pz[j]);
        g.moveTo(ax, ay); g.lineTo(bx, by);
      }
      g.strokeStyle = E.road === 'gravel' ? `hsl(32, 22%, ${roadL[0] + (bk / Math.max(buckets - 1, 1)) * 14}%)` : `hsl(215, 10%, ${roadL[0] + (bk / Math.max(buckets - 1, 1)) * roadL[1]}%)`;
      g.stroke();
    }
    // bridges
    for (const c of T.crossings) {
      const i = c.upper;
      g.beginPath(); this.segPath(g, T, (i - 14 + N) % N, (i + 14) % N);
      g.lineWidth = (T.width + 4) * s; g.strokeStyle = '#a8a59d'; g.stroke();
      g.lineWidth = T.width * s; g.strokeStyle = 'hsl(215, 10%, 40%)'; g.stroke();
    }
    // racing line coloured by throttle / brake
    if (this.overlay.line) {
      g.lineWidth = Math.max(1.5, 0.6 * s);
      const cols = ['rgba(80,240,140,0.75)', 'rgba(255,200,60,0.85)', 'rgba(255,70,60,0.9)'];
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
        g.strokeStyle = cols[ci]; g.stroke();
      }
    }
    // highlighted corner (hover in the analysis table)
    if (this.hiCorner >= 0 && this.analysis?.corners[this.hiCorner]) {
      const c = this.analysis.corners[this.hiCorner];
      g.beginPath(); this.segPath(g, T, c.brakeI, c.exitI);
      g.strokeStyle = 'rgba(255,210,63,0.9)'; g.lineWidth = Math.max(3, (T.width + 6) * s); g.stroke();
    }
    // start/finish chequer + direction arrows
    {
      const [x, y] = this.toScreen(T.px[0], T.pz[0]);
      const ang = Math.atan2(T.tz[0], T.tx[0]);
      g.save(); g.translate(x, y); g.rotate(ang);
      const w = T.width * s, cell = Math.max(2, w / 8);
      for (let a = 0; a < 8; a++) for (let b = 0; b < 2; b++) { g.fillStyle = (a + b) % 2 ? '#111' : '#fff'; g.fillRect(b * cell - cell, -w / 2 + a * (w / 8), cell, w / 8); }
      g.restore();
      const step = Math.max(40, Math.floor(N / 10));
      for (let k = 18; k < N; k += step) {
        const [x2, y2] = this.toScreen(T.px[k], T.pz[k]);
        g.save(); g.translate(x2, y2); g.rotate(Math.atan2(T.tz[k], T.tx[k]));
        g.fillStyle = k === 18 ? '#ff7a3d' : 'rgba(255,255,255,0.45)';
        const z = k === 18 ? 1 : 0.7;
        g.beginPath(); g.moveTo(10 * z, 0); g.lineTo(-6 * z, -7 * z); g.lineTo(-2 * z, 0); g.lineTo(-6 * z, 7 * z); g.closePath(); g.fill();
        g.restore();
      }
    }
    // corner numbers (and pass ratings in analysis)
    if (this.overlay.numbers) {
      g.font = '800 12px "Saira Variable", system-ui';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const A = this.analysis;
      T.corners.forEach((c, k) => {
        const i = c.apex;
        const off = -c.dir * (T.width / 2 + 26 / s);
        const [x, y] = this.toScreen(T.px[i] + T.nx[i] * off, T.pz[i] + T.nz[i] * off);
        const hi = k === this.hiCorner;
        g.fillStyle = hi ? '#ffd23f' : 'rgba(12,16,22,0.9)';
        g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.4)'; g.lineWidth = 1; g.stroke();
        g.fillStyle = hi ? '#141000' : '#fff';
        g.fillText(`${k + 1}`, x, y + 0.5);
        if (this.overlay.passing && A?.corners[k]?.pass >= 0.3) {
          const p = A.corners[k].pass;
          g.font = '700 10px "Inter Variable", system-ui';
          g.fillStyle = 'rgba(61,220,132,0.95)';
          g.fillText(`PASS ${(p * 10).toFixed(1)}`, x, y + 20);
          g.font = '800 12px "Saira Variable", system-ui';
        }
      });
      g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    }
  }

  drawItems(g) {
    const d = this.def, s = this.view.scale;
    const T = this.preview?.T;
    // TV cameras: icon + view cone toward the track
    d.cams.forEach((c, i) => {
      const [x, y] = this.toScreen(c.x, c.z);
      const on = this.sel?.kind === 'cam' && this.sel.i === i;
      if (T) {
        const n = this.nearestOnTrack(c.x, c.z);
        const a = Math.atan2(T.pz[n.i] - c.z, T.px[n.i] - c.x);
        g.fillStyle = on ? 'rgba(255,210,63,0.25)' : 'rgba(74,168,255,0.16)';
        g.beginPath(); g.moveTo(x, y); g.arc(x, y, Math.max(40, 140 * s), a - 0.5, a + 0.5); g.closePath(); g.fill();
      }
      g.fillStyle = on ? '#ffd23f' : '#4aa8ff';
      g.beginPath(); g.roundRect(x - 9, y - 7, 14, 14, 3); g.fill();
      g.beginPath(); g.moveTo(x + 5, y); g.lineTo(x + 11, y - 5); g.lineTo(x + 11, y + 5); g.closePath(); g.fill();
      g.fillStyle = '#0b0e13'; g.font = '800 9px "Inter Variable", system-ui'; g.textAlign = 'center'; g.fillText(`${i + 1}`, x - 2, y + 3); g.textAlign = 'start';
    });
    // objects: footprint + icon
    d.objects.forEach((o, i) => {
      const def = OBJECTS[o.type] || { r: 8, icon: '?' };
      const [x, y] = this.toScreen(o.x, o.z);
      const on = this.sel?.kind === 'object' && this.sel.i === i;
      const hov = this.hover?.kind === 'object' && this.hover.i === i;
      const r = Math.max(7, def.r * s);
      g.save(); g.translate(x, y); g.rotate(-(o.rot || 0));
      g.fillStyle = o.type === 'lake' ? 'rgba(40,110,150,0.6)' : on ? 'rgba(255,210,63,0.35)' : 'rgba(255,255,255,0.14)';
      g.strokeStyle = on ? '#ffd23f' : hov ? '#fff' : 'rgba(255,255,255,0.5)';
      g.lineWidth = on ? 2 : 1;
      g.beginPath();
      if (o.type === 'lake' || o.type === 'trees' || o.type === 'palms') g.ellipse(0, 0, r, o.type === 'lake' ? r * 0.7 : r, 0, 0, Math.PI * 2);
      else g.rect(-r, -r * 0.6, r * 2, r * 1.2);
      g.fill(); g.stroke();
      g.restore();
      g.fillStyle = '#fff'; g.font = '700 13px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(def.icon, x, y);
      g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    });
    // control points (select / erase tools, or when one is selected)
    if (this.tool === 'select' || this.tool === 'erase' || this.sel?.kind === 'point') {
      const P = d.points;
      g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1;
      this.pathWorld(g, P, true); g.stroke();
      const dense = P.length > 60 && s < 0.5;
      P.forEach(([x, z, h, b], k) => {
        const on = this.sel?.kind === 'point' && this.sel.i === k;
        const hov = this.hover?.kind === 'point' && this.hover.i === k;
        if (dense && !on && !hov && !h && b == null && k % 3) return;
        const [sx, sy] = this.toScreen(x, z);
        const edited = h || b != null;
        const big = on || hov;
        // keep the outline readable: small quiet handles, bright when near the cursor
        const near = this.mouse ? Math.hypot(x - this.mouse[0], z - this.mouse[1]) * s < 70 : false;
        g.fillStyle = on ? '#ffd23f' : hov ? '#ff7a3d' : edited ? '#ffd23f' : near ? '#ffffff' : 'rgba(255,255,255,0.55)';
        g.beginPath(); g.arc(sx, sy, big ? 7 : near || edited ? 4.5 : P.length > 40 ? 2.6 : 4, 0, Math.PI * 2); g.fill();
        if (big || near || edited || P.length <= 40) { g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 1.5; g.stroke(); }
        if (on && this.brush) {
          g.strokeStyle = 'rgba(255,210,63,0.4)'; g.setLineDash([4, 5]);
          g.beginPath(); g.arc(sx, sy, this.brush * s, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        }
      });
    }
  }

  drawBuilding(g) {
    const B = this.building;
    if (!B.length) return;
    const s = this.view.scale;
    const pts = this.mouse ? [...B, this.snapPt(this.mouse)] : B;
    if (pts.length >= 3) {
      const smooth = catmullRomClosed(pts, 12);
      g.lineCap = 'round'; g.lineJoin = 'round';
      this.pathWorld(g, smooth, true);
      g.strokeStyle = 'rgba(255,122,61,0.35)'; g.lineWidth = Math.max(3, (this.def?.width || 13) * s); g.stroke();
      this.pathWorld(g, smooth, true);
      g.strokeStyle = '#ff7a3d'; g.lineWidth = 2; g.stroke();
    }
    g.setLineDash([5, 6]); g.strokeStyle = 'rgba(255,255,255,0.4)'; g.lineWidth = 1;
    this.pathWorld(g, pts, false); g.stroke(); g.setLineDash([]);
    B.forEach(([x, z], k) => {
      const [sx, sy] = this.toScreen(x, z);
      g.fillStyle = k === 0 ? '#3ddc84' : '#fff';
      g.beginPath(); g.arc(sx, sy, k === 0 ? 7 : 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1.5; g.stroke();
    });
  }

  destroy() { window.removeEventListener('keydown', this.onKey); }
}

// ================================================================ helpers
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2, 0, 1);
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/** Laplacian smoothing that keeps per-point edits. */
function smoothPoints(P) {
  const n = P.length;
  return P.map((p, i) => {
    const a = P[(i - 1 + n) % n], b = P[(i + 1) % n];
    const q = p.slice();
    q[0] = p[0] * 0.5 + (a[0] + b[0]) * 0.25;
    q[1] = p[1] * 0.5 + (a[1] + b[1]) * 0.25;
    return q;
  });
}

/** Re-space the outline to `count` points along the spline (edits are dropped). */
function respace(P, count) {
  const dense = catmullRomClosed(P.map((p) => [p[0], p[1]]), 12);
  const L = polylineLength(dense, true);
  return resamplePolyline(dense, L / count, true).slice(0, count).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

export function drawThumb(c, points, color = '#ff7a3d', lw = 2.2, bg = null) {
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const dense = catmullRomClosed(points.map((p) => [p[0], p[1]]), 8);
  for (const [x, z] of dense) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const pad = Math.max(10, lw * 4);
  const s = Math.min((W - pad) / (maxX - minX), (H - pad) / (maxZ - minZ));
  const ox = (W - (maxX - minX) * s) / 2, oz = (H - (maxZ - minZ) * s) / 2;
  g.clearRect(0, 0, W, H);
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, W, H); }
  g.beginPath();
  dense.forEach(([x, z], k) => { const sx = ox + (x - minX) * s, sy = oz + (z - minZ) * s; if (k) g.lineTo(sx, sy); else g.moveTo(sx, sy); });
  g.closePath();
  g.lineJoin = 'round';
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.stroke();
}
