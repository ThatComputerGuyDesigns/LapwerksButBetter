// Open-world HUD: location name, speedometer, rotating minimap of the road
// network, flash messages and skill pop-ups (air time, drifts, speed).
import { HALF, SIZE, S_WATER } from './worldgen.js';
import { clamp } from '../core/math.js';

export class OpenHUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="oh-loc"><span class="oh-area"></span><b class="oh-road"></b></div>
      <div class="oh-map"><canvas width="440" height="440"></canvas><i class="oh-me"></i><span class="oh-n">N</span></div>
      <div class="oh-speed"><b class="oh-spd">0</b><span>KM/H</span><em class="oh-gear">1</em></div>
      <div class="oh-flash"></div>
      <div class="oh-skill" hidden><b></b><span></span></div>
      <div class="oh-help"><kbd>R</kbd> reset to road · <kbd>C</kbd> camera · <kbd>M</kbd> map · <kbd>Esc</kbd> menu</div>`;
    this.mapCanvas = root.querySelector('.oh-map canvas');
    this.g = this.mapCanvas.getContext('2d');
  }

  setWorld(W) {
    this.W = W;
    // pre-render the whole island once (1 px = 4 m)
    const S = 1000, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const N = W.N;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const ix = Math.round((x / (S - 1)) * (N - 1)), iz = Math.round((y / (S - 1)) * (N - 1));
      const k = iz * N + ix, h = W.H[k], s = W.surf[k];
      const i = (y * S + x) * 4;
      let r, gg, b;
      if (s === S_WATER) { const d = clamp(-h / 20, 0, 1); r = 22 - d * 10; gg = 66 - d * 20; b = 92 - d * 20; }
      else { const t = clamp(h / 300, 0, 1); r = 38 + t * 50; gg = 58 + t * 30; b = 40 + t * 40; }
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const toPx = (v) => ((v + HALF) / SIZE) * S;
    for (const r of W.roads) {
      g.beginPath();
      r.pts.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z))));
      if (r.closed) g.closePath();
      g.strokeStyle = r.type === 'dirt' ? '#b08a5a' : r.type === 'highway' ? '#ffffff' : '#d8dde4';
      g.lineWidth = r.type === 'highway' ? 4 : r.type === 'runway' ? 7 : 2.5;
      if (r.type === 'dirt') g.setLineDash([5, 4]); else g.setLineDash([]);
      g.stroke();
    }
    g.setLineDash([]);
    const [fx, fz] = W.landmarks.festival;
    g.fillStyle = '#ff5a1f'; g.beginPath(); g.arc(toPx(fx), toPx(fz), 9, 0, Math.PI * 2); g.fill();
    this.full = c;
  }

  flash(text, kind = '', dur = 2) {
    const f = this.root.querySelector('.oh-flash');
    f.textContent = text;
    f.className = `oh-flash show ${kind}`;
    clearTimeout(this.ft);
    this.ft = setTimeout(() => (f.className = 'oh-flash'), dur * 1000);
  }

  skill(title, detail) {
    const s = this.root.querySelector('.oh-skill');
    s.querySelector('b').textContent = title;
    s.querySelector('span').textContent = detail;
    s.hidden = false;
    s.classList.remove('pop'); void s.offsetWidth; s.classList.add('pop');
    clearTimeout(this.st);
    this.st = setTimeout(() => (s.hidden = true), 2200);
  }

  landing({ airTime }) {
    if (airTime > 0.45) this.skill(airTime > 1.6 ? 'HUGE AIR' : 'AIR', `${airTime.toFixed(1)} s · +${Math.round(airTime * 400)}`);
  }

  update(session) {
    const car = session.car, W = this.W;
    this.root.querySelector('.oh-spd').textContent = Math.round(car.speed * 3.6);
    this.root.querySelector('.oh-gear').textContent = car.gear === -1 ? 'R' : car.gear;
    // location: nearest road name or area
    this.locT = (this.locT || 0) + 1;
    if (this.locT % 15 === 0) {
      let name = '', bd = 60 * 60;
      for (const r of W.roads) for (let i = 0; i < r.pts.length; i += 3) { const d = (r.pts[i][0] - car.x) ** 2 + (r.pts[i][1] - car.z) ** 2; if (d < bd) { bd = d; name = r.name; } }
      const L = W.landmarks;
      const near = (p, r) => Math.hypot(car.x - p[0], car.z - p[1]) < r;
      const area = near(L.festival, 260) ? 'Festival Grounds' : near(L.town, 420) ? 'Port Arden' : near(L.airfield, 700) ? 'Airfield' : car.z < -900 ? 'The Highlands' : car.z > 1000 ? 'Coast' : car.x < -700 ? 'Timberline Forest' : 'Valley';
      this.root.querySelector('.oh-area').textContent = area;
      this.root.querySelector('.oh-road').textContent = name || 'Off road';
    }
    // minimap: rotate the island around the car (heading up)
    const g = this.g, S = this.mapCanvas.width;
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#0d1a22'; g.fillRect(0, 0, S, S);
    g.translate(S / 2, S / 2);
    g.rotate(Math.PI + car.heading);
    const zoom = 2.2; // map px per full-map px
    const px = ((car.x + HALF) / SIZE) * 1000, pz = ((car.z + HALF) / SIZE) * 1000;
    g.scale(zoom, zoom);
    g.drawImage(this.full, -px, -pz);
    g.restore();
    const n = this.root.querySelector('.oh-n');
    const a = Math.PI + car.heading;
    n.style.transform = `translate(${Math.sin(-a) * 92}px, ${-Math.cos(-a) * 92}px)`;
  }
}
