// Track environments. Choosing one restyles the whole venue: ground, trees,
// run-off surface, barriers, grandstands and the default road dimensions.
// Time of day (theme) is chosen separately.

export const ENVIRONMENTS = {
  gp: {
    name: 'Grand Prix', blurb: 'Grandstands, gravel traps, tyre walls and wide asphalt.',
    ground: [1, 1, 1], dirt: [0.36, 0.29, 0.2], mountains: 'alpine',
    trees: { density: 1, pine: 0.65, palm: 0 }, tufts: true,
    runoff: 'grass', trap: 'gravel', barrier: 'armco', tyres: 1, stands: 3, fences: true, floodlights: true,
    defaults: { width: 14, hills: 0.35, banking: 0.3 },
  },
  street: {
    name: 'Street circuit', blurb: 'Concrete walls tight to the road, catch fences and city blocks.',
    ground: [0.82, 0.86, 0.8], dirt: [0.45, 0.44, 0.42], mountains: 'city',
    trees: { density: 0.25, pine: 0.1, palm: 0 }, tufts: false,
    runoff: 'asphalt', trap: 'asphalt', barrier: 'concrete', tyres: 0.4, stands: 4, fences: true, floodlights: true, city: true,
    defaults: { width: 11, hills: 0.15, banking: 0 },
  },
  forest: {
    name: 'Forest ring', blurb: 'Narrow, flowing road through pine forest with Armco both sides.',
    ground: [0.86, 0.95, 0.82], dirt: [0.3, 0.24, 0.17], mountains: 'alpine',
    trees: { density: 1.8, pine: 0.9, palm: 0 }, tufts: true,
    runoff: 'grass', trap: 'grass', barrier: 'armco', tyres: 0.5, stands: 1, fences: false, floodlights: false,
    defaults: { width: 10, hills: 0.75, banking: 0.4 },
  },
  desert: {
    name: 'Desert oasis', blurb: 'Sand run-off, dunes and palms under a hard sun.',
    ground: [1, 1, 1], dirt: [0.62, 0.47, 0.3], mountains: 'desert', sand: [0.86, 0.7, 0.48],
    trees: { density: 0.22, pine: 0, palm: 1 }, tufts: false,
    runoff: 'sand', trap: 'sand', barrier: 'concrete', tyres: 0.8, stands: 2, fences: true, floodlights: true,
    defaults: { width: 15, hills: 0.25, banking: 0.2 },
  },
  rally: {
    name: 'Rally stage', blurb: 'Gravel road, crests and dirt verges. No walls, no mercy.',
    ground: [0.95, 0.98, 0.85], dirt: [0.4, 0.32, 0.22], mountains: 'alpine', road: 'gravel',
    trees: { density: 1.4, pine: 0.7, palm: 0 }, tufts: true,
    runoff: 'dirt', trap: 'dirt', barrier: 'none', tyres: 0, stands: 0, fences: false, floodlights: false,
    defaults: { width: 9, hills: 1, banking: 0.1 },
  },
  speedway: {
    name: 'Speedway', blurb: 'High-banked turns, SAFER walls and huge grandstands.',
    ground: [0.95, 1, 0.92], dirt: [0.4, 0.35, 0.28], mountains: 'low',
    trees: { density: 0.15, pine: 0.3, palm: 0 }, tufts: false,
    runoff: 'asphalt', trap: 'grass', barrier: 'concrete', tyres: 0, stands: 6, fences: true, floodlights: true,
    defaults: { width: 18, hills: 0, banking: 1 },
  },
  drift: {
    name: 'Drift circuit', blurb: 'Linked corners, cones, floodlights and walls close by.',
    ground: [0.9, 0.92, 0.88], dirt: [0.42, 0.4, 0.38], mountains: 'low',
    trees: { density: 0.35, pine: 0.4, palm: 0 }, tufts: false,
    runoff: 'asphalt', trap: 'asphalt', barrier: 'concrete', tyres: 1.4, stands: 2, fences: true, floodlights: true, cones: true,
    defaults: { width: 13, hills: 0.1, banking: 0 },
  },
  kart: {
    name: 'Kart track', blurb: 'Tight, twisty and lined with tyre walls.',
    ground: [1, 1.02, 0.95], dirt: [0.4, 0.33, 0.24], mountains: 'low',
    trees: { density: 0.5, pine: 0.3, palm: 0 }, tufts: true,
    runoff: 'grass', trap: 'grass', barrier: 'tyre', tyres: 2, stands: 1, fences: false, floodlights: true,
    defaults: { width: 9, hills: 0.05, banking: 0 },
  },
};

export const envOf = (id) => ENVIRONMENTS[id] || ENVIRONMENTS.gp;

// Placeable trackside objects (Studio "Place" tool)
export const OBJECTS = {
  stand: { name: 'Grandstand', icon: '▤', r: 14 },
  trees: { name: 'Tree cluster', icon: '♣', r: 16 },
  palms: { name: 'Palms', icon: '¥', r: 10 },
  lake: { name: 'Lake', icon: '≈', r: 40 },
  building: { name: 'Building', icon: '▣', r: 14 },
  tower: { name: 'Floodlight', icon: '☀', r: 4 },
  cones: { name: 'Cones', icon: '▲', r: 6 },
  tyres: { name: 'Tyre stack', icon: '◎', r: 5 },
  marquee: { name: 'Marquee', icon: '⌂', r: 9 },
  blimp: { name: 'Camera blimp', icon: '◖', r: 10 },
};
