/**
 * The sealed-round engine, and the two games defined on top of it.
 *
 * Everything here steps a fake clock, so a 20-second deadline costs no seconds.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { C2S, INPUT, PHASE, S2C } from '../shared/protocol.js';
import { SealedRounds } from '../core/sealed.js';
import { bids } from '../core/games/bids.js';
import { superlatives } from '../core/games/superlatives.js';
import { recorder, seeded } from './helpers.js';

const ROSTER = [
  { id: 'p1', name: 'ADA' },
  { id: 'p2', name: 'BO' },
  { id: 'p3', name: 'CY' },
];

/** A definition with no randomness and arithmetic simple enough to assert on. */
function countingGame(overrides = {}) {
  return {
    key: 'counting',
    title: 'Counting',
    blurb: 'test game',
    minPlayers: 2,
    rounds: 2,
    collectMs: 10_000,
    revealMs: 5000,
    deal: ({ round }) => ({
      prompt: `round ${round}`,
      input: { kind: INPUT.NUMBER, min: 0, max: 9 },
    }),
    clean: (value) => {
      const n = Math.floor(Number(value));
      return Number.isFinite(n) && n >= 0 && n <= 9 ? n : undefined;
    },
    resolve: ({ submissions, players }) => ({
      deltas: new Map([...submissions].map(([id, value]) => [id, value])),
      entries: [...players.keys()].map((id) => ({ id, shown: String(submissions.get(id) ?? '—') })),
      note: 'counted',
    }),
    ...overrides,
  };
}

function started(definition, roster = ROSTER, now = 1000) {
  const rec = recorder();
  const game = new SealedRounds({ definition, transport: rec.transport, random: seeded(7) });
  game.start(roster, now);
  return { game, rec };
}

const submit = (game, id, value, now) =>
  game.input(id, { t: C2S.SUBMIT, round: game.round, value }, now);

// ───────────────────────────── the primitive ─────────────────────────────

test('a round is dealt privately to every player', () => {
  const { game, rec } = started(countingGame());

  assert.equal(game.round, 1);
  assert.equal(rec.of(S2C.ROUND).length, 3);
  for (const id of ['p1', 'p2', 'p3']) {
    const round = rec.last(S2C.ROUND, id);
    assert.equal(round.prompt, 'round 1');
    assert.equal(round.input.kind, INPUT.NUMBER);
    assert.equal(round.endsIn, 10_000);
  }
});

test('answers stay sealed until the reveal', () => {
  const { game, rec } = started(countingGame());
  submit(game, 'p1', 4, 1500);

  // Progress is public; the answer is not.
  const progress = rec.last(S2C.SUBMITTED);
  assert.equal(progress.count, 1);
  assert.equal(progress.of, 3);
  assert.equal(JSON.stringify(rec.of(S2C.SUBMITTED)).includes('"value"'), false);
  assert.equal(rec.of(S2C.REVEAL).length, 0);
});

test('the round resolves as soon as everybody has answered', () => {
  const { game, rec } = started(countingGame());
  submit(game, 'p1', 1, 1500);
  submit(game, 'p2', 2, 1600);
  assert.equal(rec.of(S2C.REVEAL).length, 0, 'still waiting on p3');

  submit(game, 'p3', 3, 1700);

  const reveal = rec.last(S2C.REVEAL);
  assert.ok(reveal, 'resolved without waiting out the deadline');
  assert.equal(reveal.note, 'counted');
  assert.deepEqual(
    reveal.standings.map((p) => [p.name, p.score]),
    [['CY', 3], ['BO', 2], ['ADA', 1]],
  );
});

test('the deadline resolves a round nobody finished', () => {
  const { game, rec } = started(countingGame());
  submit(game, 'p1', 5, 1500);

  game.tick(10_999);
  assert.equal(rec.of(S2C.REVEAL).length, 0, 'not yet');

  game.tick(11_000);
  const reveal = rec.last(S2C.REVEAL);
  assert.equal(reveal.entries.find((e) => e.id === 'p2').shown, '—');
  assert.equal(game.players.get('p1').score, 5);
  assert.equal(game.players.get('p2').score, 0);
});

test('an answer stamped with the previous round is ignored', () => {
  const { game } = started(countingGame());
  for (const id of ['p1', 'p2', 'p3']) submit(game, id, 1, 1500);
  game.tick(6600); // through the reveal and into round 2

  assert.equal(game.round, 2);
  // A tap that lost a race with the deadline must not score in the new round.
  game.input('p1', { t: C2S.SUBMIT, round: 1, value: 9 }, 6700);
  assert.equal(game.submissions.size, 0);
});

test('the game ends after its last round', () => {
  const { game, rec } = started(countingGame({ rounds: 2 }));

  for (let round = 1; round <= 2; round++) {
    for (const id of ['p1', 'p2', 'p3']) submit(game, id, 1, 2000 * round);
    game.tick(2000 * round + 5000);
  }

  assert.equal(game.isOver, true);
  assert.equal(game.phase, PHASE.OVER);
  const over = rec.last(S2C.PARTY_OVER);
  assert.equal(over.title, 'Counting');
  assert.deepEqual(over.winners, ['ADA', 'BO', 'CY']);
});

test('a dropped phone never holds up the round', () => {
  const { game, rec } = started(countingGame());
  submit(game, 'p1', 1, 1500);
  submit(game, 'p2', 2, 1600);

  game.setConnected('p3', false, 1700);

  assert.ok(rec.last(S2C.REVEAL), 'resolved once the only missing answer left');
});

test('a phone that comes back is handed the round in progress', () => {
  const { game, rec } = started(countingGame());
  game.setConnected('p2', false, 1500);
  rec.clear();

  game.setConnected('p2', true, 6000);

  const round = rec.last(S2C.ROUND, 'p2');
  assert.equal(round.round, 1);
  // What is left, not what the round started with.
  assert.equal(round.endsIn, 5000);
});

test('losing too many players ends the game rather than stalling it', () => {
  const { game, rec } = started(countingGame({ minPlayers: 3 }));

  game.removePlayer('p3', 1500);

  assert.equal(game.isOver, true);
  assert.match(rec.last(S2C.PARTY_OVER).reason, /needs 3 players/);
});

// ───────────────────────────── Sealed Bids ─────────────────────────────

test('the highest bid wins the prize and everybody pays their bid', () => {
  const { game, rec } = started(bids, ROSTER);
  const prize = game.deal.prize;

  submit(game, 'p1', 5, 1500);
  submit(game, 'p2', 3, 1500);
  submit(game, 'p3', 0, 1500);

  const reveal = rec.last(S2C.REVEAL);
  assert.equal(game.players.get('p1').score, prize);
  assert.equal(game.players.get('p2').score, 0);
  // Losing a sealed auction still costs you the chips you offered.
  assert.equal(game.state.chips.get('p1'), 15);
  assert.equal(game.state.chips.get('p2'), 17);
  assert.equal(game.state.chips.get('p3'), 20);
  assert.match(reveal.note, /ADA took it for 5\./);
});

test('a tie burns everybody’s chips and awards nothing', () => {
  const { game, rec } = started(bids, ROSTER);

  submit(game, 'p1', 4, 1500);
  submit(game, 'p2', 4, 1500);
  submit(game, 'p3', 1, 1500);

  assert.equal(game.players.get('p1').score, 0);
  assert.equal(game.players.get('p2').score, 0);
  assert.equal(game.state.chips.get('p1'), 16);
  assert.equal(game.state.chips.get('p2'), 16);
  assert.match(rec.last(S2C.REVEAL).note, /Nobody won it — ADA and BO both bid 4\./);
});

test('everybody passing wins nobody anything', () => {
  const { game, rec } = started(bids, ROSTER);
  for (const id of ['p1', 'p2', 'p3']) submit(game, id, 0, 1500);

  assert.equal([...game.players.values()].every((p) => p.score === 0), true);
  assert.match(rec.last(S2C.REVEAL).note, /passed/);
});

test('you cannot bid chips you do not have', () => {
  const { game } = started(bids, ROSTER);

  submit(game, 'p1', 21, 1500);
  assert.equal(game.submissions.has('p1'), false);

  submit(game, 'p1', -1, 1500);
  assert.equal(game.submissions.has('p1'), false);

  submit(game, 'p1', 20, 1500);
  assert.equal(game.submissions.get('p1'), 20);
});

test('a round nobody answered costs nobody chips', () => {
  const { game } = started(bids, ROSTER);
  game.tick(1000 + bids.collectMs);

  for (const id of ['p1', 'p2', 'p3']) assert.equal(game.state.chips.get(id), 20);
});

test('the chip budget spans the whole game, so it can run out', () => {
  const { game } = started(bids, ROSTER);
  let now = 1500;

  for (let round = 1; round <= 4; round++) {
    submit(game, 'p1', 5, now);
    submit(game, 'p2', 0, now);
    submit(game, 'p3', 0, now);
    now += bids.revealMs + 1;
    game.tick(now);
  }

  assert.equal(game.state.chips.get('p1'), 0);
  // And the input offered on the next round says so.
  assert.equal(game.deal.input({ id: 'p1' }, game.state).max, 0);
});

// ─────────────────────────── Who In This Bar ───────────────────────────

test('the most-voted player scores, and so does everyone who called it', () => {
  const { game, rec } = started(superlatives, ROSTER);

  submit(game, 'p1', 'p3', 1500);
  submit(game, 'p2', 'p3', 1500);
  submit(game, 'p3', 'p1', 1500);

  assert.equal(game.players.get('p3').score, 3, 'won the vote');
  assert.equal(game.players.get('p1').score, 2, 'called it');
  assert.equal(game.players.get('p2').score, 2, 'called it');
  assert.match(rec.last(S2C.REVEAL).note, /CY took it with 2\./);
});

test('voting for yourself is refused', () => {
  const { game } = started(superlatives, ROSTER);

  submit(game, 'p1', 'p1', 1500);
  assert.equal(game.submissions.has('p1'), false);

  submit(game, 'p1', 'nobody', 1500);
  assert.equal(game.submissions.has('p1'), false);
});

test('a three-way split hands everybody the win and nobody the bonus', () => {
  const { game, rec } = started(superlatives, ROSTER);

  submit(game, 'p1', 'p2', 1500);
  submit(game, 'p2', 'p3', 1500);
  submit(game, 'p3', 'p1', 1500);

  for (const id of ['p1', 'p2', 'p3']) {
    // Won the tie for 3; the 2 for calling it goes to whoever voted for a
    // winner — which, in a three-way tie, is everybody.
    assert.equal(game.players.get(id).score, 5);
  }
  assert.match(rec.last(S2C.REVEAL).note, /tied on 1 each/);
});

test('the prompt changes every round', () => {
  const { game, rec } = started(superlatives, ROSTER);
  const seen = new Set();
  let now = 1500;

  for (let round = 1; round <= 5; round++) {
    seen.add(rec.last(S2C.ROUND, 'p1').prompt);
    for (const id of ['p1', 'p2', 'p3']) submit(game, id, id === 'p1' ? 'p2' : 'p1', now);
    now += superlatives.revealMs + 1;
    game.tick(now);
  }

  assert.equal(seen.size, 5, `repeated a prompt: ${[...seen].join(' | ')}`);
});

test('nobody voting is a result, not a crash', () => {
  const { game, rec } = started(superlatives, ROSTER);
  game.tick(1000 + superlatives.collectMs);

  assert.match(rec.last(S2C.REVEAL).note, /Nobody voted/);
  assert.equal([...game.players.values()].every((p) => p.score === 0), true);
});

test('changing your answer is silent, so a tap cannot be amplified at the room', () => {
  const { game, rec } = started(countingGame());
  submit(game, 'p1', 1, 1500);
  assert.equal(rec.of(S2C.SUBMITTED).length, 1);

  for (const value of [2, 3, 4, 5, 6, 7]) submit(game, 'p1', value, 1500);

  assert.equal(rec.of(S2C.SUBMITTED).length, 1, 'one broadcast per player, not per tap');
  assert.equal(game.submissions.get('p1'), 7, 'but the last answer is the one that counts');
});
