/**
 * Don't Say It.
 *
 * The rules that matter here are the anti-abuse ones: a word nobody else can
 * see, a catch only the accused can confirm, and no way to spam accusations at
 * somebody who keeps saying no.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { C2S, INPUT, S2C } from '../shared/protocol.js';
import { CATCH_POINTS, CLAIM_MS, COOLDOWN_MS, Taboo } from '../core/games/taboo.js';
import { recorder, seeded } from './helpers.js';

const ROSTER = [
  { id: 'p1', name: 'ADA' },
  { id: 'p2', name: 'BO' },
  { id: 'p3', name: 'CY' },
];

const DURATION = 60_000;

function started(now = 1000, roster = ROSTER) {
  const rec = recorder();
  const game = new Taboo({ transport: rec.transport, random: seeded(3), durationMs: DURATION });
  game.start(roster, now);
  return { game, rec };
}

const claim = (game, by, targetId, now) => game.input(by, { t: C2S.CLAIM, targetId }, now);
const answer = (game, who, claimId, ok, now) =>
  game.input(who, { t: C2S.CONFIRM, claimId, ok }, now);

test('every player gets their own word, and only their own', () => {
  const { game, rec } = started();

  const words = rec.of(S2C.SECRET);
  assert.equal(words.length, 3);
  assert.equal(new Set(words.map((m) => m.word)).size, 3, 'two players chasing one word');

  for (const { to, word } of words) {
    // A secret broadcast is not a secret.
    assert.notEqual(to, '*');
    assert.equal(game.players.get(to).word, word);
  }
});

test('the briefing tells you what to do with it', () => {
  const { game, rec } = started();
  const round = rec.last(S2C.ROUND, 'p1');

  assert.equal(round.input.kind, INPUT.CLAIM);
  assert.equal(round.endsIn, DURATION);
  assert.ok(round.prompt.includes(game.players.get('p1').word));
});

test('an accusation is put to the whole room', () => {
  const { game, rec } = started();
  const word = game.players.get('p1').word;

  claim(game, 'p1', 'p2', 2000);

  const ask = rec.last(S2C.CLAIM_ASK);
  assert.equal(ask.to, '*', 'the room turning to look is the point');
  assert.equal(ask.by, 'ADA');
  assert.equal(ask.target, 'p2');
  assert.equal(ask.word, word);
});

test('only the accused can settle it', () => {
  const { game, rec } = started();
  claim(game, 'p1', 'p2', 2000);
  const { claimId } = rec.last(S2C.CLAIM_ASK);
  rec.clear();

  // The claimer confirming their own catch would make the handshake theatre.
  answer(game, 'p1', claimId, true, 2100);
  answer(game, 'p3', claimId, true, 2100);
  assert.equal(rec.of(S2C.CLAIM_DONE).length, 0);
  assert.equal(game.players.get('p1').score, 0);

  answer(game, 'p2', claimId, true, 2200);
  assert.equal(game.players.get('p1').score, CATCH_POINTS);
});

test('a confirmed catch earns points and a fresh word', () => {
  const { game, rec } = started();
  const first = game.players.get('p1').word;
  claim(game, 'p1', 'p2', 2000);
  answer(game, 'p2', rec.last(S2C.CLAIM_ASK).claimId, true, 2100);

  const done = rec.last(S2C.CLAIM_DONE);
  assert.equal(done.ok, true);
  assert.equal(done.points, CATCH_POINTS);
  assert.equal(done.word, first);
  // Chasing a word the room is now watching for would be a dead end.
  assert.notEqual(game.players.get('p1').word, first);
  assert.equal(rec.last(S2C.SECRET, 'p1').word, game.players.get('p1').word);
  assert.equal(rec.last(S2C.STANDINGS).standings[0].name, 'ADA');
});

test('a denial puts that pairing on ice for a while', () => {
  const { game, rec } = started();
  claim(game, 'p1', 'p2', 2000);
  answer(game, 'p2', rec.last(S2C.CLAIM_ASK).claimId, false, 2100);
  assert.equal(game.players.get('p1').score, 0);
  rec.clear();

  claim(game, 'p1', 'p2', 3000);
  assert.equal(rec.of(S2C.CLAIM_ASK).length, 0, 'nagging the same person is not a strategy');

  // Somebody else is still fair game immediately.
  claim(game, 'p1', 'p3', 3100);
  assert.equal(rec.last(S2C.CLAIM_ASK).target, 'p3');
  rec.clear();

  // And the pairing comes back once the cooldown expires.
  answer(game, 'p3', game.claims.values().next().value.id, false, 3200);
  claim(game, 'p1', 'p2', 2100 + COOLDOWN_MS + 1);
  assert.equal(rec.last(S2C.CLAIM_ASK).target, 'p2');
});

test('one accusation at a time', () => {
  const { game, rec } = started();
  claim(game, 'p1', 'p2', 2000);
  rec.clear();

  claim(game, 'p1', 'p3', 2100);

  assert.equal(rec.of(S2C.CLAIM_ASK).length, 0);
  assert.equal(game.claims.size, 1);
});

test('an unanswered accusation lapses instead of hanging there', () => {
  const { game, rec } = started();
  claim(game, 'p1', 'p2', 2000);

  game.tick(2000 + CLAIM_MS - 1);
  assert.equal(game.claims.size, 1);

  game.tick(2000 + CLAIM_MS);
  assert.equal(game.claims.size, 0);
  const done = rec.last(S2C.CLAIM_DONE);
  assert.equal(done.ok, false);
  assert.equal(done.reason, 'no answer');
});

test('you cannot accuse yourself, or somebody who is not there', () => {
  const { game, rec } = started();

  claim(game, 'p1', 'p1', 2000);
  claim(game, 'p1', 'nobody', 2000);
  assert.equal(rec.of(S2C.CLAIM_ASK).length, 0);

  game.setConnected('p2', false, 2100);
  claim(game, 'p1', 'p2', 2200);
  assert.equal(rec.of(S2C.CLAIM_ASK).length, 0, 'a dropped phone cannot confirm anything');
});

test('a phone that comes back is told its word again', () => {
  const { game, rec } = started();
  const word = game.players.get('p2').word;
  game.setConnected('p2', false, 2000);
  rec.clear();

  game.setConnected('p2', true, 3000);

  assert.equal(rec.last(S2C.SECRET, 'p2').word, word);
  assert.equal(rec.last(S2C.ROUND, 'p2').endsIn, DURATION - 2000);
});

test('losing a player voids the accusations they were part of', () => {
  const { game } = started();
  claim(game, 'p1', 'p2', 2000);
  claim(game, 'p3', 'p1', 2000);
  assert.equal(game.claims.size, 2);

  game.removePlayer('p1', 2100);

  assert.equal(game.claims.size, 0, 'nobody left to confirm either of them');
});

test('the game ends on the clock, and says what everyone was chasing', () => {
  const { game, rec } = started();
  claim(game, 'p1', 'p2', 2000);
  answer(game, 'p2', rec.last(S2C.CLAIM_ASK).claimId, true, 2100);

  game.tick(1000 + DURATION);

  assert.equal(game.isOver, true);
  const over = rec.last(S2C.PARTY_OVER);
  assert.deepEqual(over.winners, ['ADA']);
  assert.equal(over.words.length, 3);
  assert.equal(
    over.words.every((entry) => typeof entry.word === 'string' && entry.word.length > 0),
    true,
  );
});

test('nothing happens after the final whistle', () => {
  const { game, rec } = started();
  game.tick(1000 + DURATION);
  rec.clear();

  claim(game, 'p1', 'p2', 1000 + DURATION + 1);

  assert.equal(rec.of(S2C.CLAIM_ASK).length, 0);
  assert.equal(rec.of(S2C.PARTY_OVER).length, 0, 'ended once, not twice');
});
