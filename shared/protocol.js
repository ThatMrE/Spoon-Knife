/**
 * Wire protocol shared verbatim by the Node server and the browser client.
 *
 * Every frame is JSON: { t: <type>, ...payload }. The server is authoritative
 * about room state, panels, instructions and the hull; clients only ever report
 * "I touched this control" or "I did this motion".
 */

/** Client -> server. */
export const C2S = {
  CREATE: 'create',       // { name }
  JOIN: 'join',           // { code, name }
  RESUME: 'resume',       // { code, token } — rejoin a game after dropping
  READY: 'ready',         // { ready }
  START: 'start',         // host only
  CONTROL: 'control',     // { controlId, value }
  MOTION: 'motion',       // { kind }
  RESTART: 'restart',     // host only
  LEAVE: 'leave',
  PONG: 'pong',

  // Party games (see core/sealed.js and core/games/).
  PICK_GAME: 'pickGame',  // { game } — host only, in the lobby
  SUBMIT: 'submit',       // { round, value } — one sealed answer per round
  CLAIM: 'claim',         // { targetId } — "they said my word"
  CONFIRM: 'confirm',     // { claimId, ok } — the accused settles it
};

/** Server -> client. */
export const S2C = {
  WELCOME: 'welcome',         // { playerId, code, isHost, token, resumed }
  CREW: 'crew',               // { name, connected } — someone dropped or came back
  LOBBY: 'lobby',             // { code, hostId, players[], phase }
  ERROR: 'error',             // { message, fatal }
  PANEL: 'panel',             // { wave, controls[] }
  INSTRUCTION: 'instruction', // { id, text, deadline, duration }
  RESOLVED: 'resolved',       // { id, ok, reason }
  STATE: 'state',             // { phase, wave, hull, progress, goal, score }
  ALL_HANDS: 'allHands',      // { id, kind, text, deadline, duration }
  ALL_HANDS_PROGRESS: 'allHandsProgress', // { id, pending[] }
  ALL_HANDS_DONE: 'allHandsDone', // { id, ok, pending[] }
  WAVE: 'wave',               // { wave, hull }
  GAME_OVER: 'gameOver',      // { score, wave, completed, reason }
  PING: 'ping',

  // Party games. A round's prompt is public, but what a round hands *you* is
  // not, so ROUND is addressed per player.
  ROUND: 'round',             // { game, title, round, of, prompt, note, input, you, duration }
  SUBMITTED: 'submitted',     // { round, count, of } — progress, never values
  REVEAL: 'reveal',           // { round, of, entries[], note, standings[] }
  STANDINGS: 'standings',     // { standings[] }
  SECRET: 'secret',           // { word } — yours alone
  CLAIM_ASK: 'claimAsk',      // { claimId, byId, by, target, word, duration }
  CLAIM_DONE: 'claimDone',    // { claimId, ok, by, target, word, points, reason }
  PARTY_OVER: 'partyOver',    // { game, title, standings[], winners[] }
};

/**
 * The games a room can play. Titles and blurbs live with the games themselves
 * (core/games/index.js) and reach the client in the lobby, so adding a game
 * does not mean editing the client.
 */
export const GAMES = {
  SPACETEAM: 'spaceteam',
  BIDS: 'bids',
  SUPERLATIVES: 'superlatives',
  TABOO: 'taboo',
};

/** What a sealed round asks a phone to collect. */
export const INPUT = {
  NUMBER: 'number', // integer between min and max
  PLAYER: 'player', // somebody in the room, never yourself
  CLAIM: 'claim',   // "they said it" — not a sealed round, a running accusation
};

/** Room lifecycle. */
export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  WAVE_BREAK: 'waveBreak',
  OVER: 'over',
};

/** The kinds of gizmo that can appear on a player's console. */
export const CONTROL = {
  TOGGLE: 'toggle', // two labelled states
  SLIDER: 'slider', // integer 0..max
  DIAL: 'dial',     // one of N labelled positions
  LEVER: 'lever',   // DOWN / MID / UP
  BUTTON: 'button', // momentary, counts presses
};

/** Whole-crew emergencies. Each has a motion and an always-available tap fallback. */
export const ALL_HANDS = {
  SHAKE: 'shake',
  TILT_LEFT: 'tiltLeft',
  TILT_RIGHT: 'tiltRight',
  FLIP: 'flip',
  SHOUT: 'shout',
};

export const LIMITS = {
  MAX_PLAYERS: 8,
  MIN_PLAYERS: 1,
  NAME_MAX: 14,
  CODE_LENGTH: 4,
  /**
   * How long a dropped player keeps their seat and their console.
   *
   * Long enough to cover a phone that slept, a WiFi hiccup or a walk past the
   * microwave; short enough that a crew is not stuck waiting on somebody who
   * has gone home.
   */
  RESUME_GRACE_MS: 90_000,
};
