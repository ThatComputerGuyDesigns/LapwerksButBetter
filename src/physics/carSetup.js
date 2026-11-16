// Car bodies, tire compounds and the tuning model that turns garage choices
// into physical parameters. Pure data — used by the sim, the garage and the AI.

// Real-world car archetypes with true-to-life figures (original names).
// model: visual builder / profile; cls: garage category; gears: count;
// compound: default tyres; grip: chassis grip multiplier (aero-optimised
// floors, wide tyres); roll: visual body-roll scale; cyl: engine sound.
const car = (o) => ({ grip: 1, roll: 1, gears: 6, first: 3.1, compound: 'sport', cyl: 6, steer: 0.52, ...o });
export const BODIES = {
  formula: car({
    id: 'formula', model: 'formula', cls: 'Open-wheel', name: 'Apex FR-1', blurb: 'Grand-prix style single-seater. 800 kg, 1000 hp, five g of downforce. Brutal.',
    mass: 800, wheelbase: 3.6, weightFront: 0.45, cgHeight: 0.28, trackF: 1.6, trackR: 1.55, wheelR: 0.36,
    powerKW: 745, redline: 12500, drivetrain: 'RWD', brakeBias: 0.57, cdA: 1.25, clA: 4.6, aeroBalance: 0.42,
    length: 5.6, width: 2.0, height: 0.95, gears: 8, first: 2.9, compound: 'slick', grip: 1.08, roll: 0.25, cyl: 6, steer: 0.4,
  }),
  proto: car({
    id: 'proto', model: 'proto', cls: 'Prototype', name: 'Aerion P1', blurb: 'Endurance prototype. Enormous downforce, demands respect.',
    mass: 980, wheelbase: 2.75, weightFront: 0.42, cgHeight: 0.38, trackF: 1.68, trackR: 1.64, wheelR: 0.34,
    powerKW: 500, redline: 9000, drivetrain: 'RWD', brakeBias: 0.6, cdA: 0.82, clA: 3.1, aeroBalance: 0.42,
    length: 4.7, width: 2.0, height: 1.08, compound: 'slick', roll: 0.45, cyl: 8,
  }),
  gt3: car({
    id: 'gt3', model: 'gt3', cls: 'GT race', name: 'Kestrel 9R Cup', blurb: 'Rear-engined GT3 racer. Swan-neck wing, slicks, traction for days.',
    mass: 1260, wheelbase: 2.46, weightFront: 0.4, cgHeight: 0.42, trackF: 1.62, trackR: 1.6, wheelR: 0.34,
    powerKW: 405, redline: 9000, drivetrain: 'RWD', brakeBias: 0.6, cdA: 0.85, clA: 2.2, aeroBalance: 0.4,
    length: 4.6, width: 2.0, height: 1.25, compound: 'slick', roll: 0.55, cyl: 6,
  }),
  hyper: car({
    id: 'hyper', model: 'hyper', cls: 'Hypercar', name: 'Valkyr H', blurb: 'Hybrid all-wheel-drive hypercar. 1200 hp, sub-3-second sprints.',
    mass: 1450, wheelbase: 2.7, weightFront: 0.43, cgHeight: 0.4, trackF: 1.7, trackR: 1.65, wheelR: 0.35,
    powerKW: 880, redline: 8500, drivetrain: 'AWD', brakeBias: 0.62, cdA: 0.98, clA: 1.6, aeroBalance: 0.42,
    length: 4.65, width: 2.05, height: 1.15, gears: 7, compound: 'sport', grip: 1.05, roll: 0.6, cyl: 8,
  }),
  rs: car({
    id: 'rs', model: 'rs', cls: 'Sports car', name: 'Kestrel 9RS', blurb: 'Rear-engined flat-six sports car. Light nose, huge traction, lift-off rotation.',
    mass: 1435, wheelbase: 2.46, weightFront: 0.39, cgHeight: 0.46, trackF: 1.59, trackR: 1.56, wheelR: 0.34,
    powerKW: 375, redline: 9000, drivetrain: 'RWD', brakeBias: 0.62, cdA: 0.66, clA: 0.7, aeroBalance: 0.42,
    length: 4.55, width: 1.9, height: 1.28, gears: 7, roll: 0.8, cyl: 6,
  }),
  gt: car({
    id: 'gt', model: 'gt', cls: 'Grand tourer', name: 'Vantor GT', blurb: 'Front-engined V8 coupe. Balanced, forgiving, quick.',
    mass: 1290, wheelbase: 2.62, weightFront: 0.5, cgHeight: 0.47, trackF: 1.62, trackR: 1.6, wheelR: 0.335,
    powerKW: 360, redline: 7800, drivetrain: 'RWD', brakeBias: 0.68, cdA: 0.68, clA: 0.9, aeroBalance: 0.44,
    length: 4.5, width: 1.95, height: 1.24, cyl: 8,
  }),
  muscle: car({
    id: 'muscle', model: 'muscle', cls: 'Muscle', name: 'Brawler 70', blurb: 'Big-block American muscle. 650 hp, heavy nose, lots of smoke.',
    mass: 1720, wheelbase: 2.72, weightFront: 0.55, cgHeight: 0.54, trackF: 1.6, trackR: 1.6, wheelR: 0.345,
    powerKW: 485, redline: 6600, drivetrain: 'RWD', brakeBias: 0.66, cdA: 1.1, clA: 0.15, aeroBalance: 0.5,
    length: 4.85, width: 1.92, height: 1.33, compound: 'street', roll: 1.3, cyl: 8, first: 2.7,
  }),
  jdm: car({
    id: 'jdm', model: 'jdm', cls: 'Tuner', name: 'Kaze 86R', blurb: 'Light rear-drive tuner coupe. Built to slide; perfect for learning car control.',
    mass: 1240, wheelbase: 2.57, weightFront: 0.53, cgHeight: 0.46, trackF: 1.52, trackR: 1.54, wheelR: 0.32,
    powerKW: 225, redline: 7800, drivetrain: 'RWD', brakeBias: 0.66, cdA: 0.88, clA: 0.3, aeroBalance: 0.48,
    length: 4.24, width: 1.78, height: 1.3, compound: 'sport', roll: 1.1, cyl: 4,
  }),
  rally: car({
    id: 'rally', model: 'rally', cls: 'Rally', name: 'Ridge R4', blurb: 'Turbo all-wheel-drive rally hatch. Grips anywhere, loves gravel.',
    mass: 1300, wheelbase: 2.55, weightFront: 0.57, cgHeight: 0.5, trackF: 1.6, trackR: 1.6, wheelR: 0.33,
    powerKW: 250, redline: 7200, drivetrain: 'AWD', brakeBias: 0.64, cdA: 0.95, clA: 0.5, aeroBalance: 0.48,
    length: 4.1, width: 1.88, height: 1.4, roll: 1.1, cyl: 4, offroad: 1.35,
  }),
  hatch: car({
    id: 'hatch', model: 'hatch', cls: 'Hot hatch', name: 'Pico RS', blurb: 'Light front-drive hot hatch. Nimble and playful on lift-off.',
    mass: 1080, wheelbase: 2.5, weightFront: 0.61, cgHeight: 0.52, trackF: 1.56, trackR: 1.54, wheelR: 0.315,
    powerKW: 205, redline: 7400, drivetrain: 'FWD', brakeBias: 0.7, cdA: 0.76, clA: 0.35, aeroBalance: 0.5,
    length: 4.05, width: 1.82, height: 1.38, roll: 1.1, cyl: 4,
  }),
};

export const COMPOUNDS = {
  street: { id: 'street', name: 'Street', mu: 1.02, kappaPeak: 0.12, alphaPeak: 0.16, slide: 0.86, optTemp: 70, window: 55, heat: 0.7 },
  sport: { id: 'sport', name: 'Sport', mu: 1.18, kappaPeak: 0.1, alphaPeak: 0.135, slide: 0.84, optTemp: 85, window: 42, heat: 1.0 },
  slick: { id: 'slick', name: 'Slick', mu: 1.4, kappaPeak: 0.085, alphaPeak: 0.11, slide: 0.8, optTemp: 95, window: 32, heat: 1.25 },
};

export const PAINTS = [
  { id: 'signal', name: 'Signal Orange', color: '#ff5a1f' },
  { id: 'racing', name: 'Heritage Green', color: '#0f5c3a' },
  { id: 'ice', name: 'Glacier White', color: '#e9edf2' },
  { id: 'night', name: 'Midnight Blue', color: '#14224a' },
  { id: 'crimson', name: 'Crimson', color: '#b3121c' },
  { id: 'volt', name: 'Volt Yellow', color: '#e8d21d' },
  { id: 'graphite', name: 'Graphite', color: '#2a2d33' },
  { id: 'teal', name: 'Lagoon Teal', color: '#0f8a8c' },
];

export const LIVERIES = ['none', 'stripes', 'band', 'split'];

export const DEFAULT_SETUP = {
  body: 'gt',
  paint: '#ff5a1f',
  accent: '#16181d',
  finish: 'gloss', // gloss | metallic | matte | pearl
  livery: 'stripes',
  number: 7,
  rim: '#c9ccd1',
  compound: 'sport',
  powerScale: 1.0, // 0.7 .. 1.3
  weightScale: 1.0, // 0.85 .. 1.1
  downforce: 0.5, // 0..1 wing angle
  aeroBalance: 0, // -0.1..0.1 shift
  brakeBias: 0, // offset from the body's base front share (-0.08..0.08)
  diffLock: 0.35, // 0 open .. 1 locked
  rollFront: 0.55, // front anti-roll share
  finalDrive: 1.0, // 0.85 .. 1.15 multiplier (short/long)
  steerLock: 1.0, // 0.8 .. 1.2
  drivetrain: null, // null = body default
};

/**
 * Gameplay grip level (set from the app settings). 'arcade' turns sharper and
 * stops harder than real cars; 'real' uses the true-to-life figures.
 */
export const GRIP_LEVELS = {
  // transfer: weight-transfer scale (arcade cars stay planted at huge g)
  arcade: { grip: 3.05, brake: 3.3, steer: 1.35, transfer: 0.3 },
  sport: { grip: 1.5, brake: 1.6, steer: 1.2, transfer: 0.7 },
  real: { grip: 1, brake: 1, steer: 1, transfer: 1 },
};
export const GAMEPLAY = { ...GRIP_LEVELS.arcade };
export function setGripLevel(k) { Object.assign(GAMEPLAY, GRIP_LEVELS[k] || GRIP_LEVELS.arcade); }

/** Build the physical parameter set consumed by the vehicle model. */
export function makeCarParams(setup = DEFAULT_SETUP) {
  const s = { ...DEFAULT_SETUP, ...setup };
  const B = BODIES[s.body] || BODIES.gt;
  const C = COMPOUNDS[s.compound] || COMPOUNDS.sport;
  const mass = B.mass * s.weightScale;
  const wingCl = 0.45 + s.downforce * 1.1; // multiplier on body downforce
  const clA = B.clA * wingCl;
  const cdA = B.cdA * (1 + (wingCl - 1) * 0.12);
  const redline = B.redline;
  // gearbox: geometric ratios; final drive chosen so top gear tops out at
  // the drag-limited top speed (so every car pulls to redline in top)
  const n = B.gears;
  const top = 0.82;
  const gears = Array.from({ length: n }, (_, k) => B.first * Math.pow(top / B.first, Math.pow(k / (n - 1), 0.9)));
  const P = B.powerKW * s.powerScale * 1000 * 0.86;
  const vTop = Math.cbrt(P / (0.5 * 1.225 * cdA)) * 1.02;
  const finalBase = ((redline * Math.PI) / 30) * B.wheelR / (vTop * top);
  return {
    setup: s,
    body: B,
    mass,
    inertia: mass * B.wheelbase * B.wheelbase * B.weightFront * (1 - B.weightFront) * 1.12, // yaw inertia ≈ m·a·b
    wheelbase: B.wheelbase,
    a: B.wheelbase * (1 - B.weightFront),
    b: B.wheelbase * B.weightFront,
    cgHeight: B.cgHeight * GAMEPLAY.transfer,
    heatScale: 1 / GAMEPLAY.grip,
    trackF: B.trackF,
    trackR: B.trackR,
    wheelR: B.wheelR,
    wheelInertia: 1.15,
    drivetrain: s.drivetrain || B.drivetrain,
    engine: {
      powerKW: B.powerKW * s.powerScale,
      redline,
      idle: 950,
      limiter: redline + 150,
      inertia: 0.22,
    },
    gears,
    reverse: 3.2,
    finalDrive: finalBase * s.finalDrive,
    shiftTime: 0.11,
    // arcade grip boosts the tyres; aero grip is scaled back so high-downforce
    // cars don't stack to absurd corner speeds
    aero: { cdA, clA: clA / Math.sqrt(GAMEPLAY.grip), balance: B.aeroBalance + s.aeroBalance },
    tire: { ...C, mu: C.mu * B.grip * GAMEPLAY.grip },
    brake: { maxTorque: mass * 9.81 * 1.55 * B.wheelR * GAMEPLAY.brake * Math.max(1, C.mu * B.grip * GAMEPLAY.grip / 1.2), bias: B.brakeBias + s.brakeBias, handbrake: 2600 },
    diffLock: s.diffLock,
    rollFront: s.rollFront,
    maxSteer: B.steer * s.steerLock * GAMEPLAY.steer,
    offroad: B.offroad || 1,
    steerRate: 6,
  };
}

/** Engine torque (Nm) at rpm for full throttle. */
export function engineTorque(engine, rpm) {
  const x = Math.min(rpm / engine.redline, 1.05);
  const shape = 0.52 + 1.4 * x - 1.02 * x * x; // peaks ~0.69 · redline
  const omegaRed = (engine.redline * Math.PI) / 30;
  const Tmax = (engine.powerKW * 1000) / (0.9 * omegaRed);
  return Math.max(0, shape) * Tmax;
}

export function engineBraking(engine, rpm) {
  const omegaRed = (engine.redline * Math.PI) / 30;
  const Tmax = (engine.powerKW * 1000) / (0.9 * omegaRed);
  return Tmax * (0.06 + 0.12 * (rpm / engine.redline));
}
