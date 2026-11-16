// Procedural car model. The body is lofted from smooth superellipse
// cross-sections (so it reads as a sculpted shell rather than boxes), with
// real wheel-arch openings, a livery-mapped UV layout, a glass greenhouse,
// aero parts and detailed wheels (tyre, multi-spoke rim, disc, caliper).
import * as THREE from 'three';
import { BODIES } from '../physics/carSetup.js';
import { liveryTexture } from '../world/textures.js';
import { createFormula } from './formulaModel.js';
import { createCar2 } from './carModel2.js';
import { batchStatic } from '../world/batch.js';
import { clamp, lerp, smoothstep } from '../core/math.js';

// keyframe profiles: [t, halfWidthFactor, belt (top of lower body, m)]
const PROFILES = {
  gt: {
    frontOH: 0.98, rearOH: 0.9, clearance: 0.13, n: 3.2,
    body: [[0, 0.86, 0.66], [0.05, 0.95, 0.86], [0.16, 1.0, 0.9], [0.32, 0.98, 0.88], [0.5, 0.96, 0.84], [0.66, 0.96, 0.79], [0.82, 0.96, 0.7], [0.92, 0.88, 0.6], [0.97, 0.76, 0.52], [1, 0.62, 0.46]],
    cabin: { t0: 0.2, t1: 0.66, roof: 1.24, peakA: 0.36, peakB: 0.47, baseW: 0.84, topW: 0.62, roofPaint: true },
    wing: 'lip',
  },
  hatch: {
    frontOH: 0.85, rearOH: 0.7, clearance: 0.14, n: 3.6,
    body: [[0, 0.9, 0.84], [0.05, 0.97, 0.93], [0.2, 1.0, 0.95], [0.45, 0.98, 0.93], [0.62, 0.97, 0.88], [0.8, 0.97, 0.82], [0.93, 0.93, 0.74], [1, 0.82, 0.58]],
    cabin: { t0: 0.04, t1: 0.66, roof: 1.38, peakA: 0.1, peakB: 0.44, baseW: 0.88, topW: 0.7, roofPaint: true },
    wing: 'roof',
  },
  proto: {
    frontOH: 1.0, rearOH: 0.95, clearance: 0.09, n: 2.8,
    body: [[0, 0.95, 0.8], [0.06, 1.0, 0.86], [0.2, 1.0, 0.82], [0.38, 0.9, 0.72], [0.55, 0.88, 0.66], [0.72, 0.98, 0.7], [0.84, 0.98, 0.66], [0.94, 0.9, 0.48], [1, 0.75, 0.32]],
    cabin: { t0: 0.36, t1: 0.74, roof: 1.08, peakA: 0.46, peakB: 0.56, baseW: 0.55, topW: 0.38, roofPaint: false },
    wing: 'big',
  },
  // rear-engined flat-six sports car: long sloping roof, wide hips, round lamps
  rs: {
    frontOH: 0.92, rearOH: 1.15, clearance: 0.12, n: 3.0, hips: 0.09, lights: 'round',
    body: [[0, 0.84, 0.8], [0.06, 0.94, 0.86], [0.18, 1.0, 0.86], [0.32, 0.97, 0.84], [0.5, 0.93, 0.82], [0.66, 0.95, 0.78], [0.8, 0.96, 0.72], [0.9, 0.86, 0.6], [0.96, 0.74, 0.52], [1, 0.58, 0.44]],
    cabin: { t0: 0.06, t1: 0.66, roof: 1.28, peakA: 0.46, peakB: 0.52, baseW: 0.82, topW: 0.6, roofPaint: true },
    wing: 'duck',
  },
  gt3: {
    frontOH: 1.0, rearOH: 1.15, clearance: 0.08, n: 2.9, hips: 0.14, lights: 'round',
    body: [[0, 0.88, 0.8], [0.06, 0.98, 0.86], [0.18, 1.0, 0.86], [0.32, 0.95, 0.84], [0.5, 0.9, 0.82], [0.66, 0.95, 0.78], [0.8, 0.98, 0.7], [0.9, 0.88, 0.56], [0.96, 0.76, 0.46], [1, 0.6, 0.38]],
    cabin: { t0: 0.06, t1: 0.66, roof: 1.25, peakA: 0.46, peakB: 0.52, baseW: 0.78, topW: 0.56, roofPaint: true },
    wing: 'swan', splitter: 1.4,
  },
  hyper: {
    frontOH: 1.05, rearOH: 0.9, clearance: 0.08, n: 2.6, hips: 0.1,
    body: [[0, 0.92, 0.82], [0.06, 1.0, 0.9], [0.2, 1.0, 0.86], [0.36, 0.86, 0.74], [0.5, 0.84, 0.7], [0.64, 0.94, 0.72], [0.8, 0.96, 0.62], [0.9, 0.86, 0.5], [0.96, 0.74, 0.4], [1, 0.58, 0.32]],
    cabin: { t0: 0.3, t1: 0.74, roof: 1.15, peakA: 0.44, peakB: 0.55, baseW: 0.64, topW: 0.45, roofPaint: true },
    wing: 'big', splitter: 1.2,
  },
  muscle: {
    frontOH: 1.0, rearOH: 1.05, clearance: 0.15, n: 5.5, hips: 0.03, lights: 'round',
    body: [[0, 0.95, 0.9], [0.05, 0.99, 0.94], [0.2, 1.0, 0.95], [0.4, 1.0, 0.94], [0.6, 1.0, 0.93], [0.8, 0.99, 0.92], [0.94, 0.98, 0.88], [1, 0.94, 0.74]],
    cabin: { t0: 0.18, t1: 0.6, roof: 1.33, peakA: 0.4, peakB: 0.48, baseW: 0.86, topW: 0.7, roofPaint: true },
    wing: 'lip', stripes: true,
  },
  jdm: {
    frontOH: 0.86, rearOH: 0.82, clearance: 0.12, n: 3.6,
    body: [[0, 0.9, 0.82], [0.06, 0.97, 0.88], [0.2, 1.0, 0.88], [0.4, 0.98, 0.85], [0.6, 0.97, 0.82], [0.8, 0.97, 0.74], [0.92, 0.9, 0.64], [0.97, 0.8, 0.56], [1, 0.66, 0.5]],
    cabin: { t0: 0.17, t1: 0.66, roof: 1.3, peakA: 0.3, peakB: 0.48, baseW: 0.85, topW: 0.66, roofPaint: true },
    wing: 'gtwing',
  },
  rally: {
    frontOH: 0.82, rearOH: 0.72, clearance: 0.2, n: 3.8, hips: 0.06,
    body: [[0, 0.9, 0.88], [0.05, 0.98, 0.96], [0.2, 1.0, 0.97], [0.45, 0.98, 0.95], [0.62, 0.97, 0.9], [0.8, 0.97, 0.84], [0.93, 0.93, 0.76], [1, 0.82, 0.6]],
    cabin: { t0: 0.04, t1: 0.66, roof: 1.42, peakA: 0.1, peakB: 0.44, baseW: 0.88, topW: 0.7, roofPaint: true },
    wing: 'roof', scoop: true, flaps: true,
  },
};

function interp(keys, t, col) {
  if (t <= keys[0][0]) return keys[0][col];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      const u = (t - a[0]) / (b[0] - a[0]);
      // cubic hermite with catmull-rom tangents
      const p0 = keys[Math.max(0, i - 2)][col], p1 = a[col], p2 = b[col], p3 = keys[Math.min(keys.length - 1, i + 1)][col];
      const m1 = (p2 - p0) / 2, m2 = (p3 - p1) / 2;
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
    }
  }
  return keys[keys.length - 1][col];
}

const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

export function createCar(setup) {
  const B = BODIES[setup.body] || BODIES.gt;
  if (B.model === 'formula') return createFormula(setup, B);
  if (setup.modelV2) return createCar2(setup); // design-language v2 (in development)
  const P = PROFILES[B.model] || PROFILES.gt;
  const a = B.wheelbase * (1 - B.weightFront); // CG → front axle
  const b = B.wheelbase * B.weightFront; // CG → rear axle
  const zF = a + P.frontOH, zR = -b - P.rearOH;
  const W2 = B.width / 2;
  const wheelR = B.wheelR;
  const archR = wheelR + 0.055;
  const axles = [a, -b];
  const zOf = (t) => lerp(zR, zF, t);

  const finish = setup.finish || 'gloss';
  const paintMat = new THREE.MeshPhysicalMaterial({
    map: liveryTexture(setup),
    metalness: finish === 'metallic' ? 0.65 : finish === 'pearl' ? 0.35 : 0.05,
    roughness: finish === 'matte' ? 0.55 : finish === 'metallic' ? 0.32 : 0.28,
    clearcoat: finish === 'matte' ? 0.0 : 1.0,
    clearcoatRoughness: 0.04,
    iridescence: finish === 'pearl' ? 0.6 : 0,
    iridescenceIOR: 1.6,
    envMapIntensity: 1.0,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x1a222c, metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.8 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.55, metalness: 0.2 });
  const carbonMat = new THREE.MeshPhysicalMaterial({ color: 0x15171a, roughness: 0.35, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.12, metalness: 1 });
  const accentMat = new THREE.MeshPhysicalMaterial({ color: setup.accent || '#16181d', roughness: 0.3, metalness: 0.2, clearcoat: 1 });

  const root = new THREE.Group();
  root.name = 'car';
  const body = new THREE.Group(); // receives pitch/roll
  root.add(body);

  // ---------------- lofted lower body
  const halfW = (t) => {
    let w = interp(P.body, t, 1) * W2;
    for (const az of axles) w += (az < 0 ? 0.045 + (P.hips || 0) : 0.045) * W2 * Math.exp(-(((zOf(t) - az) / (az < 0 ? 0.7 : 0.55)) ** 2)); // fender bulges / hips
    return w;
  };
  const belt = (t) => interp(P.body, t, 2);
  const floorY = (t) => {
    let y = P.clearance + 0.05 * smoothstep(0.85, 1, t) + 0.06 * smoothstep(0.12, 0, t);
    for (const az of axles) {
      const dz = Math.abs(zOf(t) - az);
      if (dz < archR) y = Math.max(y, wheelR + Math.sqrt(archR * archR - dz * dz) - 0.02);
    }
    return Math.min(y, belt(t) - 0.06);
  };
  const SEG_L = 110, SEG_R = 44;
  // Designed cross-section (unit space: x = fraction of half-width,
  // y = fraction of section height). Tucked sill, widest point low on the
  // door, a sharp shoulder crease and a gently crowned deck.
  const SECTION = [
    [0.0, 0.0], [0.55, 0.0], [0.82, 0.01], [0.93, 0.05], [0.985, 0.16], [1.0, 0.3], [0.998, 0.45],
    [0.99, 0.6], [0.978, 0.72], [0.965, 0.8], [0.955, 0.86], // shoulder crease ↓
    [0.9, 0.935], [0.78, 0.975], [0.55, 0.995], [0.28, 1.005], [0.0, 1.01],
  ];
  const secLen = [0];
  for (let k = 1; k < SECTION.length; k++) secLen.push(secLen[k - 1] + Math.hypot(SECTION[k][0] - SECTION[k - 1][0], (SECTION[k][1] - SECTION[k - 1][1]) * 0.8));
  const secAt = (q) => {
    const L = q * secLen[secLen.length - 1];
    let k = 1;
    while (k < secLen.length - 1 && secLen[k] < L) k++;
    const f = (L - secLen[k - 1]) / (secLen[k] - secLen[k - 1] || 1);
    return [lerp(SECTION[k - 1][0], SECTION[k][0], f), lerp(SECTION[k - 1][1], SECTION[k][1], f)];
  };
  const sectionPt = (t, theta, out) => {
    const y0 = floorY(t), y1 = belt(t);
    // theta → position around the section: v = 0 bottom, .25 left (+x), .5 top, .75 right
    let f = (theta + Math.PI / 2) / (Math.PI * 2);
    f = ((f % 1) + 1) % 1;
    const side = f <= 0.5 ? 1 : -1;
    const q = side > 0 ? f / 0.5 : (1 - f) / 0.5;
    const [xn, yn] = secAt(q);
    // ends of the car get rounder (nose/tail) so the crease fades out
    const endSoft = smoothstep(0.1, 0, t) + smoothstep(0.9, 1, t);
    const xr = lerp(xn, Math.sin(Math.acos(Math.min(1, Math.abs(yn * 2 - 1)))) , Math.min(1, endSoft * 0.7));
    out.set(side * halfW(t) * xr, y0 + (y1 - y0) * yn, zOf(t));
    return out;
  };
  body.add(lofted(sectionPt, SEG_L, SEG_R, paintMat, { capScale: [0.9, 0.62, 0.0], capOffset: [0.035, 0.065, 0.08], zF, zR }));

  // ---------------- greenhouse / canopy
  const C = P.cabin;
  const roofAt = (t) => {
    const u = (t - C.t0) / (C.t1 - C.t0);
    const pa = (C.peakA - C.t0) / (C.t1 - C.t0), pb = (C.peakB - C.t0) / (C.t1 - C.t0);
    let f;
    if (u < pa) f = Math.sin((u / pa) * Math.PI * 0.5) ** 0.7;
    else if (u > pb) f = Math.cos(((u - pb) / (1 - pb)) * Math.PI * 0.5) ** 0.85;
    else f = 1;
    return lerp(belt(t) - 0.04, C.roof, f);
  };
  const cabinPt = (tc, theta, out) => {
    const t = lerp(C.t0, C.t1, tc);
    const y0 = belt(t) - 0.05, y1 = Math.max(roofAt(t), y0 + 0.02);
    const yc = (y0 + y1) / 2, hh = (y1 - y0) / 2;
    const c = Math.cos(theta), s = Math.sin(theta);
    const yy = yc + hh * spow(s, 2 / 3.2);
    const k = (yy - y0) / Math.max(y1 - y0, 0.01);
    const w = halfW(t) * lerp(C.baseW, C.topW, k);
    out.set(w * spow(c, 2 / 3.2), yy, zOf(t));
    return out;
  };
  // greenhouse: glass panes framed by painted A-pillars / roof rails and
  // black B-pillars (instead of one dark glass bubble)
  const pillarMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, roughness: 0.25, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08 });
  const cabin = lofted(cabinPt, 72, 48, [glassMat, paintMat, pillarMat], {
    capScale: [0.6, 0], capOffset: [0.0, 0.0], zF, zR,
    group: (tc, theta) => {
      const a = Math.abs(((theta + Math.PI * 2.5) % (Math.PI * 2)) - Math.PI); // 0 = top, π/2 = side
      if (a > Math.PI * 0.85) return 2; // underside (hidden)
      const roof = C.roofPaint ? 1 : 0;
      if (a < 1.0) return tc > 0.3 && tc < 0.62 ? roof : 0; // roof panel vs screens
      if (a < 1.28) return C.roofPaint ? 1 : 2; // A-pillars & roof rails
      if (tc < 0.05 || tc > 0.95) return 2; // C-pillar / base of A-pillar
      if (Math.abs(tc - 0.5) < 0.035 && C.roofPaint) return 2; // B-pillar
      return 0; // side windows
    },
    noCaps: false,
  });
  body.add(cabin);

  // ---------------- underfloor + arch liners (hide the inside of the shell)
  {
    const fl = new THREE.Mesh(new THREE.BoxGeometry(W2 * 1.35, 0.06, B.wheelbase + archR * 1.2), blackMat);
    fl.position.set(0, P.clearance + 0.06, (a - b) / 2);
    body.add(fl);
    for (const az of axles) {
      const liner = new THREE.Mesh(new THREE.CylinderGeometry(archR - 0.005, archR - 0.005, W2 * 1.9, 28, 1, true, -Math.PI / 2, Math.PI), new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.9, side: THREE.BackSide }));
      liner.rotation.z = Math.PI / 2;
      liner.rotation.y = 0;
      liner.position.set(0, wheelR, az);
      body.add(liner);
    }
  }

  // ---------------- lights
  const tmp = new THREE.Vector3();
  const headMat = new THREE.MeshPhysicalMaterial({ color: 0xdfe6ee, emissive: 0xd8e6ff, emissiveIntensity: 0.55, roughness: 0.05, metalness: 0.6, clearcoat: 1 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 0.9, roughness: 0.25 });
  const revMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 });
  for (const sx of [1, -1]) {
    const tH = 0.955;
    sectionPt(tH, sx > 0 ? 0.45 : Math.PI - 0.45, tmp);
    const round = P.lights === 'round';
    const hl = new THREE.Mesh(round ? new THREE.SphereGeometry(0.085, 20, 14) : new THREE.CapsuleGeometry(0.035, 0.26, 6, 12), headMat);
    if (round) { hl.scale.set(1, 1, 0.55); } else { hl.rotation.z = Math.PI / 2; }
    hl.rotation.y = sx * 0.35;
    hl.position.copy(tmp).add(new THREE.Vector3(-sx * 0.05, -0.01, -0.03));
    body.add(hl);
    const drl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.018, 0.02), headMat);
    drl.position.copy(tmp).add(new THREE.Vector3(-sx * 0.05, -0.07, 0.03));
    drl.rotation.y = sx * 0.35;
    body.add(drl);
  }
  {
    const yT = belt(0.02) - 0.1;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(W2 * 1.62, 0.055, 0.05), tailMat);
    bar.position.set(0, yT, zR - 0.025);
    body.add(bar);
    for (const sx of [1, -1]) {
      const cl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.11, 0.05), tailMat);
      cl.position.set(sx * W2 * 0.68, yT - 0.02, zR - 0.02);
      body.add(cl);
      const rv = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.04), revMat);
      rv.position.set(sx * W2 * 0.4, yT - 0.08, zR - 0.01);
      body.add(rv);
    }
  }

  // ---------------- aero and trim
  {
    const spl = new THREE.Mesh(new THREE.BoxGeometry(halfW(0.95) * 1.7 * Math.min(P.splitter || 1, 1.15), 0.02, 0.22 * (P.splitter || 1)), carbonMat);
    spl.position.set(0, P.clearance - 0.01, zF - 0.24);
    body.add(spl);
    const grille = new THREE.Mesh(new THREE.BoxGeometry(halfW(0.98) * 1.1, 0.12, 0.05), blackMat);
    grille.position.set(0, P.clearance + 0.13, zF - 0.06);
    body.add(grille);
    const diff = new THREE.Mesh(new THREE.BoxGeometry(halfW(0.03) * 1.4, 0.08, 0.36), carbonMat);
    diff.position.set(0, P.clearance + 0.02, zR + 0.12);
    body.add(diff);
    for (let k = -2; k <= 2; k++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.14, 0.4), carbonMat);
      fin.position.set(k * 0.3, P.clearance + 0.04, zR + 0.12);
      body.add(fin);
    }
    for (const sx of [1, -1]) {
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 18, 1, true), chromeMat);
      ex.rotation.x = Math.PI / 2;
      ex.position.set(sx * 0.32, P.clearance + 0.11, zR - 0.03);
      body.add(ex);
      // side skirts
      const sk = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, B.wheelbase - archR * 2 - 0.1), carbonMat);
      sk.position.set(sx * (W2 * 0.94), P.clearance + 0.04, (a - b) / 2);
      body.add(sk);
      // mirrors
      const tm = C.t0 + (C.t1 - C.t0) * (B.model === 'proto' || B.model === 'hyper' ? 0.62 : 0.78);
      const mirror = new THREE.Group();
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.04), blackMat);
      stalk.position.x = sx * 0.06;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 10), paintMat);
      cap.scale.set(1.3, 0.75, 0.9);
      cap.position.x = sx * 0.14;
      const glassM = new THREE.Mesh(new THREE.CircleGeometry(0.055, 16), chromeMat);
      glassM.position.set(sx * 0.14, 0, -0.068);
      glassM.rotation.y = Math.PI;
      mirror.add(stalk, cap, glassM);
      mirror.position.set(sx * halfW(tm) * C.baseW, belt(tm) + 0.08, zOf(tm));
      body.add(mirror);
    }
    // wing
    const wing = new THREE.Group();
    if (P.wing === 'big') {
      const prof = new THREE.Shape();
      prof.moveTo(0, 0); prof.bezierCurveTo(0.08, 0.05, 0.25, 0.045, 0.38, 0.0); prof.bezierCurveTo(0.25, 0.012, 0.08, -0.008, 0, 0);
      const wg = new THREE.ExtrudeGeometry(prof, { depth: W2 * 1.85, bevelEnabled: false, steps: 1 });
      wg.translate(-0.19, 0, -W2 * 0.925);
      wg.rotateY(Math.PI / 2);
      const blade = new THREE.Mesh(wg, carbonMat);
      wing.add(blade);
      for (const sx of [1, -1]) {
        const ep = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.28, 0.5), carbonMat);
        ep.position.set(sx * W2 * 0.93, -0.06, 0);
        wing.add(ep);
        const py = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.36, 0.12), carbonMat);
        py.position.set(sx * 0.3, -0.22, 0.05);
        wing.add(py);
      }
      wing.position.set(0, belt(0.06) + 0.38, zR + 0.32);
    } else if (P.wing === 'swan') {
      // GT3 swan-neck wing: wide blade hung from above
      const prof = new THREE.Shape();
      prof.moveTo(0, 0); prof.bezierCurveTo(0.08, 0.06, 0.28, 0.05, 0.42, 0.0); prof.bezierCurveTo(0.28, 0.014, 0.08, -0.01, 0, 0);
      const wg = new THREE.ExtrudeGeometry(prof, { depth: W2 * 1.9, bevelEnabled: false });
      wg.translate(-0.21, 0, -W2 * 0.95);
      wg.rotateY(Math.PI / 2);
      wing.add(new THREE.Mesh(wg, carbonMat));
      for (const sx of [1, -1]) {
        const ep = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.3, 0.52), carbonMat);
        ep.position.set(sx * W2 * 0.95, -0.05, 0);
        wing.add(ep);
        const neck = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.018, 6, 16, Math.PI * 0.8), carbonMat);
        neck.rotation.y = Math.PI / 2;
        neck.position.set(sx * 0.32, -0.16, -0.02);
        wing.add(neck);
      }
      wing.position.set(0, belt(0.06) + 0.42, zR + 0.38);
    } else if (P.wing === 'duck') {
      const duck = new THREE.Mesh(new THREE.BoxGeometry(W2 * 1.45, 0.05, 0.26), paintMat);
      duck.position.set(0, 0.0, 0);
      wing.add(duck);
      wing.position.set(0, belt(0.05) + 0.05, zR + 0.32);
    } else if (P.wing === 'gtwing') {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(W2 * 1.7, 0.03, 0.26), carbonMat);
      wing.add(blade);
      for (const sx of [1, -1]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.1), carbonMat);
        st.position.set(sx * 0.45, -0.1, 0);
        wing.add(st);
        const ep = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.12, 0.3), carbonMat);
        ep.position.set(sx * W2 * 0.85, 0, 0);
        wing.add(ep);
      }
      wing.position.set(0, belt(0.04) + 0.2, zR + 0.2);
    } else if (P.wing === 'lip') {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(W2 * 1.5, 0.03, 0.16), carbonMat);
      lip.position.set(0, 0.0, 0);
      wing.add(lip);
      wing.position.set(0, belt(0.03) + 0.02, zR + 0.12);
    } else {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(W2 * 1.45, 0.035, 0.3), accentMat);
      wing.add(sp);
      wing.position.set(0, C.roof - 0.02, zOf(C.t0) + 0.12);
    }
    wing.rotation.x = -0.08 - (setup.rearWing ?? 0.5) * 0.18;
    body.add(wing);
    if (P.scoop) {
      const sc = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.35), accentMat);
      sc.position.set(0, C.roof + 0.03, zOf((C.t0 + C.t1) / 2 + 0.12));
      body.add(sc);
    }
    if (P.flaps) {
      for (const sx of [1, -1]) for (const az of axles) {
        const flap = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.24, 0.012), new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.8 }));
        flap.position.set(sx * (B.trackR / 2), 0.2, az - archR - 0.02);
        body.add(flap);
      }
    }
  }

  // ---------------- wheels
  const wheels = [];
  const wheelPositions = [
    [B.trackF / 2, a], [-B.trackF / 2, a], [B.trackR / 2, -b], [-B.trackR / 2, -b],
  ];
  const tyreWidth = B.model === 'hatch' || B.model === 'jdm' ? 0.225 : B.model === 'gt3' || B.model === 'hyper' || B.model === 'proto' ? 0.31 : 0.275;
  const wheelTemplate = buildWheel(wheelR, tyreWidth, setup.rim || '#c9ccd1', B.model);
  batchStatic(wheelTemplate); // ~25 parts → 5 draw calls per wheel
  const caliperMat = new THREE.MeshStandardMaterial({ color: B.model === 'proto' || B.model === 'hyper' ? 0xffc21a : 0xd4202a, roughness: 0.35, metalness: 0.3 });
  wheelPositions.forEach(([x, z], i) => {
    const steer = new THREE.Group();
    steer.position.set(x, wheelR, z);
    const spin = wheelTemplate.clone();
    if (x < 0) spin.scale.x = -1;
    steer.add(spin);
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.11), caliperMat);
    cal.position.set(Math.sign(x) * -0.05, 0.12, -0.12);
    steer.add(cal);
    root.add(steer);
    wheels.push({ steer, spin });
  });

  // contact shadow blob for grounding (cheap AO)
  const blobTex = new THREE.CanvasTexture((() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return c;
  })());
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(W2 * 2.6, (zF - zR) * 1.18), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(0, 0.03, (zF + zR) / 2);
  blob.renderOrder = 1;
  root.add(blob);

  // only the big shapes cast shadows (shadow-pass draw calls are not free)
  root.traverse((o) => {
    if (!o.isMesh || o === blob) return;
    o.receiveShadow = true;
    const big = o.geometry.boundingSphere || (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere);
    o.castShadow = big.radius > 0.3;
  });

  batchStatic(body); // the whole shell + trim → one mesh per material
  root.userData = { body, wheels, tailMat, revMat, headMat, paintMat, length: zF - zR, width: W2 * 2, zF, zR, wheelR, sync: makeSync(body, wheels, tailMat, revMat) };
  return root;
}

/**
 * Loft a closed tube through cross-sections. fn(t, theta, out) gives points.
 * Caps close both ends with rounded nose rings.
 */
export function lofted(fn, segL, segR, material, opts) {
  const pos = [], uv = [], idx = [];
  const v = new THREE.Vector3();
  const rows = [];
  const centerOf = (t) => {
    const c = new THREE.Vector3();
    for (let j = 0; j < segR; j++) c.add(fn(t, (j / segR) * Math.PI * 2 - Math.PI / 2, v.clone ? new THREE.Vector3() : v));
    return c.multiplyScalar(1 / segR);
  };
  const ringAt = (t, scale = 1, dz = 0, uOverride) => {
    const c = scale < 1 ? centerOf(t) : null;
    const row = [];
    for (let j = 0; j <= segR; j++) {
      const theta = (j / segR) * Math.PI * 2 - Math.PI / 2;
      const p = fn(t, theta, new THREE.Vector3());
      if (c) { p.sub(c).multiplyScalar(scale).add(c); }
      p.z += dz;
      pos.push(p.x, p.y, p.z);
      uv.push(uOverride ?? t, j / segR);
      row.push(pos.length / 3 - 1);
    }
    return row;
  };
  const caps = opts.noCaps ? [] : opts.capScale;
  // rear cap rings (reverse order so the tube is continuous)
  for (let k = caps.length - 1; k >= 0; k--) rows.push({ row: ringAt(0, caps[k], -opts.capOffset[k] || 0, 0), t: 0 });
  for (let i = 0; i <= segL; i++) rows.push({ row: ringAt(i / segL), t: i / segL });
  for (let k = 0; k < caps.length; k++) rows.push({ row: ringAt(1, caps[k], opts.capOffset[k] || 0, 1), t: 1 });
  const nMat = Array.isArray(material) ? material.length : 1;
  const groups = Array.from({ length: nMat }, () => []);
  for (let r = 0; r < rows.length - 1; r++) {
    const A = rows[r].row, Bq = rows[r + 1].row;
    const tc = (rows[r].t + rows[r + 1].t) / 2;
    for (let j = 0; j < segR; j++) {
      const theta = ((j + 0.5) / segR) * Math.PI * 2 - Math.PI / 2;
      const gi = opts.group ? Math.min(nMat - 1, opts.group(tc, theta)) : 0;
      // outward-facing winding (normals point away from the body)
      groups[gi].push(A[j], A[j + 1], Bq[j], A[j + 1], Bq[j + 1], Bq[j]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(groups.flat());
  if (nMat > 1) {
    let start = 0;
    groups.forEach((g, k) => { geo.addGroup(start, g.length, k); start += g.length; });
  }
  geo.computeVertexNormals();
  // weld normals across the seam (theta wraps)
  const n = geo.attributes.normal;
  for (const { row } of rows) {
    const a = row[0], b = row[row.length - 1];
    const nx = n.getX(a) + n.getX(b), ny = n.getY(a) + n.getY(b), nz = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(a, nx / l, ny / l, nz / l); n.setXYZ(b, nx / l, ny / l, nz / l);
  }
  return new THREE.Mesh(geo, material);
}

export function buildWheel(R, width, rimColor, style) {
  const g = new THREE.Group();
  // tyre: lathe a rounded section around the X axis
  const rimR = R * 0.7;
  const pts = [];
  const hw = width / 2;
  const sh = 0.035;
  pts.push(new THREE.Vector2(rimR - 0.01, -hw * 0.92));
  pts.push(new THREE.Vector2(rimR + 0.02, -hw));
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * Math.PI / 2;
    pts.push(new THREE.Vector2(R - sh + Math.sin(a) * sh, -hw + sh - Math.cos(a) * sh));
  }
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * Math.PI / 2;
    pts.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, hw - sh + Math.sin(a) * sh));
  }
  pts.push(new THREE.Vector2(rimR + 0.02, hw));
  pts.push(new THREE.Vector2(rimR - 0.01, hw * 0.92));
  const tg = new THREE.LatheGeometry(pts, 48);
  tg.rotateZ(Math.PI / 2);
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.88, metalness: 0 });
  g.add(new THREE.Mesh(tg, tyreMat));
  // rim barrel + face
  const rimMat = new THREE.MeshPhysicalMaterial({ color: rimColor, metalness: 0.9, roughness: 0.25, clearcoat: 0.6 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.8, roughness: 0.45 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, width * 0.9, 40, 1, true), darkMat);
  barrel.rotation.z = Math.PI / 2;
  g.add(barrel);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR - 0.008, 0.012, 8, 48), rimMat);
  lip.rotation.y = Math.PI / 2;
  lip.position.x = width * 0.44;
  g.add(lip);
  const spokes = style === 'hatch' ? 6 : 5;
  for (let k = 0; k < spokes; k++) {
    const ang = (k / spokes) * Math.PI * 2;
    for (const off of [-0.11, 0.11]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.035, rimR * 0.92, 0.042), rimMat);
      sp.geometry.translate(0, rimR * 0.46, 0);
      sp.rotation.x = ang + off * (style === 'proto' ? 0.4 : 1);
      sp.position.x = width * 0.36;
      g.add(sp);
    }
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.06, 20), rimMat);
  hub.rotation.z = Math.PI / 2;
  hub.position.x = width * 0.38;
  g.add(hub);
  const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.07, 6), rimMat);
  nut.rotation.z = Math.PI / 2;
  nut.position.x = width * 0.4;
  g.add(nut);
  // brake disc
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.82, rimR * 0.82, 0.03, 36), darkMat);
  disc.rotation.z = Math.PI / 2;
  disc.position.x = -0.02;
  g.add(disc);
  return g;
}

/** Shared visual suspension + wheel/lights sync for every car model. */
export function makeSync(body, wheels, tailMat, revMat) {
  const state = { roll: 0, pitch: 0, heave: 0 };
  return (car, dt) => {
    const rf = car.p.body.roll ?? 1;
    const targetPitch = clamp(-car.ax * 0.0022 * Math.sqrt(rf), -0.025, 0.025);
    const targetRoll = clamp(-car.ay * 0.0026 * rf, -0.035, 0.035);
    const k = 1 - Math.exp(-dt * 16);
    state.pitch += (targetPitch - state.pitch) * k;
    state.roll += (targetRoll - state.roll) * k;
    let heave = 0;
    if (car.surface === 1) heave = Math.sin(car.time * 70) * 0.008;
    if (car.surface === 3) heave = Math.sin(car.time * 43) * 0.012;
    state.heave += (heave - state.heave) * 0.5;
    body.rotation.set(state.pitch, 0, state.roll);
    body.position.y = state.heave;
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      wheels[i].steer.rotation.y = w.steer;
      wheels[i].spin.rotation.x = w.spin;
    }
    tailMat.emissiveIntensity = car.brake > 0.05 ? 3 : 0.5;
    if (revMat) revMat.emissiveIntensity = car.gear === -1 ? 3 : 0;
  };
}

export function disposeCar(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
