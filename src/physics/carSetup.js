// Car bodies, tire compounds and the tuning model that turns garage choices
// into physical parameters. Pure data — used by the sim, the garage and the AI.

export const BODIES = {
  gt: {
    id: 'gt', name: 'Vantor GT', blurb: 'Front-engined coupe. Balanced, forgiving, quick.',
    mass: 1290, wheelbase: 2.62, weightFront: 0.5, cgHeight: 0.47, trackF: 1.62, trackR: 1.6, wheelR: 0.335,
    powerKW: 360, redline: 7800, drivetrain: 'RWD', brakeBias: 0.68, cdA: 0.68, clA: 0.9, aeroBalance: 0.44,
    length: 4.5, width: 1.95, height: 1.24,
  },
  hatch: {
    id: 'hatch', name: 'Pico RS', blurb: 'Light hot hatch. Nimble, front-driven, playful lift-off.',
    mass: 1080, wheelbase: 2.5, weightFront: 0.61, cgHeight: 0.52, trackF: 1.56, trackR: 1.54, wheelR: 0.315,
    powerKW: 205, redline: 7400, drivetrain: 'FWD', brakeBias: 0.7, cdA: 0.66, clA: 0.35, aeroBalance: 0.5,
    length: 4.05, width: 1.82, height: 1.38,
  },
  proto: {
    id: 'proto', name: 'Aerion P1', blurb: 'Mid-engined prototype. Enormous downforce, demands respect.',
    mass: 980, wheelbase: 2.75, weightFront: 0.42, cgHeight: 0.38, trackF: 1.68, trackR: 1.64, wheelR: 0.34,
    powerKW: 450, redline: 9000, drivetrain: 'RWD', brakeBias: 0.62, cdA: 0.82, clA: 3.1, aeroBalance: 0.42,
    length: 4.7, width: 2.0, height: 1.08,
  },
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
  const finalBase = s.body === 'proto' ? 3.55 : s.body === 'hatch' ? 4.1 : 3.62;
  return {
    setup: s,
    body: B,
    mass,
    inertia: mass * B.wheelbase * B.wheelbase * B.weightFront * (1 - B.weightFront) * 1.12, // yaw inertia ≈ m·a·b
    wheelbase: B.wheelbase,
    a: B.wheelbase * (1 - B.weightFront),
    b: B.wheelbase * B.weightFront,
    cgHeight: B.cgHeight,
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
    gears: [2.9, 2.1, 1.64, 1.33, 1.11, 0.94],
    reverse: 3.2,
    finalDrive: finalBase * s.finalDrive,
    shiftTime: 0.11,
    aero: { cdA, clA, balance: B.aeroBalance + s.aeroBalance },
    tire: { ...C },
    brake: { maxTorque: mass * 9.81 * 1.55 * B.wheelR, bias: B.brakeBias + s.brakeBias, handbrake: 2600 },
    diffLock: s.diffLock,
    rollFront: s.rollFront,
    maxSteer: 0.52 * s.steerLock,
    steerRate: 3.2,
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
