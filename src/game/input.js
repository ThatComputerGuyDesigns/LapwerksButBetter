// Unified input: keyboard (with speed-sensitive smoothing), gamepad (analog,
// deadzones, response curves) and touch (virtual steering + pedals).
import { clamp } from '../core/math.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.edges = new Set();
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.source = 'keyboard';
    this.touch = { steer: 0, throttle: 0, brake: 0, active: false };
    this.gpPrev = {};
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (!this.keys.has(e.code)) this.edges.add(e.code);
      this.keys.add(e.code);
      this.source = 'keyboard';
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code) && this.captureKeys) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.captureKeys = false;
  }

  pressed(code) { return this.edges.has(code); }
  down(...codes) { return codes.some((c) => this.keys.has(c)); }

  bindTouch(root) {
    const pad = root.querySelector('.touch-steer');
    const gas = root.querySelector('.touch-gas');
    const brk = root.querySelector('.touch-brake');
    const knob = root.querySelector('.touch-knob');
    let steerId = null, x0 = 0;
    const rect = () => pad.getBoundingClientRect();
    pad.addEventListener('pointerdown', (e) => {
      steerId = e.pointerId; x0 = e.clientX; pad.setPointerCapture(e.pointerId);
      this.source = 'touch'; this.touch.active = true;
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== steerId) return;
      const w = Math.min(rect().width * 0.4, 160);
      this.touch.steer = clamp(-(e.clientX - x0) / w, -1, 1);
      knob.style.transform = `translateX(${-this.touch.steer * 60}px)`;
    });
    const endSteer = (e) => { if (e.pointerId === steerId) { steerId = null; this.touch.steer = 0; knob.style.transform = ''; } };
    pad.addEventListener('pointerup', endSteer);
    pad.addEventListener('pointercancel', endSteer);
    const pedal = (el, key) => {
      el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); this.touch[key] = 1; el.classList.add('on'); this.source = 'touch'; this.touch.active = true; });
      const up = () => { this.touch[key] = 0; el.classList.remove('on'); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    pedal(gas, 'throttle');
    pedal(brk, 'brake');
  }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const ax = gp.axes[0] || 0;
      const rt = gp.buttons[7]?.value ?? 0, lt = gp.buttons[6]?.value ?? 0;
      const any = Math.abs(ax) > 0.15 || rt > 0.05 || lt > 0.05 || gp.buttons.some((b) => b.pressed);
      if (any) this.source = 'gamepad';
      const btn = (i) => gp.buttons[i]?.pressed;
      const edge = (i, name) => { if (btn(i) && !this.gpPrev[i]) this.edges.add(name); this.gpPrev[i] = btn(i); };
      edge(0, 'GP_A'); edge(1, 'GP_B'); edge(2, 'GP_X'); edge(3, 'GP_Y');
      edge(4, 'GP_LB'); edge(5, 'GP_RB'); edge(9, 'GP_START'); edge(8, 'GP_BACK'); edge(12, 'GP_UP'); edge(13, 'GP_DOWN');
      const dz = 0.08;
      let s = Math.abs(ax) < dz ? 0 : (Math.abs(ax) - dz) / (1 - dz) * Math.sign(ax);
      s = Math.sign(s) * Math.pow(Math.abs(s), 1.6); // finer control near centre
      return { steer: -s, throttle: Math.pow(rt, 1.2), brake: Math.pow(lt, 1.1), handbrake: btn(2) || btn(1) };
    }
    return null;
  }

  /** Produce driving commands for this frame. speed in m/s. */
  sample(dt, speed) {
    const gp = this.pollGamepad();
    const out = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: false, shiftDown: false };
    if (this.source === 'gamepad' && gp) {
      Object.assign(out, gp);
      out.shiftUp = this.pressed('GP_RB') || this.pressed('GP_A');
      out.shiftDown = this.pressed('GP_LB') || this.pressed('GP_X') && false;
      this.steer = out.steer;
    } else if (this.source === 'touch') {
      out.throttle = this.touch.throttle;
      out.brake = this.touch.brake;
      const k = 1 - Math.exp(-dt * 12);
      this.steer += (this.touch.steer - this.steer) * k;
      out.steer = this.steer;
    } else {
      const left = this.down('ArrowLeft', 'KeyA'), right = this.down('ArrowRight', 'KeyD');
      const target = (left ? 1 : 0) - (right ? 1 : 0);
      // speed-sensitive rates: quick at low speed, calmer at high speed,
      // always fast to return to centre
      const v = Math.max(0, speed);
      const rateIn = 5.2 / (1 + v / 28);
      const rateOut = 7.5;
      const rate = target === 0 || Math.sign(target) !== Math.sign(this.steer) ? rateOut : rateIn;
      const d = target - this.steer;
      this.steer += clamp(d, -rate * dt, rate * dt);
      out.steer = this.steer;
      const up = this.down('ArrowUp', 'KeyW'), dn = this.down('ArrowDown', 'KeyS');
      // ramp pedals slightly so keyboard input isn't purely on/off
      this.throttle += clamp((up ? 1 : 0) - this.throttle, -dt * 9, dt * 7);
      this.brake += clamp((dn ? 1 : 0) - this.brake, -dt * 12, dt * 9);
      out.throttle = this.throttle;
      out.brake = this.brake;
      out.handbrake = this.down('Space');
      out.shiftUp = this.pressed('KeyE') || this.pressed('ShiftLeft') || this.pressed('ShiftRight');
      out.shiftDown = this.pressed('KeyQ') || this.pressed('ControlLeft') || this.pressed('ControlRight');
    }
    return out;
  }

  endFrame() { this.edges.clear(); }
}
