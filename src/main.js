// Kerbstone — app shell: screens, settings, track pipeline and the main loop.
import '@fontsource-variable/inter';
import '@fontsource-variable/saira';
import './ui/styles.css';
import * as THREE from 'three';
import { World, buildTerrain, buildVegetation, THEMES } from './world/environment.js';
import { buildTrackScene, runoffHeight, sampleHF } from './world/trackMesh.js';
import { buildGrass } from './world/grass.js';
import { buildTrack, buildHeightfield } from './track/track.js';
import { computeRacingLine, speedProfile } from './track/racingLine.js';
import { PRESETS, presetById } from './track/presets.js';
import { DEFAULT_SETUP, makeCarParams, setGripLevel } from './physics/carSetup.js';
import { ASSIST_PRESETS } from './physics/vehicle.js';
import { DriveSession } from './game/drive.js';
import { Input } from './game/input.js';
import { store, trackHash, encodeTrack, decodeTrack } from './game/store.js';
import { audio } from './audio/audio.js';
import { HUD } from './ui/hud.js';
import { TrackEditor, drawThumb } from './ui/editor.js';
import { Garage } from './ui/garage.js';
import { formatTime, clamp } from './core/math.js';

const VERSION = '0.1.0';
const $ = (s) => document.querySelector(s);

const DEFAULT_SETTINGS = {
  assists: 'casual', grip: 'arcade', race: { mode: 'race', laps: 3, rivals: 5, difficulty: 'medium' }, gearbox: 'auto', units: 'kmh', quality: 'auto', volume: 0.8, showLine: true, ghost: true, camera: 'chase',
};

class App {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
    if (!store.get('migratedEasy', false)) { this.settings.assists = 'casual'; store.set('migratedEasy', true); }
    this.setup = { ...DEFAULT_SETUP, ...store.get('setup', {}) };
    this.store = store;
    setGripLevel(this.settings.grip);
    this.world = new World($('#gl'));
    this.input = new Input();
    this.hud = new HUD($('#hud'), this);
    this.editor = new TrackEditor(this, $('#studio'));
    this.garage = new Garage(this, $('#garage'));
    this.screen = 'loading';
    this.session = null;
    this.lastT = performance.now();
    this.fps = { acc: 0, n: 0, slow: 0, fast: 0 };
    audio.setVolume(this.settings.volume);
    this.world.setQuality(this.settings.quality === 'auto' ? 'high' : this.settings.quality);
    $('.ver').textContent = VERSION;
    this.bindUI();
    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.hud.input = this.input;
    this.input.bindTouch($('#hud'));
  }

  async start() {
    // shared track in the URL?
    const m = location.hash.match(/t=([A-Za-z0-9_-]+)/);
    let def = null;
    if (m) {
      def = decodeTrack(m[1]);
      if (def) { store.saveTrack(def); this.toast(`Imported “${def.name}”`); }
    }
    if (!def) def = store.get('currentTrack', null) || presetById('harbor');
    await this.loadTrack(def);
    this.showHome();
    $('#loader').classList.add('fade');
    setTimeout(() => ($('#loader').hidden = true), 600);
    this.loop();
  }

  // ------------------------------------------------------------ track pipeline
  trackKey() { return trackHash(this.trackDef); }

  async loadTrack(def, { keepSession = false } = {}) {
    this.trackDef = JSON.parse(JSON.stringify(def));
    store.set('currentTrack', this.trackDef);
    const T = buildTrack(this.trackDef);
    buildHeightfield(T);
    const line = computeRacingLine(T);
    this.track = T;
    this.line = line;
    line.profile = speedProfile(T, line, makeCarParams(this.setup));
    if (this.session) { this.session.dispose(); this.session = null; }
    this.world.clearContent();
    this.world.setTheme(def.theme || 'golden');
    // yield a frame so the loader can paint on slower machines
    await new Promise((r) => setTimeout(r, 0));
    this.trackGroup = buildTrackScene(T, line);
    this.world.content.add(this.trackGroup);
    this.world.content.add(buildTerrain(T));
    this.world.content.add(buildVegetation(T, { density: this.world.quality === 'low' ? 0.5 : 1 }));
    if (this.world.quality !== 'low') {
      const grass = buildGrass(T, (i, d, x, z) => {
        const wall = T.half + (d >= 0 ? T.runL[i] : T.runR[i]);
        return Math.abs(d) <= wall + 3 ? runoffHeight(T, i, d) : sampleHF(T.heightfield, x, z);
      }, { density: this.world.quality === 'high' ? 1 : 0.6 });
      this.world.content.add(grass);
      this.world.grassUniforms = grass.userData.uniforms;
    }
    this.hud.setTrack(T);
    this.updateHomeCard();
    void keepSession;
  }

  // ------------------------------------------------------------ screens
  hideAll() {
    for (const id of ['home', 'reveal', 'hud', 'pause', 'settings', 'circuits', 'modes', 'results']) $('#' + id).hidden = true;
    if (this.editor.active) this.editor.close();
    if (this.garage.active) this.garage.close();
    this.input.captureKeys = false;
  }

  showHome() {
    this.hideAll();
    this.screen = 'home';
    $('#home').hidden = false;
    this.startAttract();
    this.updateHomeCard();
    setTimeout(() => $('#home .menu-item.primary')?.focus({ preventScroll: true }), 50);
  }

  startAttract() {
    if (this.session) this.session.dispose();
    this.session = new DriveSession(this, { mode: 'attract' });
  }

  async startRace() {
    this.hideAll();
    this.screen = 'race';
    if (this.session) this.session.dispose();
    setGripLevel(this.settings.grip);
    const R = this.settings.race || DEFAULT_SETTINGS.race;
    this.session = new DriveSession(this, { mode: 'race', race: R.mode === 'race' ? { laps: R.laps, rivals: R.rivals, difficulty: R.difficulty } : null });
    $('#hud').hidden = false;
    this.hud.setTouch(this.isTouch());
    this.input.captureKeys = true;
    await audio.unlock();
  }

  openStudio(def) {
    this.hideAll();
    if (this.session) { this.session.dispose(); this.session = null; }
    this.screen = 'studio';
    $('#studio').hidden = false;
    this.editor.open(def);
  }

  openGarage() {
    this.hideAll();
    this.screen = 'garage';
    this.garage.open();
  }

  openOverlay(id) {
    $('#' + id).hidden = false;
    if (id === 'settings') this.renderSettings();
    if (id === 'circuits') this.renderCircuits();
    if (id === 'modes') this.renderModes();
  }

  closeOverlay(id) {
    $('#' + id).hidden = true;
  }

  togglePause(force) {
    if (this.screen !== 'race' || !this.session) return;
    const p = force ?? !this.session.paused;
    this.session.paused = p;
    $('#pause').hidden = !p;
    if (p) audio.silence();
  }

  isTouch() { return matchMedia('(pointer: coarse)').matches || this.input.source === 'touch'; }

  /** From the studio: build the 3D circuit with a cinematic reveal. */
  async buildAndReveal(def) {
    this.hideAll();
    $('#loader').hidden = false;
    $('#loader').classList.remove('fade');
    $('.loader-text').textContent = 'Laying asphalt…';
    await new Promise((r) => setTimeout(r, 30));
    await this.loadTrack(def);
    $('#loader').classList.add('fade');
    setTimeout(() => ($('#loader').hidden = true), 500);
    this.screen = 'reveal';
    this.reveal = { t: 0, dur: 4.2 };
    // grow the road along its length
    const road = this.trackGroup.userData.road;
    this.reveal.road = road;
    this.reveal.total = road.geometry.index.count;
    road.geometry.setDrawRange(0, 0);
    this.trackGroup.children.forEach((c) => { if (c !== road) c.visible = false; });
    const T = this.track;
    $('.rv-name').textContent = def.name || 'My Circuit';
    $('.rv-stats').innerHTML = `<span><b>${(T.length / 1000).toFixed(2)} km</b>Length</span><span><b>${T.corners.length}</b>Corners</span><span><b>${(T.bounds.maxY - T.bounds.minY).toFixed(0)} m</b>Elevation</span><span><b>${formatTime(this.line.profile.lapTime * 1.05)}</b>Target lap</span>`;
  }

  updateReveal(dt) {
    const R = this.reveal;
    R.t += dt;
    const T = this.track;
    const k = clamp(R.t / 2.6, 0, 1);
    const e = 1 - Math.pow(1 - k, 3);
    const cnt = Math.floor((R.total * e) / 6) * 6;
    R.road.geometry.setDrawRange(0, cnt);
    if (k >= 1 && !R.shown) {
      R.shown = true;
      this.trackGroup.children.forEach((c) => (c.visible = true));
      $('#reveal').hidden = false;
      audio.beep(784, 0.2, 0.15, 'triangle');
    }
    // camera: orbit high around the circuit, following the growing tip
    const b = T.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const a = R.t * 0.16 + 0.6;
    const r = span * (0.75 - 0.12 * Math.min(R.t / R.dur, 1));
    const cam = this.world.camera;
    cam.position.set(cx + Math.cos(a) * r, T.meanY + span * (0.45 - 0.1 * Math.min(R.t / R.dur, 1)), cz + Math.sin(a) * r);
    const tip = Math.min(T.N - 1, Math.floor(e * T.N));
    const look = new THREE.Vector3(cx, T.meanY, cz).lerp(new THREE.Vector3(T.px[tip], T.py[tip], T.pz[tip]), k < 1 ? 0.35 : 0);
    if (!R.look) R.look = look.clone();
    R.look.lerp(look, 0.05);
    cam.lookAt(R.look);
    cam.fov = 45;
    cam.updateProjectionMatrix();
    this.world.followShadow(new THREE.Vector3(cx, T.meanY, cz));
  }

  // ------------------------------------------------------------ persistence
  saveSettings() { store.set('settings', this.settings); }
  saveSetup() { store.set('setup', this.setup); }
  saveTrack(def) { store.saveTrack(def); }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => t.classList.remove('show'), 2400);
  }

  updateHomeCard() {
    if (!this.track) return;
    const T = this.track;
    $('.hc-name').textContent = this.trackDef.name;
    $('.drive-sub').textContent = this.trackDef.name;
    drawThumb($('.hc-thumb'), this.trackDef.points, '#ff7a3d');
    const best = store.bestForTrack(this.trackKey());
    $('.hc-stats').innerHTML = `<span><b>${(T.length / 1000).toFixed(2)} km</b>Length</span><span><b>${T.corners.length}</b>Corners</span><span><b>${(THEMES[this.trackDef.theme] || THEMES.golden).name}</b>Scenery</span><span><b>${best ? formatTime(best.time) : '—'}</b>Your best</span>`;
  }

  // ------------------------------------------------------------ settings UI
  renderSettings() {
    const S = this.settings;
    const g = $('.settings-grid');
    const seg = (key, opts) => `<div class="seg small" data-set="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${S[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const sw = (key, label) => `<div class="toggle"><span>${label}</span><button class="switch ${S[key] ? 'on' : ''}" data-switch="${key}" aria-pressed="${!!S[key]}"></button></div>`;
    g.innerHTML = `
      <h4>Driving</h4>
      <div class="field"><span>Assists</span>${seg('assists', [['casual', 'Easy'], ['sport', 'Sport'], ['pro', 'Pro']])}
        <div class="desc">${{ casual: 'Best for keyboard & touch. Keys ask for a turn and the car finds the grip; full ABS, traction and stability control; auto-recovery if you get stuck.', sport: 'Same keyboard-friendly steering with lighter traction and stability control — you can feel and use the slide.', pro: 'No aids, direct steering. Best with a gamepad or wheel.' }[S.assists]}</div></div>
      <div class="field"><span>Grip</span>${seg('grip', [['arcade', 'Arcade'], ['sport', 'Sport'], ['real', 'Realistic']])}
        <div class="desc">${{ arcade: 'Sharper turning and much stronger brakes than real cars. Most fun.', sport: 'A bit more grip and braking than real life.', real: 'True-to-life tyre grip and braking distances.' }[S.grip]} Applies from the next session.</div></div>
      <div class="field"><span>Gearbox</span>${seg('gearbox', [['auto', 'Automatic'], ['manual', 'Manual']])}</div>
      ${sw('showLine', 'Driving line')}
      ${sw('ghost', 'Best-lap ghost')}
      <h4>Display &amp; sound</h4>
      <div class="field"><span>Graphics</span>${seg('quality', [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}</div>
      <div class="field"><span>Units</span>${seg('units', [['kmh', 'km/h'], ['mph', 'mph']])}</div>
      <label class="slider"><span>Volume <b>${Math.round(S.volume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value="${S.volume}" data-vol></label>
      <h4>Controls</h4>
      <div class="desc" style="grid-column:1/-1">Keyboard: WASD / arrows · Space handbrake · E/Q shift · R reset · C camera · L line · G ghost · Esc pause.<br>Gamepad: left stick steer · RT/LT throttle/brake · RB/LB shift · X handbrake · Y camera · Start pause.<br>Touch: drag left half to steer, pedals on the right.</div>`;
    g.querySelectorAll('[data-set]').forEach((s) => s.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      audio.click();
      S[s.dataset.set] = b.dataset.v;
      this.applySettings();
      this.renderSettings();
    }));
    g.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => {
      audio.click();
      S[b.dataset.switch] = !S[b.dataset.switch];
      this.applySettings();
      this.renderSettings();
    }));
    g.querySelector('[data-vol]').addEventListener('input', (e) => {
      S.volume = parseFloat(e.target.value);
      audio.setVolume(S.volume);
      e.target.closest('label').querySelector('b').textContent = `${Math.round(S.volume * 100)}%`;
      this.saveSettings();
    });
  }

  applySettings() {
    const S = this.settings;
    this.saveSettings();
    if (S.quality !== 'auto') this.world.setQuality(S.quality);
    if (this.session && this.session.mode === 'race') {
      const car = this.session.car;
      car.assists = { ...ASSIST_PRESETS[S.assists] };
      if (S.gearbox === 'manual') car.assists.autoShift = false;
      this.session.lineMesh.visible = S.showLine && car.assists.line;
    }
  }

  // ------------------------------------------------------------ mode picker & results
  renderModes() {
    const R = (this.settings.race = { ...DEFAULT_SETTINGS.race, ...(this.settings.race || {}) });
    const seg = (key, opts) => `<div class="seg small" data-race="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(R[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    $('.modes-body').innerHTML = `
      <div class="mode-cards">
        <button class="mode-card ${R.mode === 'race' ? 'on' : ''}" data-mode="race"><b>Race</b><small>Grid start against AI rivals. Fight for position.</small></button>
        <button class="mode-card ${R.mode === 'trial' ? 'on' : ''}" data-mode="trial"><b>Time trial</b><small>Just you, the clock and your ghost.</small></button>
      </div>
      <div class="race-opts" ${R.mode === 'race' ? '' : 'hidden'}>
        <div class="field"><span>Laps</span>${seg('laps', [[2, '2'], [3, '3'], [5, '5'], [10, '10']])}</div>
        <div class="field"><span>Rivals</span>${seg('rivals', [[3, '3'], [5, '5'], [7, '7']])}</div>
        <div class="field"><span>Rival skill</span>${seg('difficulty', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']])}</div>
      </div>
      <div class="mode-foot"><span class="mode-track">${this.trackDef.name} · ${(this.track.length / 1000).toFixed(2)} km</span><button class="btn primary big" data-start><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>Start</button></div>`;
    const body = $('.modes-body');
    body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { audio.click(); R.mode = b.dataset.mode; this.saveSettings(); this.renderModes(); }));
    body.querySelectorAll('[data-race]').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      audio.click();
      const k = sg.dataset.race;
      R[k] = k === 'difficulty' ? b.dataset.v : parseInt(b.dataset.v);
      this.saveSettings();
      this.renderModes();
    }));
    body.querySelector('[data-start]').addEventListener('click', () => { audio.click(); this.startRace(); });
  }

  onRaceFinish(session) {
    if (this.session !== session || this.screen !== 'race') return;
    const st = session.field.standings();
    const winner = st[0];
    $('.results-body').innerHTML = `
      <div class="res-head">${st.findIndex((r) => r.isPlayer) === 0 ? '<span class="trophy">🏆</span> Victory' : `You finished P${st.findIndex((r) => r.isPlayer) + 1}`}</div>
      <div class="res-table">${st.map((r, k) => `<div class="${r.isPlayer ? 'me' : ''}"><b>${k + 1}</b><i style="background:${r.paint}"></i><span>${r.name}</span><em>${r.finished != null ? formatTime(r.finished) : 'running'}</em><small>best ${r.best != null ? formatTime(r.best) : '—'}</small></div>`).join('')}</div>`;
    void winner;
    $('#results').hidden = false;
    this.input.captureKeys = false;
  }

  // ------------------------------------------------------------ circuits UI
  renderCircuits() {
    const list = $('.circuit-list');
    const saved = store.tracks();
    const items = [...saved.map((d) => ({ def: d, saved: true })), ...PRESETS.map((d) => ({ def: d, saved: false }))];
    list.innerHTML = '';
    const curKey = this.trackKey();
    for (const { def, saved } of items) {
      const key = trackHash(def);
      const best = store.bestForTrack(key);
      const card = document.createElement('div');
      card.className = 'circuit' + (key === curKey ? ' current' : '');
      card.innerHTML = `<span class="tagline">${saved ? 'My circuit' : 'Featured'}</span><canvas width="300" height="170"></canvas><h4></h4>
        <div class="meta">${def.blurb ? def.blurb + '<br>' : ''}Best: ${best ? formatTime(best.time) : '—'}</div>
        <div class="acts"><button class="chip" data-a="drive">Drive</button><button class="chip" data-a="edit">Edit</button><button class="chip" data-a="share">Share link</button><button class="chip" data-a="export">Export</button>${saved ? '<button class="chip" data-a="delete">Delete</button>' : ''}</div>`;
      card.querySelector('h4').textContent = def.name;
      drawThumb(card.querySelector('canvas'), def.points, saved ? '#ff7a3d' : '#e9edf2');
      card.addEventListener('click', async (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        audio.click();
        if (a === 'drive') { this.closeOverlay('circuits'); await this.loadTrack(def); this.startRace(); }
        else if (a === 'edit') { this.closeOverlay('circuits'); this.openStudio(saved ? def : { ...def, id: 'custom-' + Date.now().toString(36), name: def.name + ' (copy)' }); }
        else if (a === 'share') this.share(def);
        else if (a === 'export') this.exportMenu(def, card);
        else if (a === 'delete') { store.deleteTrack(def.id); this.renderCircuits(); }
      });
      list.appendChild(card);
    }
  }

  shareUrl(def) {
    return `${location.origin}${location.pathname}#t=${encodeTrack(def)}`;
  }

  async share(def) {
    const url = this.shareUrl(def);
    try {
      if (navigator.share && this.isTouch()) await navigator.share({ title: `Kerbstone · ${def.name}`, url });
      else { await navigator.clipboard.writeText(url); this.toast('Share link copied'); }
    } catch {
      prompt('Copy this link', url);
    }
  }

  exportMenu(def, card) {
    const acts = card.querySelector('.acts');
    acts.innerHTML = `<button class="chip" data-x="json">Track JSON</button><button class="chip" data-x="csv">Centerline CSV</button><button class="chip" data-x="glb">3D model .glb</button>`;
    acts.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (!x) return;
      e.stopPropagation();
      await this.exportTrack(def, x);
      this.renderCircuits();
    }, { once: true });
  }

  async exportTrack(def, kind) {
    const safe = (def.name || 'circuit').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const download = (blob, name) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    if (kind === 'json') {
      download(new Blob([JSON.stringify({ format: 'kerbstone-track', version: 1, ...def }, null, 2)], { type: 'application/json' }), `${safe}.kerbstone.json`);
    } else if (kind === 'csv') {
      const T = buildTrack(def);
      let csv = 's_m,x_m,y_m,z_m,width_m,bank_rad,curvature_1pm,kerb\n';
      for (let i = 0; i < T.N; i++) csv += `${T.s[i].toFixed(2)},${T.px[i].toFixed(3)},${T.py[i].toFixed(3)},${T.pz[i].toFixed(3)},${T.width},${T.bank[i].toFixed(5)},${T.curv[i].toFixed(6)},${T.kerb[i]}\n`;
      download(new Blob([csv], { type: 'text/csv' }), `${safe}_centerline.csv`);
    } else if (kind === 'glb') {
      this.toast('Preparing 3D model…');
      if (trackHash(def) !== this.trackKey()) await this.loadTrack(def);
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      const ex = new GLTFExporter();
      const root = this.trackGroup.clone();
      ex.parse(root, (res) => download(new Blob([res], { type: 'model/gltf-binary' }), `${safe}.glb`), (err) => this.toast('Export failed: ' + err.message), { binary: true, onlyVisible: true });
    }
  }

  // ------------------------------------------------------------ bindings
  bindUI() {
    $('#home').addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]')?.dataset.go;
      if (!go) return;
      audio.click();
      if (go === 'drive') this.openOverlay('modes');
      else if (go === 'studio') this.openStudio(null);
      else if (go === 'garage') this.openGarage();
      else this.openOverlay(go);
    });
    $('#reveal').addEventListener('click', (e) => {
      const a = e.target.closest('[data-rv]')?.dataset.rv;
      if (!a) return;
      audio.click();
      if (a === 'drive') this.startRace();
      else this.openStudio(this.trackDef);
    });
    $('#pause').addEventListener('click', (e) => {
      const a = e.target.closest('[data-p]')?.dataset.p;
      if (!a) return;
      audio.click();
      if (a === 'resume') this.togglePause(false);
      else if (a === 'restart') { this.togglePause(false); this.startRace(); }
      else if (a === 'camera') this.session?.cycleCamera();
      else if (a === 'settings') this.openOverlay('settings');
      else if (a === 'edit') this.openStudio(this.trackDef);
      else if (a === 'garage') this.openGarage();
      else if (a === 'exit') this.showHome();
    });
    $('#results').addEventListener('click', (e) => {
      const a = e.target.closest('[data-res]')?.dataset.res;
      if (!a) return;
      audio.click();
      $('#results').hidden = true;
      if (a === 'again') this.startRace();
      else if (a === 'modes') { this.showHome(); this.openOverlay('modes'); }
      else this.showHome();
    });
    for (const id of ['settings', 'circuits', 'modes']) {
      $('#' + id).addEventListener('click', (e) => {
        if (e.target.closest('[data-close]') || e.target === $('#' + id)) { audio.click(); this.closeOverlay(id); }
      });
    }
    $('[data-import]').addEventListener('click', async () => {
      const v = $('.import-code').value.trim();
      const m = v.match(/t=([A-Za-z0-9_-]+)/);
      const def = decodeTrack(m ? m[1] : v);
      if (!def) { this.toast('That code doesn’t look like a Kerbstone circuit'); return; }
      store.saveTrack(def);
      $('.import-code').value = '';
      this.toast(`Imported “${def.name}”`);
      this.renderCircuits();
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Escape') {
        if (!$('#settings').hidden) return this.closeOverlay('settings');
        if (!$('#circuits').hidden) return this.closeOverlay('circuits');
        if (!$('#modes').hidden) return this.closeOverlay('modes');
        if (this.screen === 'race') return this.togglePause();
        if (this.screen === 'garage' || this.screen === 'reveal') return this.showHome();
      }
      if (e.code === 'Enter' && this.screen === 'home' && $('#settings').hidden && $('#circuits').hidden) {
        if ($('#modes').hidden) this.openOverlay('modes'); else this.startRace();
        e.preventDefault();
      }
      if (e.code === 'Enter' && this.screen === 'reveal') this.startRace();
    });
    // orbit camera drag
    const c = this.world.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => { if (this.session?.camMode === 'orbit') { drag = { x: e.clientX, y: e.clientY, ...this.session.orbit }; this.pointerOrbiting = true; } });
    window.addEventListener('pointermove', (e) => {
      if (!drag || !this.session) return;
      this.session.orbit.yaw = drag.yaw - (e.clientX - drag.x) * 0.006;
      this.session.orbit.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.004, 0.02, 1.3);
    });
    window.addEventListener('pointerup', () => { drag = null; this.pointerOrbiting = false; });
    c.addEventListener('wheel', (e) => { if (this.session?.camMode === 'orbit') this.session.orbit.dist = clamp(this.session.orbit.dist * Math.exp(e.deltaY * 0.001), 4, 30); }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.screen === 'race') this.togglePause(true); });
  }

  handleRaceKeys() {
    const I = this.input;
    const s = this.session;
    if (I.pressed('GP_START')) this.togglePause();
    if (s.paused) return;
    if (I.pressed('KeyC') || I.pressed('GP_Y')) s.cycleCamera();
    if (I.pressed('KeyR') || I.pressed('GP_BACK')) { s.car.recover(); s.message('RESET', '', 0.8); if (s.lap.start != null) s.lap.invalid = true; }
    if (I.pressed('KeyL')) { this.settings.showLine = !this.settings.showLine; this.applySettings(); s.message(this.settings.showLine ? 'DRIVING LINE ON' : 'DRIVING LINE OFF', '', 1); }
    if (I.pressed('KeyF')) this.toggleFps();
    if (I.pressed('KeyG')) { this.settings.ghost = !this.settings.ghost; this.saveSettings(); s.message(this.settings.ghost ? 'GHOST ON' : 'GHOST OFF', '', 1); }
  }

  toggleFps() {
    if (this.fpsEl) { this.fpsEl.remove(); this.fpsEl = null; return; }
    const e = (this.fpsEl = document.createElement('div'));
    e.className = 'fps-meter';
    document.body.appendChild(e);
    let n = 0, acc = 0, worst = 0;
    const tick = (dt) => {
      n++; acc += dt; worst = Math.max(worst, dt);
      if (acc >= 0.5 && this.fpsEl) {
        e.textContent = `${Math.round(n / acc)} fps · worst ${(worst * 1000).toFixed(0)} ms · ${Math.round((this.world.resScale ?? 1) * 100)}% res · ${this.world.quality}`;
        n = 0; acc = 0; worst = 0;
      }
    };
    this.fpsTick = tick;
  }

  // ------------------------------------------------------------ main loop
  loop() {
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - this.lastT) / 1000, 0.1);
      this.lastT = now;
      this.frame(dt);
      if (this.fpsEl) this.fpsTick(dt);
      this.input.endFrame();
    };
    requestAnimationFrame(tick);
  }

  frame(dt) {
    const scr = this.screen;
    if (scr === 'studio') return; // 2D editor draws itself
    if (scr === 'garage') {
      this.garage.update(dt);
      this.world.renderPass.scene = this.garage.scene;
      this.world.renderPass.camera = this.garage.camera;
      const prevExp = this.world.renderer.toneMappingExposure;
      this.world.renderer.toneMappingExposure = 0.8;
      if (this.world.quality === 'low') this.world.renderer.render(this.garage.scene, this.garage.camera);
      else this.world.composer.render();
      this.world.renderer.toneMappingExposure = prevExp;
      this.world.renderPass.scene = this.world.scene;
      this.world.renderPass.camera = this.world.camera;
      return;
    }
    if (scr === 'reveal') this.updateReveal(dt);
    else if (this.session) {
      let cmd = null;
      if (scr === 'race') {
        this.handleRaceKeys();
        cmd = this.input.sample(dt, this.session.car.speed);
        if (this.input.source === 'touch' && !$('#hud').classList.contains('touch')) this.hud.setTouch(true);
      }
      this.session.update(dt, cmd);
      if (scr === 'race') this.input.rumble(this.session.car);
      if (scr === 'race') this.hud.update(this.session, this.settings);
    }
    this.world.tick(dt, scr === 'race' && this.session ? this.session.car.speed : 0);
    this.world.render();
    this.adaptQuality(dt);
  }

  /**
   * Keep the frame rate smooth: continuously scale render resolution (and, if
   * that is not enough, drop a quality tier). Remembers the scale at which
   * stutter appeared so it does not keep oscillating.
   */
  adaptQuality(dt) {
    if (this.settings.quality !== 'auto' || document.hidden) return;
    const f = this.fps;
    if (dt > 0.25) return; // tab switch / hitch, ignore
    f.acc += dt; f.n++;
    f.worst = Math.max(f.worst || 0, dt);
    if (f.acc < 0.75) return;
    const avg = f.acc / f.n;
    f.acc = 0; f.n = 0; f.worst = 0;
    const W = this.world;
    const k = W.resScale ?? 1;
    if (avg > 1 / 52) {
      f.ceiling = Math.min(f.ceiling ?? 1, k);
      if (k > 0.55) W.setResScale(k * 0.88);
      else if (W.quality !== 'low') { W.setQuality(W.quality === 'high' ? 'medium' : 'low'); W.setResScale(0.85); }
      f.good = 0;
    } else if (avg < 1 / 57) {
      f.good = (f.good || 0) + 1;
      // creep back up slowly, staying just below the scale that stuttered
      if (f.good >= 6 && k < 1 && k * 1.06 < (f.ceiling ?? 1) - 0.02) { W.setResScale(k * 1.06); f.good = 0; }
      if (f.good >= 40) { f.ceiling = Math.min(1, (f.ceiling ?? 1) + 0.05); f.good = 0; }
    }
  }
}

const app = new App();
window.kerbstone = app;
app.start().catch((err) => {
  console.error(err);
  $('.loader-text').textContent = 'Something went wrong starting Kerbstone: ' + err.message;
});
