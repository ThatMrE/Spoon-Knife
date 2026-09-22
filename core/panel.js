/**
 * Console generation and the rules for "has this control reached the state the
 * instruction asked for?". The server owns every control's value; clients just
 * report interactions.
 */
import { CONTROL } from '../shared/protocol.js';
import { LEVER_STATES, makeLabel, pick, pickDialSet, pickToggleSet } from './jargon.js';

const KINDS = [CONTROL.TOGGLE, CONTROL.SLIDER, CONTROL.DIAL, CONTROL.LEVER, CONTROL.BUTTON];

/**
 * The mix that feels best on a phone. Toggles carry the game because their
 * instructions read as verbs ("Engage the...") rather than coordinates.
 * Buttons are rarest: a lone button is the least informative thing to shout at.
 */
const KIND_WEIGHTS = {
  [CONTROL.TOGGLE]: 4,
  [CONTROL.SLIDER]: 3,
  [CONTROL.DIAL]: 3,
  [CONTROL.LEVER]: 2,
  [CONTROL.BUTTON]: 1,
};

const WEIGHTED_KINDS = KINDS.flatMap((kind) => Array(KIND_WEIGHTS[kind]).fill(kind));

let nextControlId = 1;

/** Build one control. `taken` is the set of labels already used across the ship. */
export function makeControl(taken, random = Math.random, kind = pick(WEIGHTED_KINDS, random)) {
  const control = {
    id: `ctl${nextControlId++}`,
    kind,
    label: makeLabel(taken, random),
  };

  switch (kind) {
    case CONTROL.TOGGLE:
      control.states = pickToggleSet(random);
      control.value = control.states[0];
      break;
    case CONTROL.SLIDER:
      control.max = pick([4, 6, 8, 9], random);
      control.value = Math.floor(random() * (control.max + 1));
      break;
    case CONTROL.DIAL:
      control.states = pickDialSet(random);
      control.value = pick(control.states, random);
      break;
    case CONTROL.LEVER:
      control.states = LEVER_STATES;
      control.value = pick(LEVER_STATES, random);
      break;
    case CONTROL.BUTTON:
      // Buttons are momentary; `value` is a monotonic press counter.
      control.value = 0;
      break;
  }
  return control;
}

/** A player's console for one wave. */
export function makePanel(size, taken, random = Math.random) {
  return Array.from({ length: size }, () => makeControl(taken, random));
}

/** How many gizmos each player gets, given crew size. Small crews need more to do. */
export function panelSize(playerCount, wave) {
  const base = playerCount <= 2 ? 6 : playerCount <= 4 ? 5 : 4;
  return Math.min(8, base + Math.floor((wave - 1) / 3));
}

/**
 * Choose a state for `control` that it is not already in, and that a player can
 * actually reach. Returns the requirement stored on the instruction.
 */
export function makeRequirement(control, random = Math.random) {
  switch (control.kind) {
    case CONTROL.TOGGLE:
    case CONTROL.DIAL:
    case CONTROL.LEVER: {
      const options = control.states.filter((state) => state !== control.value);
      return { value: pick(options, random) };
    }
    case CONTROL.SLIDER: {
      const options = [];
      for (let n = 0; n <= control.max; n++) if (n !== control.value) options.push(n);
      return { value: pick(options, random) };
    }
    case CONTROL.BUTTON: {
      // 1-3 presses, counted from wherever the counter is right now.
      const presses = pick([1, 1, 1, 2, 3], random);
      return { value: presses, from: control.value };
    }
    default:
      return { value: null };
  }
}

/** Has `control` satisfied `requirement`? */
export function isSatisfied(control, requirement) {
  if (control.kind === CONTROL.BUTTON) {
    return control.value - requirement.from >= requirement.value;
  }
  return control.value === requirement.value;
}

/**
 * Apply a client's reported interaction, rejecting anything that isn't a legal
 * state for that control. Returns true if the value changed.
 */
export function applyInput(control, rawValue) {
  switch (control.kind) {
    case CONTROL.TOGGLE:
    case CONTROL.DIAL:
    case CONTROL.LEVER: {
      if (!control.states.includes(rawValue)) return false;
      if (control.value === rawValue) return false;
      control.value = rawValue;
      return true;
    }
    case CONTROL.SLIDER: {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 0 || n > control.max) return false;
      if (control.value === n) return false;
      control.value = n;
      return true;
    }
    case CONTROL.BUTTON:
      control.value += 1;
      return true;
    default:
      return false;
  }
}

/** The view of a control a client needs in order to render it. */
export function publicControl(control) {
  const view = { id: control.id, kind: control.kind, label: control.label, value: control.value };
  if (control.states) view.states = control.states;
  if (control.max !== undefined) view.max = control.max;
  return view;
}

/** Test seam: keep control ids deterministic in tests. */
export function resetControlIds() {
  nextControlId = 1;
}
