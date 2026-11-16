// Synthesised audio: layered engine (firing harmonics + intake noise + load
// filter), tyre squeal, scrub on kerbs/gravel, wind, impacts, gear shifts and
// UI blips. All generated in WebAudio, no samples to download.
import { clamp, lerp } from '../core/math.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.8;
    this.lastGear = 1;
  }

  /** Must be called from a user gesture. */
  async unlock() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const master = (this.master = ctx.createGain());
    master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    this.noiseBuf = this.makeNoise(2);
    this.buildEngine();
    this.buildTyres();
    this.buildWind();
  }

  makeNoise(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2; }
    return buf;
  }

  noise() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start(0, Math.random() * 1.5);
    return s;
  }

  buildEngine() {
    const ctx = this.ctx;
    const out = (this.engOut = ctx.createGain());
    out.gain.value = 0;
    const filt = (this.engFilter = ctx.createBiquadFilter());
    filt.type = 'lowpass'; filt.Q.value = 3.5; filt.frequency.value = 900;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    filt.connect(shaper).connect(out).connect(this.master);
    // harmonic stack (multiples of firing frequency)
    this.oscs = [];
    const defs = [[0.5, 'sawtooth', 0.35], [1, 'sawtooth', 0.6], [1.5, 'square', 0.12], [2, 'sawtooth', 0.28], [3, 'triangle', 0.15], [4.02, 'sawtooth', 0.06]];
    for (const [mul, type, g] of defs) {
      const o = ctx.createOscillator();
      o.type = type;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn).connect(filt);
      o.start();
      this.oscs.push({ o, mul, gn, base: g });
    }
    // intake / mechanical noise shaped by a bandpass that tracks rpm
    const n = this.noise();
    const bp = (this.intake = ctx.createBiquadFilter());
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    const ng = (this.intakeGain = ctx.createGain());
    ng.gain.value = 0;
    n.connect(bp).connect(ng).connect(out);
    // limiter "stutter" LFO
    this.revCutGain = ctx.createGain();
  }

  buildTyres() {
    const ctx = this.ctx;
    // squeal: resonant band-passed noise + faint tonal component
    const n = this.noise();
    const bp = (this.squealFilter = ctx.createBiquadFilter());
    bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 9;
    const g = (this.squealGain = ctx.createGain());
    g.gain.value = 0;
    n.connect(bp).connect(g).connect(this.master);
    const tone = ctx.createOscillator();
    tone.type = 'triangle'; tone.frequency.value = 950;
    const tg = (this.squealTone = ctx.createGain());
    tg.gain.value = 0;
    const vib = ctx.createOscillator();
    vib.frequency.value = 13;
    const vg = ctx.createGain();
    vg.gain.value = 40;
    vib.connect(vg).connect(tone.frequency);
    tone.connect(tg).connect(this.master);
    tone.start(); vib.start();
    this.toneOsc = tone;
    // rumble/scrub (kerb, gravel, grass)
    const n2 = this.noise();
    const lp = (this.rumbleFilter = ctx.createBiquadFilter());
    lp.type = 'lowpass'; lp.frequency.value = 220;
    const rg = (this.rumbleGain = ctx.createGain());
    rg.gain.value = 0;
    n2.connect(lp).connect(rg).connect(this.master);
    const kerbOsc = ctx.createOscillator();
    kerbOsc.type = 'square'; kerbOsc.frequency.value = 40;
    const kg = (this.kerbGain = ctx.createGain());
    kg.gain.value = 0;
    const kf = ctx.createBiquadFilter();
    kf.type = 'lowpass'; kf.frequency.value = 160;
    kerbOsc.connect(kf).connect(kg).connect(this.master);
    kerbOsc.start();
    this.kerbOsc = kerbOsc;
  }

  buildWind() {
    const ctx = this.ctx;
    const n = this.noise();
    const f = (this.windFilter = ctx.createBiquadFilter());
    f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.5;
    const g = (this.windGain = ctx.createGain());
    g.gain.value = 0;
    n.connect(f).connect(g).connect(this.master);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Called every frame while driving. */
  update(car, cams = { interior: false }) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const p = car.p;
    const rpm = car.rpm;
    const cyl = car.p.engine.cyl || car.p.body.cyl || 6;
    const fire = (rpm / 60) * (cyl / 2);
    const load = clamp(car.throttle, 0, 1);
    const cut = car.revCut ? 0.25 : 1;
    for (const o of this.oscs) o.o.frequency.setTargetAtTime(fire * o.mul, t, 0.02);
    // overrun crackle: lifting off at high revs pops through the exhaust
    const overrun = car.throttle < 0.05 && rpm > p.engine.redline * 0.55;
    if (overrun && Math.random() < 0.06 * (rpm / p.engine.redline)) this.pop(0.08 + Math.random() * 0.12);
    this.engFilter.frequency.setTargetAtTime(lerp(380, 3200, load * 0.75 + (rpm / p.engine.redline) * 0.35) * (cams.interior ? 0.8 : 1), t, 0.03);
    this.engOut.gain.setTargetAtTime((0.11 + load * 0.16 + (rpm / p.engine.redline) * 0.05) * cut, t, 0.03);
    this.intake.frequency.setTargetAtTime(fire * 3.2, t, 0.02);
    this.intakeGain.gain.setTargetAtTime(load * 0.12 * (rpm / p.engine.redline), t, 0.04);
    if (car.gear !== this.lastGear && this.lastGear !== 0) this.shiftBlip(car.gear > this.lastGear);
    this.lastGear = car.gear;

    // tyres
    let slip = 0, slipF = 0;
    let rough = 0, kerb = 0;
    for (const w of car.wheels) {
      const s = clamp((w.slipVel - 1.4) / 7, 0, 1) * clamp(w.load / 3500, 0, 1.5);
      if (w.surface === 0) { slip += s; slipF = Math.max(slipF, w.slipVel); }
      if (w.surface === 1) kerb += 1;
      if (w.surface >= 2) rough += 1;
    }
    slip /= 4;
    const spd = car.speed;
    this.squealGain.gain.setTargetAtTime(clamp(slip, 0, 1) * 0.55, t, 0.05);
    this.squealTone.gain.setTargetAtTime(clamp(slip - 0.15, 0, 1) * 0.06, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(900 + slipF * 22, t, 0.08);
    this.toneOsc.frequency.setTargetAtTime(880 + slipF * 18, t, 0.08);
    this.kerbGain.gain.setTargetAtTime(kerb > 0 ? clamp(spd / 30, 0, 1) * 0.35 * (kerb / 2) : 0, t, 0.02);
    this.kerbOsc.frequency.setTargetAtTime(18 + spd * 2.2, t, 0.02);
    this.rumbleGain.gain.setTargetAtTime(rough > 0 ? clamp(spd / 25, 0, 1) * 0.5 * (rough / 4) : 0, t, 0.04);
    this.rumbleFilter.frequency.setTargetAtTime(120 + spd * 6, t, 0.05);
    this.windGain.gain.setTargetAtTime(clamp(spd / 80, 0, 1) ** 2 * 0.28, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + spd * 14, t, 0.1);
    if (car.lastImpact > 1.2) { this.impact(car.lastImpact); car.lastImpact = 0; }
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const g of [this.engOut, this.intakeGain, this.squealGain, this.squealTone, this.kerbGain, this.rumbleGain, this.windGain]) g?.gain.setTargetAtTime(0, t, 0.08);
  }

  shiftBlip(up) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.engOut.gain.cancelScheduledValues(t);
    this.engOut.gain.setValueAtTime(this.engOut.gain.value, t);
    this.engOut.gain.linearRampToValueAtTime(this.engOut.gain.value * 0.35, t + 0.04);
    if (up) {
      // exhaust pop
      const n = this.noise();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 700;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      n.connect(f).connect(g).connect(this.master);
      n.stop(t + 0.15);
    }
  }

  pop(vol) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this.noise();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 500 + Math.random() * 900; f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05 + Math.random() * 0.04);
    n.connect(f).connect(g).connect(this.master);
    n.stop(t + 0.12);
  }

  impact(strength) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this.noise();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 400 + strength * 40;
    const g = ctx.createGain();
    const v = clamp(strength / 12, 0.15, 1);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    n.connect(f).connect(g).connect(this.master);
    n.stop(t + 0.4);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(v * 0.7, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(og).connect(this.master);
    o.start(t); o.stop(t + 0.3);
  }

  beep(freq = 880, dur = 0.12, vol = 0.25, type = 'sine') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  click() { this.beep(1400, 0.04, 0.08, 'triangle'); }
}

export const audio = new AudioEngine();
