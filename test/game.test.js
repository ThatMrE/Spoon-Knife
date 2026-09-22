import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ALL_HANDS, PHASE, S2C } from '../shared/protocol.js';
import { Game, difficulty } from '../core/game.js';
import { obey, recorder, seeded } from './helpers.js';

const CREW = [
  { id: 'p1', name: 'Ada' },
  { id: 'p2', name: 'Bo' },
  { id: 'p3', name: 'Cy' },
];

const T0 = 1_000_000;

/** Start a game and run it up to the first playing tick. */
function launch({ crew = CREW, seed = 42 } = {}) {
  const rec = recorder();
  const game = new Game({ transport: rec.transport, random: seeded(seed) });
  game.start(crew, T0);
  game.tick(T0 + 4000); // past the countdown
  return { game, rec, now: T0 + 4000 };
}

test('every player gets a console and an instruction once the countdown ends', () => {
  const { game, rec } = launch();

  assert.equal(game.phase, PHASE.PLAYING);
  assert.equal(rec.of(S2C.PANEL).length, 3);
  for (const player of game.players.values()) {
    assert.ok(player.instruction, `${player.id} should be holding an instruction`);
    assert.ok(player.instruction.text.length > 0);
  }
  assert.equal(rec.of(S2C.INSTRUCTION).length, 3);
});

test('instructions mostly point at somebody else’s console — that is the game', () => {
  let elsewhere = 0;
  let total = 0;

  for (let seed = 1; seed <= 60; seed++) {
    const { game } = launch({ seed });
    for (const player of game.players.values()) {
      const { ownerId } = game.controls.get(player.instruction.controlId);
      if (ownerId !== player.id) elsewhere++;
      total++;
    }
  }
  assert.ok(elsewhere / total > 0.6, `expected mostly cross-console, got ${elsewhere}/${total}`);
});

test('obeying an instruction credits the reader, not the operator', () => {
  const { game, rec, now } = launch();
  rec.clear();

  const instruction = game.players.get('p1').instruction;
  const { ownerId } = game.controls.get(instruction.controlId);
  assert.notEqual(ownerId, 'p1', 'seed 42 should hand p1 someone else’s gizmo');

  obey(game, 'p1', now);

  const resolved = rec.last(S2C.RESOLVED, 'p1');
  assert.equal(resolved.id, instruction.id);
  assert.equal(resolved.ok, true);
  assert.equal(game.progress, 1);
  assert.ok(game.score > 0);
  // And p1 is immediately handed the next one.
  assert.ok(game.players.get('p1').instruction);
  assert.notEqual(game.players.get('p1').instruction.id, instruction.id);
});

test('putting a control into the wrong state does nothing at all', () => {
  const { game, rec, now } = launch();
  rec.clear();

  const instruction = game.players.get('p1').instruction;
  const { control, ownerId } = game.controls.get(instruction.controlId);
  const wrong = (control.states ?? [0, 1, 2, 3, 4]).find(
    (option) => option !== instruction.requirement.value && option !== control.value,
  );

  if (wrong !== undefined) game.handleControl(ownerId, control.id, wrong, now);
  assert.equal(rec.of(S2C.RESOLVED, 'p1').length, 0);
  assert.equal(game.progress, 0);
});

test('a player cannot operate a console that is not theirs', () => {
  const { game, rec, now } = launch();
  rec.clear();

  const instruction = game.players.get('p1').instruction;
  const { control, ownerId } = game.controls.get(instruction.controlId);
  const impostor = [...game.players.keys()].find((id) => id !== ownerId);

  game.handleControl(impostor, control.id, instruction.requirement.value, now);
  assert.equal(rec.of(S2C.RESOLVED).length, 0);
  assert.equal(game.progress, 0);
});

test('missing the deadline costs hull and hands out a fresh instruction', () => {
  const { game, rec, now } = launch();
  const before = game.hull;
  const stale = new Map([...game.players].map(([id, p]) => [id, p.instruction.id]));
  rec.clear();

  // Everyone was issued at the same instant, so everyone fumbles together.
  game.tick(now + difficulty(1, 3).instructionMs + 1);

  assert.equal(game.hull, before - difficulty(1, 3).damage * 3);
  assert.equal(game.missed, 3);
  assert.equal(rec.of(S2C.RESOLVED).every((m) => m.ok === false && m.reason === 'expired'), true);
  for (const [id, player] of game.players) {
    assert.notEqual(player.instruction.id, stale.get(id), `${id} should get a new order`);
  }
});

test('the ship is lost when the hull runs out', () => {
  const { game, rec } = launch();
  let now = T0 + 4000;

  // Let everybody fumble everything until the hull gives out.
  for (let i = 0; i < 200 && !game.isOver; i++) {
    now += difficulty(game.wave, 3).instructionMs + 1;
    game.tick(now);
  }

  assert.equal(game.phase, PHASE.OVER);
  assert.equal(game.hull, 0, 'hull is clamped, never negative');
  const over = rec.last(S2C.GAME_OVER);
  assert.ok(over.missed > 0);
  assert.equal(over.completed, 0);
});

test('clearing the goal ends the wave, patches the hull and deals new consoles', () => {
  const { game, rec } = launch();
  let now = T0 + 4000;

  game.hull = 50;
  game.progress = game.goal - 1;
  const oldControls = new Set(game.controls.keys());

  obey(game, 'p1', now);

  assert.equal(game.phase, PHASE.WAVE_BREAK);
  assert.equal(game.wave, 2, 'the wave counter advances immediately');
  assert.equal(game.hull, 62, 'clearing a wave patches 12 points of hull');
  assert.ok(rec.last(S2C.WAVE));

  now += 5000;
  game.tick(now);
  assert.equal(game.phase, PHASE.PLAYING);
  assert.equal(game.progress, 0);
  const newControls = new Set(game.controls.keys());
  assert.equal([...newControls].some((id) => oldControls.has(id)), false, 'fresh consoles');
  for (const player of game.players.values()) assert.ok(player.instruction);
});

test('an all-hands emergency interrupts everyone and needs the whole crew', () => {
  const { game, rec } = launch();
  let now = T0 + 4000;

  game.wave = 4; // all-hands only fire from wave 2
  game.nextAllHandsAt = now;
  game.random = () => 0; // force the roll, and pick the first emergency kind
  game.tick(now);

  const alert = rec.last(S2C.ALL_HANDS);
  assert.ok(alert, 'an emergency should have fired');
  assert.equal(game.allHands.pending.size, 3);
  for (const player of game.players.values()) {
    assert.equal(player.instruction, null, 'individual orders are suspended');
  }

  game.handleMotion('p1', alert.kind, now);
  game.handleMotion('p1', alert.kind, now); // double-tapping must not double-count
  assert.equal(game.allHands.pending.size, 2);
  assert.equal(rec.last(S2C.ALL_HANDS_PROGRESS).pending.length, 2);

  game.handleMotion('p2', alert.kind, now);
  game.handleMotion('p3', alert.kind, now);

  assert.equal(game.allHands, null);
  assert.equal(rec.last(S2C.ALL_HANDS_DONE).ok, true);
  assert.equal(game.progress, 3, 'the whole crew pulling together is worth one each');
  for (const player of game.players.values()) assert.ok(player.instruction, 'orders resume');
});

test('the wrong motion does not count, and a missed emergency hurts extra', () => {
  const { game, rec } = launch();
  const now = T0 + 4000;

  game.wave = 4;
  game.nextAllHandsAt = now;
  game.random = () => 0;
  game.tick(now);

  const alert = rec.last(S2C.ALL_HANDS);
  const wrongKind = Object.values(ALL_HANDS).find((kind) => kind !== alert.kind);
  game.handleMotion('p1', wrongKind, now);
  assert.equal(game.allHands.pending.size, 3, 'flailing the wrong way is not obeying');

  const before = game.hull;
  game.tick(now + 7000);

  assert.equal(game.allHands, null);
  assert.equal(rec.last(S2C.ALL_HANDS_DONE).ok, false);
  assert.equal(before - game.hull, Math.round(difficulty(4, 3).damage * 1.5));
});

test('a player dropping off the WiFi tears down orders that pointed at them', () => {
  const { game, now } = launch();

  // Point p1 at one of p2's gizmos so the teardown has something to do.
  const p2Control = game.players.get('p2').panel[0];
  game.players.get('p1').instruction = {
    id: 'forced',
    controlId: p2Control.id,
    requirement: { value: 'anything' },
    text: 'x',
    issuedAt: now,
    expiresAt: now + 10_000,
  };

  game.removePlayer('p2', now);

  assert.equal(game.players.size, 2);
  assert.equal(game.controls.has(p2Control.id), false, 'their console goes with them');
  const reissued = game.players.get('p1').instruction;
  assert.ok(reissued);
  assert.notEqual(reissued.id, 'forced');
  assert.ok(game.controls.has(reissued.controlId), 'and points somewhere that still exists');
});

test('the run ends if the last crew member leaves', () => {
  const { game, rec, now } = launch({ crew: [{ id: 'solo', name: 'Solo' }] });
  game.removePlayer('solo', now);
  assert.equal(game.phase, PHASE.OVER);
  assert.match(rec.last(S2C.GAME_OVER).reason, /abandoned/i);
});

test('a solo player still gets a playable game', () => {
  const { game, rec, now } = launch({ crew: [{ id: 'solo', name: 'Solo' }] });
  const instruction = game.players.get('solo').instruction;
  assert.ok(instruction);
  assert.equal(game.controls.get(instruction.controlId).ownerId, 'solo');

  obey(game, 'solo', now);
  assert.equal(rec.last(S2C.RESOLVED, 'solo').ok, true);
});

test('no two players are ever sent after the same control', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { game, now } = launch({ seed });
    let clock = now;
    for (let round = 0; round < 12 && game.phase === PHASE.PLAYING; round++) {
      const targets = [...game.players.values()]
        .filter((p) => p.instruction)
        .map((p) => p.instruction.controlId);
      assert.equal(new Set(targets).size, targets.length, `seed ${seed}: duplicate target`);
      for (const id of [...game.players.keys()]) {
        if (game.players.get(id).instruction && game.phase === PHASE.PLAYING) obey(game, id, clock);
      }
      clock += 500;
      game.tick(clock);
    }
  }
});

test('clearing a wave does not defer the emergency that was already due', () => {
  const { game, now } = launch();

  game.wave = 3;
  game.nextAllHandsAt = now + 1000; // an emergency was about to land
  game.progress = game.goal - 1;
  obey(game, 'p1', now);
  assert.equal(game.phase, PHASE.WAVE_BREAK);

  game.tick(now + 5000); // through the break into the next wave
  assert.equal(game.phase, PHASE.PLAYING);
  assert.ok(
    game.nextAllHandsAt <= now + 5000,
    'the wave break must not push an already-due emergency into the future',
  );
});

test('a crew that clears waves quickly still meets emergencies', () => {
  // Regression: anchoring the emergency schedule to wave starts starved
  // exactly the crews playing well, because they cleared waves faster than the
  // nudge — they never saw a single asteroid field.
  let runsWithNone = 0;
  const RUNS = 12;

  for (let seed = 1; seed <= RUNS; seed++) {
    const game = new Game({ transport: { toPlayer() {}, toAll() {} }, random: seeded(seed) });
    let now = 0;
    game.start(CREW, now);
    const due = new Map();
    let emergencies = 0;

    // A brisk crew: every instruction obeyed within 400ms.
    while (now < 60_000 && !game.isOver) {
      now += 100;
      game.tick(now);
      if (game.allHands) {
        emergencies++;
        for (const id of [...game.allHands.pending]) game.handleMotion(id, game.allHands.kind, now);
        continue;
      }
      for (const player of game.players.values()) {
        if (!player.instruction) {
          due.delete(player.id);
          continue;
        }
        if (!due.has(player.id)) due.set(player.id, now + 400);
        if (now >= due.get(player.id)) {
          obey(game, player.id, now);
          due.delete(player.id);
        }
      }
    }
    if (emergencies === 0) runsWithNone++;
  }

  assert.ok(
    runsWithNone <= 2,
    `${runsWithNone}/${RUNS} minute-long fast runs saw no emergency at all`,
  );
});

test('difficulty tightens with every wave but stays humanly readable', () => {
  let previous = Infinity;
  for (let wave = 1; wave <= 30; wave++) {
    const { instructionMs, damage, goal } = difficulty(wave, 4);
    assert.ok(instructionMs <= previous);
    assert.ok(instructionMs >= 4000, `wave ${wave} gave only ${instructionMs}ms`);
    assert.ok(damage <= 24);
    assert.ok(goal > 0);
    previous = instructionMs;
  }
  assert.ok(difficulty(3, 6).goal > difficulty(3, 2).goal, 'bigger crews need more done');
  assert.equal(difficulty(1, 4).allHandsChance, 0, 'wave 1 is a gentle introduction');
});
