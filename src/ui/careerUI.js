// Career hub: tiers of events, briefing, dealership, rewards.
import { TIERS, EVENT_TYPES, CAR_PRICES, findEvent, eventTrackDef, className } from '../game/career.js';
import { BODIES } from '../physics/carSetup.js';
import { PRESETS } from '../track/presets.js';
import { audio } from '../audio/audio.js';

const stars = (n) => '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n);
const money = (n) => `₡${Math.round(n).toLocaleString()}`;

export class CareerUI {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.tab = 'events';
    root.addEventListener('click', (e) => this.onClick(e));
  }

  get C() { return this.app.career; }

  open() { this.root.hidden = false; this.render(); }
  close() { this.root.hidden = true; }

  render() {
    const C = this.C;
    const head = `
      <div class="cr-head">
        <button class="icon-btn" data-cr="back" title="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div class="cr-title"><span class="eyebrow">Career</span><h2>Kerbstone World Series</h2></div>
        <div class="cr-stat"><b>Lv ${C.level}</b><div class="cr-xp"><i style="width:${Math.round(C.levelProgress * 100)}%"></i></div></div>
        <div class="cr-stat"><b>${money(C.credits)}</b><small>credits</small></div>
        <div class="cr-stat"><b>${C.totalStars} ★</b><small>stars</small></div>
        <div class="seg small cr-tabs"><button data-tab="events" class="${this.tab === 'events' ? 'on' : ''}">Events</button><button data-tab="dealer" class="${this.tab === 'dealer' ? 'on' : ''}">Dealership</button></div>
      </div>`;
    let body = '';
    if (this.tab === 'events') {
      body = `<div class="cr-tiers">${TIERS.map((t) => {
        const unlocked = C.tierUnlocked(t);
        return `<section class="cr-tier ${unlocked ? '' : 'locked'}">
          <header><b>${t.name}</b><small>${t.blurb}</small><em>${className(t)}</em>${unlocked ? '' : `<span class="lock">🔒 ${t.unlockStars} ★ to unlock</span>`}</header>
          <div class="cr-events">${t.events.map((e) => {
            const r = C.eventResult(e.id);
            return `<button class="cr-event" data-event="${e.id}" ${unlocked ? '' : 'disabled'}>
              <span class="cr-type ${e.type}">${EVENT_TYPES[e.type].name}</span>
              <b>${e.name}</b>
              <small>${trackName(e)} · ${e.laps} laps${e.rivals ? ` · ${e.rivals + 1} cars` : ''}</small>
              <span class="cr-stars ${r ? 'got' : ''}">${stars(r?.stars || 0)}</span>
            </button>`;
          }).join('')}</div>
        </section>`;
      }).join('')}</div>`;
    } else {
      body = `<div class="cr-dealer">${Object.values(BODIES).map((b) => {
        const owned = C.owns(b.id);
        const price = CAR_PRICES[b.id] ?? 0;
        return `<div class="cr-car ${owned ? 'owned' : ''}">
          <em>${b.cls}</em><b>${b.name}</b>
          <small>${b.drivetrain} · ${Math.round(b.powerKW * 1.341)} hp · ${b.mass} kg</small>
          <p>${b.blurb}</p>
          ${owned ? `<button class="btn" data-drive-car="${b.id}">${this.app.setup.body === b.id ? 'Selected' : 'Select'}</button>` : `<button class="btn primary" data-buy="${b.id}" ${C.credits < price ? 'disabled' : ''}>Buy ${money(price)}</button>`}
        </div>`;
      }).join('')}</div>`;
    }
    this.root.innerHTML = `<div class="cr-wrap">${head}${body}</div><div class="cr-brief" hidden></div>`;
  }

  brief(eventId) {
    const { tier, event } = findEvent(eventId);
    const C = this.C;
    const owned = C.eligibleOwned(event);
    const r = C.eventResult(eventId);
    const el = this.root.querySelector('.cr-brief');
    el.innerHTML = `<div class="panel glass">
      <span class="eyebrow">${tier.name} · ${EVENT_TYPES[event.type].name}</span>
      <h2>${event.name}</h2>
      <p class="muted">${EVENT_TYPES[event.type].desc} ${trackName(event)} · ${event.laps} laps${event.rivals ? ` · ${event.rivals} rivals` : ''}.</p>
      <div class="cr-goals">${event.type === 'trial' ? '<span>★ bronze</span><span>★★ silver</span><span>★★★ gold target time</span>' : event.type === 'overtake' ? '<span>★ +3 places</span><span>★★ +5 places</span><span>★★★ win</span>' : event.type === 'duel' ? '<span>★★★ beat your rival</span>' : '<span>★ 3rd</span><span>★★ 2nd</span><span>★★★ win</span>'}</div>
      ${r ? `<p class="muted">Your best: ${stars(r.stars)}${r.position ? ` · P${r.position}` : ''}</p>` : ''}
      <div class="field"><span>Your car (${className(tier)})</span>
        ${owned.length ? `<div class="seg small">${owned.map((b) => `<button data-pick="${b}" class="${this.pick === b || (!owned.includes(this.pick) && b === owned[0]) ? 'on' : ''}">${BODIES[b].name}</button>`).join('')}</div>` : `<p class="warn-text">You don't own a car for this series. Visit the dealership.</p>`}
      </div>
      <div class="row-btns">
        ${owned.length ? `<button class="btn primary big" data-start="${eventId}">Start event</button>` : `<button class="btn primary" data-tab="dealer">Dealership</button>`}
        <button class="btn ghost" data-cr="closebrief">Cancel</button>
      </div></div>`;
    if (!owned.includes(this.pick)) this.pick = owned[0];
    el.hidden = false;
  }

  onClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    const C = this.C;
    if (t.dataset.cr === 'back') { audio.click(); this.app.showHome(); return; }
    if (t.dataset.cr === 'closebrief') { audio.click(); this.root.querySelector('.cr-brief').hidden = true; return; }
    if (t.dataset.tab) { audio.click(); this.tab = t.dataset.tab; this.render(); return; }
    if (t.dataset.event) { audio.click(); this.brief(t.dataset.event); return; }
    if (t.dataset.pick) { audio.click(); this.pick = t.dataset.pick; t.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === t)); return; }
    if (t.dataset.buy) {
      const res = C.buy(t.dataset.buy);
      if (res.ok) { audio.beep(1046, 0.2, 0.2); this.app.toast(`${BODIES[t.dataset.buy].name} is yours`); this.app.setup = { ...this.app.setup, body: t.dataset.buy, compound: BODIES[t.dataset.buy].compound, drivetrain: null }; this.app.saveSetup(); }
      else this.app.toast(res.reason);
      this.render();
      return;
    }
    if (t.dataset.driveCar) { audio.click(); this.app.setup = { ...this.app.setup, body: t.dataset.driveCar, compound: BODIES[t.dataset.driveCar].compound, drivetrain: null }; this.app.saveSetup(); this.render(); return; }
    if (t.dataset.start) { audio.click(); this.app.startCareerEvent(t.dataset.start, this.pick); }
  }
}

function trackName(e) {
  if (e.track.startsWith('gen:')) return eventTrackDef(e, PRESETS).name;
  return PRESETS.find((p) => p.id === e.track)?.name || e.track;
}
export { money, stars };
