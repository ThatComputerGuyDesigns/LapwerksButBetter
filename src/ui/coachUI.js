// Coach screen: pick two laps (in-game or from a GPS logger file) and see
// where time is gained and lost — map, speed/delta/input traces, corner
// table and plain-language insights. Everything stays in the browser.
import { lapFromGame, parseSession, lapsFromSession, compareLaps } from '../game/coach.js';
import { store } from '../game/store.js';
import { formatTime, clamp } from '../core/math.js';
import { audio } from '../audio/audio.js';

const fmtD = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(2)}`;

export class CoachUI {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.source = 'session';
    this.laps = [];
    this.a = 0; this.b = 1;
    this.hover = -1;
    root.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('resize', () => !root.hidden && this.drawAll());
  }

  open(source) {
    this.root.hidden = false;
    if (source) this.source = source;
    this.load();
    this.render();
  }
  close() { this.root.hidden = true; }

  /** Collect laps for the current source. */
  load() {
    const app = this.app;
    if (this.source === 'session') {
      const s = app.lastSessionLaps || [];
      this.title = app.lastSessionTrack || 'This session';
      this.laps = s.filter((l) => l.tele?.length > 20).map((l) => lapFromGame(l));
    } else if (this.source === 'saved') {
      const all = store.get('coachBest', {});
      this.title = 'Best laps by circuit';
      this.laps = Object.values(all).map((e, k) => ({ ...lapFromGame({ ...e.lap, n: k + 1 }), label: e.track }));
    } else if (this.source === 'file' && this.fileLaps) {
      this.title = this.fileName;
      this.laps = this.fileLaps;
    } else this.laps = [];
    // default: best valid lap as reference, the most recent other lap to compare
    const valid = this.laps.filter((l) => l.valid);
    const best = (valid.length ? valid : this.laps).reduce((m, l) => (!m || l.time < m.time ? l : m), null);
    this.a = Math.max(0, this.laps.indexOf(best));
    this.b = this.laps.length > 1 ? (this.a === this.laps.length - 1 ? this.laps.length - 2 : this.laps.length - 1) : this.a;
  }

  render() {
    const L = this.laps;
    const can = L.length >= 2 && this.laps[this.a].length > 100 && this.laps[this.b].length > 100;
    const A = L[this.a], B = L[this.b];
    this.G = can ? compareLaps(A, B) : null;
    const G = this.G;
    const savedCount = Object.keys(store.get('coachBest', {})).length;
    this.root.innerHTML = `
      <header class="co-top">
        <button class="icon-btn" data-co="back" title="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div><span class="eyebrow">Coach</span><h2>${this.title || 'Lap analysis'}</h2></div>
        <div class="seg small co-src">
          <button data-src="session" class="${this.source === 'session' ? 'on' : ''}">This session</button>
          <button data-src="saved" class="${this.source === 'saved' ? 'on' : ''}">Saved best laps${savedCount ? ` (${savedCount})` : ''}</button>
          <button data-src="file" class="${this.source === 'file' ? 'on' : ''}">Lap timer file</button>
        </div>
        <button class="btn" data-co="import">Import GPS session</button>
      </header>
      ${!L.length ? this.emptyHTML() : `
      <div class="co-grid">
        <aside class="co-laps">
          <div class="co-lh"><span>Lap</span><span>Time</span><span>A</span><span>B</span></div>
          ${L.map((l, k) => `<div class="co-lap ${k === this.a ? 'a' : ''} ${k === this.b ? 'b' : ''} ${l.valid ? '' : 'inv'}">
            <b>${l.label ? l.label : l.n}</b><span>${formatTime(l.time)}${l.valid ? '' : ' ✕'}</span>
            <button data-pick-a="${k}" title="Reference lap">A</button><button data-pick-b="${k}" title="Compare lap">B</button></div>`).join('')}
          ${G ? `<div class="co-sum"><span>Gap</span><b class="${G.delta[G.N] > 0 ? 'slow' : 'fast'}">${fmtD(G.delta[G.N])} s</b>
            <div class="co-secs">${G.sectors.map((v, k) => `<span class="${v > 0.02 ? 'slow' : v < -0.02 ? 'fast' : ''}">S${k + 1} ${fmtD(v)}</span>`).join('')}</div></div>` : ''}
        </aside>
        <section class="co-main">
          ${G ? `
          <div class="co-row">
            <canvas class="co-map" width="520" height="420"></canvas>
            <div class="co-insights"><span class="st-lbl">Insights · lap ${B.n} vs lap ${A.n}</span>${G.insights.map((t) => `<p>${t}</p>`).join('')}</div>
          </div>
          <div class="co-chart-wrap"><span class="co-ct">Speed <i class="ka">A</i><i class="kb">B</i></span><canvas class="co-chart" data-ch="speed" width="1200" height="220"></canvas></div>
          <div class="co-chart-wrap"><span class="co-ct">Time delta (B − A)</span><canvas class="co-chart" data-ch="delta" width="1200" height="140"></canvas></div>
          ${G.thrA ? `<div class="co-chart-wrap"><span class="co-ct">Throttle / brake <i class="ka">A</i><i class="kb">B</i></span><canvas class="co-chart" data-ch="pedals" width="1200" height="160"></canvas></div>` : ''}
          <div class="co-corners">
            <div class="co-ch"><span>Corner</span><span>Min A</span><span>Min B</span><span>Brake</span><span>Time</span></div>
            ${G.corners.map((c) => `<div class="co-cr" data-cn="${c.n}"><b>T${c.n} ${c.dir}</b><span>${Math.round(c.minA)}</span><span>${Math.round(c.minB)}</span><span>${Math.round((c.brakeA - c.brakeB) * (G.d[G.N] / G.N))} m</span><em class="${c.delta > 0.03 ? 'slow' : c.delta < -0.03 ? 'fast' : ''}">${fmtD(c.delta)}</em></div>`).join('')}
          </div>` : `<p class="st-note">Pick two different laps to compare.</p>`}
        </section>
      </div>`}`;
    if (G) this.bindCharts();
    this.drawAll();
  }

  emptyHTML() {
    const hint = this.source === 'session'
      ? 'Drive a few laps in a race or time trial, then open Coach from the results screen or the main menu. Every lap is recorded: speed, throttle, brake, steering, gear and g-forces.'
      : this.source === 'saved' ? 'Your best valid lap on each circuit is saved here automatically.'
        : 'Import a session from a GPS lap timer or phone app (.gpx or .csv with time, latitude and longitude). Coach finds the laps, sectors and corners, and shows where you gain and lose time. The file never leaves your device.';
    return `<div class="co-empty"><h3>No laps yet</h3><p>${hint}</p>${this.source === 'file' ? '<button class="btn primary" data-co="import">Import GPS session</button>' : '<button class="btn primary" data-co="drive">Go driving</button>'}</div>`;
  }

  onClick(e) {
    const t = e.target;
    const co = t.closest('[data-co]')?.dataset.co;
    if (co) {
      audio.click();
      if (co === 'back') this.app.showHome();
      else if (co === 'import') this.importFile();
      else if (co === 'drive') { this.app.showHome(); this.app.openOverlay('modes'); }
      return;
    }
    const src = t.closest('[data-src]')?.dataset.src;
    if (src) { audio.click(); this.source = src; this.load(); this.render(); return; }
    const pa = t.closest('[data-pick-a]'), pb = t.closest('[data-pick-b]');
    if (pa) { audio.click(); this.a = +pa.dataset.pickA; if (this.a === this.b) this.b = (this.a + 1) % this.laps.length; this.render(); }
    if (pb) { audio.click(); this.b = +pb.dataset.pickB; if (this.a === this.b) this.a = (this.b + 1) % this.laps.length; this.render(); }
  }

  importFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.gpx,.csv,.txt';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const laps = lapsFromSession(parseSession(await f.text()));
        this.fileLaps = laps;
        this.fileName = f.name.replace(/\.[^.]+$/, '');
        this.source = 'file';
        this.load();
        this.render();
        this.app.toast(`Found ${laps.length} lap${laps.length > 1 ? 's' : ''}`);
      } catch (err) { this.app.toast(err.message || 'Could not read that file'); }
    };
    inp.click();
  }

  bindCharts() {
    this.root.querySelectorAll('.co-chart').forEach((c) => {
      c.addEventListener('pointermove', (e) => {
        const r = c.getBoundingClientRect();
        const f = clamp((e.clientX - r.left - (46 * r.width) / c.width) / (r.width - (60 * r.width) / c.width), 0, 1);
        this.hover = Math.round(f * this.G.N);
        this.drawAll();
      });
      c.addEventListener('pointerleave', () => { this.hover = -1; this.drawAll(); });
    });
    this.root.querySelectorAll('.co-cr').forEach((row) => row.addEventListener('mouseenter', () => {
      const c = this.G.corners.find((q) => q.n === +row.dataset.cn);
      this.hiCorner = c; this.drawAll();
    }));
    this.root.querySelector('.co-corners')?.addEventListener('mouseleave', () => { this.hiCorner = null; this.drawAll(); });
  }

  drawAll() {
    if (!this.G) return;
    this.drawMap();
    this.root.querySelectorAll('.co-chart').forEach((c) => this.drawChart(c));
  }

  drawMap() {
    const c = this.root.querySelector('.co-map');
    if (!c) return;
    const G = this.G, g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i <= G.N; i++) { x0 = Math.min(x0, G.x[i]); x1 = Math.max(x1, G.x[i]); z0 = Math.min(z0, G.z[i]); z1 = Math.max(z1, G.z[i]); }
    const s = Math.min((W - 50) / (x1 - x0 || 1), (H - 50) / (z1 - z0 || 1));
    const ox = (W - (x1 - x0) * s) / 2, oz = (H - (z1 - z0) * s) / 2;
    const P = (i) => [ox + (G.x[i] - x0) * s, oz + (G.z[i] - z0) * s];
    // base
    g.lineCap = g.lineJoin = 'round';
    g.lineWidth = 12; g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); for (let i = 0; i <= G.N; i++) { const [x, y] = P(i); if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke();
    // coloured by where B gains (green) or loses (red) time
    g.lineWidth = 6;
    const step = Math.max(1, Math.floor(G.N / 400));
    for (let i = step; i <= G.N; i += step) {
      const dd = G.delta[i] - G.delta[i - step];
      const k = clamp(dd / (0.012 * step), -1, 1);
      g.strokeStyle = k > 0 ? `rgba(255,${Math.round(200 - k * 150)},${Math.round(80 - k * 50)},${0.35 + Math.abs(k) * 0.65})` : `rgba(${Math.round(120 + k * 80)},${Math.round(220)},${Math.round(130)},${0.35 + Math.abs(k) * 0.65})`;
      const [ax, ay] = P(i - step), [bx, by] = P(i);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    }
    // corners
    g.font = '800 13px "Saira Variable", system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const cn of G.corners) {
      const [x, y] = P(cn.apex);
      const hi = this.hiCorner === cn;
      g.fillStyle = hi ? '#ffd23f' : 'rgba(12,16,22,0.92)';
      g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill();
      g.strokeStyle = cn.delta > 0.03 ? '#ff6a5a' : cn.delta < -0.03 ? '#3ddc84' : 'rgba(255,255,255,0.4)'; g.lineWidth = 2; g.stroke();
      g.fillStyle = hi ? '#141000' : '#fff'; g.fillText(`${cn.n}`, x, y + 0.5);
    }
    // start/finish + hover marker
    const [sx, sy] = P(0);
    g.fillStyle = '#fff'; g.fillRect(sx - 6, sy - 6, 12, 12);
    if (this.hover >= 0) { const [hx, hy] = P(this.hover); g.fillStyle = '#4aa8ff'; g.beginPath(); g.arc(hx, hy, 7, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
  }

  drawChart(c) {
    const G = this.G, kind = c.dataset.ch, g = c.getContext('2d'), W = c.width, H = c.height;
    const padL = 46, padR = 14, padT = 10, padB = 22;
    g.clearRect(0, 0, W, H);
    const X = (i) => padL + (i / G.N) * (W - padL - padR);
    const series = kind === 'speed' ? [[G.vA, '#9aa3ae'], [G.vB, '#ff7a3d']]
      : kind === 'delta' ? [[G.delta, '#4aa8ff']]
        : [[G.thrA, 'rgba(61,220,132,0.55)'], [G.brkA.map((v) => -v), 'rgba(255,90,80,0.55)'], [G.thrB, '#3ddc84'], [G.brkB.map((v) => -v), '#ff5a50']];
    let lo = Infinity, hi = -Infinity;
    for (const [arr] of series) for (const v of arr) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (kind === 'delta') { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.1); lo = -m; hi = m; }
    if (kind === 'pedals') { lo = -1.05; hi = 1.05; }
    if (kind === 'speed') { lo = Math.max(0, lo - 10); hi += 10; }
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
    // corner bands
    for (const cn of G.corners) {
      g.fillStyle = this.hiCorner === cn ? 'rgba(255,210,63,0.16)' : 'rgba(255,255,255,0.035)';
      g.fillRect(X(cn.entry), padT, X(cn.exit) - X(cn.entry), H - padT - padB);
      g.fillStyle = 'rgba(255,255,255,0.4)'; g.font = '700 16px "Saira Variable", system-ui';
      g.fillText(`T${cn.n}`, X(cn.apex) - 8, H - 4);
    }
    // zero / grid
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    if (kind !== 'speed') { g.beginPath(); g.moveTo(padL, Y(0)); g.lineTo(W - padR, Y(0)); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = '600 16px "Inter Variable", system-ui';
    g.fillText(kind === 'speed' ? `${Math.round(hi)}` : kind === 'delta' ? `+${hi.toFixed(1)}s` : 'thr', 2, padT + 12);
    g.fillText(kind === 'speed' ? `${Math.round(lo)}` : kind === 'delta' ? `−${hi.toFixed(1)}s` : 'brk', 2, H - padB);
    for (const [arr, col] of series) {
      g.beginPath();
      arr.forEach((v, i) => { const x = X(i), y = Y(v); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.strokeStyle = col; g.lineWidth = kind === 'pedals' ? 2 : 3; g.stroke();
    }
    if (this.hover >= 0) {
      const x = X(this.hover);
      g.strokeStyle = 'rgba(74,168,255,0.9)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, H - padB); g.stroke();
      g.fillStyle = '#fff'; g.font = '700 16px "Inter Variable", system-ui';
      const lbl = kind === 'speed' ? `A ${Math.round(G.vA[this.hover])}  B ${Math.round(G.vB[this.hover])} km/h · ${Math.round(G.d[this.hover])} m`
        : kind === 'delta' ? `${fmtD(G.delta[this.hover])} s` : `B thr ${Math.round(G.thrB[this.hover] * 100)}% brk ${Math.round(G.brkB[this.hover] * 100)}%`;
      g.fillText(lbl, Math.min(x + 8, W - 330), padT + 14);
    }
  }
}
