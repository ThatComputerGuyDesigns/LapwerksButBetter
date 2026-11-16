// Car builder v2 (see carShape.js for the design language). One lofted body
// surface with paint / glass / trim regions, conforming light units and
// grilles, real proportions, and detailed wheels.
import * as THREE from 'three';
import { BODIES } from '../physics/carSetup.js';
import { liveryTexture } from '../world/textures.js';
import { batchStatic } from '../world/batch.js';
import { lerp, smoothstep } from '../core/math.js';
import { DESIGNS, bodyShape } from './carShape.js';
import { lofted, makeSync } from './carModel.js';

const REGIONS = ['paint', 'glass', 'trim', 'dark'];

function materials(setup) {
  const finish = setup.finish || 'gloss';
  const paint = new THREE.MeshPhysicalMaterial({
    map: liveryTexture(setup),
    metalness: finish === 'metallic' ? 0.55 : finish === 'pearl' ? 0.3 : 0.02,
    roughness: finish === 'matte' ? 0.5 : finish === 'metallic' ? 0.3 : 0.22,
    clearcoat: finish === 'matte' ? 0 : 1, clearcoatRoughness: 0.03,
    iridescence: finish === 'pearl' ? 0.5 : 0, iridescenceIOR: 1.5,
    envMapIntensity: 1.15,
  });
  return {
    paint,
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0d1218, metalness: 0.1, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0.0, envMapIntensity: 2.0, specularIntensity: 1 }),
    trim: new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.18, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.8, metalness: 0.1 }),
    carbon: new THREE.MeshPhysicalMaterial({ color: 0x141619, roughness: 0.3, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.12 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.08, metalness: 1 }),
    grille: new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.6, metalness: 0.4 }),
    head: new THREE.MeshStandardMaterial({ color: 0xf4f7ff, emissive: 0xe8f0ff, emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.2 }),
    lensBack: new THREE.MeshPhysicalMaterial({ color: 0x10141a, roughness: 0.05, metalness: 0.9, clearcoat: 1 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0xff1a10, emissiveIntensity: 0.9, roughness: 0.25 }),
    rev: new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 }),
    plate: new THREE.MeshStandardMaterial({ color: 0xf0f0ea, roughness: 0.5, map: plateTexture(setup.number) }),
    accent: new THREE.MeshPhysicalMaterial({ color: setup.accent || '#16181d', roughness: 0.3, metalness: 0.2, clearcoat: 1 }),
  };
}

let plateCache = new Map();
function plateTexture(num) {
  const key = String(num ?? 7);
  if (plateCache.has(key)) return plateCache.get(key);
  const c = document.createElement('canvas'); c.width = 256; c.height = 56;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f2ec'; g.fillRect(0, 0, 256, 56);
  g.strokeStyle = '#222'; g.lineWidth = 3; g.strokeRect(3, 3, 250, 50);
  g.fillStyle = '#16181c'; g.font = '700 34px "Saira Variable", system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(`KRB ${key.padStart(2, '0')}`, 128, 30);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  plateCache.set(key, t);
  return t;
}

export function createCar2(setup) {
  const B = BODIES[setup.body] || BODIES.gt;
  const D = DESIGNS[B.model] || DESIGNS.gt;
  const S = bodyShape(D, B);
  const M = materials(setup);
  const root = new THREE.Group();
  root.name = 'car';
  const body = new THREE.Group();
  root.add(body);

  // ---------------- body surface (one continuous loft)
  const shell = lofted(S.point, 200, 80, [M.paint, M.glass, M.trim, M.dark], {
    capScale: [0.92, 0.7, 0.35, 0], capOffset: [0.02, 0.045, 0.065, 0.075], zF: S.zF, zR: S.zR,
    group: (tc, theta) => REGIONS.indexOf(S.region(Math.min(0.999, Math.max(0.001, tc)), theta)),
  });
  body.add(shell);

  // ---------------- helpers: points / normals on the surface by (t, q, side)
  const thetaOf = (q, side) => (side > 0 ? q * 0.5 : 1 - q * 0.5) * Math.PI * 2 - Math.PI / 2;
  const P = (t, q, side) => S.point(t, thetaOf(q, side), new THREE.Vector3());
  const N = (t, q, side) => {
    const e = 0.004;
    const pt = P(t, q, side);
    const du = P(Math.min(1, t + e), q, side).sub(P(Math.max(0, t - e), q, side));
    const dv = P(t, Math.min(1, q + e), side).sub(P(t, Math.max(0, q - e), side));
    const n = new THREE.Vector3().crossVectors(du, dv).normalize();
    // ensure it points away from the car's centre line
    const out = new THREE.Vector3(pt.x, pt.y - 0.5, 0).normalize();
    if (n.dot(out) < 0 && Math.abs(pt.x) > 0.05) n.negate();
    if (q > 0.8 && n.y < 0) n.negate();
    return n;
  };
  /** A grid patch of the surface, lifted along the normal (decals that conform). */
  const patch = (t0, t1, q0, q1, side, mat, lift = 0.004, nu = 10, nv = 6, shape = null) => {
    const pos = [], idx = [];
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const u = i / nu, v = j / nv;
      let qq = lerp(q0, q1, v);
      if (shape) qq = shape(u, v, q0, q1);
      const t = lerp(t0, t1, u);
      const p = P(t, qq, side).addScaledVector(N(t, qq, side), lift);
      pos.push(p.x, p.y, p.z);
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j, b = a + nv + 1;
      if (side > 0) idx.push(a, b, a + 1, b, b + 1, a + 1); else idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    body.add(m);
    return m;
  };

  // ---------------- lights
  for (const side of [1, -1]) {
    if (D.lights === 'round') {
      const c = P(0.962, 0.6, side), n = N(0.962, 0.6, side);
      const lamp = new THREE.Group();
      const bezel = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.11, 0.03, 32), M.trim);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2.6), M.glass);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.009, 8, 32), M.head);
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.02;
      const proj = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 20), M.head);
      proj.position.y = 0.018;
      lamp.add(bezel, ring, proj, lens);
      lamp.position.copy(c).addScaledVector(n, 0.005);
      lamp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      body.add(lamp);
    } else if (D.lights === 'twin') {
      for (const k of [0, 1]) {
        const c = P(0.993, 0.42 + k * 0.0, side).add(new THREE.Vector3(-side * (0.18 + k * 0.2), 0, 0.01));
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.04, 28), M.head);
        lamp.rotation.x = Math.PI / 2;
        lamp.position.copy(c);
        body.add(lamp);
      }
    } else {
      // swept LED blade + dark projector housing
      const blade = D.lights === 'blade';
      patch(blade ? 0.935 : 0.92, 0.988, 0.47, 0.6, side, M.lensBack, 0.003, 12, 5, (u, v, q0, q1) => lerp(q0, q1, v) + (blade ? 0.05 : 0.03) * u);
      patch(blade ? 0.94 : 0.925, 0.985, 0.585, 0.6, side, M.head, 0.006, 12, 2, (u, v, q0, q1) => lerp(q0, q1, v) + (blade ? 0.05 : 0.03) * u);
      const pc = P(0.972, 0.53, side), pn = N(0.972, 0.53, side);
      const proj = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.02, 20), M.head);
      proj.position.copy(pc).addScaledVector(pn, 0.008);
      proj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pn);
      body.add(proj);
    }
    // tail light wrap on the rear corner
    patch(0.004, 0.05, 0.5, 0.56, side, M.tail, 0.004, 8, 3);
    // side marker / fender vent
    if (D.vents === 'wing' || D.vents === 'arch') {
      const t0 = S.tOf(S.a + S.archR * 0.6);
      for (let k = 0; k < 3; k++) patch(t0 + k * 0.012, t0 + k * 0.012 + 0.007, 0.32, 0.44, side, M.trim, 0.004, 2, 4);
    }
    // deep side intakes ahead of the rear wheels (mid-engined cars)
    if (D.sideIntake) patch(S.tOf(-S.b + S.archR + 0.05), S.tOf(-S.b + S.archR + 0.55), 0.24, 0.5, side, M.grille, 0.003, 10, 6, (u, v, q0, q1) => lerp(q0 + (1 - u) * 0.05, q1, v));
    // door handle
    const th = S.tOf(S.zOf(lerp(S.cabin[1], S.cabin[2], 0.15)));
    patch(th, th + 0.022, 0.5, 0.515, side, D.lights === 'round' ? M.trim : M.chrome, 0.006, 3, 1);
  }
  // full-width rear light bar across the tail
  {
    const yT = S.belt(0.02) - 0.07;
    const hw = S.halfW(0.03) * 0.86;
    const pts = [];
    for (let k = 0; k <= 24; k++) { const u = k / 24 * 2 - 1; pts.push(new THREE.Vector3(u * hw, yT, S.zR + 0.03 + 0.1 * u * u)); }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.024, 8, false), M.tail);
    body.add(tube);
    for (const sx of [1, -1]) {
      const rv = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.03), M.rev);
      rv.position.set(sx * hw * 0.45, yT - 0.07, S.zR + 0.045);
      body.add(rv);
    }
  }

  // ---------------- front end: grille, lower intakes, splitter, plate
  {
    const zf = S.zF, yb = D.clear + 0.06;
    const fw = S.halfW(0.99);
    const addPlate = (z, y, flip) => {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.095), M.plate);
      pl.position.set(0, y, z);
      if (flip) pl.rotation.y = Math.PI;
      body.add(pl);
    };
    if (D.grille !== 'none') {
      const gw = D.grille === 'wide' ? fw * 1.15 : D.grille === 'muscle' ? fw * 1.5 : D.grille === 'race' ? fw * 1.4 : fw * 0.95;
      const gh = D.grille === 'muscle' ? 0.22 : D.grille === 'lower' ? 0.1 : 0.14;
      const shape = new THREE.Shape();
      const r = 0.04;
      shape.moveTo(-gw / 2 + r, 0); shape.lineTo(gw / 2 - r, 0); shape.quadraticCurveTo(gw / 2, 0, gw / 2, r);
      shape.lineTo(gw / 2 * 0.92, gh - r); shape.quadraticCurveTo(gw / 2 * 0.92, gh, gw / 2 * 0.92 - r, gh);
      shape.lineTo(-gw / 2 * 0.92 + r, gh); shape.quadraticCurveTo(-gw / 2 * 0.92, gh, -gw / 2 * 0.92, gh - r);
      shape.lineTo(-gw / 2, r); shape.quadraticCurveTo(-gw / 2, 0, -gw / 2 + r, 0);
      const gr = new THREE.Mesh(new THREE.ShapeGeometry(shape, 6), M.grille);
      const gy = D.grille === 'muscle' ? S.belt(0.995) - 0.3 : yb + (D.grille === 'lower' ? 0.02 : 0.06);
      gr.position.set(0, gy, zf + 0.012 - (D.grille === 'muscle' ? 0.02 : 0.05));
      gr.rotation.x = -0.15;
      body.add(gr);
      // honeycomb slats
      for (let k = 1; k < 4; k++) {
        const sl = new THREE.Mesh(new THREE.BoxGeometry(gw * 0.86, 0.008, 0.02), M.trim);
        sl.position.set(0, gy + (gh * k) / 4, zf + 0.006 - (D.grille === 'muscle' ? 0.02 : 0.05));
        body.add(sl);
      }
      addPlate(zf + 0.02 - (D.grille === 'muscle' ? 0.0 : 0.04), gy + (D.grille === 'muscle' ? -0.1 : gh * 0.5), false);
    }
    if (D.intakes) {
      for (const sx of [1, -1]) {
        const it = new THREE.Mesh(new THREE.BoxGeometry(fw * 0.42, 0.1, 0.05), M.grille);
        it.position.set(sx * fw * 0.62, yb + 0.05, zf - 0.11);
        it.rotation.y = sx * 0.35;
        body.add(it);
      }
    }
    // splitter
    const spW = S.halfW(0.95) * 1.85 * Math.min(D.splitter || 1, 1.15);
    const sp = new THREE.Mesh(new THREE.BoxGeometry(spW * 0.92, 0.02, 0.12 * (D.splitter || 1)), M.dark);
    sp.position.set(0, D.clear + 0.01, zf - 0.12 - 0.04 * (D.splitter || 1));
    body.add(sp);
    // rear: diffuser, exhausts, plate
    const dfW = S.halfW(0.03) * 1.45;
    const df = new THREE.Mesh(new THREE.BoxGeometry(dfW, 0.08, 0.4), M.carbon);
    df.position.set(0, D.clear + 0.025, S.zR + 0.16);
    body.add(df);
    for (let k = -3; k <= 3; k++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.13, 0.42), M.carbon);
      fin.position.set(k * dfW / 7.5, D.clear + 0.05, S.zR + 0.16);
      body.add(fin);
    }
    for (const sx of D.model === 'muscle' ? [1, -1] : [1, -1]) {
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.18, 22, 1, true), M.chrome);
      ex.rotation.x = Math.PI / 2;
      ex.position.set(sx * (D.lights === 'round' ? 0.12 : 0.36), D.clear + 0.13, S.zR + 0.02);
      body.add(ex);
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.044, 18), M.dark);
      inner.position.set(sx * (D.lights === 'round' ? 0.12 : 0.36), D.clear + 0.13, S.zR + 0.03);
      inner.rotation.y = Math.PI;
      body.add(inner);
    }
    addPlate(S.zR - 0.005, S.belt(0.01) - 0.2, true);
  }

  // ---------------- mirrors (teardrop caps on stalks at the base of the A-pillar)
  {
    const tm = lerp(S.cabin[2], S.cabin[3], 0.82);
    for (const side of [1, -1]) {
      const base = P(tm, 0.6, side);
      const m = new THREE.Group();
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.05), M.trim);
      stalk.position.x = side * 0.05;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 14), M.paint);
      cap.scale.set(1.45, 0.72, 0.85);
      cap.position.set(side * 0.15, 0.03, 0);
      const glassM = new THREE.Mesh(new THREE.CircleGeometry(0.06, 20), M.chrome);
      glassM.scale.set(1.4, 0.7, 1);
      glassM.position.set(side * 0.15, 0.03, -0.062);
      glassM.rotation.y = Math.PI;
      m.add(stalk, cap, glassM);
      m.position.copy(base).add(new THREE.Vector3(0, 0.05, 0));
      body.add(m);
    }
  }

  // ---------------- aero
  {
    const wing = new THREE.Group();
    const W2 = S.W2;
    const blade = (span, chord, thick) => {
      const prof = new THREE.Shape();
      prof.moveTo(0, 0); prof.bezierCurveTo(chord * 0.2, thick, chord * 0.65, thick * 0.9, chord, 0); prof.bezierCurveTo(chord * 0.65, thick * 0.25, chord * 0.2, -thick * 0.15, 0, 0);
      const g = new THREE.ExtrudeGeometry(prof, { depth: span, bevelEnabled: false, curveSegments: 10 });
      g.translate(-chord / 2, 0, -span / 2);
      g.rotateY(Math.PI / 2);
      return new THREE.Mesh(g, M.carbon);
    };
    if (D.wing === 'big' || D.wing === 'swan') {
      const span = W2 * (D.wing === 'swan' ? 1.9 : 1.85);
      wing.add(blade(span, 0.4, 0.06));
      const flap = blade(span, 0.16, 0.03);
      flap.position.set(0, 0.07, -0.2);
      flap.rotation.x = -0.35;
      wing.add(flap);
      for (const sx of [1, -1]) {
        const ep = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.3, 0.55), M.carbon);
        ep.position.set(sx * span / 2, -0.05, -0.04);
        wing.add(ep);
        if (D.wing === 'swan') {
          const neck = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.016, 6, 18, Math.PI * 0.75), M.carbon);
          neck.rotation.y = Math.PI / 2;
          neck.position.set(sx * 0.3, -0.18, 0.04);
          wing.add(neck);
        } else {
          const py = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.36, 0.14), M.carbon);
          py.position.set(sx * 0.32, -0.22, 0.05);
          wing.add(py);
        }
      }
      wing.position.set(0, S.belt(0.06) + (D.wing === 'swan' ? 0.42 : 0.36), S.zR + 0.34);
    } else if (D.wing === 'gtwing') {
      wing.add(blade(W2 * 1.7, 0.26, 0.04));
      for (const sx of [1, -1]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.2, 0.08), M.carbon);
        st.position.set(sx * 0.48, -0.1, 0);
        wing.add(st);
        const ep = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.12, 0.3), M.carbon);
        ep.position.set(sx * W2 * 0.85, 0, 0);
        wing.add(ep);
      }
      wing.position.set(0, S.belt(0.04) + 0.22, S.zR + 0.2);
    } else if (D.wing === 'duck') {
      const duck = blade(W2 * 1.5, 0.28, 0.07);
      duck.material = M.paint;
      wing.add(duck);
      wing.position.set(0, S.top(0.05) + 0.03, S.zR + 0.3);
    } else if (D.wing === 'lip') {
      const lip = blade(W2 * 1.45, 0.14, 0.03);
      wing.add(lip);
      wing.position.set(0, S.top(0.03) + 0.01, S.zR + 0.13);
    } else {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(W2 * 1.4, 0.03, 0.3), M.accent);
      wing.add(sp);
      wing.position.set(0, S.top(S.cabin[0] + 0.01) - 0.01, S.zOf(S.cabin[0]) + 0.08);
      wing.rotation.x = 0.1;
    }
    if (D.wing !== 'roof') wing.rotation.x = -0.06 - (setup.rearWing ?? 0.5) * 0.16;
    body.add(wing);
    if (D.scoop === 'hood') {
      const sc = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.7), M.paint);
      sc.position.set(0, S.top(0.85) + 0.02, S.zOf(0.85));
      body.add(sc);
      const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.02), M.grille);
      mouth.position.set(0, S.top(0.85) + 0.025, S.zOf(0.85) + 0.355);
      body.add(mouth);
    }
    if (D.scoop === 'roof') {
      const sc = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.35), M.accent);
      sc.position.set(0, S.top(0.45) + 0.03, S.zOf(0.45));
      body.add(sc);
    }
    if (D.fin) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.36, 1.3), M.paint);
      fin.position.set(0, S.top(0.25) + 0.12, S.zOf(0.22));
      body.add(fin);
    }
    for (const sx of [1, -1]) {
      const sk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, B.wheelbase - S.archR * 2 - 0.12), M.carbon);
      sk.position.set(sx * S.halfW(S.tOf((S.a - S.b) / 2)) * 0.97, D.clear + 0.03, (S.a - S.b) / 2);
      body.add(sk);
      if (D.flaps) for (const az of S.axles) {
        const flap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24, 0.012), M.dark);
        flap.position.set(sx * (B.trackR / 2), 0.2, az - S.archR - 0.03);
        body.add(flap);
      }
    }
  }

  // ---------------- underfloor + arch liners
  {
    const fl = new THREE.Mesh(new THREE.BoxGeometry(S.W2 * 1.5, 0.05, S.L * 0.8), M.dark);
    fl.position.set(0, D.clear + 0.04, (S.zF + S.zR) / 2);
    body.add(fl);
    for (const az of S.axles) {
      const liner = new THREE.Mesh(new THREE.CylinderGeometry(S.archR - 0.004, S.archR - 0.004, S.W2 * 1.92, 32, 1, true, -Math.PI / 2, Math.PI), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.95, side: THREE.BackSide }));
      liner.rotation.z = Math.PI / 2;
      liner.position.set(0, S.wheelR, az);
      body.add(liner);
    }
  }

  // ---------------- wheels
  const wheels = [];
  const tyreW = B.model === 'hatch' || B.model === 'jdm' ? 0.235 : ['gt3', 'hyper', 'proto'].includes(B.model) ? 0.32 : 0.285;
  const style = { gt: 'twin5', rs: 'mono5', gt3: 'race', hyper: 'blade', proto: 'race', muscle: 'mesh', jdm: 'mesh', hatch: 'six', rally: 'gravel' }[B.model] || 'twin5';
  const tpl = buildWheel2(S.wheelR, tyreW, setup.rim || '#c9ccd1', style);
  batchStatic(tpl);
  const caliper = new THREE.MeshStandardMaterial({ color: ['proto', 'hyper', 'gt3'].includes(B.model) ? 0xffc21a : 0xd4202a, roughness: 0.3, metalness: 0.3 });
  [[B.trackF / 2, S.a], [-B.trackF / 2, S.a], [B.trackR / 2, -S.b], [-B.trackR / 2, -S.b]].forEach(([x, z]) => {
    const steer = new THREE.Group();
    steer.position.set(x, S.wheelR, z);
    const spin = tpl.clone();
    if (x < 0) spin.scale.x = -1;
    steer.add(spin);
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.13), caliper);
    cal.position.set(Math.sign(x) * -0.04, 0.13, -0.13);
    cal.rotation.x = 0.5;
    steer.add(cal);
    root.add(steer);
    wheels.push({ steer, spin });
  });

  // ---------------- contact shadow
  const blobTex = new THREE.CanvasTexture((() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.8)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return c;
  })());
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(S.W2 * 2.5, S.L * 1.12), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(0, 0.03, (S.zF + S.zR) / 2);
  blob.renderOrder = 1;
  root.add(blob);

  root.traverse((o) => {
    if (!o.isMesh || o === blob) return;
    o.receiveShadow = true;
    const bs = o.geometry.boundingSphere || (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere);
    o.castShadow = bs.radius > 0.3;
  });
  batchStatic(body);
  root.userData = { body, wheels, tailMat: M.tail, revMat: M.rev, headMat: M.head, paintMat: M.paint, length: S.L, width: S.W2 * 2, zF: S.zF, zR: S.zR, wheelR: S.wheelR, sync: makeSync(body, wheels, M.tail, M.rev) };
  return root;
}

/** Detailed wheel: bulged tyre with sidewall shoulder, dished rim, spokes, vented disc. */
export function buildWheel2(R, width, rimColor, style) {
  const g = new THREE.Group();
  const rimR = R * (style === 'gravel' ? 0.62 : 0.72);
  const hw = width / 2;
  // tyre section: bead → bulging sidewall → rounded shoulder → tread
  const pts = [];
  const bulge = 0.012;
  pts.push(new THREE.Vector2(rimR - 0.005, -hw * 0.86));
  for (let k = 0; k <= 8; k++) { const f = k / 8; pts.push(new THREE.Vector2(lerp(rimR + 0.01, R - 0.03, f), -hw - bulge * Math.sin(f * Math.PI))); }
  for (let k = 0; k <= 6; k++) { const a = (k / 6) * Math.PI / 2; pts.push(new THREE.Vector2(R - 0.03 + Math.sin(a) * 0.03, -hw + 0.03 - Math.cos(a) * 0.03)); }
  for (let k = 0; k <= 6; k++) { const a = (k / 6) * Math.PI / 2; pts.push(new THREE.Vector2(R - 0.03 + Math.cos(a) * 0.03, hw - 0.03 + Math.sin(a) * 0.03)); }
  for (let k = 8; k >= 0; k--) { const f = k / 8; pts.push(new THREE.Vector2(lerp(rimR + 0.01, R - 0.03, f), hw + bulge * Math.sin(f * Math.PI))); }
  pts.push(new THREE.Vector2(rimR - 0.005, hw * 0.86));
  const tg = new THREE.LatheGeometry(pts, 64);
  tg.rotateZ(Math.PI / 2);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.92, metalness: 0 });
  g.add(new THREE.Mesh(tg, tyre));
  const rim = new THREE.MeshPhysicalMaterial({ color: rimColor, metalness: 0.95, roughness: 0.22, clearcoat: 0.7, clearcoatRoughness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f22, metalness: 0.7, roughness: 0.5 });
  // barrel + outer lip + dished face
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, width * 0.88, 48, 1, true), dark);
  barrel.rotation.z = Math.PI / 2;
  g.add(barrel);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR - 0.006, 0.013, 10, 56), rim);
  lip.rotation.y = Math.PI / 2;
  lip.position.x = hw * 0.9;
  g.add(lip);
  const face = new THREE.Mesh(new THREE.RingGeometry(rimR * 0.22, rimR * 0.98, 48), dark);
  face.rotation.y = Math.PI / 2;
  face.position.x = hw * 0.25;
  g.add(face);
  const spokeX = hw * 0.72, depth = hw * 0.5;
  const addSpoke = (ang, w, thick, len = rimR * 0.94, inset = 0) => {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(thick, len * 0.82, w), rim);
    sp.geometry.translate(0, len * 0.5, 0);
    sp.rotation.x = ang;
    // spokes dish inward toward the hub
    sp.rotation.z = 0.12;
    sp.position.x = spokeX - inset;
    g.add(sp);
  };
  const n = style === 'six' ? 6 : style === 'mesh' ? 10 : style === 'race' ? 10 : style === 'blade' ? 7 : style === 'gravel' ? 6 : 5;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    if (style === 'twin5') { addSpoke(a - 0.1, 0.034, 0.05); addSpoke(a + 0.1, 0.034, 0.05); }
    else if (style === 'mesh') { addSpoke(a, 0.026, 0.04); addSpoke(a + 0.31, 0.02, 0.035, rimR * 0.6); }
    else if (style === 'race') addSpoke(a, 0.038, 0.06);
    else if (style === 'blade') { const sp = addSpoke(a, 0.07, 0.03); void sp; }
    else addSpoke(a, 0.05, 0.055);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.22, rimR * 0.26, 0.06, 28), rim);
  hub.rotation.z = Math.PI / 2;
  hub.position.x = spokeX - 0.005;
  g.add(hub);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.1, rimR * 0.1, 0.07, style === 'race' || style === 'gravel' ? 6 : 24), style === 'race' ? new THREE.MeshStandardMaterial({ color: 0xd4202a, metalness: 0.5, roughness: 0.3 }) : dark);
  cap.rotation.z = Math.PI / 2;
  cap.position.x = spokeX + 0.01;
  g.add(cap);
  // vented disc
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.86, rimR * 0.86, 0.034, 48), new THREE.MeshStandardMaterial({ color: 0x55585e, metalness: 0.9, roughness: 0.35 }));
  disc.rotation.z = Math.PI / 2;
  disc.position.x = -depth * 0.3;
  g.add(disc);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.4, rimR * 0.4, 0.05, 24), dark);
  hat.rotation.z = Math.PI / 2;
  hat.position.x = -depth * 0.3 + 0.02;
  g.add(hat);
  return g;
}

export { smoothstep };
