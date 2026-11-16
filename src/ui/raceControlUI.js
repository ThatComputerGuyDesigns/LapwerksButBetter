// Race Control director UI: timing tower, incident queue, flags, cameras,
// message ticker, review room with decisions, and the end-of-race report.
import { DECISIONS, FLAGS } from '../game/raceControl.js';
import { RC_CAMERAS } from '../game/controlSession.js';
import { formatTime } from '../core/math.js';
import { audio } from '../audio/audio.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const TYPE_ICON = { contact: '💥', limits: '⚠️', spin: '🌀', stopped: '🛑' };

export class RaceControlUI {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    root.innerHTML = `
      <div class="rc-top">
        <div class="rc-flag"><i></i><b>GREEN</b></div>
        <div class="rc-lap"></div>
        <div class="rc-score" title="Your stewarding score"></div>
        <button class="icon-btn rc-exit" title="Leave race control"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="rc-tower"></div>
      <div class="rc-side">
        <div class="rc-panel-title">Incidents <span class="rc-open"></span></div>
        <div class="rc-incidents"></div>
        <div class="rc-panel-title">Race control messages</div>
        <div class="rc-log"></div>
      </div>
      <div class="rc-bottom">
        <div class="rc-group"><span>Flags</span>
          <button data-flag="green" class="g">Green</button>
          <button data-flag="yellow" data-sector="0" class="y">Yellow S1</button>
          <button data-flag="yellow" data-sector="1" class="y">S2</button>
          <button data-flag="yellow" data-sector="2" class="y">S3</button>
          <button data-flag="vsc" class="o">VSC</button>
          <button data-flag="sc" class="o">Safety car</button>
          <button data-flag="red" class="r">Red</button>
        </div>
        <div class="rc-group"><span>Camera</span>
          <button data-auto class="on">Auto</button>
          ${RC_CAMERAS.map((c) => `<button data-cam="${c}">${{ tv: 'TV', chase: 'Chase', onboard: 'Onboard', heli: 'Heli' }[c]}</button>`).join('')}
        </div>
      </div>
      <div class="rc-ticker"></div>
      <div class="rc-review" hidden>
        <div class="rv-card glass">
          <div class="rv-head"><b class="rv-title"></b><span class="rv-sub"></span></div>
          <div class="rv-controls">
            <button data-rv="play">⏯</button>
            <input type="range" min="0" max="1000" value="0" class="rv-scrub">
            <span class="rv-time"></span>
            <div class="seg small rv-speed"><button data-sp="0.25">¼×</button><button data-sp="0.5" class="on">½×</button><button data-sp="1">1×</button></div>
          </div>
          <div class="rv-angles seg small"><button data-ang="tv" class="on">TV</button><button data-ang="carA">Car A</button><button data-ang="carB">Car B</button><button data-ang="overhead">Overhead</button></div>
          <div class="rv-culprit"></div>
          <div class="rv-decisions">${DECISIONS.map((d) => `<button data-dec="${d.id}" class="${d.id}">${d.label}</button>`).join('')}</div>
          <button class="btn ghost rv-close">Back to live</button>
        </div>
      </div>`;
    this.q = (s) => root.querySelector(s);
    this.bind();
  }

  get S() { return this.app.session; }

  bind() {
    const r = this.root;
    r.querySelector('.rc-exit').addEventListener('click', () => { audio.click(); this.app.showHome(); });
    r.querySelector('.rc-bottom').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.S) return;
      audio.click();
      if (b.dataset.flag) this.S.rc.setFlag(b.dataset.flag, +b.dataset.sector);
      if (b.dataset.auto !== undefined) { this.S.autoDirector = !this.S.autoDirector; b.classList.toggle('on', this.S.autoDirector); }
      if (b.dataset.cam) { this.S.camMode = b.dataset.cam; this.S.camInit = false; }
      this.render(true);
    });
    r.querySelector('.rc-tower').addEventListener('click', (e) => {
      const row = e.target.closest('[data-car]');
      if (!row || !this.S) return;
      audio.click();
      const entry = this.S.field.cars[+row.dataset.car];
      this.S.setFocus(entry);
      this.S.autoDirector = false;
      this.q('[data-auto]').classList.remove('on');
    });
    r.querySelector('.rc-incidents').addEventListener('click', (e) => {
      const b = e.target.closest('[data-review]');
      if (!b || !this.S) return;
      audio.click();
      const inc = this.S.rc.incidents.find((i) => i.id === +b.dataset.review);
      if (inc) this.openReview(inc);
    });
    const rv = r.querySelector('.rc-review');
    rv.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.S?.review) return;
      const R = this.S.review;
      audio.click();
      if (b.dataset.rv === 'play') R.playing = !R.playing;
      if (b.dataset.sp) { R.speed = +b.dataset.sp; rv.querySelectorAll('[data-sp]').forEach((x) => x.classList.toggle('on', x === b)); }
      if (b.dataset.ang) { R.angle = b.dataset.ang; rv.querySelectorAll('[data-ang]').forEach((x) => x.classList.toggle('on', x === b)); }
      if (b.dataset.culprit !== undefined) { this.culprit = +b.dataset.culprit; this.renderCulprit(); }
      if (b.dataset.dec) {
        const inc = R.inc;
        const target = inc.cars[this.culprit] || inc.cars[0];
        const res = this.S.rc.decide(inc.id, b.dataset.dec, target);
        if (res) this.message(`Decision: ${DECISIONS.find((d) => d.id === b.dataset.dec).label} · ${res.verdict}${res.pts ? ` (${res.pts > 0 ? '+' : ''}${res.pts})` : ''}`);
        this.closeReview();
      }
      if (b.classList.contains('rv-close')) this.closeReview();
    });
    rv.querySelector('.rv-scrub').addEventListener('input', (e) => {
      const R = this.S?.review;
      if (!R) return;
      R.t = R.t0 + (R.t1 - R.t0) * (+e.target.value / 1000);
      R.playing = false;
    });
  }

  openReview(inc) {
    this.S.openReview(inc);
    this.culprit = inc.fault ? inc.cars.indexOf(inc.fault) : 0;
    if (this.culprit < 0) this.culprit = 0;
    this.q('.rv-title').textContent = `Incident ${inc.id} · ${inc.title}`;
    this.q('.rv-sub').textContent = `Lap ${inc.lap} · sector ${inc.sector + 1}${inc.speed ? ` · ${(inc.speed * 3.6).toFixed(0)} km/h closing` : ''}${inc.count ? ` · strike ${inc.count}` : ''}`;
    this.q('.rv-decisions').hidden = !inc.expected && inc.type !== 'contact' && inc.type !== 'limits';
    this.renderCulprit();
    this.q('.rc-review').hidden = false;
  }

  renderCulprit() {
    const inc = this.S.review?.inc;
    if (!inc) return;
    this.q('.rv-culprit').innerHTML = inc.cars.length > 1
      ? `<span>Penalise:</span>${inc.cars.map((c, k) => `<button data-culprit="${k}" class="${k === this.culprit ? 'on' : ''}">#${c.setup.number} ${esc(c.name)}</button>`).join('')}`
      : `<span>Driver:</span><b>#${inc.cars[0].setup.number} ${esc(inc.cars[0].name)}</b>`;
  }

  closeReview() {
    this.S?.closeReview();
    if (this.S) this.S.setFocus(this.S.focus);
    this.q('.rc-review').hidden = true;
    this.render(true);
  }

  message(text) {
    const t = this.q('.rc-ticker');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.tickT);
    this.tickT = setTimeout(() => t.classList.remove('show'), 3500);
  }

  incidentsChanged() { this.dirtyInc = true; }

  render(force) {
    const S = this.S;
    if (!S || !S.rc) return;
    this.frame = (this.frame || 0) + 1;
    const RC = S.rc, F = S.field;
    // review scrubber
    if (S.review) {
      const R = S.review;
      this.q('.rv-scrub').value = String(Math.round(((R.t - R.t0) / (R.t1 - R.t0)) * 1000));
      this.q('.rv-time').textContent = `${(R.t - R.inc.time).toFixed(1)} s`;
    }
    if (!force && this.frame % 8) return;
    // flag
    const sectors = [...RC.yellowSectors].map((s) => s + 1);
    const f = RC.flag !== 'green' ? FLAGS[RC.flag] : sectors.length ? { label: `YELLOW S${sectors.join(',')}`, color: FLAGS.yellow.color } : FLAGS.green;
    this.q('.rc-flag b').textContent = RC.scEnding ? 'SC IN THIS LAP' : f.label;
    this.q('.rc-flag i').style.background = f.color;
    const order = F.order();
    const lead = order[0];
    this.q('.rc-lap').textContent = `LAP ${Math.min(F.laps, lead.lapsDone + 1)}/${F.laps}  ·  ${formatTime(S.raceTime)}`;
    const rep = RC.report();
    this.q('.rc-score').innerHTML = `<b>${rep.grade}</b><span>Steward ${rep.correct}/${rep.decisions}</span><span>Safety ${Math.round(rep.safety)}%</span>`;
    // tower
    const L = this.app.track.length;
    let html = '';
    order.forEach((r, k) => {
      const idx = F.cars.indexOf(r);
      let gap = '';
      if (k === 0) gap = r.finished != null ? 'FIN' : 'Leader';
      else if (r.dsq) gap = 'DSQ';
      else {
        const ahead = order[k - 1];
        let g = F.rank(ahead) - F.rank(r);
        gap = g > L ? `+${Math.floor(g / L)}L` : `+${(g / Math.max(r.car.u, 20)).toFixed(1)}`;
      }
      const tags = `${r.penalty ? `<em class="pen">+${r.penalty}s</em>` : ''}${r.warnings ? `<em class="warn">W${r.warnings}</em>` : ''}${r.stoppedT > 1 ? '<em class="stop">STOP</em>' : ''}`;
      html += `<div data-car="${idx}" class="${r === S.focus ? 'focus' : ''} ${r.dsq ? 'dsq' : ''}"><b>${k + 1}</b><i style="background:${r.setup.paint}"></i><span>${esc(r.name)}</span>${tags}<small>${gap}</small></div>`;
    });
    if (html !== this.lastTower) { this.q('.rc-tower').innerHTML = html; this.lastTower = html; }
    // incidents (open first)
    if (force || this.dirtyInc || this.frame % 30 === 0) {
      this.dirtyInc = false;
      const list = RC.incidents.slice(0, 40);
      const open = RC.incidents.filter((i) => i.status === 'open' && (i.type === 'contact' || i.type === 'limits')).length;
      this.q('.rc-open').textContent = open ? `${open} to review` : '';
      this.q('.rc-incidents').innerHTML = list.length ? list.map((i) => `
        <div class="inc ${i.status} sev${i.severity}">
          <span class="ic">${TYPE_ICON[i.type] || '•'}</span>
          <div><b>${esc(i.title)}</b><small>L${i.lap} S${i.sector + 1} · ${i.cars.map((c) => '#' + c.setup.number + ' ' + esc(c.name.split(' ').pop())).join(' / ')}</small>
          ${i.status === 'decided' ? `<small class="dec">${DECISIONS.find((d) => d.id === i.decision)?.label}${i.verdict ? ' · ' + i.verdict : ''}</small>` : ''}</div>
          <button data-review="${i.id}">${i.status === 'decided' ? 'Replay' : 'Review'}</button>
        </div>`).join('') : '<p class="empty">No incidents yet. Watch the race and keep it safe.</p>';
      this.q('.rc-log').innerHTML = RC.log.slice(0, 6).map((l) => `<div><span>${formatTime(l.t).slice(0, -4)}</span>${esc(l.text)}</div>`).join('');
    }
  }
}
