/**
 * The catalogue of games a room can play, and the one function that builds one.
 *
 * Every engine here speaks the same lifecycle — `start(roster)`, `tick(now)`,
 * `input(playerId, msg)`, `setConnected`, `removePlayer`, `isOver`, `result()` —
 * so core/rooms.js hosts any of them without knowing which. Adding a game means
 * adding a file and a line, and the client learns about it from the lobby rather
 * than from a hardcoded list.
 */
import { GAMES } from '../../shared/protocol.js';
import { Game } from '../game.js';
import { SealedRounds } from '../sealed.js';
import { bids } from './bids.js';
import { superlatives } from './superlatives.js';
import { Taboo, taboo } from './taboo.js';

const SPACETEAM = {
  key: GAMES.SPACETEAM,
  title: 'Spaceteam',
  blurb: 'Shout instructions for gizmos on somebody else’s console.',
  minPlayers: 1,
};

/** Sealed-round games are pure definitions; these two need no engine of their own. */
const SEALED = [bids, superlatives];

/**
 * What the lobby offers, in the order it should be offered.
 *
 * Don't Say It is deliberately absent: it is not something you play *instead*
 * of a game, it is the thing that runs underneath whichever one you picked. The
 * lobby offers it as a switch instead — see SIDE_GAME.
 */
export const CATALOGUE = [
  SPACETEAM,
  // Sealed Bids first of the party games: it is the fastest to explain, so it
  // is the one to hand strangers who have not played anything yet.
  ...SEALED.map(({ key, title, blurb, minPlayers }) => ({ key, title, blurb, minPlayers })),
];

/** The game that runs under the others, and what the lobby says about it. */
export const SIDE_GAME = {
  key: taboo.key,
  title: taboo.title,
  blurb: taboo.blurb,
  minPlayers: taboo.minPlayers,
};

/**
 * Build the game that runs underneath the rest of the evening.
 *
 * Open-ended on purpose: it outlives any number of rounds played on top of it,
 * and only the host switching it off ends it.
 */
export function createSideGame({ transport, random }) {
  return new Taboo({ transport, random, durationMs: null, side: true });
}

export const DEFAULT_GAME = GAMES.SPACETEAM;

export function catalogueEntry(key) {
  return CATALOGUE.find((entry) => entry.key === key) ?? null;
}

export function isGame(key) {
  return catalogueEntry(key) !== null;
}

/**
 * @param {string} key one of GAMES
 * @param {{transport: object, random?: () => number}} options
 */
export function createEngine(key, { transport, random }) {
  const definition = SEALED.find((game) => game.key === key);
  if (definition) return new SealedRounds({ definition, transport, random });
  return new Game({ transport, random });
}
