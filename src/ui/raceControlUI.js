// Race Control desk: timing tower, track-status alerts with one-click
// responses, a stewards' case list, case-file review with evidence, flags,
// cameras, time controls, keyboard shortcuts and the end-of-race report.
import { DECISIONS, FLAGS } from '../game/raceControl.js';
import { formatTime } from '../core/math.js';
import { audio } from '../audio/audio.js';
import { Broadcast, code } from './broadcast.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const chip = (r) => `<span class="rc-chip"><i style="background:${r.setup.paint}"></i>#${r.setup.number} ${esc(r.name.split(' ').pop())}</span>`;
const isCase = (i) => i.type === 'contact' || i.type === 'limits';
const KEYS = { nfa: '1', warn: '2', p5: '3', p10: '4', dt: '5', dsq: '6' };

export class RaceControlUI {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.tab = 'cases';
    this.dismissed = new Set();
    root.innerHTML = `
      <div class="rc-top">
        <div class="rc-flag"><i></i><b>GREEN</b></div>
        <div class="rc-lap"></div>
        <div class="seg small rc-speed" title="Time"><button data-speed="1" class="on">1×</button><button data-speed="2">2×</button><button data-speed="4">4×</button></div>
        <div class="rc-score" title="Your stewarding score"></div>
        <button class="icon-btn rc-help" title="Shortcuts">?</button>
        <button class="icon-btn rc-exit" title="Leave race control"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="rc-alerts"></div>
      <div class="bc"></div>
      <div class="rc-desk">
        <div class="rc-tabs"><button data-tab="cases" class="on">Cases <em class="rc-count"></em></button><button data-tab="decided">Decided</button><button data-tab="log">Log</button></div>
        <div class="rc-list"></div>
      </div>
      <div class="rc-bottom">
        <div class="rc-group"><span>Flags</span>
          <button data-flag="green" class="g" title="Green / safety car in">Green</button>
          <button data-flag="yellow" data-sector="0" class="y">Y·S1</button>
          <button data-flag="yellow" data-sector="1" class="y">Y·S2</button>
          <button data-flag="yellow" data-sector="2" class="y">Y·S3</button>
          <button data-flag="vsc" class="o">VSC</button>
          <button data-flag="sc" class="o">Safety car</button>
          <button data-flag="red" class="r">Red</button>
        </div>
        <div class="rc-group"><span>Camera</span>
          <button data-auto class="on" title="Auto director">Director</button>
          <button data-cam="tv">TV</button><button data-cam="heli">Heli</button><button data-cam="chase">Chase</button><button data-cam="onboard">Onboard</button>
        </div>
      </div>
      <div class="rc-ticker"></div>
      <div class="rc-review" hidden>
        <div class="rv-card glass">
          <div class="rv-head"><b class="rv-title"></b><span class="rv-sub"></span><button class="icon-btn rv-x" title="Back to live (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
          <div class="rv-grid">
            <div class="rv-evidence"></div>
            <div class="rv-right">
              <div class="rv-controls">
                <button data-rv="play" title="Play / pause (Space)">⏯</button>
                <input type="range" min="0" max="1000" value="0" class="rv-scrub">
                <span class="rv-time"></span>
              </div>
              <div class="rv-row"><div class="seg small rv-speed"><button data-sp="0.25">¼×</button><button data-sp="0.5" class="on">½×</button><button data-sp="1">1×</button></div>
                <div class="seg small rv-angles"><button data-ang="tv" class="on">TV</button><button data-ang="carA">Car A</button><button data-ang="carB">Car B</button><button data-ang="overhead">Above</button></div></div>
              <div class="rv-culprit"></div>
              <div class="rv-decisions">${DECISIONS.map((d) => `<button data-dec="${d.id}" class="${d.id}"><kbd>${KEYS[d.id]}</kbd>${d.label}</button>`).join('')}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="rc-shortcuts glass" hidden>
        <b>Shortcuts</b>
        <span><kbd>R</kbd> review next case</span><span><kbd>1</kbd>–<kbd>6</kbd> rulings in review</span><span><kbd>Space</kbd> play / pause replay</span>
        <span><kbd>H</kbd> clean TV view (hide the desk)</span><span><kbd>Esc</kbd> back to live</span><span><kbd>Tab</kbd> camera</span><span><kbd>F</kbd> time 1× / 2× / 4×</span><span><kbd>Y</kbd> yellow in the focused car's sector</span>
      </div>`;
    this.q = (s) => root.querySelector(s);
    this.bc = new Broadcast(this.q('.bc'));
    this.bind();
  }

  get S() { return this.app.session?.rc ? this.app.session : null; }

  bind() {
    const r = this.root;
    r.querySelector('.rc-exit').addEventListener('click', () => { audio.click(); this.app.showHome(); });
    r.querySelector('.rc-help').addEventListener('click', () => { this.q('.rc-shortcuts').hidden = !this.q('.rc-shortcuts').hidden; });
    r.querySelector('.rc-speed').addEventListener('click', (e) => { const b = e.target.closest('[data-speed]'); if (b) this.setSpeed(+b.dataset.speed); });
    r.querySelector('.rc-bottom').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.S) return;
      audio.click();
      if (b.dataset.flag) this.S.rc.setFlag(b.dataset.flag, +b.dataset.sector);
      if (b.dataset.auto !== undefined) { this.S.autoDirector = !this.S.autoDirector; }
      if (b.dataset.cam) { this.S.camMode = b.dataset.cam; this.S.camInit = false; this.S.shotT = 0; this.S.autoDirector = false; }
      this.render(true);
    });
    r.querySelector('.bc').addEventListener('click', (e) => {
      const row = e.target.closest('[data-car]');
      if (!row || !this.S) return;
      audio.click();
      this.S.setFocus(this.S.field.cars[+row.dataset.car]);
      this.S.autoDirector = false;
      this.render(true);
    });
    r.querySelector('.rc-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      this.tab = b.dataset.tab;
      r.querySelectorAll('.rc-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      this.render(true);
    });
    r.querySelector('.rc-list').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.S) return;
      audio.click();
      const inc = this.S.rc.incidents.find((i) => i.id === +(b.dataset.review || b.dataset.quick));
      if (!inc) return;
      if (b.dataset.review) this.openReview(inc);
      else this.rule(inc, 'nfa', inc.cars[0]);
    });
    r.querySelector('.rc-alerts').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.S) return;
      audio.click();
      if (b.dataset.act === 'dismiss') this.dismissed.add(+b.dataset.inc);
      else if (b.dataset.act === 'watch') { const inc = this.S.rc.incidents.find((i) => i.id === +b.dataset.inc); if (inc) { this.S.setFocus(inc.cars[0]); this.S.autoDirector = false; } }
      else { this.S.rc.setFlag(b.dataset.act, +b.dataset.sector); this.dismissed.add(+b.dataset.inc); }
      this.render(true);
    });
    const rv = r.querySelector('.rc-review');
    rv.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.S?.review) return;
      const R = this.S.review;
      audio.click();
      if (b.dataset.rv === 'play') R.playing = !R.playing;
      if (b.dataset.sp) { R.speed = +b.dataset.sp; rv.querySelectorAll('[data-sp]').forEach((x) => x.classList.toggle('on', x === b)); }
      if (b.dataset.ang) { R.angle = b.dataset.ang; this.S.camInit = false; rv.querySelectorAll('[data-ang]').forEach((x) => x.classList.toggle('on', x === b)); }
      if (b.dataset.culprit !== undefined) { this.culprit = +b.dataset.culprit; this.renderCulprit(); }
      if (b.dataset.dec) this.rule(R.inc, b.dataset.dec, R.inc.cars[this.culprit] || R.inc.cars[0]);
      if (b.classList.contains('rv-x')) this.closeReview();
    });
    rv.querySelector('.rv-scrub').addEventListener('input', (e) => {
      const R = this.S?.review;
      if (!R) return;
      R.t = R.t0 + (R.t1 - R.t0) * (+e.target.value / 1000);
      R.playing = false;
    });
    window.addEventListener('keydown', (e) => this.key(e));
  }

  key(e) {
    if (this.app.screen !== 'control' || !this.S || e.target.tagName === 'INPUT') return;
    const S = this.S;
    if (S.review) {
      const d = Object.entries(KEYS).find(([, k]) => k === e.key);
      if (d) { e.preventDefault(); this.rule(S.review.inc, d[0], S.review.inc.cars[this.culprit] || S.review.inc.cars[0]); return; }
      if (e.code === 'Space') { e.preventDefault(); S.review.playing = !S.review.playing; }
      if (e.code === 'ArrowLeft') S.review.t = Math.max(S.review.t0, S.review.t - 0.5);
      if (e.code === 'ArrowRight') S.review.t = Math.min(S.review.t1, S.review.t + 0.5);
      return;
    }
    if (e.code === 'KeyR') { const next = this.pending()[0]; if (next) this.openReview(next); }
    if (e.code === 'Tab') { e.preventDefault(); S.cycleCamera(); S.autoDirector = false; S.shotT = 0; }
    if (e.code === 'KeyF') this.setSpeed(S.timeScale === 1 ? 2 : S.timeScale === 2 ? 4 : 1);
    if (e.code === 'KeyY') S.rc.setFlag('yellow', S.rc.sectorOf(S.car.q.s));
    if (e.code === 'KeyH') this.root.classList.toggle('clean');
  }

  setSpeed(k) {
    if (!this.S) return;
    this.S.timeScale = k;
    this.root.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed === k));
  }

  pending() { return this.S ? this.S.rc.incidents.filter((i) => i.status === 'open' && isCase(i)).sort((a, b) => a.time - b.time) : []; }

  rule(inc, decId, target) {
    const res = this.S.rc.decide(inc.id, decId, target);
    if (res) {
      const d = DECISIONS.find((x) => x.id === decId);
      const why = inc.type === 'limits' ? 'TRACK LIMITS' : 'CAUSING A COLLISION';
      const carTxt = `CAR ${target.setup.number} (${code(target)})`;
      this.bc.message(decId === 'nfa' ? `${inc.cars.map((c) => `CAR ${c.setup.number} (${code(c)})`).join(' AND ')} — NO FURTHER INVESTIGATION` : decId === 'warn' ? `BLACK AND WHITE FLAG FOR ${carTxt} — ${why}` : decId === 'dsq' ? `${carTxt} DISQUALIFIED — ${why}` : `${d.label.toUpperCase()} FOR ${carTxt} — ${why}`);
      this.message(`${d.label}${decId !== 'nfa' ? ` · #${target.setup.number} ${target.name}` : ''}`);
      audio.beep(decId === 'nfa' ? 660 : 880, 0.12, 0.12, 'triangle');
    }
    if (this.S.review) this.closeReview();
    this.render(true);
  }

  openReview(inc) {
    this.S.openReview(inc);
    if (isCase(inc) && inc.status === 'open' && !inc.investigating) { inc.investigating = true; this.bc.message(`${inc.cars.map((c) => `CAR ${c.setup.number} (${code(c)})`).join(' AND ')} — UNDER INVESTIGATION`); }
    this.culprit = inc.fault ? Math.max(0, inc.cars.indexOf(inc.fault)) : 0;
    this.q('.rv-title').textContent = `Case ${inc.id} · ${inc.title}`;
    this.q('.rv-sub').textContent = `Lap ${inc.lap} · Sector ${inc.sector + 1} · ${formatTime(inc.time).slice(0, -4)}`;
    this.q('.rv-evidence').innerHTML = this.evidenceHTML(inc);
    this.q('.rv-decisions').hidden = !isCase(inc) || inc.status === 'decided';
    this.root.querySelectorAll('[data-ang]').forEach((x) => x.classList.toggle('on', x.dataset.ang === 'tv'));
    this.renderCulprit();
    this.q('.rc-review').hidden = false;
    this.root.classList.add('reviewing');
  }

  evidenceHTML(inc) {
    const E = inc.evidence;
    if (inc.type === 'contact' && E) {
      const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
      return `<div class="ev-cars">${chip(E.behind)}<em>behind</em>${chip(E.ahead)}<em>ahead</em></div>
        ${row('Closing speed', `${E.closing.toFixed(0)} km/h`)}
        ${row('Overlap at contact', `${E.overlap}% ${E.overlap > 45 ? '(alongside)' : '(not alongside)'}`)}
        ${row(`Speed #${E.behind.setup.number} / #${E.ahead.setup.number}`, `${E.speedA.toFixed(0)} / ${E.speedB.toFixed(0)} km/h`)}
        ${row('Braking', `${E.brakeA > 0.2 ? 'yes' : 'no'} / ${E.brakeB > 0.2 ? 'yes' : 'no'}`)}
        ${row('Moved across', E.moverA ? `#${E.behind.setup.number}` : E.moverB ? `#${E.ahead.setup.number}` : 'neither')}
        ${row('Consequence', inc.consequence ? 'victim lost places / spun' : inc.checkAt ? 'assessing…' : 'none')}
        ${inc.status === 'decided' ? `<p class="ev-verdict">Ruling: ${DECISIONS.find((d) => d.id === inc.decision)?.label} · ${inc.verdict}</p>` : ''}`;
    }
    if (inc.type === 'limits') return `<div class="ev-cars">${chip(inc.cars[0])}</div><div><span>Track-limit strikes</span><b>${inc.count}</b></div><p class="ev-note">Guideline: warning after 3, then penalties for repeat offences.</p>`;
    return `<div class="ev-cars">${chip(inc.cars[0])}</div><p class="ev-note">${inc.type === 'stopped' ? (inc.onTrack ? 'Stopped in the racing line. Neutralise the race.' : 'Stopped off the circuit. Local yellows protect the marshals.') : 'Spin. Watch for a stopped car.'}</p>`;
  }

  renderCulprit() {
    const inc = this.S?.review?.inc;
    if (!inc) return;
    this.q('.rv-culprit').innerHTML = inc.cars.length > 1 && isCase(inc) && inc.status !== 'decided'
      ? `<span>Penalise</span>${inc.cars.map((c, k) => `<button data-culprit="${k}" class="${k === this.culprit ? 'on' : ''}">#${c.setup.number} ${esc(c.name)}</button>`).join('')}`
      : '';
  }

  closeReview() {
    this.S?.closeReview();
    if (this.S) this.S.setFocus(this.S.focus);
    this.q('.rc-review').hidden = true;
    this.root.classList.remove('reviewing');
    this.render(true);
  }

  message(text) {
    const t = this.q('.rc-ticker');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.tickT);
    this.tickT = setTimeout(() => t.classList.remove('show'), 3200);
  }

  incidentsChanged(inc) {
    this.dirty = true;
    if (inc && isCase(inc)) this.bc.message(`${inc.title === 'Track limits' ? `CAR ${inc.cars[0].setup.number} (${code(inc.cars[0])}) — TRACK LIMITS NOTED` : `${inc.cars.map((c) => `CAR ${c.setup.number} (${code(c)})`).join(' AND ')} — INCIDENT NOTED`}`);
    if (inc && inc.type === 'stopped' && inc.onTrack) this.bc.message(`CAR ${inc.cars[0].setup.number} (${code(inc.cars[0])}) STOPPED ON TRACK`);
  }

  render(force) {
    const S = this.S;
    if (!S) return;
    this.frame = (this.frame || 0) + 1;
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastT || now)) / 1000);
    this.lastT = now;
    if (S.field) this.bc.update(S, dt);
    const RC = S.rc, F = S.field;
    if (S.review) {
      const R = S.review;
      this.q('.rv-scrub').value = String(Math.round(((R.t - R.t0) / Math.max(R.t1 - R.t0, 0.01)) * 1000));
      const rel = R.t - R.inc.time;
      this.q('.rv-time').textContent = `${rel >= 0 ? '+' : '−'}${Math.abs(rel).toFixed(1)} s`;
      if (this.frame % 10 === 0) this.q('.rv-evidence').innerHTML = this.evidenceHTML(R.inc);
    }
    if (!force && this.frame % 6) return;
    // flag + clock
    const sectors = [...RC.yellowSectors].map((x) => x + 1);
    const f = RC.flag !== 'green' ? FLAGS[RC.flag] : sectors.length ? { label: `YELLOW S${sectors.join(' S')}`, color: FLAGS.yellow.color } : FLAGS.green;
    this.q('.rc-flag b').textContent = RC.scEnding ? 'SC IN THIS LAP' : f.label;
    this.q('.rc-flag i').style.background = f.color;
    this.q('.rc-flag').style.borderColor = f.color;
    const order = F.order();
    this.q('.rc-lap').textContent = `LAP ${Math.min(F.laps, order[0].lapsDone + 1)}/${F.laps} · ${formatTime(S.raceTime).slice(0, -4)}`;
    const rep = RC.report();
    this.q('.rc-score').innerHTML = `<b>${rep.grade}</b><span>Rulings ${rep.correct}/${rep.decisions}</span><span>Safety ${Math.round(rep.safety)}%</span>`;
    this.root.querySelectorAll('[data-auto]').forEach((b) => b.classList.toggle('on', S.autoDirector));
    this.root.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('on', !S.autoDirector && b.dataset.cam === S.camMode));
    // track-status alerts (stopped cars, uncovered danger) with one-click responses
    const alerts = RC.incidents.filter((i) => i.type === 'stopped' && i.status === 'open' && !this.dismissed.has(i.id)).slice(0, 2);
    const ah = alerts.map((i) => {
      const covered = i.onTrack ? ['sc', 'vsc', 'red'].includes(RC.flag) : RC.flag !== 'green' || RC.yellowSectors.has(i.sector);
      return `<div class="rc-alert ${covered ? 'ok' : ''}"><b>${covered ? '✓' : '⚠'} ${esc(i.title)} · S${i.sector + 1}</b><span>${chip(i.cars[0])}</span>
        <div>${covered ? '' : i.onTrack ? `<button data-act="vsc" data-inc="${i.id}">VSC</button><button data-act="sc" data-inc="${i.id}">Safety car</button>` : `<button data-act="yellow" data-sector="${i.sector}" data-inc="${i.id}">Yellow S${i.sector + 1}</button>`}
        <button data-act="watch" data-inc="${i.id}">Watch</button><button data-act="dismiss" data-inc="${i.id}">✕</button></div></div>`;
    }).join('');
    if (ah !== this.lastAlerts) { this.q('.rc-alerts').innerHTML = ah; this.lastAlerts = ah; }
    // desk
    const pend = this.pending();
    this.q('.rc-count').textContent = pend.length ? String(pend.length) : '';
    if (force || this.dirty || this.frame % 30 === 0) {
      this.dirty = false;
      let list;
      if (this.tab === 'log') list = RC.log.slice(0, 30).map((l) => `<div class="rc-logline"><span>${formatTime(l.t).slice(0, -4)}</span>${esc(l.text)}</div>`).join('') || '<p class="empty">Nothing yet.</p>';
      else {
        const items = this.tab === 'cases' ? pend : RC.incidents.filter((i) => i.status === 'decided' || !isCase(i));
        list = items.slice(0, 40).map((i) => `
          <div class="case ${i.status} sev${i.severity}">
            <div class="case-top"><b>${esc(i.title)}</b><small>L${i.lap} · S${i.sector + 1}</small></div>
            <div class="case-cars">${i.cars.map(chip).join('')}</div>
            ${i.status === 'decided' ? `<small class="dec">${DECISIONS.find((d) => d.id === i.decision)?.label} · ${i.verdict}</small>` : ''}
            <div class="case-btns"><button data-review="${i.id}">${i.status === 'decided' ? 'Replay' : 'Review'}</button>${i.status === 'open' && isCase(i) ? `<button data-quick="${i.id}" class="ghost">No action</button>` : ''}</div>
          </div>`).join('') || `<p class="empty">${this.tab === 'cases' ? 'No open cases. Keep an eye on the racing.' : 'Nothing decided yet.'}</p>`;
      }
      if (list !== this.lastList) { this.q('.rc-list').innerHTML = list; this.lastList = list; }
    }
  }
}
