// Open-wheel single-seater (grand-prix style): lofted monocoque with
// sidepods, multi-element wings, halo, exposed wheels and suspension.
import * as THREE from 'three';
import { lofted, buildWheel, makeSync } from './carModel.js';
import { liveryTexture } from '../world/textures.js';
import { lerp } from '../core/math.js';

function keys(arr, t) {
  if (t <= arr[0][0]) return arr[0][1];
  for (let i = 1; i < arr.length; i++) {
    if (t <= arr[i][0]) {
      const [t0, v0] = arr[i - 1], [t1, v1] = arr[i];
      const u = (t - t0) / (t1 - t0);
      const e = u * u * (3 - 2 * u);
      return v0 + (v1 - v0) * e;
    }
  }
  return arr[arr.length - 1][1];
}
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

export function createFormula(setup, B) {
  const a = B.wheelbase * (1 - B.weightFront), b = B.wheelbase * B.weightFront;
  const zF = a + 1.05, zR = -b - 0.62;
  const zOf = (t) => lerp(zR, zF, t);
  const R = B.wheelR;

  const paint = new THREE.MeshPhysicalMaterial({ map: liveryTexture({ ...setup, livery: setup.livery === 'none' ? 'stripes' : setup.livery }), metalness: 0.2, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.3 });
  const carbon = new THREE.MeshPhysicalMaterial({ color: 0x131518, roughness: 0.32, metalness: 0.35, clearcoat: 0.9, clearcoatRoughness: 0.12 });
  const accent = new THREE.MeshPhysicalMaterial({ color: setup.accent || '#111', roughness: 0.3, clearcoat: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.6, metalness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 0.6 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // monocoque + engine cover + nose
  const hw = [[0, 0.2], [0.12, 0.28], [0.3, 0.3], [0.45, 0.34], [0.56, 0.36], [0.66, 0.26], [0.8, 0.16], [0.93, 0.12], [1, 0.08]];
  const top = [[0, 0.5], [0.14, 0.7], [0.3, 0.98], [0.4, 0.86], [0.5, 0.7], [0.58, 0.66], [0.7, 0.58], [0.85, 0.46], [1, 0.3]];
  const bot = [[0, 0.1], [0.6, 0.08], [0.75, 0.16], [0.9, 0.2], [1, 0.2]];
  const mono = (t, th, out) => {
    const w = keys(hw, t), y0 = keys(bot, t), y1 = keys(top, t);
    const c = Math.cos(th), s = Math.sin(th);
    const yc = (y0 + y1) / 2, hh = (y1 - y0) / 2;
    const yy = yc + hh * spow(s, 2 / 2.6);
    const taper = 1 - 0.35 * Math.max(0, (yy - y0) / (y1 - y0) - 0.5);
    return out.set(w * spow(c, 2 / 2.6) * taper, yy, zOf(t));
  };
  body.add(lofted(mono, 90, 36, paint, { capScale: [0.7, 0.0], capOffset: [0.03, 0.05] }));

  // sidepods
  for (const sx of [1, -1]) {
    const pod = (t, th, out) => {
      // t spans the sidepod only
      const tt = lerp(0.26, 0.6, t);
      const w = 0.24 * (0.4 + 0.6 * Math.sin(Math.min(1, t * 1.6) * Math.PI / 2)) * (1 - 0.5 * (1 - t) ** 3);
      const y0 = 0.1, y1 = 0.22 + 0.36 * Math.sin(Math.min(1, t * 1.3) * Math.PI / 2) * (0.6 + 0.4 * t);
      const c = Math.cos(th), s = Math.sin(th);
      const yc = (y0 + y1) / 2, hh = (y1 - y0) / 2;
      return out.set(sx * 0.5 + w * spow(c, 2 / 3), yc + hh * spow(s, 2 / 3), zOf(tt));
    };
    body.add(lofted(pod, 36, 24, paint, { capScale: [0.6, 0], capOffset: [0.04, 0.06] }));
    // inlet
    const inlet = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.04), dark);
    inlet.position.set(sx * 0.52, 0.4, zOf(0.6) + 0.01);
    body.add(inlet);
  }

  // floor + plank + diffuser
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.03, b + a * 0.55), carbon);
  floor.position.set(0, 0.06, (-b + a * 0.55) / 2);
  body.add(floor);
  const diff = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.2, 0.5), carbon);
  diff.position.set(0, 0.16, zR + 0.35);
  diff.rotation.x = -0.35;
  body.add(diff);

  // front wing (main plane + two flaps + endplates)
  const fw = new THREE.Group();
  const plane = (w, d) => new THREE.Mesh(new THREE.BoxGeometry(w, 0.018, d), carbon);
  const main = plane(1.95, 0.42); main.position.set(0, 0, 0); fw.add(main);
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.016, 0.22), accent); f1.position.set(0.58, 0.07, -0.16); f1.rotation.x = -0.35; fw.add(f1);
  const f2 = f1.clone(); f2.position.x = -0.58; fw.add(f2);
  for (const sx of [1, -1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.22, 0.52), carbon);
    ep.position.set(sx * 0.98, 0.08, -0.04);
    fw.add(ep);
  }
  fw.position.set(0, 0.12, zF - 0.2);
  body.add(fw);
  for (const sx of [1, -1]) {
    const pyl = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.18), carbon);
    pyl.position.set(sx * 0.1, 0.2, zF - 0.25);
    body.add(pyl);
  }

  // rear wing + beam wing + rain light
  const rw = new THREE.Group();
  const rmain = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.025, 0.38), carbon); rw.add(rmain);
  const rflap = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.02, 0.18), accent); rflap.position.set(0, 0.11, -0.14); rflap.rotation.x = -0.6; rw.add(rflap);
  for (const sx of [1, -1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.55, 0.62), carbon);
    ep.position.set(sx * 0.505, -0.12, -0.02);
    rw.add(ep);
  }
  rw.rotation.x = -0.06 - (setup.downforce ?? 0.5) * 0.15;
  rw.position.set(0, 0.95, zR + 0.2);
  body.add(rw);
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.2), carbon);
  pylon.position.set(0, 0.68, zR + 0.32);
  body.add(pylon);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 0.22), carbon);
  beam.position.set(0, 0.42, zR + 0.12);
  body.add(beam);
  const rain = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.04), tailMat);
  rain.position.set(0, 0.3, zR - 0.02);
  body.add(rain);

  // halo + driver
  const haloCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.27, 0.68, zOf(0.5)), new THREE.Vector3(-0.25, 0.86, zOf(0.55)), new THREE.Vector3(-0.08, 0.92, zOf(0.6)),
    new THREE.Vector3(0.08, 0.92, zOf(0.6)), new THREE.Vector3(0.25, 0.86, zOf(0.55)), new THREE.Vector3(0.27, 0.68, zOf(0.5)),
  ]);
  body.add(new THREE.Mesh(new THREE.TubeGeometry(haloCurve, 40, 0.028, 10), carbon));
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.3, 10), carbon);
  strut.position.set(0, 0.76, zOf(0.63));
  strut.rotation.x = 0.7;
  body.add(strut);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), new THREE.MeshPhysicalMaterial({ color: setup.accent === '#16181d' ? '#f2f2f2' : setup.accent, clearcoat: 1, roughness: 0.2 }));
  helmet.position.set(0, 0.72, zOf(0.52));
  body.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.132, 24, 8, -0.9, 1.8, 1.25, 0.45), new THREE.MeshPhysicalMaterial({ color: 0x080808, metalness: 0.6, roughness: 0.05, clearcoat: 1 }));
  visor.position.copy(helmet.position);
  body.add(visor);
  // mirrors
  for (const sx of [1, -1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.03), paint);
    m.position.set(sx * 0.42, 0.7, zOf(0.62));
    body.add(m);
  }

  // wheels + suspension
  const wheels = [];
  const front = buildWheel(R, 0.3, setup.rim || '#2a2c30', 'proto');
  const rear = buildWheel(R + 0.01, 0.4, setup.rim || '#2a2c30', 'proto');
  const pos = [[B.trackF / 2, a], [-B.trackF / 2, a], [B.trackR / 2, -b], [-B.trackR / 2, -b]];
  pos.forEach(([x, z], i) => {
    const steer = new THREE.Group();
    steer.position.set(x, R, z);
    const spin = (i < 2 ? front : rear).clone();
    if (x < 0) spin.scale.x = -1;
    steer.add(spin);
    root.add(steer);
    wheels.push({ steer, spin });
    // wishbones (upper and lower)
    for (const yy of [-0.06, 0.1]) {
      const from = new THREE.Vector3(Math.sign(x) * 0.2, R + yy, z);
      const to = new THREE.Vector3(x - Math.sign(x) * 0.18, R + yy * 0.6, z);
      const len = from.distanceTo(to);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, len, 6), carbon);
      arm.position.copy(from).add(to).multiplyScalar(0.5);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      body.add(arm);
    }
  });

  // contact shadow
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.7)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.4, zF - zR + 0.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(0, 0.03, (zF + zR) / 2);
  root.add(blob);

  root.traverse((o) => { if (o.isMesh && o !== blob) { o.castShadow = true; o.receiveShadow = true; } });
  root.userData = { body, wheels, tailMat, paintMat: paint, length: zF - zR, width: 2, zF, zR, wheelR: R, sync: makeSync(body, wheels, tailMat, null) };
  return root;
}
