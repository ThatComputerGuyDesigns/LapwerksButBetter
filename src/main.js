// Kerbstone — app shell: screens, settings, track pipeline and the main loop.
import '@fontsource-variable/inter';
import '@fontsource-variable/saira';
import './ui/styles.css';
import * as THREE from 'three';
import { World, buildTerrain, buildVegetation, THEMES } from './world/environment.js';
import { buildTrackScene, runoffHeight, sampleHF } from './world/trackMesh.js';
import { buildGrass } from './world/grass.js';
import { buildMountains, buildNature, buildTrackside } from './world/scenery.js';
import { batchStatic } from './world/batch.js';
import { buildPlacedObjects } from './world/objects.js';
import { envOf, ENVIRONMENTS } from './track/environments.js';
import { buildTrack, buildHeightfield } from './track/track.js';
import { computeRacingLine, speedProfile } from './track/racingLine.js';
import { PRESETS, presetById } from './track/presets.js';
import { DEFAULT_SETUP, makeCarParams, setGripLevel, BODIES } from './physics/carSetup.js';
import { ASSIST_PRESETS } from './physics/vehicle.js';
import { DriveSession } from './game/drive.js';
import { ControlSession } from './game/controlSession.js';
import { RaceControlUI } from './ui/raceControlUI.js';
import { Career, findEvent, eventTrackDef } from './game/career.js';
import { CareerUI, money, stars } from './ui/careerUI.js';
import { Input } from './game/input.js';
import { store, trackHash, encodeTrack, decodeTrack } from './game/store.js';
import { audio } from './audio/audio.js';
import { HUD } from './ui/hud.js';
import { TrackEditor, drawThumb } from './ui/editor.js';
import { Garage } from './ui/garage.js';
import { formatTime, clamp } from './core/math.js';
import { carShot } from './ui/renders.js';
import { CoachUI } from './ui/coachUI.js';
import { generateWorld } from './open/worldgen.js';
import { buildOpenWorld } from './open/worldMesh.js';
import { OpenSession } from './open/openSession.js';
import { OpenHUD } from './open/openHud.js';
import { dailyChallenge, dayKey, endlessRound, newEndless, newChampionship, recordRound, standings as champStandings, SERIES, POINTS } from './game/challenges.js';
import { randomTrack } from './track/generator.js';

const VERSION = '0.7.0';
const $ = (s) => document.querySelector(s);

const DEFAULT_SETTINGS = {
  assists: 'casual', grip: 'arcade', rc: { cars: 10, laps: 6, cls: 'gt', drama: 0.6 }, race: { mode: 'race', laps: 3, rivals: 5, difficulty: 'medium' }, gearbox: 'auto', units: 'kmh', quality: 'auto', volume: 0.8, showLine: true, ghost: true, camera: 'chase',
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
    this.rcui = new RaceControlUI(this, $('#rc'));
    this.career = new Career(store);
    this.careerUI = new CareerUI(this, $('#career'));
    this.coach = new CoachUI(this, $('#coach'));
    this.openHud = new OpenHUD($('#openhud'));
    this.screen = 'loading';
    this.session = null;
    this.lastT = performance.now();
    this.fps = { acc: 0, n: 0, slow: 0, fast: 0 };
    audio.setVolume(this.settings.volume);
    // Auto starts at medium and only climbs if the machine has headroom
    this.world.setQuality(this.settings.quality === 'auto' ? 'medium' : this.settings.quality);
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
    // merge static trackside geometry (keep the road: the reveal animates it)
    batchStatic(this.trackGroup, (m) => m === this.trackGroup.userData.road);
    this.world.content.add(this.trackGroup);
    this.world.content.add(buildTerrain(T));
    this.world.content.add(buildVegetation(T, { density: this.world.quality === 'low' ? 0.5 : 1 }));
    const side = buildTrackside(T, line);
    batchStatic(side);
    this.world.content.add(buildMountains(T), buildNature(T), side);
    const objs = buildPlacedObjects(T);
    batchStatic(objs);
    this.world.content.add(objs);
    if (this.world.quality !== 'low' && envOf(T.env).tufts) {
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
  /** Short fade to black over screen changes (hides the swap of scenes). */
  veil() {
    const v = $('.fade-veil');
    if (!v) return;
    v.classList.add('on');
    clearTimeout(this.veilT);
    this.veilT = setTimeout(() => v.classList.remove('on'), 240);
  }

  hideAll() {
    this.veil();
    for (const id of ['home', 'coach', 'openhud', 'reveal', 'preview3d', 'hud', 'pause', 'settings', 'circuits', 'modes', 'results', 'rc', 'rcsetup', 'rcreport', 'career']) $('#' + id).hidden = true;
    setGripLevel(this.settings.grip); // race control runs on realistic grip; restore yours
    if (this.editor.active) this.editor.close();
    if (this.pv) this.closePreview3D();
    this.world.camera.up.set(0, 1, 0);
    if (this.garage.active) this.garage.close();
    this.input.captureKeys = false;
  }

  showHome() {
    this.keepSessionLaps();
    this.hideAll();
    this.challenge = null;
    this.restoreSetup();
    audio.setVolume(this.settings.volume);
    this.screen = 'home';
    $('#home').hidden = false;
    if (this.trackStale) {
      this.trackStale = false;
      this.world.fogDensity = null;
      this.loadTrack(this.trackDef).then(() => { if (this.screen === 'home') this.startAttract(); });
    } else this.startAttract();
    this.updateHomeCard();
    this.updateHomeTiles();
    setTimeout(() => $('#home .tile')?.focus({ preventScroll: true }), 50);
  }

  startAttract() {
    if (this.session) this.session.dispose();
    this.session = new DriveSession(this, { mode: 'attract' });
  }

  async startRace(keepChallenge = false) {
    this.lastCareer = false;
    this.careerEvent = null;
    if (!keepChallenge) { this.challenge = null; this.restoreSetup(); }
    this.hideAll();
    this.screen = 'race';
    if (this.session) this.session.dispose();
    setGripLevel(this.settings.grip);
    const R = this.settings.race || DEFAULT_SETTINGS.race;
    const ch = keepChallenge ? this.challenge : null;
    this.session = ch ? new DriveSession(this, { mode: 'race', race: ch.race, trial: ch.trial }) : new DriveSession(this, { mode: 'race', race: R.mode === 'race' ? { laps: R.laps, rivals: R.rivals, difficulty: R.difficulty } : null });
    if (ch?.intro) this.session.message(ch.intro, '', 5);
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

  /** Studio → orbitable 3D preview of the circuit (no cars). */
  async openStudio3D(def) {
    this.hideAll();
    $('#loader').hidden = false;
    $('#loader').classList.remove('fade');
    $('.loader-text').textContent = 'Building 3D preview…';
    await new Promise((r) => setTimeout(r, 30));
    if (this.session) { this.session.dispose(); this.session = null; }
    await this.loadTrack(def);
    $('#loader').classList.add('fade');
    setTimeout(() => ($('#loader').hidden = true), 400);
    const T = this.track;
    const b = T.bounds;
    this.pv = {
      def, mode: 'orbit', wire: false, s: 0, camIdx: 0, camT: 0,
      target: new THREE.Vector3((b.minX + b.maxX) / 2, T.meanY, (b.minZ + b.maxZ) / 2),
      yaw: 0.7, pitch: 0.75, dist: Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.9,
      pos: new THREE.Vector3(), look: new THREE.Vector3(),
    };
    this.screen = 'preview';
    $('#preview3d').hidden = false;
    $('.pv3-name').textContent = def.name || 'My Circuit';
    this.setPreviewMode('orbit');
  }

  setPreviewMode(m) {
    const pv = this.pv;
    if (m === 'tv' && !(pv.def.cams?.length)) { this.toast('Place TV cameras in the editor first (C tool)'); return; }
    if (m === 'wire') {
      pv.wire = !pv.wire;
      this.world.scene.overrideMaterial = pv.wire ? (this.wireMat ||= new THREE.MeshBasicMaterial({ color: 0x4aa8ff, wireframe: true })) : null;
      this.world.sky.visible = !pv.wire;
      this.world.scene.background = pv.wire ? new THREE.Color(0x070a0f) : null;
      $('#preview3d [data-pv=wire]').classList.toggle('on', pv.wire);
      return;
    }
    if (m === 'tv' && pv.mode === 'tv') pv.camIdx = (pv.camIdx + 1) % pv.def.cams.length;
    pv.mode = m;
    if (m === 'overhead') { pv.pitch = 1.53; pv.yaw = 0; }
    if (m === 'orbit' && pv.pitch > 1.4) pv.pitch = 0.75;
    document.querySelectorAll('#preview3d .seg [data-pv]').forEach((b) => b.classList.toggle('on', b.dataset.pv === m));
  }

  closePreview3D() {
    if (!this.pv) return;
    this.world.scene.overrideMaterial = null;
    this.world.sky.visible = true;
    this.world.scene.background = null;
    $('#preview3d').hidden = true;
    this.pv = null;
  }

  updatePreview3D(dt) {
    const pv = this.pv, T = this.track, cam = this.world.camera;
    const N = T.N;
    let pos, look;
    if (pv.mode === 'flyover') {
      pv.s = (pv.s + dt * 42) % T.length;
      const i = Math.floor(pv.s / T.DS) % N;
      const j = (i + 30) % N, k = (i - 12 + N) % N;
      const L = this.line;
      pos = new THREE.Vector3(L.x[k], T.py[k] + 9, L.z[k]);
      look = new THREE.Vector3(L.x[j], T.py[j] + 1.5, L.z[j]);
    } else if (pv.mode === 'tv') {
      const c = pv.def.cams[pv.camIdx % pv.def.cams.length];
      let bi = 0, bd = Infinity;
      for (let i = 0; i < N; i += 2) { const d = (T.px[i] - c.x) ** 2 + (T.pz[i] - c.z) ** 2; if (d < bd) { bd = d; bi = i; } }
      pv.camT += dt;
      const sweep = Math.round(Math.sin(pv.camT * 0.35) * 40);
      const q = (bi + sweep + N) % N;
      pos = new THREE.Vector3(c.x, T.py[bi] + 8, c.z);
      look = new THREE.Vector3(T.px[q], T.py[q] + 1, T.pz[q]);
    } else {
      const p = pv.pitch, d = pv.dist;
      pos = new THREE.Vector3(pv.target.x + Math.sin(pv.yaw) * Math.cos(p) * d, pv.target.y + Math.sin(p) * d, pv.target.z + Math.cos(pv.yaw) * Math.cos(p) * d);
      look = pv.target.clone();
      if (pv.mode === 'orbit' && !pv.dragging) pv.yaw += dt * 0.04;
    }
    const k = 1 - Math.exp(-dt * (pv.mode === 'flyover' ? 6 : 10));
    if (!pv.init) { pv.pos.copy(pos); pv.look.copy(look); pv.init = true; }
    pv.pos.lerp(pos, k); pv.look.lerp(look, k);
    cam.position.copy(pv.pos);
    if (pv.mode === 'overhead') cam.up.set(0, 0, -1); else cam.up.set(0, 1, 0);
    cam.lookAt(pv.look);
    cam.fov = pv.mode === 'tv' ? 28 : 50;
    cam.far = 30000;
    cam.updateProjectionMatrix();
    this.world.followShadow(pv.look);
  }

  /** Open world: generate the island once, build it, drive. */
  async startOpenWorld() {
    this.hideAll();
    $('#loader').hidden = false;
    $('#loader').classList.remove('fade');
    $('.loader-text').textContent = 'Heading to the festival…';
    this.tip();
    await new Promise((r) => setTimeout(r, 40));
    if (this.session) { this.session.dispose(); this.session = null; }
    this.restoreSetup();
    this.world.clearContent();
    this.trackStale = true;
    this.openW ||= generateWorld(7);
    this.world.fogDensity = 0.00009;
    this.world.setTheme(this.settings.openTheme || 'midday');
    await new Promise((r) => setTimeout(r, 0));
    this.openView = buildOpenWorld(this.openW);
    this.world.content.add(this.openView.group);
    if (this.openHud.W !== this.openW) this.openHud.setWorld(this.openW);
    setGripLevel(this.settings.grip);
    this.session = new OpenSession(this, this.openW, this.openView);
    this.screen = 'open';
    $('#openhud').hidden = false;
    $('#loader').classList.add('fade');
    setTimeout(() => ($('#loader').hidden = true), 500);
    this.input.captureKeys = true;
    this.session.message('WELCOME TO THE FESTIVAL', 'go', 2.5);
    await audio.unlock();
  }

  handleOpenKeys() {
    const I = this.input, s = this.session;
    if (I.pressed('GP_START')) this.togglePause();
    if (s.paused) return;
    if (I.pressed('KeyC') || I.pressed('GP_Y')) s.cycleCamera();
    if (I.pressed('KeyR') || I.pressed('GP_BACK')) { s.placeOnRoad(s.car.x, s.car.z); s.message('RESET', '', 0.8); }
    if (I.pressed('KeyF')) this.toggleFps();
  }

  /** Keep the laps of the session that is ending, for Coach. */
  keepSessionLaps() {
    const s = this.session;
    if (s?.mode === 'race' && s.laps?.length) { this.lastSessionLaps = s.laps; this.lastSessionTrack = this.trackDef?.name; }
  }

  openCoach(source) {
    this.keepSessionLaps();
    this.hideAll();
    if (this.session) { this.session.dispose(); this.session = null; }
    this.screen = 'coach';
    this.coach.open(source || (this.lastSessionLaps?.length ? 'session' : 'saved'));
  }

  /** A valid lap finished: keep the best one per circuit for Coach. */
  coachLap(trackKey, lap) {
    const all = store.get('coachBest', {});
    const cur = all[trackKey];
    if (cur && cur.lap.time <= lap.time) return;
    all[trackKey] = { track: this.trackDef?.name || 'Circuit', car: lap.body, lap: { time: lap.time, valid: true, n: 1, tele: lap.tele, sectors: lap.sectors } };
    const keys = Object.keys(all);
    if (keys.length > 20) delete all[keys[0]];
    store.set('coachBest', all);
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
    if (id === 'rcsetup') this.renderRcSetup();
  }

  closeOverlay(id) {
    $('#' + id).hidden = true;
  }

  togglePause(force) {
    if ((this.screen !== 'race' && this.screen !== 'open') || !this.session) return;
    const p = force ?? !this.session.paused;
    $('#pause [data-p=edit]').hidden = this.screen === 'open';
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
    this.tip();
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

  tip() {
    const TIPS = [
      'Hold Backspace to rewind a mistake. It costs you that lap\'s time.',
      'Tuck in behind a rival on a straight. The slipstream cuts your drag by up to 40%.',
      'Full brake and full steer still turns the car. The ABS saves grip for steering.',
      'Race Control: press R to review the next case, then 1–6 to rule.',
      'A car stopped on the racing line needs a VSC or the Safety Car, not just a yellow.',
      'Settings → Grip changes the whole feel: Arcade, Sport or Realistic.',
      'Career stars unlock the next championship. Time trials pay out on gold.',
      'Press C for cameras, F for the FPS meter, L to toggle the driving line.',
    ];
    const el = $('.loader-tip');
    if (el) el.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
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

  updateHomeTiles() {
    const c = this.career;
    $('.hp-lv').textContent = c.level;
    $('.hp-cr').textContent = money(c.credits);
    $('.hp-st').textContent = c.totalStars;
    $('.hp-xp i').style.width = `${Math.round(c.levelProgress * 100)}%`;
    if (this.homeTilesDone) return;
    this.homeTilesDone = true;
    // hero renders of the game's own cars; deferred so the menu appears instantly
    const shots = [
      ['.t-open .t-img', { body: 'rally', paint: '#0f8a8c', accent: '#f2f2f2', livery: 'band', number: 21, finish: 'metallic' }, { yaw: -0.8, dist: 8.2 }],
      ['.t-career .t-img', { body: 'formula', paint: '#ff5a1f', accent: '#111418', livery: 'band', number: 1, finish: 'metallic' }, { yaw: 0.85, dist: 9 }],
      ['.t-race .t-img', { ...this.setup }, { yaw: 0.7, dist: 8.2 }],
      ['.t-control .t-img', { body: 'gt3', paint: '#e8d21d', accent: '#111418', livery: 'stripes', number: 33 }, { yaw: -0.75, dist: 8.2 }],
    ];
    let i = 0;
    const next = () => {
      if (i >= shots.length) return;
      const [sel, setup, o] = shots[i++];
      try { $(sel).src = carShot(setup, { w: 560, h: 315, ...o }); } catch (e) { console.warn(e); }
      setTimeout(next, 30);
    };
    setTimeout(next, 200);
    // studio tile: a hand-drawn circuit sketch
    const cv = $('.t-studio .t-art');
    const g = cv.getContext('2d');
    const pts = (presetById('harbor') || PRESETS[0]).points;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const sc = Math.min(260 / (x1 - x0), 140 / (y1 - y0));
    const ox = 240 - (x1 - x0) * sc / 2, oy = 28;
    const P = pts.map(([x, y]) => [ox + (x - x0) * sc, oy + (y - y0) * sc]);
    g.strokeStyle = 'rgba(74,168,255,0.12)'; g.lineWidth = 1;
    for (let x = 0; x < 480; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 300); g.stroke(); }
    for (let y = 0; y < 300; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(480, y); g.stroke(); }
    g.lineJoin = g.lineCap = 'round';
    for (const [w, col] of [[14, 'rgba(0,0,0,0.35)'], [9, '#e8eef6'], [3, '#4aa8ff']]) {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      const n = P.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const m0 = mid(P[n - 1], P[0]); g.moveTo(m0[0], m0[1]);
      for (let k = 0; k < n; k++) { const m = mid(P[k], P[(k + 1) % n]); g.quadraticCurveTo(P[k][0], P[k][1], m[0], m[1]); }
      g.stroke();
    }
    const [sx, sy] = P[0];
    g.fillStyle = '#ff5a1f'; g.beginPath(); g.arc(sx, sy, 7, 0, Math.PI * 2); g.fill();
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
      <div class="field"><span>Graphics</span>${seg('quality', [['auto', 'Auto'], ['ultra', 'Ultra'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}
        <div class="desc">Auto keeps the frame rate smooth. Ultra adds ambient occlusion and full resolution (fast GPUs).</div></div>
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
    const D = dailyChallenge();
    const dailyBest = store.get('daily', {})[D.key];
    const endless = store.get('endless', null);
    const endlessBest = store.get('endlessBest', 0);
    const ch = store.get('champ', null);
    const cards = [
      ['race', 'Race', 'Grid start against AI rivals.'],
      ['trial', 'Time trial', 'You, the clock and your ghost.'],
      ['daily', 'Daily Challenge', dailyBest != null ? `Today: ${formatTime(dailyBest)}` : 'New track and car every day.'],
      ['endless', 'Endless', endlessBest ? `Best run: ${endlessBest} rounds` : 'Random circuits. Three lives.'],
      ['champ', 'Championship', ch && !ch.done ? `Round ${ch.round + 1} of ${ch.rounds.length}` : 'Full season, points, standings.'],
    ];
    let panel = '';
    const foot = (label, attr) => `<div class="mode-foot"><span class="mode-track">${label}</span><button class="btn primary big" ${attr}><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>Start</button></div>`;
    if (R.mode === 'race' || R.mode === 'trial') {
      panel = `<div class="race-opts" ${R.mode === 'race' ? '' : 'hidden'}>
        <div class="field"><span>Laps</span>${seg('laps', [[2, '2'], [3, '3'], [5, '5'], [10, '10']])}</div>
        <div class="field"><span>Rivals</span>${seg('rivals', [[3, '3'], [5, '5'], [7, '7']])}</div>
        <div class="field"><span>Rival skill</span>${seg('difficulty', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']])}</div>
      </div>${foot(`${this.trackDef.name} · ${(this.track.length / 1000).toFixed(2)} km · ${BODIES[this.setup.body]?.name}`, 'data-start')}`;
    } else if (R.mode === 'daily') {
      panel = `<div class="ch-intro"><canvas class="ch-thumb" width="220" height="140"></canvas><div>
        <span class="eyebrow">${D.key}</span><h3>${D.def.name}</h3>
        <p>Everyone gets the same circuit, car and conditions today. Three laps, best lap counts. Gold, silver and bronze targets.</p>
        <div class="ch-facts"><span><b>${BODIES[D.body].name}</b>Car</span><span><b>${(ENVIRONMENTS[D.def.env] || ENVIRONMENTS.gp).name}</b>Venue</span><span><b>${dailyBest != null ? formatTime(dailyBest) : '—'}</b>Your best</span></div>
      </div></div>${foot('New challenge every day at midnight', 'data-daily')}`;
    } else if (R.mode === 'endless') {
      const live = endless && endless.lives > 0 && endless.round > 0;
      panel = `<div class="ch-intro"><div>
        <h3>Endless</h3>
        <p>A fresh random circuit every round. Finish high enough to survive — the target gets tougher and the rivals faster. Miss it and you lose a life. Three lives.</p>
        <div class="ch-facts"><span><b>${endlessBest}</b>Best run</span>${live ? `<span><b>${endless.round}</b>Current round</span><span><b>${'♥'.repeat(endless.lives)}</b>Lives</span>` : ''}</div>
      </div></div>
      <div class="mode-foot"><span class="mode-track">${live ? 'Run in progress' : 'Uses your garage car'}</span>${live ? '<button class="btn" data-endless-new>New run</button>' : ''}<button class="btn primary big" data-endless><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>${live ? 'Continue' : 'Start run'}</button></div>`;
    } else if (R.mode === 'champ') {
      if (ch && !ch.done) {
        const tbl = champStandings(ch);
        const next = ch.rounds[ch.round].def;
        panel = `<div class="ch-intro"><div style="flex:1">
          <span class="eyebrow">${ch.name} · ${BODIES[ch.body]?.name}</span><h3>Round ${ch.round + 1} of ${ch.rounds.length}: ${next.name}</h3>
          <div class="ch-rounds">${ch.rounds.map((r, k) => `<span class="${k < ch.round ? 'done' : k === ch.round ? 'next' : ''}">${k + 1}${r.result ? ` · P${r.result.order.indexOf('You') + 1}` : ''}</span>`).join('')}</div>
          <div class="ch-table">${tbl.map((r, k) => `<div class="${r.isPlayer ? 'me' : ''}"><b>${k + 1}</b><i style="background:${r.paint || 'var(--accent)'}"></i><span>${r.name}</span><small>${r.wins ? `${r.wins} win${r.wins > 1 ? 's' : ''}` : ''}</small><em>${r.pts}</em></div>`).join('')}</div>
        </div></div>
        <div class="mode-foot"><button class="btn ghost" data-champ-quit>Abandon season</button><button class="btn primary big" data-champ-go><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>Race round ${ch.round + 1}</button></div>`;
      } else {
        const cs = (this.champSetup ||= { series: 'gt', rounds: 5, source: 'mixed' });
        const sg = (key, opts) => `<div class="seg small" data-cs="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(cs[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
        const last = ch?.done ? champStandings(ch) : null;
        panel = `${last ? `<div class="ch-box"><span class="ch-k">Last season · ${ch.name}</span><b>${last[0].isPlayer ? 'You were champion' : `Champion: ${last[0].name} · you P${last.findIndex((r) => r.isPlayer) + 1}`}</b></div>` : ''}
          <div class="race-opts">
            <div class="field"><span>Series</span>${sg('series', Object.entries(SERIES).map(([k, v]) => [k, v.name.replace(/ (Trophy|Cup|Series|World Championship|Endurance)$/, '')]))}</div>
            <div class="field"><span>Rounds</span>${sg('rounds', [[3, '3'], [5, '5'], [8, '8']])}</div>
            <div class="field"><span>Circuits</span>${sg('source', [['mixed', 'Featured + new'], ['mine', 'My circuits']])}</div>
          </div>
          <p class="ch-note">Nine AI rivals, the same grid all season. Points: ${POINTS.join('-')} plus 1 for fastest lap.</p>
          ${foot(SERIES[cs.series].name, 'data-champ-new')}`;
      }
    }
    $('.modes-body').innerHTML = `<div class="mode-cards five">${cards.map(([k, n, d]) => `<button class="mode-card ${R.mode === k ? 'on' : ''}" data-mode="${k}"><b>${n}</b><small>${d}</small></button>`).join('')}</div>${panel}`;
    const body = $('.modes-body');
    const thumb = body.querySelector('.ch-thumb');
    if (thumb) drawThumb(thumb, D.def.points, '#ff7a3d');
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
    body.querySelectorAll('[data-cs]').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      audio.click();
      const k = sg.dataset.cs;
      this.champSetup[k] = k === 'rounds' ? parseInt(b.dataset.v) : b.dataset.v;
      if (k === 'source' && b.dataset.v === 'mine' && !store.tracks().length) { this.toast('Save a circuit in Track Studio first'); this.champSetup.source = 'mixed'; }
      this.renderModes();
    }));
    const on = (sel, fn) => body.querySelector(sel)?.addEventListener('click', () => { audio.click(); fn(); });
    on('[data-start]', () => this.startRace());
    on('[data-daily]', () => this.startDaily());
    on('[data-endless]', () => this.startEndless(false));
    on('[data-endless-new]', () => this.startEndless(true));
    on('[data-champ-go]', () => this.startChampRound());
    on('[data-champ-quit]', () => { store.set('champ', null); this.renderModes(); });
    on('[data-champ-new]', () => { const c = this.champSetup; this.newChampionship(c.series, c.rounds, c.source); this.startChampRound(); });
  }

  // ------------------------------------------------------------ career
  openCareer() {
    this.hideAll();
    this.screen = 'careerhub';
    this.careerEvent = null;
    if (!this.session || this.session.mode !== 'attract') this.startAttract();
    this.careerUI.open();
  }

  async startCareerEvent(eventId, body) {
    const { tier, event } = findEvent(eventId);
    const def = eventTrackDef(event, PRESETS);
    this.careerUI.close();
    $('#loader').hidden = false; $('#loader').classList.remove('fade');
    $('.loader-text').textContent = `${tier.name} · ${event.name}`;
    this.tip();
    await new Promise((r) => setTimeout(r, 30));
    this.setup = { ...this.setup, body, compound: BODIES[body].compound, drivetrain: null };
    this.saveSetup();
    await this.loadTrack(def);
    $('#loader').classList.add('fade');
    setTimeout(() => ($('#loader').hidden = true), 500);
    this.careerEvent = { eventId, tier, event };
    this.lastCareer = true;
    const race = event.type === 'trial' ? null : {
      laps: event.laps, rivals: event.type === 'duel' ? 1 : event.rivals, difficulty: tier.difficulty,
      rivalBodies: tier.cls, playerSlot: event.type === 'overtake' ? 'last' : 'mid', duel: event.type === 'duel',
    };
    const ideal = this.line.profile.lapTime;
    const trial = event.type === 'trial' ? { laps: event.laps, targets: [ideal * 1.07, ideal * 1.12, ideal * 1.18] } : null;
    this.hideAll();
    this.screen = 'race';
    if (this.session) this.session.dispose();
    setGripLevel(this.settings.grip);
    this.session = new DriveSession(this, { mode: 'race', race, trial });
    if (trial) this.session.message(`Targets  ★ ${formatTime(trial.targets[2])}  ★★ ${formatTime(trial.targets[1])}  ★★★ ${formatTime(trial.targets[0])}`, '', 5);
    $('#hud').hidden = false;
    this.hud.setTouch(this.isTouch());
    this.input.captureKeys = true;
    await audio.unlock();
  }

  // ------------------------------------------------------------ challenges
  useBody(body) {
    if (!this.setupBackup) this.setupBackup = { ...this.setup };
    this.setup = { ...this.setup, body, compound: BODIES[body]?.compound || this.setup.compound, drivetrain: null };
  }
  restoreSetup() { if (this.setupBackup) { this.setup = this.setupBackup; this.setupBackup = null; } }

  async runChallenge(def, label) {
    this.closeOverlay('modes');
    $('#loader').hidden = false; $('#loader').classList.remove('fade');
    $('.loader-text').textContent = label;
    this.tip();
    await new Promise((r) => setTimeout(r, 30));
    await this.loadTrack(def);
    $('#loader').classList.add('fade');
    setTimeout(() => ($('#loader').hidden = true), 500);
    await this.startRace(true);
  }

  async startDaily() {
    const D = dailyChallenge();
    this.useBody(D.body);
    const ideal = speedProfile(buildTrack(D.def), computeRacingLine(buildTrack(D.def)), makeCarParams(this.setup)).lapTime;
    const targets = [ideal * 1.06, ideal * 1.11, ideal * 1.17];
    this.challenge = { kind: 'daily', key: D.key, trial: { laps: D.laps, targets }, intro: `Daily Challenge · ${BODIES[D.body].name} · beat ${formatTime(targets[0])} for gold` };
    await this.runChallenge(D.def, `Daily Challenge · ${D.key}`);
  }

  async startEndless(fresh) {
    let st = store.get('endless', null);
    if (fresh || !st || st.lives <= 0) st = newEndless();
    store.set('endless', st);
    const r = endlessRound(st);
    this.restoreSetup();
    this.challenge = { kind: 'endless', state: st, need: r.need, race: { laps: r.laps, rivals: r.rivals, difficulty: r.difficulty }, intro: `Round ${st.round + 1} · finish P${r.need} or better · ${'♥'.repeat(st.lives)}` };
    await this.runChallenge(r.def, `Endless · Round ${st.round + 1}`);
  }

  newChampionship(series, rounds, source) {
    let tracks;
    const mine = store.tracks();
    if (source === 'mine' && mine.length) tracks = Array.from({ length: rounds }, (_, k) => mine[k % mine.length]);
    else {
      const pool = [...PRESETS];
      const seed = Math.floor(Math.random() * 1e5);
      tracks = Array.from({ length: rounds }, (_, k) => (k < pool.length && k % 2 === 0 ? pool[(k / 2 + seed) % pool.length] : { ...randomTrack(seed + k * 31), id: `ch-${seed}-${k}` }));
    }
    const ch = newChampionship({ series, tracks, laps: rounds > 5 ? 3 : 4, rivals: 9, difficulty: this.settings.race?.difficulty || 'medium', playerBody: this.setup.body });
    store.set('champ', ch);
    return ch;
  }

  async startChampRound() {
    const ch = store.get('champ', null);
    if (!ch || ch.done) return;
    this.useBody(ch.body);
    const rd = ch.rounds[ch.round];
    this.challenge = { kind: 'champ', race: { laps: ch.laps, rivals: ch.roster.length, difficulty: ch.difficulty, roster: ch.roster }, intro: `${ch.name} · Round ${ch.round + 1} of ${ch.rounds.length}` };
    await this.runChallenge(rd.def, `${ch.name} · Round ${ch.round + 1}`);
  }

  /** Results panel extras for a finished challenge; returns HTML. */
  challengeResults(session) {
    const c = this.challenge;
    if (!c) return '';
    if (c.kind === 'daily') {
      const best = session.raceBest;
      const all = store.get('daily', {});
      const prev = all[c.key];
      if (best != null && (prev == null || best < prev)) all[c.key] = best;
      store.set('daily', all);
      // streak: consecutive days with a valid lap
      let streak = 0;
      for (let d = new Date(); ; d.setDate(d.getDate() - 1)) { if (all[dayKey(d)] != null) streak++; else break; }
      const medal = best == null ? 'No valid lap' : best <= c.trial.targets[0] ? 'Gold' : best <= c.trial.targets[1] ? 'Silver' : best <= c.trial.targets[2] ? 'Bronze' : 'No medal';
      return `<div class="ch-box"><span class="ch-k">Daily Challenge · ${c.key}</span><b>${medal}</b><small>Today's best ${all[c.key] != null ? formatTime(all[c.key]) : '—'} · ${streak}-day streak · new track tomorrow</small></div>`;
    }
    if (c.kind === 'endless') {
      const st = c.state;
      const pos = session.field.standings().findIndex((r) => r.isPlayer) + 1;
      const ok = pos <= c.need;
      st.history.push(pos);
      if (ok) { st.round++; st.score++; } else st.lives--;
      const best = Math.max(store.get('endlessBest', 0), st.score);
      store.set('endlessBest', best);
      store.set('endless', st);
      c.over = st.lives <= 0;
      return `<div class="ch-box ${ok ? 'good' : 'bad'}"><span class="ch-k">Endless · ${'♥'.repeat(Math.max(0, st.lives))}${'♡'.repeat(3 - Math.max(0, st.lives))}</span><b>${c.over ? 'Run over' : ok ? 'Survived!' : 'Life lost'}</b><small>${c.over ? `You cleared ${st.score} round${st.score === 1 ? '' : 's'} · best ${best}` : `P${pos} (needed P${c.need}) · ${st.score} cleared · best ${best}`}</small></div>`;
    }
    if (c.kind === 'champ') {
      const ch = store.get('champ', null);
      const st = session.field.standings();
      const order = st.map((r) => r.name);
      let fastest = null, fb = Infinity;
      for (const r of st) if (r.best != null && r.best < fb) { fb = r.best; fastest = r.name; }
      const aw = recordRound(ch, order, fastest);
      store.set('champ', ch);
      c.done = ch.done;
      const tbl = champStandings(ch);
      const me = tbl.findIndex((r) => r.isPlayer) + 1;
      return `<div class="ch-box"><span class="ch-k">${ch.name} · after round ${ch.round} of ${ch.rounds.length}</span><b>${ch.done ? (me === 1 ? 'Champion!' : `Final position: P${me}`) : `+${aw.You || 0} points · P${me} overall`}</b>
        <div class="ch-table">${tbl.slice(0, 10).map((r, k) => `<div class="${r.isPlayer ? 'me' : ''}"><b>${k + 1}</b><i style="background:${r.paint || 'var(--accent)'}"></i><span>${r.name}</span><em>${r.pts}</em></div>`).join('')}</div></div>`;
    }
    return '';
  }

  /** Career result → rewards panel (appended to the results overlay). */
  careerRewards(result) {
    const ev = this.careerEvent;
    if (!ev) return '';
    const R = this.career.record(ev.eventId, result);
    this.careerEvent = null;
    return `<div class="cr-rewards"><span class="cr-big-stars">${stars(R.stars)}</span>
      <div><b>+${money(R.credits)}</b><small>credits</small></div><div><b>+${R.xp} XP</b><small>${R.levelUp ? `Level up! Lv ${R.levelUp}` : `Lv ${this.career.level}`}</small></div>
      ${R.unlocked.length ? `<p class="cr-unlock">Unlocked: ${R.unlocked.join(', ')}</p>` : ''}</div>`;
  }

  setResultButtons() {
    const c = this.challenge;
    $('[data-res=again]').textContent = this.lastCareer ? 'Back to career'
      : c?.kind === 'daily' ? 'Try again'
      : c?.kind === 'endless' ? (c.over ? 'New run' : 'Next round')
      : c?.kind === 'champ' ? (c.done ? 'Championships' : 'Next round')
      : 'Race again';
    $('[data-res=modes]').hidden = !!this.lastCareer || !!c;
  }

  onTrialFinish(session) {
    if (this.session !== session || this.screen !== 'race') return;
    const tc = session.trialCfg;
    const best = session.raceBest;
    $('.results-body').innerHTML = `<div class="res-head">${best != null ? `Best lap ${formatTime(best)}` : 'No valid lap'}</div>
      <div class="res-table">${['★★★ Gold', '★★ Silver', '★ Bronze'].map((n, k) => `<div class="${best != null && best <= tc.targets[k] ? 'me' : ''}"><b></b><i></i><span>${n}</span><em>${formatTime(tc.targets[k])}</em></div>`).join('')}</div>
      ${this.careerRewards({ bestLap: best, targets: tc.targets })}${this.challengeResults(session)}`;
    this.setResultButtons();
    $('#results').hidden = false;
    this.input.captureKeys = false;
  }

  // ------------------------------------------------------------ race control
  renderRcSetup() {
    const C = (this.settings.rc = { ...DEFAULT_SETTINGS.rc, ...(this.settings.rc || {}) });
    const seg = (key, opts) => `<div class="seg small" data-rcs="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(C[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const body = $('.rcsetup-body');
    body.innerHTML = `
      <div class="race-opts rc-opts">
        <div class="field"><span>Series</span>${seg('cls', [['hatch', 'Hot hatch'], ['club', 'Club sports'], ['gt', 'GT'], ['proto', 'Prototype'], ['formula', 'Grand Prix']])}</div>
        <div class="field"><span>Field</span>${seg('cars', [[8, '8 cars'], [10, '10 cars'], [12, '12 cars']])}</div>
        <div class="field"><span>Laps</span>${seg('laps', [[4, '4'], [6, '6'], [10, '10']])}</div>
        <div class="field"><span>Drama</span>${seg('drama', [[0.3, 'Clean'], [0.6, 'Normal'], [0.95, 'Chaos']])}</div>
      </div>
      <div class="mode-foot"><span class="mode-track">${this.trackDef.name} · ${(this.track.length / 1000).toFixed(2)} km</span><button class="btn primary big" data-rcstart><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>Take control</button></div>`;
    body.querySelectorAll('[data-rcs]').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      audio.click();
      const k = sg.dataset.rcs;
      C[k] = k === 'cls' ? b.dataset.v : parseFloat(b.dataset.v);
      this.saveSettings();
      this.renderRcSetup();
    }));
    body.querySelector('[data-rcstart]').addEventListener('click', () => { audio.click(); this.startControl(); });
  }

  async startControl() {
    this.hideAll();
    this.screen = 'control';
    if (this.session) this.session.dispose();
    setGripLevel('real');
    const C = this.settings.rc;
    const bodies = { hatch: ['hatch', 'jdm', 'rally'], club: ['gt', 'muscle', 'rs', 'jdm'], gt: ['gt3', 'hyper', 'rs'], proto: ['proto', 'hyper'], formula: ['formula'] }[C.cls] || ['gt3'];
    this.setup = { ...this.setup, body: bodies[0], compound: 'sport' };
    this.rcui.bc.reset();
    this.rcui.root.classList.remove('clean', 'reviewing');
    this.session = new ControlSession(this, { cars: C.cars, laps: C.laps, bodies, drama: C.drama });
    $('#rc').hidden = false;
    this.rcui.render(true);
    await audio.unlock();
    audio.setVolume(this.settings.volume * 0.6);
  }

  onControlFinish(session) {
    if (this.session !== session || this.screen !== 'control') return;
    const RC = session.rc, F = session.field;
    const rep = RC.report();
    const order = F.order();
    const decided = RC.incidents.filter((i) => i.status === 'decided' && i.expected);
    $('.rcreport-body').innerHTML = `
      <div class="rc-grade"><b>${rep.grade}</b><div><span>Overall ${rep.total}/100</span><span>Decisions ${rep.correct}/${rep.decisions} consistent</span><span>Safety ${Math.round(rep.safety)}%</span><span>${rep.open} case${rep.open === 1 ? '' : 's'} left unreviewed</span></div></div>
      <div class="res-table">${order.map((r, k) => `<div><b>${k + 1}</b><i style="background:${r.setup.paint}"></i><span>${r.name}</span><em>${r.dsq ? 'DSQ' : r.finished != null ? formatTime(r.finished + (r.penalty || 0)) : '—'}${r.penalty ? ` (+${r.penalty}s)` : ''}</em><small>best ${r.best != null ? formatTime(r.best) : '—'}</small></div>`).join('')}</div>
      ${decided.length ? `<h4 class="rc-h4">Your rulings</h4><div class="rc-rulings">${decided.map((i) => `<div><b>#${i.id} ${i.title}</b><span>${i.decision.toUpperCase()} → ${i.verdict}</span><em class="${i.points >= 50 ? 'good' : i.points < 0 ? 'bad' : ''}">${i.points > 0 ? '+' : ''}${i.points}</em></div>`).join('')}</div>` : ''}`;
    $('#rcreport').hidden = false;
  }

  onRaceFinish(session) {
    if (this.session !== session || this.screen !== 'race') return;
    const st = session.field.standings();
    const winner = st[0];
    $('.results-body').innerHTML = `
      <div class="res-head">${st.findIndex((r) => r.isPlayer) === 0 ? '<span class="trophy">🏆</span> Victory' : `You finished P${st.findIndex((r) => r.isPlayer) + 1}`}</div>
      <div class="res-table ${this.challenge?.kind === 'champ' ? 'compact' : ''}">${st.map((r, k) => `<div class="${r.isPlayer ? 'me' : ''}"><b>${k + 1}</b><i style="background:${r.paint}"></i><span>${r.name}</span><em>${r.finished != null ? formatTime(r.finished) : 'running'}</em><small>best ${r.best != null ? formatTime(r.best) : '—'}</small></div>`).join('')}</div>
      ${this.careerRewards({ position: st.findIndex((r) => r.isPlayer) + 1, gridPos: session.field.gridPos, bestLap: session.raceBest, overtakes: Math.max(0, session.field.gridPos - (st.findIndex((r) => r.isPlayer) + 1)) })}${this.challengeResults(session)}`;
    void winner;
    this.setResultButtons();
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
    } else if (kind === 'obj') {
      this.toast('Preparing 3D model…');
      if (trackHash(def) !== this.trackKey()) await this.loadTrack(def);
      const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
      const txt = new OBJExporter().parse(this.trackGroup);
      download(new Blob([txt], { type: 'text/plain' }), `${safe}.obj`);
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
      else if (go === 'control') this.openOverlay('rcsetup');
      else if (go === 'career') this.openCareer();
      else if (go === 'studio') this.openStudio(null);
      else if (go === 'garage') this.openGarage();
      else if (go === 'coach') this.openCoach();
      else if (go === 'open') this.startOpenWorld();
      else this.openOverlay(go);
    });
    $('#preview3d').addEventListener('click', (e) => {
      const a = e.target.closest('[data-pv]')?.dataset.pv;
      if (!a) return;
      audio.click();
      const def = this.pv?.def;
      if (a === 'edit') this.openStudio(def);
      else if (a === 'drive') { this.startRace(); }
      else this.setPreviewMode(a);
    });
    {
      const c = this.world.canvas;
      let d = null;
      c.addEventListener('contextmenu', (e) => { if (this.screen === 'preview') e.preventDefault(); });
      c.addEventListener('pointerdown', (e) => {
        if (this.screen !== 'preview' || !this.pv) return;
        if (this.pv.mode === 'flyover' || this.pv.mode === 'tv') this.setPreviewMode('orbit');
        d = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey || this.pv.mode === 'overhead', yaw: this.pv.yaw, pitch: this.pv.pitch, t: this.pv.target.clone() };
        this.pv.dragging = true;
      });
      window.addEventListener('pointermove', (e) => {
        if (!d || !this.pv) return;
        const pv = this.pv, dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (d.pan) {
          const k = pv.dist / 900;
          const fx = -Math.sin(pv.yaw), fz = -Math.cos(pv.yaw);
          pv.target.set(d.t.x - (dx * Math.cos(pv.yaw) - dy * fx) * k, d.t.y, d.t.z - (-dx * Math.sin(pv.yaw) - dy * fz) * k);
        } else {
          pv.yaw = d.yaw - dx * 0.005;
          pv.pitch = clamp(d.pitch + dy * 0.004, 0.06, 1.53);
        }
      });
      window.addEventListener('pointerup', () => { d = null; if (this.pv) this.pv.dragging = false; });
      c.addEventListener('wheel', (e) => { if (this.screen === 'preview' && this.pv) this.pv.dist = clamp(this.pv.dist * Math.exp(e.deltaY * 0.0012), 25, 6000); }, { passive: true });
    }
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
      else if (a === 'restart') { this.togglePause(false); if (this.screen === 'open') this.session.spawnAtFestival(); else this.startRace(); }
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
      if (a === 'coach') { this.openCoach('session'); return; }
      if (this.lastCareer && a !== 'menu') { this.openCareer(); return; }
      const c = this.challenge;
      if (c && a === 'again') {
        if (c.kind === 'daily') this.startDaily();
        else if (c.kind === 'endless') this.startEndless(c.over);
        else if (c.kind === 'champ') { if (c.done) { this.showHome(); this.settings.race.mode = 'champ'; this.openOverlay('modes'); } else this.startChampRound(); }
        return;
      }
      if (a === 'again') this.startRace();
      else if (a === 'modes') { this.showHome(); this.openOverlay('modes'); }
      else this.showHome();
    });
    $('#rcreport').addEventListener('click', (e) => {
      const a = e.target.closest('[data-rr]')?.dataset.rr;
      if (!a) return;
      audio.click();
      if (a === 'again') { this.showHome(); this.openOverlay('rcsetup'); } else this.showHome();
    });
    for (const id of ['settings', 'circuits', 'modes', 'rcsetup']) {
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
        if (!$('#rcsetup').hidden) return this.closeOverlay('rcsetup');
        if (this.screen === 'control') { if (this.session?.review) return this.rcui.closeReview(); return this.showHome(); }
        if (this.screen === 'race' || this.screen === 'open') return this.togglePause();
        if (this.screen === 'garage' || this.screen === 'reveal') return this.showHome();
        if (this.screen === 'preview') return this.openStudio(this.pv?.def);
      }
      const homeOpen = this.screen === 'home' && $('#settings').hidden && $('#circuits').hidden && $('#modes').hidden && $('#rcsetup').hidden;
      if (homeOpen && /^Arrow(Left|Right|Up|Down)$/.test(e.code)) {
        const items = [...document.querySelectorAll('#home .tile, #home .h-sub button')];
        let k = items.indexOf(document.activeElement);
        if (k < 0) k = 0;
        else if (e.code === 'ArrowRight') k = Math.min(items.length - 1, k + 1);
        else if (e.code === 'ArrowLeft') k = Math.max(0, k - 1);
        else if (e.code === 'ArrowDown') k = k < 4 ? 4 + Math.min(2, Math.floor(k * 0.75)) : k;
        else if (e.code === 'ArrowUp') k = k >= 4 ? Math.min(3, Math.round((k - 4) * 1.5)) : k;
        items[k].focus({ preventScroll: true });
        audio.click?.();
        e.preventDefault();
      }
      if (e.code === 'Enter' && homeOpen && !document.activeElement?.closest('#home')) {
        $('#home .tile')?.focus(); e.preventDefault();
      }
      if (e.code === 'Enter' && this.screen === 'home' && !$('#modes').hidden && !document.activeElement?.closest('#modes')) {
        $('#modes .mode-foot .btn.primary')?.click(); e.preventDefault();
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
    if (scr === 'studio' || scr === 'coach') return; // 2D screens draw themselves
    if (scr === 'garage') {
      this.garage.update(dt);
      this.world.renderPass.scene = this.garage.scene;
      this.world.renderPass.camera = this.garage.camera;
      const ao = this.world.gtao.enabled;
      this.world.gtao.enabled = false;
      const prevExp = this.world.renderer.toneMappingExposure;
      this.world.renderer.toneMappingExposure = 0.65;
      if (this.world.quality === 'low') this.world.renderer.render(this.garage.scene, this.garage.camera);
      else this.world.composer.render();
      this.world.renderer.toneMappingExposure = prevExp;
      this.world.renderPass.scene = this.world.scene;
      this.world.renderPass.camera = this.world.camera;
      this.world.gtao.enabled = ao;
      return;
    }
    if (scr === 'reveal') this.updateReveal(dt);
    else if (scr === 'preview' && this.pv) this.updatePreview3D(dt);
    else if (scr === 'open' && this.session) {
      this.handleOpenKeys();
      const cmd = this.input.sample(dt, this.session.car.speed);
      this.session.update(dt, cmd);
      this.input.rumble(this.session.car);
      this.openHud.update(this.session);
    }
    else if (this.session) {
      let cmd = null;
      if (scr === 'race') {
        this.handleRaceKeys();
        cmd = this.input.sample(dt, this.session.car.speed);
        if (this.input.source === 'touch' && !$('#hud').classList.contains('touch')) this.hud.setTouch(true);
      }
      this.session.update(dt, cmd);
      if (scr === 'race') this.input.rumble(this.session.car);
      if (scr === 'control') this.rcui.render();
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
      else if (W.quality !== 'low') { if (W.quality === 'high') f.noHigh = true; W.setQuality(W.quality === 'high' ? 'medium' : 'low'); W.setResScale(0.85); }
      f.good = 0;
    } else if (avg < 1 / 57) {
      f.good = (f.good || 0) + 1;
      // creep back up slowly, staying just below the scale that stuttered
      if (f.good >= 6 && k < 1 && k * 1.06 < (f.ceiling ?? 1) - 0.02) { W.setResScale(k * 1.06); f.good = 0; }
      if (f.good >= 40) { f.ceiling = Math.min(1, (f.ceiling ?? 1) + 0.05); f.good = 0; }
      // plenty of headroom at full resolution → step up to High once
      if (k >= 0.99 && W.quality === 'medium' && !f.noHigh && (f.goodTotal = (f.goodTotal || 0) + 1) > 24) W.setQuality('high');
    }
  }
}

const app = new App();
window.kerbstone = app;
window.kerbstoneDebug = { carShot };
app.start().catch((err) => {
  console.error(err);
  $('.loader-text').textContent = 'Something went wrong starting Kerbstone: ' + err.message;
});
