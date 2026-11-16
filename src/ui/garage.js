// Garage: studio turntable, body selection, paint & livery, and a tuning
// sheet whose performance numbers come from running the real physics model.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BODIES, COMPOUNDS, PAINTS, DEFAULT_SETUP, makeCarParams, engineTorque } from '../physics/carSetup.js';
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
          <button data-tab="car" class="on">Car</button><button data-tab="paint">Livery</button><button data-tab="engine">Engine</button><button data-tab="aero">Aero</button><button data-tab="tune">Chassis</button>
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
      this.setTunnel(this.tab === 'aero' && this.tunnelOn);
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

  close() { this.active = false; this.root.hidden = true; this.setTunnel(false); }

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
    const B = BODIES[s.body];
    const sl = (key, label, min, max, step, fmt) => `<label class="slider"><span>${label} <b data-out="${key}">${fmt(s[key] ?? DEFAULT_SETUP[key])}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${s[key] ?? DEFAULT_SETUP[key]}" data-tune="${key}"></label>`;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const bindSliders = (list, onChange) => {
      const fmtOf = Object.fromEntries(list.map((t) => [t[0], t[5]]));
      body.querySelectorAll('[data-tune]').forEach((inp) => inp.addEventListener('input', () => {
        const k = inp.dataset.tune;
        const v = parseFloat(inp.value);
        body.querySelector(`[data-out=${k}]`).textContent = fmtOf[k](v);
        this.change({ [k]: v }, k === 'rearWing');
        onChange?.();
      }));
    };
    const resetBtn = (keys) => {
      body.querySelector('[data-reset]')?.addEventListener('click', () => {
        audio.click();
        const patch = {};
        for (const k of keys) patch[k] = DEFAULT_SETUP[k];
        this.change(patch);
        this.renderTab();
      });
    };
    if (this.tab === 'car') {
      body.innerHTML = `<div class="body-cards">${Object.values(BODIES).map((b) => `
        <button class="body-card ${s.body === b.id ? 'on' : ''}" data-body="${b.id}">
          <em>${b.cls}</em><b>${b.name}</b><span>${b.drivetrain} · ${Math.round(b.powerKW * 1.341)} hp · ${b.mass} kg</span><small>${b.blurb}</small>
        </button>`).join('')}</div>
        <div class="field"><span>Tyres</span><div class="seg small">${Object.values(COMPOUNDS).map((c) => `<button data-compound="${c.id}" class="${s.compound === c.id ? 'on' : ''}">${c.name}</button>`).join('')}</div></div>
        <div class="field"><span>Drivetrain</span><div class="seg small">${['RWD', 'AWD', 'FWD'].map((d) => `<button data-drive="${d}" class="${(s.drivetrain || B.drivetrain) === d ? 'on' : ''}">${d}</button>`).join('')}</div></div>`;
      body.querySelectorAll('[data-body]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ body: b.dataset.body, drivetrain: null, compound: BODIES[b.dataset.body].compound, cylinders: null }); this.renderTab(); }));
      body.querySelectorAll('[data-compound]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ compound: b.dataset.compound }, false); this.renderTab(); }));
      body.querySelectorAll('[data-drive]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ drivetrain: b.dataset.drive === B.drivetrain ? null : b.dataset.drive }, false); this.renderTab(); }));
    } else if (this.tab === 'paint') {
      body.innerHTML = `
        <div class="field"><span>Paint</span><div class="swatches">${PAINTS.map((p) => `<button class="sw ${s.paint === p.color ? 'on' : ''}" style="--c:${p.color}" data-paint="${p.color}" title="${p.name}"></button>`).join('')}
          <label class="sw custom" title="Custom colour"><input type="color" value="${s.paint}" data-custom="paint"></label></div></div>
        <div class="field"><span>Finish</span><div class="seg small">${['gloss', 'metallic', 'pearl', 'matte'].map((f) => `<button data-finish="${f}" class="${s.finish === f ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div></div>
        <div class="field"><span>Livery</span><div class="seg small">${[['none', 'Clean'], ['stripes', 'Twin stripe'], ['band', 'Side band'], ['split', 'Two-tone']].map(([k, n]) => `<button data-livery="${k}" class="${s.livery === k ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="field two"><label><span>Accent</span><input type="color" value="${s.accent}" data-custom="accent"></label>
          <label><span>Wheels</span><input type="color" value="${s.rim}" data-custom="rim"></label>
          <label><span>Number</span><input type="number" min="0" max="99" value="${s.number}" data-number></label></div>
        <div class="field"><span>Sponsor text</span><input class="g-text" maxlength="18" placeholder="e.g. NIGHTFALL" value="${(s.sponsor || '').replace(/"/g, '&quot;')}" data-sponsor></div>
        <div class="field"><span>Logo</span><div class="g-logo">${s.logo ? `<img src="${s.logo}" alt="">` : '<i>No logo</i>'}<button class="chip" data-logo>Upload image</button>${s.logo ? '<button class="chip" data-logo-clear>Remove</button>' : ''}</div></div>`;
      body.querySelectorAll('[data-paint]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ paint: b.dataset.paint }); this.renderTab(); }));
      body.querySelectorAll('[data-finish]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ finish: b.dataset.finish }); this.renderTab(); }));
      body.querySelectorAll('[data-livery]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ livery: b.dataset.livery }); this.renderTab(); }));
      body.querySelectorAll('[data-custom]').forEach((inp) => inp.addEventListener('input', () => this.change({ [inp.dataset.custom]: inp.value })));
      body.querySelector('[data-number]').addEventListener('change', (e) => this.change({ number: clamp(parseInt(e.target.value) || 0, 0, 99) }));
      body.querySelector('[data-sponsor]').addEventListener('input', (e) => { clearTimeout(this.spT); this.spT = setTimeout(() => this.change({ sponsor: e.target.value.slice(0, 18) }), 250); });
      body.querySelector('[data-logo]').addEventListener('click', () => this.pickLogo());
      body.querySelector('[data-logo-clear]')?.addEventListener('click', () => { audio.click(); this.change({ logo: null }); this.renderTab(); });
    } else if (this.tab === 'engine') {
      const cyls = [3, 4, 5, 6, 8, 10, 12];
      const cyl = s.cylinders || B.cyl || 6;
      const ws = s.weightShift || 0;
      const list = [
        ['turbo', 'Turbo boost', 0, 1.5, 0.05, (v) => (v ? `${v.toFixed(2)} bar` : 'Naturally aspirated')],
        ['revLimit', 'Rev limit', -1500, 1500, 100, (v) => `${(B.redline + v).toLocaleString()} rpm`],
        ['powerScale', 'Engine map', 0.7, 1.3, 0.01, (v) => `${Math.round(v * 100)}%`],
        ['weightShift', 'Engine position (front weight)', -0.08, 0.08, 0.01, (v) => `${Math.round((B.weightFront + v) * 100)}%`],
      ];
      body.innerHTML = `
        <canvas class="g-curve" width="680" height="300"></canvas>
        <div class="g-curve-legend"><span class="tq">Torque</span><span class="pw">Power</span><b class="g-peak"></b></div>
        <div class="field"><span>Cylinders</span><div class="seg small">${cyls.map((c) => `<button data-cyl="${c}" class="${cyl === c ? 'on' : ''}">${c}</button>`).join('')}</div></div>
        <div class="field"><span>Layout</span><div class="seg small">${[['-0.06', 'Rear'], ['-0.03', 'Mid'], ['0', 'Stock'], ['0.04', 'Front']].map(([v, n]) => `<button data-layout="${v}" class="${Math.abs(ws - +v) < 0.005 ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="tune-list">${list.map((t) => sl(...t)).join('')}</div>
        <p class="tune-tip">Boost adds a fat mid-range; a higher rev limit adds top-end power. Weight further back helps traction and rotation but makes the car snappier.</p>
        <button class="chip" data-reset>Reset engine</button>`;
      bindSliders(list, () => this.drawCurve());
      body.querySelectorAll('[data-cyl]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ cylinders: +b.dataset.cyl }, false); this.renderTab(); }));
      body.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => { audio.click(); this.change({ weightShift: +b.dataset.layout }, false); this.renderTab(); }));
      resetBtn(['turbo', 'revLimit', 'powerScale', 'weightShift', 'cylinders']);
      this.drawCurve();
    } else if (this.tab === 'aero') {
      const list = [
        ['frontWing', 'Front wing', 0, 1, 0.01, pct],
        ['rearWing', 'Rear wing', 0, 1, 0.01, pct],
        ['splitter', 'Splitter', 0, 1, 0.01, pct],
        ['underfloor', 'Underfloor / diffuser', 0, 1, 0.01, pct],
      ];
      body.innerHTML = `
        <div class="g-aero"></div>
        <button class="btn ${this.tunnelOn ? 'on' : ''}" data-tunnel>${this.tunnelOn ? 'Wind tunnel: ON' : 'Open wind tunnel'}</button>
        <div class="tune-list">${list.map((t) => sl(...t)).join('')}</div>
        <p class="tune-tip">Wings add grip and drag. Shift balance forward for a pointier car, rearward for stability at speed. The floor is the most efficient downforce.</p>
        <button class="chip" data-reset>Reset aero</button>`;
      bindSliders(list, () => this.renderAero());
      body.querySelector('[data-tunnel]').addEventListener('click', () => { audio.click(); this.setTunnel(!this.tunnelOn); this.renderTab(); });
      resetBtn(['frontWing', 'rearWing', 'splitter', 'underfloor']);
      this.renderAero();
    } else {
      const list = [
        ['weightScale', 'Weight', 0.85, 1.1, 0.01, (v) => `${Math.round(B.mass * v)} kg`],
        ['brakeBias', 'Brake bias (front)', -0.08, 0.08, 0.01, (v) => `${Math.round((B.brakeBias + v) * 100)}%`],
        ['diffLock', 'Differential lock', 0, 1, 0.01, pct],
        ['rollFront', 'Roll stiffness (front)', 0.4, 0.7, 0.01, pct],
        ['finalDrive', 'Gearing', 0.85, 1.15, 0.01, (v) => (v < 0.97 ? 'Long' : v > 1.03 ? 'Short' : 'Standard')],
        ['steerLock', 'Steering lock', 0.8, 1.2, 0.01, pct],
      ];
      body.innerHTML = `<div class="tune-list">${list.map((t) => sl(...t)).join('')}</div>
        <p class="tune-tip">More front roll stiffness and rear brake bias make the car rotate; a locked diff stabilises exits but pushes on entry.</p>
        <button class="chip" data-reset>Reset chassis</button>`;
      bindSliders(list);
      resetBtn(list.map((t) => t[0]));
    }
  }

  pickLogo() {
    audio.click();
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => {
        // downscale to keep saves small
        const k = Math.min(1, 256 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        this.change({ logo: c.toDataURL('image/png') });
        this.renderTab();
      };
      img.onerror = () => this.app.toast('Could not read that image');
      img.src = URL.createObjectURL(f);
    };
    inp.click();
  }

  drawCurve() {
    const c = this.root.querySelector('.g-curve');
    if (!c) return;
    const p = makeCarParams(this.setup);
    const e = p.engine;
    const g = c.getContext('2d');
    const W = c.width, H = c.height, padL = 46, padB = 34, padT = 16, padR = 50;
    g.clearRect(0, 0, W, H);
    const rpms = [];
    for (let r = 1000; r <= e.limiter; r += 50) rpms.push(r);
    const tq = rpms.map((r) => engineTorque(e, r));
    const pw = rpms.map((r, k) => (tq[k] * r * Math.PI) / 30 / 1000);
    const tMax = Math.max(...tq) * 1.12, pMax = Math.max(...pw) * 1.12;
    const X = (r) => padL + ((r - 1000) / (e.limiter - 1000)) * (W - padL - padR);
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '600 18px "Inter Variable", system-ui';
    for (let r = 2000; r <= e.limiter; r += 2000) { g.beginPath(); g.moveTo(X(r), padT); g.lineTo(X(r), H - padB); g.stroke(); g.fillText(`${r / 1000}k`, X(r) - 10, H - 10); }
    for (let k = 1; k <= 4; k++) { const y = padT + ((H - padB - padT) * k) / 4; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); }
    const plot = (arr, max, col, fill) => {
      g.beginPath();
      arr.forEach((v, k) => { const x = X(rpms[k]), y = H - padB - (v / max) * (H - padB - padT); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
      g.strokeStyle = col; g.lineWidth = 4; g.stroke();
      if (fill) { g.lineTo(X(rpms[rpms.length - 1]), H - padB); g.lineTo(X(rpms[0]), H - padB); g.closePath(); g.fillStyle = fill; g.fill(); }
    };
    plot(pw, pMax, '#ff7a3d', 'rgba(255,122,61,0.12)');
    plot(tq, tMax, '#4aa8ff');
    // redline
    g.fillStyle = 'rgba(255,70,60,0.18)'; g.fillRect(X(e.redline), padT, X(e.limiter) - X(e.redline), H - padB - padT);
    g.fillStyle = '#4aa8ff'; g.fillText(`${Math.round(tMax / 1.12)} Nm`, 4, padT + 12);
    g.fillStyle = '#ff7a3d'; g.fillText(`${Math.round((pMax / 1.12) * 1.341)} hp`, W - padR - 30, padT + 12);
    const pk = pw.indexOf(Math.max(...pw)), tk = tq.indexOf(Math.max(...tq));
    const out = this.root.querySelector('.g-peak');
    if (out) out.textContent = `${Math.round(pw[pk] * 1.341)} hp @ ${rpms[pk].toLocaleString()} · ${Math.round(tq[tk])} Nm @ ${rpms[tk].toLocaleString()}`;
  }

  /** Aero readouts from the physics model at 200 km/h. */
  renderAero() {
    const box = this.root.querySelector('.g-aero');
    if (!box) return;
    const p = makeCarParams(this.setup);
    const v = 200 / 3.6, q = 0.5 * 1.225 * v * v;
    // use the stock (non-arcade) aero numbers so the readouts are physical
    const clA = p.aero.clA * Math.sqrt(this.app.settings?.grip === 'real' ? 1 : 1);
    const down = q * clA, drag = q * p.aero.cdA;
    const bal = p.aero.balance;
    box.innerHTML = `
      <div><span>Downforce @ 200</span><b>${Math.round(down / 9.81)} kg</b></div>
      <div><span>Drag @ 200</span><b>${Math.round(drag / 9.81)} kg</b></div>
      <div><span>Efficiency L/D</span><b>${(down / Math.max(drag, 1)).toFixed(2)}</b></div>
      <div><span>Front balance</span><b>${Math.round(bal * 100)}%</b><i class="g-bal"><em style="left:${clamp(bal, 0.2, 0.8) * 100}%"></em></i></div>`;
    if (this.tunnel) this.tunnel.userData.clA = clA;
  }

  // ---------------------------------------------------------- wind tunnel
  setTunnel(on) {
    this.tunnelOn = on;
    if (on && !this.tunnel) this.buildTunnel();
    if (this.tunnel) this.tunnel.visible = on;
    if (on) this.yaw = Math.PI / 2 + 0.25;
  }

  buildTunnel() {
    const N = 340, TRAIL = 6;
    const pos = new Float32Array(N * TRAIL * 2 * 3);
    const col = new Float32Array(N * TRAIL * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    const parts = [];
    for (let i = 0; i < N; i++) parts.push(this.spawnParticle({}, true));
    lines.userData = { parts, N, TRAIL };
    this.tunnel = lines;
    this.turntable.add(lines);
  }

  spawnParticle(pt, anywhere = false) {
    const B = BODIES[this.setup.body];
    const L = B.length || 4.5;
    pt.x = (Math.random() - 0.5) * (B.width || 1.9) * 1.25;
    pt.y = 0.06 + Math.random() * ((B.height || 1.3) * 1.35);
    pt.z = anywhere ? (Math.random() - 0.5) * L * 2.6 : L * 1.3;
    pt.trail = [];
    pt.v = 1;
    return pt;
  }

  stepTunnel(dt) {
    const T = this.tunnel;
    if (!T?.visible) return;
    const B = BODIES[this.setup.body];
    const s = this.setup;
    const L = B.length || 4.5, Wd = (B.width || 1.9) / 2, Ht = (B.height || 1.3);
    const zc = this.carMesh?.position.z || 0;
    // body silhouette: smooth roof profile over the length, front/rear taper
    const roof = (z) => { const u = (z - zc) / (L / 2); return Math.abs(u) > 1 ? 0 : Ht * (0.55 + 0.45 * Math.max(0, 1 - Math.pow(Math.abs(u + 0.1), 2.2))) ; };
    const { parts, TRAIL } = T.userData;
    const posA = T.geometry.attributes.position.array, colA = T.geometry.attributes.color.array;
    const speed = 9;
    let o = 0;
    for (const pt of parts) {
      pt.trail.unshift([pt.x, pt.y, pt.z, pt.v]);
      if (pt.trail.length > TRAIL + 1) pt.trail.pop();
      let vz = -speed, vy = 0;
      const h = roof(pt.z);
      const inside = Math.abs(pt.x) < Wd * 0.95 && h > 0;
      const gap = pt.y - h;
      if (inside && gap < 0.35) {
        // flow is pushed over the body: slows at the nose (stagnation), speeds over the roof
        const front = (pt.z - zc) / (L / 2) > 0.55;
        vy = (0.35 - gap) * 9;
        vz *= front ? 0.55 : 1.25;
        pt.v = front ? 0.35 : 1.5;
      } else pt.v += (1 - pt.v) * dt * 3;
      // rear wing: strong upwash behind the car (shows downforce)
      const rel = (pt.z - zc) / (L / 2);
      if (rel < -0.75 && rel > -1.6 && Math.abs(pt.x) < Wd && pt.y > Ht * 0.7 && pt.y < Ht * 1.35) { vy += (s.rearWing ?? 0.5) * 4.5; pt.v = 1.2 + (s.rearWing ?? 0.5); }
      // splitter / floor: low air accelerated under the car
      if (inside && pt.y < 0.18) { vz *= 1 + (s.underfloor ?? 0.5) * 0.8; pt.v = 1.3 + (s.underfloor ?? 0.5) * 0.5; pt.y = Math.max(0.04, pt.y); }
      // wake turbulence
      if (rel < -1 && rel > -2.4 && Math.abs(pt.x) < Wd * 1.1) { pt.x += (Math.random() - 0.5) * 0.06; pt.y += (Math.random() - 0.5) * 0.05; }
      pt.z += vz * dt; pt.y += vy * dt;
      if (pt.z < -L * 1.4 || pt.y > Ht * 2.2) this.spawnParticle(pt);
      for (let k = 0; k < TRAIL; k++) {
        const a = pt.trail[k] || [pt.x, pt.y, pt.z, pt.v], b = pt.trail[k + 1] || a;
        const fade = 1 - k / TRAIL;
        const c = speedColor(a[3]);
        posA[o] = a[0]; posA[o + 1] = a[1]; posA[o + 2] = a[2];
        posA[o + 3] = b[0]; posA[o + 4] = b[1]; posA[o + 5] = b[2];
        for (let q = 0; q < 2; q++) { colA[o + q * 3] = c[0] * fade; colA[o + q * 3 + 1] = c[1] * fade; colA[o + q * 3 + 2] = c[2] * fade; }
        o += 6;
      }
    }
    T.geometry.attributes.position.needsUpdate = true;
    T.geometry.attributes.color.needsUpdate = true;
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
    if (!this.drag && !this.tunnelOn) this.yaw += dt * 0.18;
    if (this.tunnelOn) this.stepTunnel(Math.min(dt, 0.05));
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

/** Flow speed → colour (blue slow, cyan, white fast, orange very fast). */
function speedColor(v) {
  if (v < 1) return [0.15 + v * 0.2, 0.4 + v * 0.45, 1];
  if (v < 1.4) { const t = (v - 1) / 0.4; return [0.35 + t * 0.65, 0.85 + t * 0.15, 1]; }
  const t = Math.min(1, (v - 1.4) / 0.6);
  return [1, 1 - t * 0.5, 1 - t * 0.85];
}
