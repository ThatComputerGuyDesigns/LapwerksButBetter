// Car design language v2: each car is ONE continuous surface lofted along its
// length — bumper, bonnet, windscreen, roof, rear glass and tail flow into
// each other like a real car body. Side profile (top line + belt line),
// plan view (shoulder width with wheel haunches) and the cross-section
// (tucked sill, door character line, crisp shoulder, tumblehome glasshouse,
// crowned roof) are designed per archetype. Glass, pillars, lights, grilles
// and intakes are regions/patches of the same surface, so they conform.
import { lerp, smoothstep, clamp } from '../core/math.js';

// Keyframes along t (0 = rear bumper → 1 = front bumper), heights in metres.
//   top: centre-line height (deck, roof, bonnet)   belt: shoulder / window-line height
//   w:   shoulder half-width factor (× half the car width)
// cabin: t of rear-glass base, roof rear, roof front, screen base; roofW: roof
// half-width as a fraction of the shoulder (tumblehome); round: section bluntness.
export const DESIGNS = {
  gt: { // front-engined GT coupé: long bonnet, cab-rearward, fastback
    oh: [0.98, 0.92], clear: 0.13, round: 3.1, roofW: 0.66, haunch: [0.05, 0.085],
    top: [[0, 0.64], [0.03, 0.8], [0.1, 0.9], [0.2, 0.96], [0.36, 1.2], [0.47, 1.28], [0.56, 1.27], [0.66, 1.03], [0.72, 0.93], [0.86, 0.86], [0.95, 0.78], [0.985, 0.66], [1, 0.52]],
    belt: [[0, 0.6], [0.03, 0.76], [0.1, 0.86], [0.2, 0.9], [0.4, 0.9], [0.6, 0.89], [0.72, 0.88], [0.86, 0.84], [0.95, 0.76], [0.985, 0.64], [1, 0.5]],
    w: [[0, 0.8], [0.04, 0.93], [0.12, 0.98], [0.28, 0.99], [0.5, 0.96], [0.72, 0.97], [0.86, 0.97], [0.95, 0.9], [0.99, 0.78], [1, 0.66]],
    cabin: [0.2, 0.42, 0.57, 0.71], lights: 'blade', grille: 'wide', intakes: true, wing: 'lip', vents: 'wing',
  },
  hatch: { // hot hatch: short nose, tall roof, chopped tail
    oh: [0.86, 0.66], clear: 0.14, round: 3.6, roofW: 0.76, haunch: [0.045, 0.06],
    top: [[0, 0.82], [0.03, 0.98], [0.07, 1.3], [0.1, 1.4], [0.4, 1.44], [0.58, 1.42], [0.7, 1.08], [0.78, 0.96], [0.9, 0.9], [0.97, 0.82], [1, 0.6]],
    belt: [[0, 0.8], [0.03, 0.94], [0.08, 0.98], [0.3, 0.97], [0.6, 0.95], [0.78, 0.92], [0.9, 0.88], [0.97, 0.8], [1, 0.58]],
    w: [[0, 0.88], [0.04, 0.96], [0.15, 0.99], [0.5, 0.98], [0.8, 0.97], [0.93, 0.93], [0.99, 0.84], [1, 0.74]],
    cabin: [0.06, 0.1, 0.58, 0.74], lights: 'swept', grille: 'hex', intakes: true, wing: 'roof',
  },
  proto: { // Le Mans prototype: bubble canopy, huge fenders, long tail
    oh: [1.0, 0.98], clear: 0.09, round: 2.6, roofW: 0.4, haunch: [0.09, 0.11],
    top: [[0, 0.78], [0.04, 0.84], [0.16, 0.86], [0.3, 0.92], [0.4, 1.06], [0.48, 1.1], [0.56, 1.08], [0.66, 0.84], [0.76, 0.72], [0.9, 0.66], [0.97, 0.52], [1, 0.32]],
    belt: [[0, 0.76], [0.04, 0.82], [0.16, 0.84], [0.3, 0.86], [0.45, 0.82], [0.6, 0.76], [0.7, 0.72], [0.82, 0.7], [0.92, 0.62], [0.97, 0.5], [1, 0.3]],
    w: [[0, 0.95], [0.08, 1.0], [0.25, 0.98], [0.42, 0.84], [0.55, 0.84], [0.7, 0.98], [0.86, 1.0], [0.96, 0.94], [1, 0.82]],
    cabin: [0.36, 0.44, 0.56, 0.66], lights: 'blade', grille: 'none', intakes: true, wing: 'big', fin: true, narrowCabin: 0.52,
  },
  rs: { // rear-engined sports car: round lamps, sloping roof, wide hips
    oh: [0.94, 1.12], clear: 0.12, round: 2.9, roofW: 0.62, haunch: [0.05, 0.12],
    top: [[0, 0.68], [0.04, 0.8], [0.12, 0.88], [0.22, 0.98], [0.36, 1.2], [0.46, 1.27], [0.56, 1.25], [0.66, 0.98], [0.72, 0.88], [0.86, 0.8], [0.95, 0.72], [0.985, 0.6], [1, 0.48]],
    belt: [[0, 0.64], [0.04, 0.78], [0.12, 0.84], [0.25, 0.86], [0.45, 0.85], [0.66, 0.84], [0.76, 0.82], [0.88, 0.76], [0.96, 0.66], [1, 0.46]],
    w: [[0, 0.8], [0.05, 0.93], [0.16, 1.0], [0.3, 1.0], [0.5, 0.92], [0.7, 0.95], [0.84, 0.96], [0.94, 0.88], [1, 0.62]],
    cabin: [0.22, 0.44, 0.56, 0.68], lights: 'round', grille: 'lower', intakes: true, wing: 'duck',
  },
  gt3: { // GT3 racer: rs shape + wide arches, splitter, swan-neck wing
    oh: [1.0, 1.12], clear: 0.08, round: 2.8, roofW: 0.6, haunch: [0.09, 0.16],
    top: [[0, 0.66], [0.04, 0.78], [0.12, 0.86], [0.22, 0.96], [0.36, 1.18], [0.46, 1.25], [0.56, 1.23], [0.66, 0.96], [0.72, 0.86], [0.86, 0.78], [0.95, 0.68], [0.985, 0.56], [1, 0.44]],
    belt: [[0, 0.62], [0.04, 0.76], [0.12, 0.82], [0.25, 0.84], [0.45, 0.83], [0.66, 0.82], [0.76, 0.8], [0.88, 0.74], [0.96, 0.62], [1, 0.42]],
    w: [[0, 0.84], [0.05, 0.97], [0.16, 1.0], [0.3, 0.98], [0.5, 0.88], [0.7, 0.94], [0.84, 0.98], [0.94, 0.9], [1, 0.66]],
    cabin: [0.22, 0.44, 0.56, 0.68], lights: 'round', grille: 'race', intakes: true, wing: 'swan', splitter: 1.4, vents: 'arch',
  },
  hyper: { // mid-engined hypercar: cab-forward teardrop, deep side intakes
    oh: [1.05, 0.95], clear: 0.08, round: 2.5, roofW: 0.5, haunch: [0.07, 0.12],
    top: [[0, 0.7], [0.03, 0.82], [0.12, 0.92], [0.26, 0.98], [0.38, 1.08], [0.47, 1.13], [0.56, 1.11], [0.66, 0.86], [0.74, 0.74], [0.88, 0.68], [0.96, 0.56], [1, 0.36]],
    belt: [[0, 0.66], [0.03, 0.78], [0.12, 0.86], [0.26, 0.9], [0.4, 0.86], [0.55, 0.8], [0.66, 0.74], [0.76, 0.7], [0.9, 0.62], [0.96, 0.52], [1, 0.34]],
    w: [[0, 0.88], [0.06, 0.99], [0.2, 1.0], [0.36, 0.9], [0.5, 0.84], [0.64, 0.92], [0.8, 0.98], [0.92, 0.94], [1, 0.74]],
    cabin: [0.3, 0.44, 0.56, 0.68], lights: 'blade', grille: 'none', intakes: true, wing: 'big', sideIntake: true, narrowCabin: 0.72,
  },
  muscle: { // front-engined muscle car: long flat bonnet, upright fascia, fastback
    oh: [1.0, 1.02], clear: 0.15, round: 4.4, roofW: 0.72, haunch: [0.03, 0.06],
    top: [[0, 0.86], [0.03, 0.94], [0.1, 0.98], [0.2, 1.02], [0.34, 1.28], [0.44, 1.36], [0.55, 1.34], [0.64, 1.06], [0.7, 1.0], [0.9, 0.97], [0.98, 0.92], [1, 0.74]],
    belt: [[0, 0.84], [0.03, 0.92], [0.1, 0.96], [0.3, 0.97], [0.6, 0.97], [0.7, 0.97], [0.9, 0.95], [0.98, 0.9], [1, 0.72]],
    w: [[0, 0.92], [0.04, 0.98], [0.2, 1.0], [0.5, 0.99], [0.8, 0.99], [0.94, 0.97], [0.99, 0.92], [1, 0.86]],
    cabin: [0.18, 0.4, 0.56, 0.66], lights: 'twin', grille: 'muscle', intakes: false, wing: 'lip', stripes: true, scoop: 'hood',
  },
  jdm: { // tuner coupé: wedge nose, notchback, ducktail
    oh: [0.88, 0.82], clear: 0.12, round: 3.5, roofW: 0.7, haunch: [0.04, 0.06],
    top: [[0, 0.76], [0.03, 0.86], [0.1, 0.9], [0.18, 0.92], [0.24, 1.18], [0.32, 1.3], [0.52, 1.3], [0.64, 1.0], [0.72, 0.9], [0.88, 0.82], [0.96, 0.72], [1, 0.54]],
    belt: [[0, 0.74], [0.03, 0.84], [0.1, 0.88], [0.3, 0.88], [0.6, 0.86], [0.72, 0.85], [0.88, 0.8], [0.96, 0.7], [1, 0.52]],
    w: [[0, 0.88], [0.04, 0.96], [0.14, 0.99], [0.5, 0.97], [0.8, 0.97], [0.94, 0.92], [0.99, 0.8], [1, 0.7]],
    cabin: [0.2, 0.3, 0.52, 0.66], lights: 'swept', grille: 'lower', intakes: true, wing: 'gtwing',
  },
  rally: { // rally hatch: tall, flared arches, roof vent, mud flaps
    oh: [0.84, 0.7], clear: 0.2, round: 3.6, roofW: 0.76, haunch: [0.08, 0.09],
    top: [[0, 0.86], [0.03, 1.02], [0.07, 1.34], [0.1, 1.44], [0.4, 1.48], [0.58, 1.46], [0.7, 1.12], [0.78, 1.0], [0.9, 0.94], [0.97, 0.86], [1, 0.64]],
    belt: [[0, 0.84], [0.03, 0.98], [0.08, 1.02], [0.3, 1.01], [0.6, 0.99], [0.78, 0.96], [0.9, 0.92], [0.97, 0.84], [1, 0.62]],
    w: [[0, 0.9], [0.04, 0.97], [0.15, 1.0], [0.5, 0.97], [0.8, 0.98], [0.93, 0.94], [0.99, 0.86], [1, 0.76]],
    cabin: [0.06, 0.1, 0.58, 0.74], lights: 'swept', grille: 'hex', intakes: true, wing: 'roof', scoop: 'roof', flaps: true,
  },
};

/** Smooth (Catmull–Rom Hermite) interpolation through keyframes [[t, v], ...]. */
export function curve(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      const u = (t - a[0]) / (b[0] - a[0]);
      const p0 = keys[Math.max(0, i - 2)], p3 = keys[Math.min(keys.length - 1, i + 1)];
      // tangents scaled for non-uniform spacing
      const m1 = ((b[1] - p0[1]) / (b[0] - p0[0] || 1)) * (b[0] - a[0]);
      const m2 = ((p3[1] - a[1]) / (p3[0] - a[0] || 1)) * (b[0] - a[0]);
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * a[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * b[1] + (u3 - u2) * m2;
    }
  }
  return keys[keys.length - 1][1];
}

// lower body section, sill → shoulder (x = fraction of half-width, y = 0..1 of sill→belt)
const LOWER = [
  [0.0, 0.0], [0.55, 0.0], [0.82, 0.012], [0.92, 0.05], [0.972, 0.13], [0.995, 0.25],
  [1.0, 0.38], [0.995, 0.52], // door bulge
  [0.982, 0.6], [0.988, 0.66], // character line (small step)
  [0.992, 0.76], [0.985, 0.86], [0.968, 0.94], [0.95, 0.985], [0.94, 1.0], // shoulder crease
];
const lowerLen = [0];
for (let k = 1; k < LOWER.length; k++) lowerLen.push(lowerLen[k - 1] + Math.hypot(LOWER[k][0] - LOWER[k - 1][0], (LOWER[k][1] - LOWER[k - 1][1]) * 0.7));
function lowerAt(q) {
  const L = q * lowerLen[lowerLen.length - 1];
  let k = 1;
  while (k < lowerLen.length - 1 && lowerLen[k] < L) k++;
  const u = (L - lowerLen[k - 1]) / (lowerLen[k] - lowerLen[k - 1] || 1);
  const p0 = LOWER[Math.max(0, k - 2)], p1 = LOWER[k - 1], p2 = LOWER[k], p3 = LOWER[Math.min(LOWER.length - 1, k + 1)];
  const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
}

const LOWER_Q = 0.56; // share of the half-section (bottom centre → top centre) used by the lower body

/**
 * Build the shape functions for a body. Returns { point(t, theta, out),
 * region(t, theta) → 'paint'|'glass'|'trim'|'dark', dims... }.
 */
export function bodyShape(D, B) {
  const W2 = B.width / 2;
  const a = B.wheelbase * (1 - B.weightFront), b = B.wheelbase * B.weightFront;
  const zF = a + D.oh[0], zR = -b - D.oh[1];
  const L = zF - zR;
  const wheelR = B.wheelR;
  const archR = wheelR + 0.045;
  const axles = [a, -b];
  const zOf = (t) => lerp(zR, zF, t);
  const tOf = (z) => (z - zR) / L;
  const [c0, c1, c2, c3] = D.cabin;
  const top = (t) => curve(D.top, t);
  const belt = (t) => Math.min(curve(D.belt, t), top(t));
  const halfW = (t) => {
    let w = curve(D.w, t) * W2;
    const z = zOf(t);
    w += D.haunch[0] * W2 * Math.exp(-(((z - a) / 0.62) ** 2));
    w += D.haunch[1] * W2 * Math.exp(-(((z + b) / 0.72) ** 2));
    return w;
  };
  const floorY = (t) => {
    let y = D.clear + 0.06 * smoothstep(0.9, 1, t) + 0.08 * smoothstep(0.08, 0, t);
    for (const az of axles) {
      const dz = Math.abs(zOf(t) - az);
      if (dz < archR) y = Math.max(y, wheelR + Math.sqrt(archR * archR - dz * dz) * 0.98);
    }
    return Math.min(y, belt(t) - 0.05);
  };
  // greenhouse width at the roof (narrow canopy for prototypes/hypercars)
  const cabinIn = (t) => smoothstep(c0 - 0.06, c0 + 0.02, t) * smoothstep(c3 + 0.06, c3 - 0.02, t);
  const roofHalf = (t) => halfW(t) * lerp(0.96, D.roofW, cabinIn(t)) * (D.narrowCabin ? lerp(1, D.narrowCabin, cabinIn(t)) : 1);
  const shoulderInset = (t) => lerp(0.98, D.narrowCabin ? D.narrowCabin + 0.06 : 0.93, cabinIn(t));

  // f in [0,1): 0 bottom, .25 left (+x), .5 top, .75 right; returns q (0 bottom → 1 top) and side
  const qOf = (theta) => {
    let f = (theta + Math.PI / 2) / (Math.PI * 2);
    f = ((f % 1) + 1) % 1;
    const side = f <= 0.5 ? 1 : -1;
    return [side > 0 ? f / 0.5 : (1 - f) / 0.5, side];
  };
  const endSoft = (t) => smoothstep(0.06, 0, t) * 0.75 + smoothstep(0.95, 1, t) * 0.6;

  function point(t, theta, out) {
    const [q, side] = qOf(theta);
    const y0 = floorY(t), y1 = belt(t), yt = top(t);
    const hw = halfW(t);
    let x, y;
    if (q <= LOWER_Q) {
      const [xn, yn] = lowerAt(q / LOWER_Q);
      // round the very ends of the car in plan so the bumpers wrap
      const es = endSoft(t);
      const xr = lerp(xn, Math.sqrt(Math.max(0, 1 - (yn * 2 - 1) ** 2)) * 0.98, es * 0.5);
      x = hw * xr;
      y = y0 + (y1 - y0) * yn;
    } else {
      // upper: shoulder ledge → glasshouse → crowned roof (super-ellipse quadrant)
      const s = (q - LOWER_Q) / (1 - LOWER_Q);
      const n = D.round;
      const xs = hw * 0.94 * shoulderInset(t);
      const xr = roofHalf(t);
      const ang = s * Math.PI / 2;
      const cx = Math.pow(Math.cos(ang), 2 / n), sy = Math.pow(Math.sin(ang), 2 / (n * 0.9));
      // side glass leans in (tumblehome) from the shoulder to the roof edge
      const lean = lerp(xs, xr, Math.min(1, s * 1.25));
      x = lean * cx;
      y = y1 + (yt - y1) * sy;
    }
    out.set(side * x, y, zOf(t));
    return out;
  }

  /** Material region for a surface point. */
  function region(t, theta) {
    const [q, side] = qOf(theta);
    void side;
    if (q < 0.05) return 'dark'; // underside
    if (q <= LOWER_Q) return 'paint';
    const s = (q - LOWER_Q) / (1 - LOWER_Q);
    const gh = top(t) - belt(t);
    if (gh < 0.1) return 'paint'; // bonnet / deck
    const cIn = t > c0 && t < c3;
    if (!cIn) return 'paint';
    // windscreen and rear glass span the whole top between their bases and the roof
    const windscreen = t > c2 && t < c3 - 0.008;
    const rearGlass = t > c0 + 0.008 && t < c1;
    const roof = t >= c1 && t <= c2;
    const sideZone = s < 0.62;
    if (s < 0.06) return 'trim'; // window seal line along the shoulder
    if (sideZone) {
      // side windows with A-, B- and C-pillars
      const tB = lerp(c1, c2, 0.48);
      if (Math.abs(t - tB) < 0.012 && !D.narrowCabin) return 'trim';
      if (t > c3 - 0.035 || t < c0 + 0.03) return 'paint';
      if (s > 0.56) return 'trim';
      return 'glass';
    }
    if (windscreen) return s > 0.66 ? 'glass' : 'trim';
    if (rearGlass) return s > 0.68 ? 'glass' : 'paint';
    if (roof) return D.blackRoof ? 'trim' : 'paint';
    return 'paint';
  }

  return { point, region, halfW, belt, top, floorY, zOf, tOf, zF, zR, L, W2, a, b, axles, wheelR, archR, roofHalf, cabin: D.cabin };
}

export { clamp };
