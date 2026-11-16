// In-race heads-up display (DOM) + minimap.
import { formatTime, formatDelta, clamp } from '../core/math.js';

export class HUD {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    root.innerHTML = `
      <div class="hud-tl">
        <div class="hud-card timing">
          <div class="lapline"><span class="pos" hidden></span><span class="lbl">LAP</span><span class="lapnum">1</span><span class="inv" hidden>INVALID</span></div>
          <div class="cur">0:00.000</div>
          <div class="delta"></div>
          <div class="rows">
            <div><span class="lbl">LAST</span><span class="last">–:––.–––</span></div>
            <div><span class="lbl">BEST</span><span class="best">–:––.–––</span></div>
          </div>
          <div class="sectors"><i></i><i></i><i></i></div>
        </div>
      </div>
      <div class="board" hidden></div>
      <div class="hud-tr">
        <button class="icon-btn hud-pause" title="Pause (Esc)"><svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg></button>
      </div>
      <div class="hud-bl"><canvas class="minimap" width="360" height="360"></canvas></div>
      <div class="hud-br">
        <div class="dash">
          <div class="revbar">${'<i></i>'.repeat(20)}</div>
          <div class="speedrow">
            <div class="speed"><span class="spd">0</span><span class="unit">KM/H</span></div>
            <div class="gearbox"><span class="gear">N</span><span class="lbl">GEAR</span></div>
          </div>
          <div class="dashfoot">
            <div class="tyres" title="Tyre temperature"><i></i><i></i><i></i><i></i></div>
            <div class="aids"><span class="aid abs">ABS</span><span class="aid tcs">TCS</span></div>
            <div class="pedals"><i class="thr"></i><i class="brk"></i></div>
          </div>
        </div>
      </div>
      <div class="hud-center"><div class="flash"></div><div class="countdown"></div><div class="rewind-tag" hidden>⏪ REWIND</div><div class="draft-tag" hidden>SLIPSTREAM</div></div>
      <div class="touch-controls">
        <div class="touch-steer"><div class="touch-track"></div><div class="touch-knob"></div><span>STEER</span></div>
        <div class="touch-pedals"><div class="touch-brake">BRAKE</div><div class="touch-gas">GAS</div></div>
      </div>`;
    const cache = new Map();
    this.q = (sel) => { let e = cache.get(sel); if (!e) { e = root.querySelector(sel); cache.set(sel, e); } return e; };
    // write DOM only when a value actually changes (avoids per-frame layout work)
    this.set = (sel, prop, v) => { const e = this.q(sel); const k = sel + '|' + prop; if (this.last.get(k) !== v) { this.last.set(k, v); if (prop === 'text') e.textContent = v; else if (prop === 'class') e.className = v; else if (prop === 'hidden') e.hidden = v; else e.style[prop] = v; } };
    this.last = new Map();
    this.revs = [...root.querySelectorAll('.revbar i')];
    this.tyres = [...root.querySelectorAll('.tyres i')];
    this.sectors = [...root.querySelectorAll('.sectors i')];
    this.mini = this.q('.minimap');
    this.mctx = this.mini.getContext('2d');
    this.q('.hud-pause').addEventListener('click', () => app.togglePause());
    this.flashTimer = 0;
  }

  setTrack(T) {
    // precompute minimap transform
    const b = T.bounds;
    const W = this.mini.width, H = this.mini.height;
    const s = Math.min((W - 40) / (b.maxX - b.minX), (H - 40) / (b.maxZ - b.minZ));
    this.mm = { s, ox: (W - (b.maxX - b.minX) * s) / 2 - b.minX * s, oz: (H - (b.maxZ - b.minZ) * s) / 2 - b.minZ * s };
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const g = off.getContext('2d');
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= T.N; i++) {
      const k = i % T.N;
      const x = T.px[k] * s + this.mm.ox, y = T.pz[k] * s + this.mm.oz;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 11; g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 5; g.stroke();
    const x0 = T.px[0] * s + this.mm.ox, y0 = T.pz[0] * s + this.mm.oz;
    g.fillStyle = '#ff5a1f';
    g.fillRect(x0 - 5, y0 - 5, 10, 10);
    this.mmBase = off;
    this.sectors.forEach((e) => (e.className = ''));
  }

  show(on) { this.root.hidden = !on; }

  setTouch(on) { this.root.classList.toggle('touch', on); }

  flash(text, kind = '', dur = 2) {
    const f = this.q('.flash');
    f.textContent = text;
    f.className = `flash show ${kind}`;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => (f.className = 'flash'), dur * 1000);
  }

  sector(k, delta) {
    const e = this.sectors[k - 1];
    if (!e) return;
    e.className = delta < 0 ? 'fast' : 'slow';
  }

  update(session, settings) {
    const car = session.car;
    const mph = settings.units === 'mph';
    const v = car.speed * (mph ? 2.23694 : 3.6);
    this.set('.spd', 'text', String(Math.round(v)));
    this.set('.unit', 'text', mph ? 'MPH' : 'KM/H');
    this.set('.gear', 'text', car.gear === -1 ? 'R' : car.gear === 0 ? 'N' : String(car.gear));
    const r = car.rpm / car.p.engine.redline;
    const lit = Math.round(clamp((r - 0.25) / 0.75, 0, 1) * this.revs.length);
    const limiter = r > 0.97;
    this.revs.forEach((e, k) => {
      const c = (k < lit ? (k >= 17 ? 'r' : k >= 13 ? 'y' : 'g') : '') + (limiter ? ' blink' : '');
      if (e.className !== c) e.className = c;
    });
    // tyre temps: blue cold → green ok → red hot
    car.wheels.forEach((w, k) => {
      const t = w.temp;
      const opt = car.p.tire.optTemp, win = car.p.tire.window;
      const x = (t - opt) / win;
      const col = x < -0.6 ? '#3b8cff' : x < -0.25 ? '#36c2d6' : x < 0.35 ? '#3ddc84' : x < 0.8 ? '#ffb020' : '#ff4433';
      if (this.tyres[k].dataset.c !== col) { this.tyres[k].dataset.c = col; this.tyres[k].style.background = col; }
    });
    const abs = car.wheels.some((w) => w.brakeMod < 0.95);
    this.q('.abs').classList.toggle('on', abs);
    this.q('.tcs').classList.toggle('on', car.tcsCut < 0.95);
    this.q('.abs').classList.toggle('off', !car.assists.abs);
    this.q('.tcs').classList.toggle('off', !car.assists.tcs);
    this.set('.pedals .thr', 'transform', `scaleY(${car.throttle.toFixed(2)})`);
    this.set('.pedals .brk', 'transform', `scaleY(${car.brake.toFixed(2)})`);

    // timing
    const L = session.lap;
    const t = L.start != null ? session.time - L.start : 0;
    this.set('.cur', 'text', formatTime(t));
    const F = session.field;
    const laps = session.raceCfg?.laps;
    this.set('.lapnum', 'text', laps ? `${Math.min(session.lapsDone + (session.lap.start != null ? 1 : 0), laps) || 1}/${laps}` : String(session.lapsDone + 1));
    this.set('.pos', 'hidden', !F);
    this.set('.board', 'hidden', !F);
    if (F) {
      this.boardT = (this.boardT || 0) + 1;
      if (this.boardT % 6 === 0 || !this.standings) this.standings = F.standings();
      const st = this.standings;
      const me = st.findIndex((r) => r.isPlayer);
      this.set('.pos', 'text', `P${me + 1}/${st.length}`);
      if (this.boardT % 6 === 0) {
        const lead = st[0].progress;
        const html = st.map((r, k) => {
          const gap = k === 0 ? 'Leader' : r.finished != null ? 'Finished' : `+${((lead - r.progress) / Math.max(session.car.speed, 25)).toFixed(1)}s`;
          return `<div class="${r.isPlayer ? 'me' : ''}"><b>${k + 1}</b><i style="background:${r.paint}"></i><span>${r.name}</span><em>${gap}</em></div>`;
        }).join('');
        if (html !== this.lastBoard) { this.q('.board').innerHTML = html; this.lastBoard = html; }
      }
    }
    this.set('.inv', 'hidden', !L.invalid);
    this.set('.last', 'text', session.lastLap ? formatTime(session.lastLap.time) : '–:––.–––');
    this.set('.best', 'text', session.best ? formatTime(session.best.time) : '–:––.–––');
    const d = session.delta();
    const de = this.q('.delta');
    this.set('.delta', 'text', d == null ? '' : formatDelta(d));
    this.set('.delta', 'class', 'delta ' + (d == null ? '' : d < 0 ? 'fast' : 'slow'));
    if (L.sector === 0 && L.sectorTimes.length === 0) this.sectors.forEach((e) => (e.className = ''));

    this.set('.rewind-tag', 'hidden', !session.rewinding);
    this.set('.draft-tag', 'hidden', !((car.draft || 0) > 0.12 && car.speed > 25));
    // countdown
    const cd = this.q('.countdown');
    if (session.state === 'countdown') {
      const n = Math.ceil(session.countdown - 0.7);
      this.set('.countdown', 'text', n > 0 && n <= 3 ? String(n) : '');
      this.set('.countdown', 'class', 'countdown' + (n > 0 && n <= 3 ? ' show' : ''));
    } else this.set('.countdown', 'class', 'countdown');

    // minimap
    const g = this.mctx;
    const W = this.mini.width, H = this.mini.height;
    g.clearRect(0, 0, W, H);
    if (this.mmBase) g.drawImage(this.mmBase, 0, 0);
    const mm = this.mm;
    if (session.ghostMesh?.visible) {
      const gp = session.ghostMesh.position;
      g.fillStyle = '#8fd3ff';
      g.beginPath(); g.arc(gp.x * mm.s + mm.ox, gp.z * mm.s + mm.oz, 6, 0, Math.PI * 2); g.fill();
    }
    if (F) for (const r of F.cars) {
      g.fillStyle = r.setup.paint;
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 2;
      g.beginPath(); g.arc(r.car.x * mm.s + mm.ox, r.car.z * mm.s + mm.oz, 7, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    const x = car.x * mm.s + mm.ox, y = car.z * mm.s + mm.oz;
    g.save();
    g.translate(x, y);
    g.rotate(-car.heading + Math.PI);
    g.fillStyle = '#ff5a1f';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(8, 8); g.lineTo(0, 4); g.lineTo(-8, 8); g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }
}
