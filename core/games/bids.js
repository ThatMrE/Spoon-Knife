/**
 * Sealed Bids — greed, with a sealed envelope.
 *
 * A prize is on the table. Everyone secretly bids chips for it. The highest bid
 * takes the prize — and *everyone pays what they bid*, winners and losers alike.
 * A tie means nobody wins it and everybody still pays.
 *
 * That last rule is the game. It makes every bid an accusation of what you
 * think the others will do, and it makes the reveal the funniest two seconds of
 * the round. There is no skill ceiling to learn and no instructions to read:
 * one sentence on screen is the whole ruleset.
 *
 * Chips are a budget for the *whole* game, not the round, so spending early is
 * a real decision and running dry is a real way to lose.
 */
import { GAMES, INPUT } from '../../shared/protocol.js';

const START_CHIPS = 20;
/** Prizes vary so the arms race cannot settle into a habit. */
const PRIZE_RANGE = [2, 6];

function prizeFor(random) {
  const [low, high] = PRIZE_RANGE;
  return low + Math.floor(random() * (high - low + 1));
}

export const bids = {
  key: GAMES.BIDS,
  title: 'Sealed Bids',
  blurb: 'Bid chips in secret. Highest bid wins — everyone pays what they bid.',
  minPlayers: 2,
  rounds: 6,
  collectMs: 20_000,
  revealMs: 7000,

  setup({ players }) {
    const chips = new Map();
    for (const id of players.keys()) chips.set(id, START_CHIPS);
    return { chips };
  },

  deal({ round, rounds, state, random }) {
    const prize = prizeFor(random);
    return {
      prize,
      prompt: `${prize} POINTS`,
      note: `Round ${round} of ${rounds} · highest bid takes it, everybody pays their bid`,
      input: (player) => ({
        kind: INPUT.NUMBER,
        min: 0,
        max: state.chips.get(player.id) ?? 0,
        label: 'chips',
      }),
      you: (player) => ({ chips: state.chips.get(player.id) ?? 0, prize }),
    };
  },

  clean(value, { player, state }) {
    const chips = state.chips.get(player.id) ?? 0;
    const bid = Math.floor(Number(value));
    if (!Number.isFinite(bid) || bid < 0 || bid > chips) return undefined;
    return bid;
  },

  resolve({ submissions, players, state, deal }) {
    const deltas = new Map();
    const bidOf = new Map();
    // No answer is a pass, not a forfeit: a phone that died mid-round should
    // cost you the prize, never chips you did not offer.
    for (const id of players.keys()) bidOf.set(id, submissions.get(id) ?? 0);

    const top = Math.max(0, ...bidOf.values());
    const winners = [...bidOf].filter(([, bid]) => bid === top && bid > 0).map(([id]) => id);

    for (const [id, bid] of bidOf) {
      state.chips.set(id, (state.chips.get(id) ?? 0) - bid);
    }
    if (winners.length === 1) deltas.set(winners[0], deal.prize);

    const entries = [...bidOf]
      .sort((a, b) => b[1] - a[1])
      .map(([id, bid]) => {
        const player = players.get(id);
        const passed = !submissions.has(id);
        const chipsLeft = state.chips.get(id) ?? 0;
        return {
          id,
          name: player?.name ?? '—',
          shown: passed ? '—' : String(bid),
          detail: chipsLeft === 1 ? '1 chip left' : `${chipsLeft} chips left`,
          delta: deltas.get(id) ?? 0,
          won: winners.length === 1 && winners[0] === id,
        };
      });

    const name = (id) => players.get(id)?.name ?? 'Somebody';
    let note;
    if (!winners.length) note = 'Everybody passed. The prize burns.';
    else if (winners.length === 1) note = `${name(winners[0])} took it for ${top}.`;
    else note = `Nobody won it — ${winners.map(name).join(' and ')} both bid ${top}.`;

    return { deltas, entries, note };
  },
};
