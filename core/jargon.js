/**
 * Spaceship nonsense. Control labels are built from these so that every panel
 * is unfamiliar and every instruction is awkward to shout across a room.
 */

const ADJECTIVES = [
  'Quantum', 'Cryo', 'Plasma', 'Photonic', 'Gravitic', 'Sub-Etheric', 'Tachyon',
  'Ionic', 'Thermal', 'Magnetic', 'Warp', 'Neutrino', 'Vector', 'Hydro',
  'Astro', 'Nano', 'Turbo', 'Micro', 'Omni', 'Poly', 'Retro', 'Dark-Matter',
  'Antimatter', 'Baryon', 'Chrono', 'Fusion', 'Holo', 'Inertial', 'Lunar',
  'Meson', 'Orbital', 'Pulsar', 'Quasar', 'Solar', 'Void', 'Xeno', 'Zero-Point',
];

const NOUNS = [
  'Flange', 'Coupling', 'Manifold', 'Injector', 'Capacitor', 'Inverter',
  'Regulator', 'Dampener', 'Thruster', 'Sprocket', 'Bearing', 'Valve',
  'Filter', 'Conduit', 'Emitter', 'Resonator', 'Gasket', 'Turbine',
  'Actuator', 'Diffuser', 'Compressor', 'Alternator', 'Grommet', 'Spindle',
  'Reticulator', 'Oscillator', 'Bypass', 'Clamp', 'Crankshaft', 'Gyro',
  'Lattice', 'Matrix', 'Nozzle', 'Piston', 'Rotor', 'Shunt', 'Sump', 'Winch',
];

/** A few labels are single evocative words, for rhythm. */
const SOLOS = [
  'Wormhole', 'Bilge', 'Tractor Beam', 'Deflector', 'Life Support',
  'Autopilot', 'Cargo Bay', 'Airlock', 'Hyperdrive', 'Escape Pods',
  'Gravity Well', 'Star Chart', 'Fuel Rods', 'Coolant', 'Shields',
];

const DIAL_SETS = [
  ['Alpha', 'Beta', 'Gamma', 'Delta'],
  ['Low', 'Mid', 'High', 'Max'],
  ['Red', 'Amber', 'Green', 'Blue'],
  ['I', 'II', 'III', 'IV'],
  ['North', 'East', 'South', 'West'],
  ['Idle', 'Cruise', 'Burn', 'Overdrive'],
];

const TOGGLE_SETS = [
  ['OFF', 'ON'],
  ['SAFE', 'ARMED'],
  ['MANUAL', 'AUTO'],
  ['CLOSED', 'OPEN'],
  ['COLD', 'HOT'],
];

/** Verb templates, keyed by the state being asked for. `{l}` is the label. */
const TOGGLE_PHRASES = {
  ON: ['Engage {l}!', 'Switch on {l}!', 'Activate {l}!', 'Fire up {l}!'],
  OFF: ['Disengage {l}!', 'Kill {l}!', 'Shut down {l}!', 'Power off {l}!'],
  ARMED: ['Arm {l}!', 'Prime {l}!'],
  SAFE: ['Safety the {l}!', 'Make {l} safe!'],
  AUTO: ['Set {l} to auto!', 'Automate {l}!'],
  MANUAL: ['Take {l} manual!', 'Override {l}!'],
  OPEN: ['Open {l}!', 'Pop {l} open!'],
  CLOSED: ['Close {l}!', 'Seal {l}!'],
  HOT: ['Heat up {l}!', 'Run {l} hot!'],
  COLD: ['Chill {l}!', 'Cool down {l}!'],
};

const SLIDER_PHRASES = ['Set {l} to {v}!', 'Slide {l} to {v}!', '{l} to {v}!', 'Crank {l} to {v}!'];
const DIAL_PHRASES = ['Turn {l} to {v}!', 'Dial {l} to {v}!', 'Rotate {l} to {v}!', '{l} to {v}!'];
const LEVER_PHRASES = {
  UP: ['Pull {l} up!', 'Raise {l}!', 'Lift {l}!'],
  MID: ['Centre {l}!', 'Level off {l}!', '{l} to the middle!'],
  DOWN: ['Push {l} down!', 'Lower {l}!', 'Drop {l}!'],
};
const BUTTON_PHRASES = ['Press {l}!', 'Punch {l}!', 'Hit {l}!', 'Smack {l}!'];
const BUTTON_MULTI_PHRASES = ['Press {l} {n} times!', 'Hit {l} {n} times!', '{n} taps on {l}!'];

export const LEVER_STATES = ['DOWN', 'MID', 'UP'];

export function pick(array, random = Math.random) {
  return array[Math.floor(random() * array.length)];
}

export function pickDialSet(random = Math.random) {
  return pick(DIAL_SETS, random);
}

export function pickToggleSet(random = Math.random) {
  return pick(TOGGLE_SETS, random);
}

/** A label like "Cryo Manifold". `taken` keeps every panel on the ship unique. */
export function makeLabel(taken, random = Math.random) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const label =
      random() < 0.15
        ? pick(SOLOS, random)
        : `${pick(ADJECTIVES, random)} ${pick(NOUNS, random)}`;
    if (!taken.has(label)) {
      taken.add(label);
      return label;
    }
  }
  // Absurdly unlikely, but never hand back a duplicate: duplicates make an
  // instruction ambiguous, which is unfair rather than funny.
  let n = 2;
  let label = `${pick(ADJECTIVES, random)} ${pick(NOUNS, random)}`;
  while (taken.has(`${label} ${n}`)) n++;
  taken.add(`${label} ${n}`);
  return `${label} ${n}`;
}

/** Render the shoutable text for "get `control` into `value`". */
export function phrase(control, value, random = Math.random) {
  const fill = (template, extra = {}) =>
    template.replace('{l}', control.label.toUpperCase()).replace('{v}', extra.v ?? value).replace('{n}', extra.n);

  switch (control.kind) {
    case 'toggle': {
      const options = TOGGLE_PHRASES[value] ?? [`Set {l} to ${value}!`];
      return fill(pick(options, random));
    }
    case 'slider':
      return fill(pick(SLIDER_PHRASES, random));
    case 'dial':
      return fill(pick(DIAL_PHRASES, random));
    case 'lever':
      return fill(pick(LEVER_PHRASES[value] ?? LEVER_PHRASES.MID, random));
    case 'button':
      return value > 1
        ? fill(pick(BUTTON_MULTI_PHRASES, random), { n: value })
        : fill(pick(BUTTON_PHRASES, random));
    default:
      return fill('Do something to {l}!');
  }
}

export const ALL_HANDS_COPY = {
  shake: { text: '☄️ ASTEROID FIELD — EVERYBODY SHAKE!', short: 'SHAKE!' },
  tiltLeft: { text: '↖️ HARD TO PORT — TILT LEFT!', short: 'TILT LEFT!' },
  tiltRight: { text: '↗️ HARD TO STARBOARD — TILT RIGHT!', short: 'TILT RIGHT!' },
  flip: { text: '🌀 WORMHOLE — FLIP YOUR PHONE OVER!', short: 'FLIP IT!' },
  shout: { text: '📣 HULL BREACH — EVERYONE HIT THE ALARM!', short: 'ALARM!' },
};
