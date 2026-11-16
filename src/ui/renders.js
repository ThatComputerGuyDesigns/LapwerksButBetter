// Studio hero renders of the game's own cars (transparent PNGs) for menu
// tiles, the dealership and career cards. One small offscreen renderer,
// results cached per car/paint/angle.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createCar, disposeCar } from '../car/carModel.js';
import { BODIES, DEFAULT_SETUP } from '../physics/carSetup.js';

let R = null;
const cache = new Map();

function init() {
  if (R) return R;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(4, 8, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffc49a, 2.2);
  rim.position.set(-6, 3, -5);
  scene.add(rim);
  // shadow catcher: invisible floor that only shows the car's shadow
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.45 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const camera = new THREE.PerspectiveCamera(26, 16 / 9, 0.1, 100);
  R = { renderer, scene, camera, canvas };
  return R;
}

/**
 * Render a car. angle: radians around the car (0 = front 3/4 view).
 * Returns a PNG data URL with a transparent background.
 */
export function carShot(setup, { w = 640, h = 360, yaw = 0.75, pitch = 0.16, dist = 9.5, lookY = 0.5, key = '' } = {}) {
  const s = { ...DEFAULT_SETUP, ...setup };
  const id = `${s.body}|${s.paint}|${s.accent}|${s.livery}|${s.number}|${s.finish}|${w}x${h}|${yaw}|${pitch}|${dist}|${key}`;
  if (cache.has(id)) return cache.get(id);
  const { renderer, scene, camera } = init();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const car = createCar(s);
  car.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  // remove the baked contact blob (the shadow catcher does it properly)
  car.children.filter((c) => c.isMesh && c.material.transparent && c.material.map && !c.material.isMeshPhysicalMaterial).forEach((c) => car.remove(c));
  const front = car.userData.zF ?? 2;
  car.position.z = -(front + (car.userData.zR ?? -2)) / 2;
  scene.add(car);
  const len = BODIES[s.body]?.length || 4.5;
  const d = dist * (len / 4.5);
  camera.position.set(Math.sin(yaw) * d * Math.cos(pitch), Math.sin(pitch) * d + 0.6, Math.cos(yaw) * d * Math.cos(pitch));
  camera.lookAt(0, lookY, 0);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(car);
  disposeCar(car);
  cache.set(id, url);
  return url;
}
