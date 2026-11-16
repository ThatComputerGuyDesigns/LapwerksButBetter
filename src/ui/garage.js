// Garage: studio turntable, body selection, paint & livery, and a tuning
// sheet whose performance numbers come from running the real physics model.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BODIES, COMPOUNDS, PAINTS, DEFAULT_SETUP, makeCarParams } from '../physics/carSetup.js';
import { Vehicle, ASSIST_PRESETS } from '../physics/vehicle.js';
import { createCar, disposeCar } from '../car/carModel.js';
import { clamp } from '../core/math.js';
import { audio } from '../audio/audio.js';

/** Flat, endless test strip so the vehicle model can be run anywhere. */
export function flatTrack() {
  const q = { i: 0, s: 0, d: 0, e: 0, height: 0, surface: 0, bank: 0, grade: 0, normal: [0, 1, 0], wallDist: 1e9, wallLeft: false, wallRight: false, runoff: 1e9, tangent: [0, 1], nrm: [1, 0], kerb: false };
  return {
    N: 1, DS: 2, length: 1e9, half: 1e6, width: 2e6,
    px: [0], pz: [0], tx: [0], tz: [1], nx: [1], nz: [0], gravelL: [0], gravelR: [0], kerb: [0], runL: [1e9], runR: [1e9],
    query: () => q,
  };
}

/** Straight-line + steady-state numbers from the real model. */
export function performanceStats(setup) {
  const p = makeCarParams(setup);
  const car = new Vehicle(p, flatTrack());
  car.assists = { ...ASSIST_PRESETS.casual, autoShift: true };
  car.reset(0, 0);
  for (const w of car.wheels) w.temp = p.tire.optTemp;
  const dt = 1 / 240; // same rate as the game (stiff arcade tyres need it)
  let t = 0, t100 = null, vmax = 0, this_last = null;
  while (t < 60) {
    car.step(dt, { throttle: 1, brake: 0, steer: 0 });
    for (const w of car.wheels) w.temp = p.tire.optTemp;
    t += dt;
    if (t100 == null && car.u >= 27.78) t100 = t;
    vmax = Math.max(vmax, car.u);
    // stop once speed gain over the last second is negligible
    if (Math.abs(t % 1) < dt) { if (t > 15 && car.u - (this_last ?? 0) < 0.05) break; this_last = car.u; }
  }
  // lateral capacity at 120 km/h including downforce
  const v = 33.3;
  const down = 0.5 * 1.225 * p.aero.clA * v * v;
  const latG = p.tire.mu * 0.95 * (1 + down / (p.mass * 9.81));
  return { t100, vmax: vmax * 3.6, latG, powerKW: p.engine.powerKW, mass: p.mass, pwr: (p.engine.powerKW * 1.341) / (p.mass / 1000) };
}

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export class Garage {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.tab = 'car';
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.buildStudio();
    this.buildUI();
    this.yaw = -0.7;
    this.drag = null;
  }

  buildStudio() {
    const s = this.scene;
    s.background = new THREE.Color(0x0d1015);
    const pm = new THREE.PMREMGenerator(this.app.world.renderer);
    s.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture;
    s.environmentIntensity = 0.8;
    s.fog = new THREE.Fog(0x0d1015, 14, 34);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.35, metalness: 0.2 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.7, 0.08, 96), new THREE.MeshStandardMaterial({ color: 0x1d2128, roughness: 0.25, metalness: 0.6 }));
    disc.position.y = 0.04;
    disc.receiveShadow = true;
    s.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.68, 0.025, 8, 160), new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 2.2 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    s.add(ring);
    this.turntable = new THREE.Group();
    this.turntable.position.y = 0.08;
    s.add(this.turntable);
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(5, 9, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -5; sc.right = 5; sc.top = 5; sc.bottom = -5;
    key.shadow.bias = -0.0003;
    s.add(key);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 1.4);
    rim.position.set(-6, 4, -6);
    s.add(rim);
    const warm = new THREE.PointLight(0xff7a3d, 3, 9, 2);
    warm.position.set(-3, 1.2, 4);
    s.add(warm);
    // soft overhead light panels (emissive) for nice reflections in the paint
    for (const z of [-1.6, 0, 1.6]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.35), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      panel.position.set(0, 6, z);
      panel.rotation.x = Math.PI / 2;
      s.add(panel);
    }
  }

  buildUI() {
    const r = this.root;
    r.classList.add('garage');
    r.innerHTML = `
      <div class="garage-top">
        <button class="icon-btn back" title="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div><span class="eyebrow">Garage</span><h2 class="g-name"></h2><p class="g-blurb"></p></div>
      </div>
      <div class="garage-panel glass">
        <div class="tabs">
          <button data-tab="car" class="on">Car</button><button data-tab="paint">Paint</button><button data-tab="tune">Tune</button>
        </div>
        <div class="tab-body"></div>
        <div class="stats"></div>
        <button class="btn primary big g-drive"><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>Drive</button>
      </div>
      <div class="garage-hint">Drag to rotate</div>`;
    r.querySelector('.back').addEventListener('click', () => { audio.click(); this.app.showHome(); });
    r.querySelector('.g-drive').addEventListener('click', () => { audio.click(); this.app.startRace(); });
    r.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      audio.click();
      this.tab = b.dataset.tab;
      r.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      this.renderTab();
    });
    const c = this.app.world.canvas;
    this.onDown = (e) => { if (this.active && e.target === c) this.drag = { x: e.clientX, yaw: this.yaw }; };
    this.onMove = (e) => { if (this.drag) this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.008; };
    this.onUp = () => (this.drag = null);
    window.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  open() {
    this.active = true;
    this.root.hidden = false;
    this.refreshCar();
    this.renderTab();
    this.renderStats();
  }

  close() { this.active = false; this.root.hidden = true; }

  get setup() { return this.app.setup; }

  change(patch, rebuild = true) {
    Object.assign(this.app.setup, patch);
    this.app.saveSetup();
    if (rebuild) this.refreshCar();
    clearTimeout(this.statT);
    this.statT = setTimeout(() => this.renderStats(), 80);
  }

  refreshCar() {
    if (this.carMesh) { this.turntable.remove(this.carMesh); disposeCar(this.carMesh); }
    this.carMesh = createCar(this.setup);
    this.turntable.add(this.carMesh);
    const B = BODIES[this.setup.body];
    this.root.querySelector('.g-name').textContent = B.name;
    this.root.querySelector('.g-blurb').textContent = B.blurb;
  }

  renderTab() {
    const body = this.root.querySelector('.tab-body');
    const s = this.setup;
    if (this.tab === 'car') {
      body.innerHTML = `<div class="body-cards">${Object.values(BODIES).map((b) => `
        <button class="body-card ${s.body === b.id ? 'on' : ''}" data-body="${b.id}">
          <em>${b.cls}</em><b>${b.name}</b><span>${b.drivetrain} · ${Math.round(b.powerKW * 1.341)} hp · ${b.mass} kg</span><small>${b.blurb}</small>
        </button>`).join('')}</div>
        <div class="field"><span>Tyres</span><div class="seg small">${Object.values(COMPOUNDS).map((c) => `<button data-compound="${c.id}" class="${s.compound === c.id ? 'on' : ''}">${c.name}</button>`).join('')}</div></div>
        <div class="field"><span>Drivetrain</span><div class="seg small">${['RWD', 'AWD', 'FWD'].map((d) => `<button data-drive="${d}" class="${(s.drivetrain || BODIES[s.body].drivetrain) === d ? 'on' : ''}">${d}</button>`).join('')}</div></div>`;
      body.querySelectorAll('[data-body]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ body: b.dataset.body, drivetrain: null, compound: BODIES[b.dataset.body].compound }); this.renderTab(); }));
      body.querySelectorAll('[data-compound]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ compound: b.dataset.compound }, false); this.renderTab(); }));
      body.querySelectorAll('[data-drive]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ drivetrain: b.dataset.drive === BODIES[s.body].drivetrain ? null : b.dataset.drive }, false); this.renderTab(); }));
    } else if (this.tab === 'paint') {
      body.innerHTML = `
        <div class="field"><span>Paint</span><div class="swatches">${PAINTS.map((p) => `<button class="sw ${s.paint === p.color ? 'on' : ''}" style="--c:${p.color}" data-paint="${p.color}" title="${p.name}"></button>`).join('')}
          <label class="sw custom" title="Custom colour"><input type="color" value="${s.paint}" data-custom="paint"></label></div></div>
        <div class="field"><span>Finish</span><div class="seg small">${['gloss', 'metallic', 'pearl', 'matte'].map((f) => `<button data-finish="${f}" class="${s.finish === f ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div></div>
        <div class="field"><span>Livery</span><div class="seg small">${[['none', 'Clean'], ['stripes', 'Twin stripe'], ['band', 'Side band'], ['split', 'Two-tone']].map(([k, n]) => `<button data-livery="${k}" class="${s.livery === k ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="field two"><label><span>Accent</span><input type="color" value="${s.accent}" data-custom="accent"></label>
          <label><span>Wheels</span><input type="color" value="${s.rim}" data-custom="rim"></label>
          <label><span>Number</span><input type="number" min="0" max="99" value="${s.number}" data-number></label></div>`;
      body.querySelectorAll('[data-paint]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ paint: b.dataset.paint }); this.renderTab(); }));
      body.querySelectorAll('[data-finish]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ finish: b.dataset.finish }); this.renderTab(); }));
      body.querySelectorAll('[data-livery]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ livery: b.dataset.livery }); this.renderTab(); }));
      body.querySelectorAll('[data-custom]').forEach((inp) => inp.addEventListener('input', () => this.change({ [inp.dataset.custom]: inp.value })));
      body.querySelector('[data-number]').addEventListener('change', (e) => this.change({ number: clamp(parseInt(e.target.value) || 0, 0, 99) }));
    } else {
      const sl = (key, label, min, max, step, fmt) => `<label class="slider"><span>${label} <b data-out="${key}">${fmt(s[key])}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-tune="${key}"></label>`;
      const pct = (v) => `${Math.round(v * 100)}%`;
      const B = BODIES[s.body];
      const tunes = [
        ['powerScale', 'Engine power', 0.7, 1.3, 0.01, (v) => `${Math.round(B.powerKW * v * 1.341)} hp`],
        ['weightScale', 'Weight', 0.85, 1.1, 0.01, (v) => `${Math.round(B.mass * v)} kg`],
        ['downforce', 'Wing angle', 0, 1, 0.01, pct],
        ['aeroBalance', 'Aero balance (front)', -0.1, 0.1, 0.01, (v) => `${Math.round((B.aeroBalance + v) * 100)}%`],
        ['brakeBias', 'Brake bias (front)', -0.08, 0.08, 0.01, (v) => `${Math.round((B.brakeBias + v) * 100)}%`],
        ['diffLock', 'Differential lock', 0, 1, 0.01, pct],
        ['rollFront', 'Roll stiffness (front)', 0.4, 0.7, 0.01, pct],
        ['finalDrive', 'Gearing', 0.85, 1.15, 0.01, (v) => (v < 0.97 ? 'Long' : v > 1.03 ? 'Short' : 'Standard')],
        ['steerLock', 'Steering lock', 0.8, 1.2, 0.01, pct],
      ];
      body.innerHTML = `<div class="tune-list">${tunes.map((t) => sl(...t)).join('')}</div>
        <p class="tune-tip">More front roll stiffness and rear brake bias make the car rotate; a locked diff stabilises exits but pushes on entry.</p>
        <button class="chip" data-reset>Reset tune</button>`;
      const fmtOf = Object.fromEntries(tunes.map((t) => [t[0], t[5]]));
      body.querySelectorAll('[data-tune]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.tune;
          const v = parseFloat(inp.value);
          body.querySelector(`[data-out=${k}]`).textContent = fmtOf[k](v);
          this.change({ [k]: v }, k === 'downforce');
        });
      });
      body.querySelector('[data-reset]').addEventListener('click', () => {
        audio.click();
        const keep = ['body', 'paint', 'accent', 'finish', 'livery', 'number', 'rim', 'compound'];
        const patch = {};
        for (const k of Object.keys(DEFAULT_SETUP)) if (!keep.includes(k)) patch[k] = DEFAULT_SETUP[k];
        this.change(patch);
        this.renderTab();
      });
    }
  }

  renderStats() {
    const st = performanceStats(this.setup);
    const bar = (label, val, frac, unit = '') => `<div class="stat"><div class="sl"><span>${label}</span><b>${val}${unit}</b></div><div class="sb"><i style="width:${clamp(frac, 0.04, 1) * 100}%"></i></div></div>`;
    this.root.querySelector('.stats').innerHTML =
      bar('Power', Math.round(st.powerKW * 1.341), st.powerKW / 900, ' hp') +
      bar('Weight', Math.round(st.mass), (1800 - st.mass) / 1000, ' kg') +
      bar('0–100 km/h', st.t100 ? st.t100.toFixed(1) : '—', st.t100 ? (8 - st.t100) / 6 : 0, ' s') +
      bar('Top speed', Math.round(st.vmax), (st.vmax - 180) / 220, ' km/h') +
      bar('Cornering', st.latG.toFixed(2), (st.latG - 0.8) / 2.6, ' g');
  }

  update(dt) {
    if (!this.drag) this.yaw += dt * 0.18;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    // frame the car to the left of the panel on wide screens; back off on
    // narrow / portrait windows so the whole car always fits
    const wide = window.innerWidth > 820;
    const visibleAspect = wide ? (window.innerWidth - 400) / window.innerHeight : this.camera.aspect;
    const r = 7.6 * clamp(1.2 / Math.max(visibleAspect, 0.5), 1, 1.45) * (wide ? 1 : 1.2);
    this.camera.setViewOffset(window.innerWidth, window.innerHeight, wide ? 200 : 0, wide ? 0 : 120, window.innerWidth, window.innerHeight);
    this.camera.position.set(Math.sin(this.yaw) * r, 2.3, Math.cos(this.yaw) * r);
    this.camera.lookAt(0, 0.55, 0);
    this.camera.updateProjectionMatrix();
    if (this.carMesh) {
      const w = this.carMesh.userData.wheels;
      w[0].steer.rotation.y = w[1].steer.rotation.y = 0.28;
    }
  }
}
