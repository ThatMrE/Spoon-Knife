/**
 * Integration tests: a real HTTP server, a real WebSocket handshake, and the
 * lobby/game protocol spoken over a real socket.
 *
 * These are the tests that would have caught the handshake bug — the unit
 * tests all passed while no browser could connect.
 */
import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';

import { C2S, PHASE, S2C } from '../shared/protocol.js';
import { DISCOVERY_APP_ID, createGameServer } from '../server/index.js';
import { TestClient } from './client.js';

let server;
let port;
const clients = [];

before(async () => {
  server = createGameServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  for (const client of clients) client.close();
  for (const room of server.rooms.rooms.values()) room.stopTimer();
  clearInterval(server.rooms.sweeper);
  await new Promise((resolve) => server.close(resolve));
});

/** Connect a client and remember it so `after` can clean up. */
async function connect() {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

function get(path) {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

// ────────────────────────────────── HTTP ──────────────────────────────────

test('the client page is served at the document root', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const body = await response.text();
  assert.match(body, /SPACE/, 'should be the game page');
  assert.match(body, /\/js\/app\.js/, 'should load the client module');
});

test('the shared protocol module is served to the browser', async () => {
  const response = await get('/shared/protocol.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /export const C2S/);
});

test('the game rules are served, so a browser can host a game', async () => {
  const response = await get('/core/rooms.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /export class RoomManager/);
});

test('Node-only transport is not served', async () => {
  assert.equal((await get('/server/ws.js')).status, 404);
  assert.equal((await get('/server/index.js')).status, 404);
});

test('server source and package metadata are not reachable over HTTP', async () => {
  for (const path of ['/../package.json', '/../server/index.js', '/js/../../server/ws.js']) {
    const response = await get(path);
    assert.ok(response.status === 404 || response.status === 403, `${path} returned ${response.status}`);
  }
});

test('a missing asset is a 404, not a crash', async () => {
  assert.equal((await get('/js/nope.js')).status, 404);
});

test('/discover identifies the ship so the app can find it on the WiFi', async () => {
  const response = await get('/discover');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);

  const body = await response.json();
  assert.equal(body.app, DISCOVERY_APP_ID, 'the marker the app matches on');
  assert.equal(typeof body.host, 'string');
  assert.equal(typeof body.rooms, 'number');
  assert.equal(typeof body.players, 'number');
});

test('/discover reports the live crew count', async () => {
  const before = await (await get('/discover')).json();

  const host = await connect();
  host.send(C2S.CREATE, { name: 'SCOUT' });
  await host.waitFor(S2C.WELCOME);

  const after = await (await get('/discover')).json();
  assert.equal(after.rooms, before.rooms + 1);
  assert.equal(after.players, before.players + 1);
});

test('/discover ignores a query string', async () => {
  assert.equal((await get('/discover?probe=1')).status, 200);
});

test('/discover does not leak room codes to the network', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'PRIVATE' });
  const { code } = await host.waitFor(S2C.WELCOME);

  // The code is the only thing keeping a passer-by on the same WiFi out of the
  // game, so advertising it would defeat the point of having one.
  const body = await (await get('/discover')).text();
  assert.equal(body.includes(code), false, `/discover exposed ${code}`);
  assert.equal('codes' in JSON.parse(body), false);
});

// ─────────────────────────────── handshake ───────────────────────────────

test('the WebSocket handshake is accepted by an independent client', async () => {
  // TestClient.connect computes Sec-WebSocket-Accept itself and rejects a
  // mismatch, so simply getting here proves the server hashes it correctly.
  const client = await connect();
  assert.ok(client.socket.writable);
});

test('a plain GET of /ws is just a missing file', async () => {
  // No Upgrade header means the HTTP server never raises 'upgrade' at all, so
  // this falls through to static serving.
  assert.equal((await get('/ws')).status, 404);
});

test('an upgrade request without a key is refused', async () => {
  const { connect } = await import('node:net');
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () =>
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      ),
    );
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
});

test('an upgrade on a path other than /ws is refused', async () => {
  const { connect } = await import('node:net');
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () =>
      socket.write(
        `GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.alloc(16).toString('base64')}\r\n\r\n`,
      ),
    );
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
});

// ──────────────────────────────── protocol ────────────────────────────────

test('creating a ship returns a code and seats the host', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'ADA' });

  const welcome = await host.waitFor(S2C.WELCOME);
  assert.match(welcome.code, /^[A-Z0-9]{4}$/);
  assert.equal(welcome.isHost, true);
  assert.ok(welcome.playerId);

  const lobby = await host.waitFor(S2C.LOBBY);
  assert.equal(lobby.phase, PHASE.LOBBY);
  assert.deepEqual(lobby.players.map((p) => p.name), ['ADA']);
});

test('joining with an unknown code reports an error rather than dropping you', async () => {
  const stray = await connect();
  stray.send(C2S.JOIN, { code: 'ZZZZ', name: 'LOST' });

  const error = await stray.waitFor(S2C.ERROR);
  assert.match(error.message, /ZZZZ/);
  assert.ok(stray.socket.writable, 'the connection should survive a bad join');
});

test('malformed frames are ignored instead of killing the connection', async () => {
  const client = await connect();
  client.sendRaw('not json at all');
  client.sendRaw('{"no":"type field"}');
  client.sendRaw('null');

  // Still functional afterwards.
  client.send(C2S.CREATE, { name: 'ROBUST' });
  assert.ok(await client.waitFor(S2C.WELCOME));
});

test('the host cannot launch until the rest of the crew is ready', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'ADA' });
  const { code } = await host.waitFor(S2C.WELCOME);

  const mate = await connect();
  mate.send(C2S.JOIN, { code, name: 'BO' });
  await mate.waitFor(S2C.WELCOME);

  host.send(C2S.START);
  const refusal = await host.waitFor(S2C.ERROR);
  assert.match(refusal.message, /BO/, 'should name who we are waiting on');

  mate.send(C2S.READY, { ready: true });
  host.send(C2S.START);

  // Both players get a console, and it is not the same console.
  const hostPanel = await host.waitFor(S2C.PANEL);
  const matePanel = await mate.waitFor(S2C.PANEL);
  assert.ok(hostPanel.controls.length >= 4);
  assert.equal(hostPanel.wave, 1);

  const hostIds = hostPanel.controls.map((c) => c.id);
  const mateIds = matePanel.controls.map((c) => c.id);
  assert.equal(hostIds.some((id) => mateIds.includes(id)), false, 'consoles must not overlap');

  const labels = [...hostPanel.controls, ...matePanel.controls].map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length, 'labels are unique across the ship');
});

test('instructions arrive over the wire and name a gizmo that exists on the ship', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'ADA' });
  const { code } = await host.waitFor(S2C.WELCOME);

  const mate = await connect();
  mate.send(C2S.JOIN, { code, name: 'BO' });
  await mate.waitFor(S2C.WELCOME);
  mate.send(C2S.READY, { ready: true });
  host.send(C2S.START);

  const panels = [await host.waitFor(S2C.PANEL), await mate.waitFor(S2C.PANEL)];
  const everyLabel = panels.flatMap((p) => p.controls.map((c) => c.label.toUpperCase()));

  // Instructions are issued once the countdown finishes.
  for (const client of [host, mate]) {
    const instruction = await client.waitFor(S2C.INSTRUCTION);
    assert.ok(instruction.text.length > 0);
    assert.ok(instruction.duration > 0);
    assert.ok(
      everyLabel.some((label) => instruction.text.includes(label)),
      `"${instruction.text}" names no gizmo on the ship`,
    );
  }

  const state = await host.waitFor(S2C.STATE);
  assert.equal(state.maxHull, 100);
  assert.ok(state.goal > 0);
});

test('a bogus control value is ignored without disturbing the game', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'SOLO' });
  await host.waitFor(S2C.WELCOME);
  host.send(C2S.START);

  const panel = await host.waitFor(S2C.PANEL);
  await host.waitFor(S2C.INSTRUCTION);

  host.send(C2S.CONTROL, { controlId: 'nope', value: 'whatever' });
  host.send(C2S.CONTROL, { controlId: panel.controls[0].id, value: { evil: true } });
  host.send(C2S.CONTROL, { controlId: panel.controls[0].id, value: 999_999 });

  // The room is still alive and still reporting state.
  const before = host.all(S2C.STATE).length;
  const state = await host.waitFor(S2C.STATE);
  assert.ok(state.hull > 0);
  assert.ok(host.all(S2C.STATE).length >= before);
  assert.ok(host.socket.writable);
});

/** Start a two-player game and return both clients plus the code. */
async function launchedGame() {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'ADA' });
  const welcome = await host.waitFor(S2C.WELCOME);

  const mate = await connect();
  mate.send(C2S.JOIN, { code: welcome.code, name: 'BO' });
  const mateWelcome = await mate.waitFor(S2C.WELCOME);
  mate.send(C2S.READY, { ready: true });
  host.send(C2S.START);

  await host.waitFor(S2C.PANEL);
  const matePanel = await mate.waitFor(S2C.PANEL);
  return { host, mate, code: welcome.code, mateToken: mateWelcome.token, matePanel };
}

test('every player is given a token so a dropped phone can prove its seat', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'ADA' });
  const welcome = await host.waitFor(S2C.WELCOME);

  assert.equal(typeof welcome.token, 'string');
  assert.ok(welcome.token.length >= 16, 'not something a bystander could guess');
  assert.equal(welcome.resumed, false);
});

test('a phone that drops mid-game can rejoin its own console', async () => {
  const { host, code, mateToken, matePanel } = await launchedGame();

  // The phone goes to sleep: FIN, and the seat is held open.
  const mate = clients[clients.length - 1];
  mate.closeGracefully();
  const dropped = await host.waitFor(S2C.CREW);
  assert.equal(dropped.name, 'BO');
  assert.equal(dropped.connected, false);

  // It wakes up and resumes with its token.
  const returning = await connect();
  returning.send(C2S.RESUME, { code, token: mateToken });
  const welcome = await returning.waitFor(S2C.WELCOME);

  assert.equal(welcome.resumed, true, 'the client is told this was a rejoin');
  assert.equal(welcome.code, code);

  const panel = await returning.waitFor(S2C.PANEL);
  assert.deepEqual(
    panel.controls.map((c) => c.id),
    matePanel.controls.map((c) => c.id),
    'the very same console, or the shouting makes no sense',
  );
  assert.ok(await returning.waitFor(S2C.INSTRUCTION), 'and they are put back to work');

  const back = host.all(S2C.CREW).filter((m) => m.connected);
  assert.equal(back.length >= 1, true, 'the crew is told they are back');
});

test('the crew roster shows who is missing rather than dropping them', async () => {
  const { host } = await launchedGame();

  const mate = clients[clients.length - 1];
  mate.closeGracefully();
  await host.waitFor(S2C.CREW);

  const deadline = Date.now() + 5000;
  let roster;
  while (Date.now() < deadline) {
    const lobbies = host.all(S2C.LOBBY);
    const latest = lobbies[lobbies.length - 1];
    if (latest && latest.players.some((p) => p.connected === false)) {
      roster = latest;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(roster, 'the roster was never updated');
  assert.equal(roster.players.length, 2, 'the seat is still theirs');
  assert.deepEqual(
    roster.players.map((p) => [p.name, p.connected]),
    [['ADA', true], ['BO', false]],
  );
});

test('a wrong token is refused without disturbing the seat', async () => {
  const { host, code, mateToken } = await launchedGame();
  const mate = clients[clients.length - 1];
  mate.closeGracefully();
  await host.waitFor(S2C.CREW);

  const impostor = await connect();
  impostor.send(C2S.RESUME, { code, token: 'not-a-real-token' });
  assert.match((await impostor.waitFor(S2C.ERROR)).message, /seat is gone/i);

  // The seat is untouched, so the real phone can still come back.
  const returning = await connect();
  returning.send(C2S.RESUME, { code, token: mateToken });
  assert.equal((await returning.waitFor(S2C.WELCOME)).resumed, true);
});

test('resuming a seat somebody is already sitting in is refused', async () => {
  const { code, mateToken } = await launchedGame();

  const second = await connect();
  second.send(C2S.RESUME, { code, token: mateToken });
  const error = await second.waitFor(S2C.ERROR);
  assert.match(error.message, /already aboard/i);
});

test('resuming into a ship that does not exist is refused', async () => {
  const stray = await connect();
  stray.send(C2S.RESUME, { code: 'ZZZZ', token: 'whatever' });
  assert.match((await stray.waitFor(S2C.ERROR)).message, /ZZZZ/);
});

test('a crewmate disconnecting is announced to whoever is left', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'ADA' });
  const { code } = await host.waitFor(S2C.WELCOME);

  const mate = await connect();
  mate.send(C2S.JOIN, { code, name: 'BO' });
  await mate.waitFor(S2C.WELCOME);
  await host.waitFor(S2C.LOBBY);

  const lobbiesBefore = host.all(S2C.LOBBY).length;
  // Regression: an upgraded socket goes half-open on FIN — 'end' fires but
  // 'close' never does. Before this was handled, BO stayed in the crew,
  // holding a console that instructions kept pointing at.
  mate.closeGracefully();

  // The host should get a fresh roster without BO on it.
  const deadline = Date.now() + 5000;
  let roster;
  while (Date.now() < deadline) {
    const lobbies = host.all(S2C.LOBBY);
    const latest = lobbies[lobbies.length - 1];
    if (lobbies.length > lobbiesBefore && latest.players.length === 1) {
      roster = latest;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(roster, 'the remaining crew was never told');
  assert.deepEqual(roster.players.map((p) => p.name), ['ADA']);
});
