// Minimum-curvature racing line + quasi-steady-state speed profile.
// Used by the AI driver, the lap simulator, the on-track driving-line
// assist and the braking boards.
import { clamp } from '../core/math.js';

export function computeRacingLine(T, { margin = 1.6, iterations = 700 } = {}) {
  const N = T.N;
  const off = new Float32Array(N);
  const lim = T.half - margin;
  const X = new Float32Array(N), Z = new Float32Array(N);
  const pos = () => {
    for (let i = 0; i < N; i++) {
      X[i] = T.px[i] + T.nx[i] * off[i];
      Z[i] = T.pz[i] + T.nz[i] * off[i];
    }
  };
  pos();
  // Iteratively move every point toward the midpoint of its neighbours
  // (straightens the path = reduces curvature) while respecting the edges.
  for (let it = 0; it < iterations; it++) {
    const span = it < iterations * 0.5 ? 6 : it < iterations * 0.8 ? 3 : 1;
    for (let i = 0; i < N; i++) {
      const a = (i - span + N) % N, b = (i + span) % N;
      const mx = (X[a] + X[b]) / 2, mz = (Z[a] + Z[b]) / 2;
      const want = (mx - T.px[i]) * T.nx[i] + (mz - T.pz[i]) * T.nz[i];
      off[i] = clamp(off[i] + (want - off[i]) * 0.5, -lim, lim);
      X[i] = T.px[i] + T.nx[i] * off[i];
      Z[i] = T.pz[i] + T.nz[i] * off[i];
    }
  }
  // curvature of the line + its arc length per sample
  const k = new Float32Array(N), ds = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 2 + N) % N, b = (i + 2) % N;
    const ax = X[i] - X[a], az = Z[i] - Z[a], bx = X[b] - X[i], bz = Z[b] - Z[i];
    const cross = ax * bz - az * bx;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(X[b] - X[a], Z[b] - Z[a]);
    k[i] = -(2 * cross) / Math.max(la * lb * lc, 1e-9);
    const n = (i + 1) % N;
    ds[i] = Math.hypot(X[n] - X[i], Z[n] - Z[i]);
  }
  const ks = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += k[(i + j + N) % N];
    ks[i] = s / 5;
  }
  return { offset: off, x: X, z: Z, curv: ks, ds };
}

/**
 * Speed profile for a car (uses the same parameters as the vehicle model).
 * Returns target speed (m/s) per sample along the racing line.
 */
export function speedProfile(T, line, car, { gripScale = 0.94 } = {}) {
  const N = T.N;
  const g = 9.81;
  const m = car.mass;
  const mu = car.tire.mu * gripScale;
  const rho = 1.225;
  const kDown = 0.5 * rho * car.aero.clA;
  const kDrag = 0.5 * rho * car.aero.cdA;
  const vmax = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // banking helps: effective lateral capacity
    const c = Math.abs(line.curv[i]);
    const bankHelp = Math.sin(Math.abs(T.bank[i])) * (Math.sign(T.bank[i]) === -Math.sign(line.curv[i]) ? 1 : -1);
    const muEff = mu + bankHelp * 0.9;
    // v^2 c m = mu (m g + kDown v^2)  →  v^2 = mu m g / (m c - mu kDown)
    const den = m * c - muEff * kDown;
    vmax[i] = den <= 0 ? 120 : Math.min(120, Math.sqrt((muEff * m * g) / den));
  }
  const v = Float32Array.from(vmax);
  const engineForce = (u) => {
    const P = car.engine.powerKW * 1000 * 0.86;
    return Math.min(P / Math.max(u, 4), mu * m * g * (car.drivetrain === 'AWD' ? 1 : 0.55));
  };
  // forward (acceleration) passes, twice around for the wrap-around
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < N; k++) {
      const i = k, j = (k + 1) % N;
      const u = v[i];
      const latA = u * u * Math.abs(line.curv[i]);
      const cap = mu * (g + (kDown * u * u) / m);
      const fric = Math.sqrt(Math.max(0, 1 - (latA / cap) ** 2));
      const a = (engineForce(u) * fric - kDrag * u * u) / m - g * T.grade[i];
      const nv = Math.sqrt(Math.max(0, u * u + 2 * a * line.ds[i]));
      if (nv < v[j]) v[j] = nv;
    }
  }
  // backward (braking) passes
  for (let pass = 0; pass < 2; pass++) {
    for (let k = N - 1; k >= 0; k--) {
      const i = (k + 1) % N, j = k;
      const u = v[i];
      const latA = u * u * Math.abs(line.curv[i]);
      const cap = mu * (g + (kDown * u * u) / m);
      const fric = Math.sqrt(Math.max(0, 1 - (latA / cap) ** 2));
      const a = cap * fric * 0.92 + (kDrag * u * u) / m + g * T.grade[j];
      const nv = Math.sqrt(Math.max(0, u * u + 2 * a * line.ds[j]));
      if (nv < v[j]) v[j] = nv;
    }
  }
  let t = 0;
  for (let i = 0; i < N; i++) t += line.ds[i] / Math.max(v[i], 1);
  return { v, vmax, lapTime: t };
}
