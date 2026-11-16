// Replay buffer: every car's pose at 20 Hz in a ring buffer (last ~3 min).
// Used by the race-control review room and post-race replays.
const HZ = 20;

export class ReplayBuffer {
  constructor(nCars, seconds = 180) {
    this.n = nCars;
    this.cap = seconds * HZ;
    this.stride = nCars * 5; // x, y, z, heading, steer
    this.data = new Float32Array(this.cap * this.stride);
    this.times = new Float64Array(this.cap);
    this.count = 0;
    this.head = 0;
    this.next = 0;
  }

  get start() { return this.count ? this.times[(this.head - this.count + this.cap) % this.cap] : 0; }
  get end() { return this.count ? this.times[(this.head - 1 + this.cap) % this.cap] : 0; }

  record(time, cars) {
    if (time < this.next) return;
    this.next = time + 1 / HZ;
    const o = this.head * this.stride;
    for (let k = 0; k < this.n; k++) {
      const c = cars[k];
      if (!c) continue;
      const b = o + k * 5;
      this.data[b] = c.x; this.data[b + 1] = c.y; this.data[b + 2] = c.z; this.data[b + 3] = c.heading; this.data[b + 4] = c.steer;
    }
    this.times[this.head] = time;
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.count + 1, this.cap);
  }

  /** Interpolated pose of car k at time t → [x, y, z, heading, steer]. */
  pose(k, t, out = [0, 0, 0, 0, 0]) {
    if (!this.count) return null;
    t = Math.max(this.start, Math.min(this.end, t));
    // binary search over the ring (times are increasing)
    let lo = 0, hi = this.count - 1;
    const idx = (i) => (this.head - this.count + i + this.cap) % this.cap;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[idx(mid)] <= t) lo = mid; else hi = mid;
    }
    const a = idx(lo), b = idx(hi);
    const ta = this.times[a], tb = this.times[b];
    const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    const A = a * this.stride + k * 5, B = b * this.stride + k * 5;
    for (let j = 0; j < 5; j++) {
      let va = this.data[A + j], vb = this.data[B + j];
      if (j === 3) { let d = vb - va; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; vb = va + d; }
      out[j] = va + (vb - va) * f;
    }
    return out;
  }
}
