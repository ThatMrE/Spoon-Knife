/**
 * The party games over a real socket, in a real room.
 *
 * The engines themselves are covered by sealed.test.js and taboo.test.js against
 * a fake clock. What is worth proving here is the wiring: that a room can host
 * something other than Spaceteam, that the host picks it, and that a message the
 * room has never heard of reaches the right engine.
 */
import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';

import { C2S, GAMES, INPUT, S2C } from '../shared/protocol.js';
import { createGameServer } from '../server/index.js';
import { ConnectionGuard } from '../server/guard.js';
import { TestClient } from './client.js';

let server;
let port;
const clients = [];

before(async () => {
  // As in server.test.js: these hold several sockets open from 127.0.0.1, and
  // the abuse limits are tested on purpose elsewhere rather than by accident here.
  server = createGameServer({
    guard: new ConnectionGuard({ maxConnections: 10_000, maxPerAddress: 10_000 }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  for (const client of clients) client.close();
  for (const room of server.rooms.rooms.values()) room.stopTimer();
  clearInterval(server.rooms.sweeper);
  await new Promise((resolve) => server.close(resolve));
});

async function connect() {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

/** A host plus `extra` joined, ready crew. Returns [host, ...others]. */
async function crew(extra, names = ['ADA', 'BO', 'CY', 'DI']) {
  const host = await connect();
  host.send(C2S.CREATE, { name: names[0] });
  const { code } = await host.waitFor(S2C.WELCOME);

  const others = [];
  for (let i = 0; i < extra; i++) {
    const client = await connect();
    client.send(C2S.JOIN, { code, name: names[i + 1] });
    await client.waitFor(S2C.WELCOME);
    client.send(C2S.READY, { ready: true });
    others.push(client);
  }
  // The host's lobby has to show everybody ready before a launch is allowed.
  for (;;) {
    const lobby = host.all(S2C.LOBBY).at(-1);
    if (lobby?.players.length === extra + 1 && lobby.players.every((p) => p.ready || p.isHost)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [host, ...others];
}

const clear = (group) => group.forEach((client) => (client.received.length = 0));

test('the lobby advertises every game, with Spaceteam picked', async () => {
  const [host] = await crew(0);
  const lobby = await host.waitFor(S2C.LOBBY);

  assert.equal(lobby.game, GAMES.SPACETEAM);
  assert.deepEqual(
    lobby.games.map((g) => g.key),
    [GAMES.SPACETEAM, GAMES.BIDS, GAMES.SUPERLATIVES, GAMES.TABOO],
  );
  for (const game of lobby.games) {
    assert.ok(game.title && game.blurb, `${game.key} has nothing to show in the lobby`);
    assert.ok(game.minPlayers >= 1);
  }
});

test('the host picks the game, and only the host', async () => {
  const [host, guest] = await crew(1);

  host.send(C2S.PICK_GAME, { game: GAMES.BIDS });
  for (;;) {
    if (guest.all(S2C.LOBBY).at(-1)?.game === GAMES.BIDS) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  guest.send(C2S.PICK_GAME, { game: GAMES.TABOO });
  const refusal = await guest.waitFor(S2C.ERROR);
  assert.match(refusal.message, /Only the host/);
  assert.equal(host.all(S2C.LOBBY).at(-1).game, GAMES.BIDS, 'the guest did not get to change it');

  host.send(C2S.PICK_GAME, { game: 'chess' });
  assert.match((await host.waitFor(S2C.ERROR)).message, /No such game/);
});

test('a game that needs more people says so instead of starting', async () => {
  const [host] = await crew(1);

  host.send(C2S.PICK_GAME, { game: GAMES.SUPERLATIVES });
  host.send(C2S.START);

  const refusal = await host.waitFor(S2C.ERROR);
  assert.match(refusal.message, /Who In This Bar needs 3 players/);
});

test('Sealed Bids: a round is dealt, sealed, and revealed to everyone', async () => {
  const group = await crew(2);
  const [host] = group;

  host.send(C2S.PICK_GAME, { game: GAMES.BIDS });
  clear(group);
  host.send(C2S.START);

  const rounds = [];
  for (const client of group) rounds.push(await client.waitFor(S2C.ROUND));
  for (const round of rounds) {
    assert.equal(round.game, GAMES.BIDS);
    assert.equal(round.input.kind, INPUT.NUMBER);
    assert.equal(round.input.max, 20, 'everyone starts with the same chips');
    assert.equal(round.you.chips, 20);
    assert.equal(round.standings.length, 3);
  }

  const bids = [7, 3, 0];
  group.forEach((client, i) => client.send(C2S.SUBMIT, { round: 1, value: bids[i] }));

  // Everybody sees the same reveal, and it resolves without waiting out the
  // 20-second deadline because all three answered.
  for (const client of group) {
    const reveal = await client.waitFor(S2C.REVEAL, 5000);
    assert.match(reveal.note, /ADA took it for 7\./);
    assert.equal(reveal.standings.find((p) => p.name === 'ADA').score > 0, true);
    assert.equal(reveal.entries.find((e) => e.name === 'BO').detail, '17 chips left');
  }
});

test('Who In This Bar: votes score the winner and whoever called it', async () => {
  const group = await crew(2);
  const [host, bo, cy] = group;

  host.send(C2S.PICK_GAME, { game: GAMES.SUPERLATIVES });
  clear(group);
  host.send(C2S.START);

  const round = await host.waitFor(S2C.ROUND);
  assert.match(round.prompt, /^Who in this bar /);
  assert.equal(round.input.kind, INPUT.PLAYER);
  await bo.waitFor(S2C.ROUND);
  await cy.waitFor(S2C.ROUND);

  const ids = Object.fromEntries(round.standings.map((p) => [p.name, p.id]));
  host.send(C2S.SUBMIT, { round: 1, value: ids.CY });
  bo.send(C2S.SUBMIT, { round: 1, value: ids.CY });
  cy.send(C2S.SUBMIT, { round: 1, value: ids.ADA });

  const reveal = await host.waitFor(S2C.REVEAL, 5000);
  const score = (name) => reveal.standings.find((p) => p.name === name).score;
  assert.match(reveal.note, /CY took it with 2\./);
  assert.equal(score('CY'), 3);
  assert.equal(score('ADA'), 2);
  assert.equal(score('BO'), 2);
});

test("Don't Say It: a secret word each, and a catch the accused has to admit", async () => {
  const group = await crew(1);
  const [host, guest] = group;

  host.send(C2S.PICK_GAME, { game: GAMES.TABOO });
  clear(group);
  host.send(C2S.START);

  const secret = await host.waitFor(S2C.SECRET);
  const guestSecret = await guest.waitFor(S2C.SECRET);
  assert.ok(secret.word);
  assert.notEqual(secret.word, guestSecret.word);
  // Nobody else may learn it: the only copy on the wire went to its owner.
  assert.equal(guest.all(S2C.SECRET).length, 1);
  assert.equal(guest.all(S2C.SECRET)[0].word, guestSecret.word);

  const round = await host.waitFor(S2C.ROUND);
  assert.equal(round.input.kind, INPUT.CLAIM);
  const guestId = round.standings.find((p) => p.name === 'BO').id;

  host.send(C2S.CLAIM, { targetId: guestId });
  const ask = await guest.waitFor(S2C.CLAIM_ASK);
  assert.equal(ask.word, secret.word);
  assert.equal(ask.target, guestId);

  guest.send(C2S.CONFIRM, { claimId: ask.claimId, ok: true });
  const done = await host.waitFor(S2C.CLAIM_DONE);
  assert.equal(done.ok, true);
  assert.equal(done.points, 3);

  const standings = await host.waitFor(S2C.STANDINGS);
  assert.equal(standings.standings.find((p) => p.name === 'ADA').score, 3);
  // Caught words are replaced, so the chase continues.
  assert.notEqual(host.all(S2C.SECRET).at(-1).word, secret.word);
});

test('Spaceteam still works, and the lobby reports either kind of result', async () => {
  const [host] = await crew(0);

  // Solo Spaceteam, ended early, is the quickest way to a finished run.
  host.send(C2S.START);
  await host.waitFor(S2C.PANEL);
  const room = [...server.rooms.rooms.values()].at(-1);
  room.game._gameOver('Testing.');
  room.finish();

  // The lobby that carries the result is a broadcast, so it has to arrive.
  let lobby;
  for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
    lobby = host.all(S2C.LOBBY).findLast((m) => m.lastResult);
    if (lobby) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(lobby, 'no lobby carried the finished run');
  assert.equal(lobby.lastResult.game, GAMES.SPACETEAM);
  assert.equal(typeof lobby.lastResult.wave, 'number');
  assert.equal(lobby.lastResult.standings, undefined, 'Spaceteam reports a run, not a table');
});
