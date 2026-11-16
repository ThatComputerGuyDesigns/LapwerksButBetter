// TV broadcast graphics package (Race Control): animated timing tower,
// lower-thirds, battle gaps, race-control message bar, fastest-lap and
// safety-car banners, featured-car telemetry. Original design.
import { formatTime, clamp } from '../core/math.js';
import { BODIES } from '../physics/carSetup.js';

export const code = (r) => r.name.split(' ').pop().slice(0, 3).toUpperCase();
const ROW = 27;

export class Broadcast {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="bc-tower">
        <div class="bc-head"><span class="bc-brand">K</span><b class="bc-lap">LAP 1/6</b><i class="bc-flag"></i></div>
        <div class="bc-rows"></div>
        <div class="bc-mode">INTERVAL</div>
      </div>
      <div class="bc-banner"></div>
      <div class="bc-battle"></div>
      <div class="bc-lower"></div>
      <div class="bc-tele">
        <div class="bc-tele-name"></div>
        <div class="bc-tele-main"><b class="bc-spd">0</b><small>KM/H</small><b class="bc-gear">1</b></div>
        <div class="bc-bars"><i class="bc-thr"></i><i class="bc-brk"></i></div>
        <div class="bc-rpm"><i></i></div>
      </div>
      <div class="bc-msg"><span>RACE CONTROL</span><b></b></div>`;
    this.q = (s) => root.querySelector(s);
    this.rows = new Map();
    this.modeT = 0;
    this.gapMode = 'interval';
    this.msgQueue = [];
    this.bestLap = null;
  }

  /** Queue a race-control message (F1-style bar). */
  message(text) {
    this.msgQueue.push(text.toUpperCase());
  }

  banner(text, kind, dur = 5) {
    const b = this.q('.bc-banner');
    b.className = `bc-banner show ${kind}`;
    b.innerHTML = text;
    clearTimeout(this.bannerT);
    if (dur) this.bannerT = setTimeout(() => (b.className = 'bc-banner'), dur * 1000);
  }

  lowerThird(r, pos, gapText) {
    const el = this.q('.bc-lower');
    el.innerHTML = `<b class="bc-pos">${pos}</b><i style="background:${r.setup.paint}"></i><div><span>${r.name.toUpperCase()}</span><small>#${r.setup.number} · ${BODIES[r.setup.body]?.name || ''}</small></div><em>${gapText}</em>`;
    el.classList.add('show');
    clearTimeout(this.lowerT);
    this.lowerT = setTimeout(() => el.classList.remove('show'), 5500);
  }

  update(S, dt) {
    const F = S.field, RC = S.rc;
    const order = F.order();
    const L = S.T.length;
    // gap mode alternates like real coverage
    this.modeT += dt;
    if (this.modeT > 9) { this.modeT = 0; this.gapMode = this.gapMode === 'interval' ? 'leader' : 'interval'; this.q('.bc-mode').textContent = this.gapMode === 'interval' ? 'INTERVAL' : 'LEADER'; }
    // tower header
    this.q('.bc-lap').textContent = `LAP ${Math.min(F.laps, order[0].lapsDone + 1)}/${F.laps}`;
    const flagCol = RC.flag === 'red' ? '#ff3b30' : RC.flag === 'sc' || RC.flag === 'vsc' ? '#ffb020' : RC.yellowSectors.size ? '#ffd23f' : '#2fd06b';
    this.q('.bc-flag').style.background = flagCol;
    // rows (persistent elements that slide to their new place)
    const host = this.q('.bc-rows');
    host.style.height = `${order.length * ROW}px`;
    const leadRank = F.rank(order[0]);
    order.forEach((r, k) => {
      let el = this.rows.get(r);
      if (!el) {
        el = document.createElement('div');
        el.className = 'bc-row';
        el.dataset.car = String(F.cars.indexOf(r));
        el.innerHTML = `<b class="p"></b><i style="background:${r.setup.paint}"></i><span>${code(r)}</span><em></em><small></small>`;
        host.appendChild(el);
        this.rows.set(r, el);
        el.style.transform = `translateY(${k * ROW}px)`;
      }
      const y = `translateY(${k * ROW}px)`;
      if (el.style.transform !== y) {
        // flash a position gain
        const prev = +el.dataset.pos || k + 1;
        if (k + 1 < prev && S.raceTime > 5) { el.classList.remove('gain'); void el.offsetWidth; el.classList.add('gain'); }
        el.style.transform = y;
      }
      el.dataset.pos = String(k + 1);
      el.querySelector('.p').textContent = String(k + 1);
      let gap = '';
      if (r.dsq) gap = 'DSQ';
      else if (r.stoppedT > 2) gap = 'STOP';
      else if (k === 0) gap = r.finished != null ? 'FIN' : 'LEADER';
      else {
        const ref = this.gapMode === 'interval' ? F.rank(order[k - 1]) : leadRank;
        const g = ref - F.rank(r);
        gap = g > L * 0.98 ? `+${Math.max(1, Math.round(g / L))} LAP` : `+${(g / Math.max(r.car.u, 18)).toFixed(1)}`;
      }
      const sm = el.querySelector('small');
      if (sm.textContent !== gap) sm.textContent = gap;
      const pen = r.penalty ? `+${r.penalty}s` : '';
      const em = el.querySelector('em');
      if (em.textContent !== pen) em.textContent = pen;
      el.classList.toggle('focus', r === S.focus);
      el.classList.toggle('out', !!r.dsq);
    });
    // featured car: lower third when the director changes focus
    if (S.focus !== this.lastFocus) {
      this.lastFocus = S.focus;
      const k = order.indexOf(S.focus);
      if (k >= 0 && S.raceTime > 3) {
        const ahead = order[k - 1];
        const g = ahead ? (F.rank(ahead) - F.rank(S.focus)) / Math.max(S.focus.car.u, 18) : 0;
        this.lowerThird(S.focus, k + 1, k === 0 ? 'LEADER' : `+${g.toFixed(1)} TO P${k}`);
      }
    }
    // battle graphic: featured car within a second of the car ahead
    const k = order.indexOf(S.focus);
    const bt = this.q('.bc-battle');
    if (k > 0 && RC.flag === 'green') {
      const a = order[k - 1];
      const g = (F.rank(a) - F.rank(S.focus)) / Math.max(S.focus.car.u, 18);
      if (g < 1.0 && !a.dsq) {
        bt.innerHTML = `<span>BATTLE FOR P${k}</span><div><i style="background:${a.setup.paint}"></i><b>${code(a)}</b><em>${g.toFixed(1)}</em><b>${code(S.focus)}</b><i style="background:${S.focus.setup.paint}"></i></div>`;
        bt.classList.add('show');
      } else bt.classList.remove('show');
    } else bt.classList.remove('show');
    // fastest lap
    for (const r of F.cars) {
      if (r.best != null && (this.bestLap == null || r.best < this.bestLap - 1e-6) && S.raceTime > 20) {
        if (this.bestLap != null || r.lapsDone > 1) this.banner(`<b>FASTEST LAP</b><i style="background:${r.setup.paint}"></i><span>${r.name.toUpperCase()}</span><em>${formatTime(r.best)}</em>`, 'purple', 5);
        this.bestLap = r.best;
      }
    }
    // neutralisation banners
    const key = RC.flag + (RC.scEnding ? 'end' : '');
    if (key !== this.lastFlag) {
      this.lastFlag = key;
      if (RC.flag === 'sc') this.banner(RC.scEnding ? '<b>SAFETY CAR IN THIS LAP</b>' : '<b>SAFETY CAR</b>', 'yellow', RC.scEnding ? 6 : 0);
      else if (RC.flag === 'vsc') this.banner('<b>VIRTUAL SAFETY CAR</b>', 'yellow', 0);
      else if (RC.flag === 'red') this.banner('<b>RED FLAG</b><span>SESSION SUSPENDED</span>', 'red', 0);
      else if (S.raceTime > 3) this.banner('<b>GREEN FLAG</b><span>TRACK CLEAR</span>', 'green', 4);
    }
    // telemetry of the featured car
    const c = S.focus.car;
    this.q('.bc-tele-name').innerHTML = `<i style="background:${S.focus.setup.paint}"></i>${code(S.focus)} <small>P${k + 1}</small>`;
    this.q('.bc-spd').textContent = String(Math.round(c.speed * 3.6));
    this.q('.bc-gear').textContent = c.gear === -1 ? 'R' : String(c.gear);
    this.q('.bc-thr').style.transform = `scaleX(${clamp(c.throttle, 0, 1).toFixed(2)})`;
    this.q('.bc-brk').style.transform = `scaleX(${clamp(c.brake, 0, 1).toFixed(2)})`;
    this.q('.bc-rpm i').style.transform = `scaleX(${clamp(c.rpm / c.p.engine.redline, 0, 1).toFixed(2)})`;
    // race-control message bar
    this.msgT = (this.msgT || 0) - dt;
    if (this.msgT <= 0 && this.msgQueue.length) {
      const m = this.q('.bc-msg');
      m.querySelector('b').textContent = this.msgQueue.shift();
      m.classList.add('show');
      this.msgT = 5;
      clearTimeout(this.msgHide);
      this.msgHide = setTimeout(() => m.classList.remove('show'), 4800);
    }
  }

  reset() {
    this.q('.bc-rows').innerHTML = '';
    this.rows.clear();
    this.bestLap = null;
    this.lastFocus = null;
    this.lastFlag = null;
    this.msgQueue = [];
  }
}
