/** Shared test scaffolding: a deterministic RNG and a recording transport. */
import { CONTROL } from '../shared/protocol.js';

/** mulberry32 — small, seeded, good enough to make a test run repeatable. */
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function recorder() {
  const sent = [];
  return {
    sent,
    transport: {
      toPlayer: (playerId, message) => sent.push({ to: playerId, ...message }),
      toAll: (message) => sent.push({ to: '*', ...message }),
    },
    /** Every message of type `t`, optionally addressed to `to`. */
    of(t, to) {
      return sent.filter((m) => m.t === t && (to === undefined || m.to === to));
    },
    last(t, to) {
      const matches = this.of(t, to);
      return matches[matches.length - 1];
    },
    clear() {
      sent.length = 0;
    },
  };
}

/**
 * Drive the control that `playerId`'s current instruction points at, into the
 * state the instruction demands — i.e. play the game correctly.
 */
export function obey(game, playerId, now) {
  const instruction = game.players.get(playerId).instruction;
  if (!instruction) throw new Error(`${playerId} has no instruction`);
  const { control, ownerId } = game.controls.get(instruction.controlId);
  const { requirement } = instruction;

  if (control.kind === CONTROL.BUTTON) {
    for (let i = 0; i < requirement.value; i++) {
      game.handleControl(ownerId, control.id, 1, now);
    }
  } else {
    game.handleControl(ownerId, control.id, requirement.value, now);
  }
  return instruction;
}
