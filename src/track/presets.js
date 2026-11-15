// Built-in circuits. Points are control points in meters (x, z).
const S = (arr, k = 10) => arr.map(([x, z]) => [x * k, z * k]);

function polar(n, R, fn) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = R * fn(t);
    pts.push([Math.cos(t) * r, Math.sin(t) * r]);
  }
  return pts;
}

export const PRESETS = [
  {
    id: 'harbor',
    name: 'Harbor Sprint',
    blurb: 'Fast flowing club circuit with a long front straight.',
    width: 13, hills: 0.35, banking: 0.35, seed: 11, theme: 'golden',
    points: S([
      [0, 0], [22, 0], [44, 0], [58, 4], [64, 15], [58, 25], [46, 28], [38, 35], [39, 47],
      [33, 57], [19, 58], [9, 49], [-3, 43], [-17, 47], [-29, 42], [-32, 29], [-24, 18], [-14, 8],
    ]),
  },
  {
    id: 'ridgeback',
    name: 'Ridgeback Loop',
    blurb: 'Rolling hill-country sweepers. Big elevation, big commitment.',
    width: 12, hills: 0.9, banking: 0.5, seed: 4, theme: 'midday',
    points: polar(26, 330, (t) => 1 + 0.22 * Math.sin(3 * t + 0.4) + 0.1 * Math.cos(5 * t) - 0.06 * Math.sin(2 * t)),
  },
  {
    id: 'copperline',
    name: 'Copperline Speedway',
    blurb: 'Steeply banked tri-oval. Flat out — if you dare.',
    width: 16, hills: 0.05, banking: 1, seed: 2, theme: 'dusk',
    points: S([
      [-30, -14], [0, -18], [30, -14], [48, -4], [52, 12], [40, 26], [16, 30], [0, 26], [-16, 30], [-40, 26], [-52, 12], [-48, -4],
    ]),
  },
  {
    id: 'twinbridge',
    name: 'Twin Bridge',
    blurb: 'A figure-eight with a flyover. Draw your own crossings too.',
    width: 12, hills: 0.25, banking: 0.4, seed: 21, theme: 'golden',
    points: (() => {
      const pts = [];
      const n = 28;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        pts.push([Math.sin(t) * 380, Math.sin(t) * Math.cos(t) * 300]);
      }
      return pts;
    })(),
  },
  {
    id: 'pinewood',
    name: 'Pinewood Technical',
    blurb: 'Tight, twisty and rewarding. Brake late, rotate early.',
    width: 11, hills: 0.55, banking: 0.2, seed: 9, theme: 'midday',
    points: S([
      [0, 0], [20, 0], [36, 2], [42, 10], [36, 17], [26, 16], [20, 22], [24, 31], [34, 34], [40, 42],
      [32, 50], [18, 48], [10, 40], [0, 44], [-10, 52], [-22, 48], [-24, 36], [-16, 28], [-22, 18], [-18, 6],
    ]),
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}
