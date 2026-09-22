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
  READY: 'ready',         // { ready }
  START: 'start',         // host only
  CONTROL: 'control',     // { controlId, value }
  MOTION: 'motion',       // { kind }
  RESTART: 'restart',     // host only
  LEAVE: 'leave',
  PONG: 'pong',
};

/** Server -> client. */
export const S2C = {
  WELCOME: 'welcome',         // { playerId, code, isHost }
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
};
