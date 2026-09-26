/**
 * Finding each other in the room: what a look may contain, and which tables a
 * server is willing to list.
 */
import { strict as assert } from 'node:assert';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { COLOURS, EMBLEMS, SPOTS, WEARING, describeLook, sanitizeLook } from '../shared/looks.js';
import { C2S, S2C } from '../shared/protocol.js';
import { createGameServer } from '../server/index.js';
import { ConnectionGuard } from '../server/guard.js';
import { TestClient } from './client.js';

let server;
let port;
const clients = [];

before(async () => {
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

const tables = (at = port) =>
  fetch(`http://127.0.0.1:${at}/tables`).then((response) => response.json());

// ───────────────────────────── what a look is ─────────────────────────────

test('a look can only ever be one of the offered descriptions', () => {
  const clean = sanitizeLook({
    colour: COLOURS[2].key,
    emblem: EMBLEMS[3],
    wearing: WEARING[1],
    spot: SPOTS[4],
  });
  assert.deepEqual(clean, {
    colour: COLOURS[2].key,
    emblem: EMBLEMS[3],
    wearing: WEARING[1],
    spot: SPOTS[4],
  });
});

test('a look cannot be used to send a stranger a message', () => {
  const nasty = sanitizeLook({
    colour: 'javascript:alert(1)',
    emblem: '<img src=x onerror=alert(1)>',
    wearing: 'call me on 07700 900000',
    spot: '',
  });
  assert.equal(nasty.colour, COLOURS[0].key, 'falls back to the first colour');
  assert.equal(EMBLEMS.includes(nasty.emblem), true);
  assert.equal(nasty.wearing, null, 'free text is dropped, not escaped');
  assert.equal(nasty.spot, null);
});

test('missing parts are simply absent', () => {
  const sparse = sanitizeLook({ colour: 'green' });
  assert.equal(sparse.colour, 'green');
  assert.equal(sparse.wearing, null);
  assert.equal(describeLook(sparse), '');
  assert.equal(describeLook({ wearing: 'stripes', spot: 'at the bar' }), 'stripes, at the bar');
});

test('nonsense in place of a look is a look, not a crash', () => {
  for (const junk of [null, undefined, 'red', 42, []]) {
    const clean = sanitizeLook(junk);
    assert.equal(COLOURS.some((c) => c.key === clean.colour), true);
    assert.equal(EMBLEMS.includes(clean.emblem), true);
  }
});

// ──────────────────────────── the tables list ────────────────────────────

test('a table waiting for people is listed, with what they look like', async () => {
  const host = await connect();
  host.send(C2S.CREATE, {
    name: 'ADA',
    look: { colour: 'teal', emblem: EMBLEMS[1], wearing: WEARING[0], spot: SPOTS[0] },
  });
  const { code } = await host.waitFor(S2C.WELCOME);

  const body = await tables();
  assert.equal(body.listing, true);
  const table = body.tables.find((t) => t.code === code);
  assert.ok(table, 'the table is not in the list');
  assert.equal(table.playing, false);
  assert.deepEqual(table.players, [
    { name: 'ADA', look: { colour: 'teal', emblem: EMBLEMS[1], wearing: WEARING[0], spot: SPOTS[0] } },
  ]);
});

test('a table that is already playing is not advertised', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'BO' });
  const { code } = await host.waitFor(S2C.WELCOME);
  host.send(C2S.START);
  await host.waitFor(S2C.PANEL);

  const body = await tables();
  assert.equal(body.tables.some((t) => t.code === code), false);
});

test('the lobby tells everybody what everybody looks like', async () => {
  const host = await connect();
  host.send(C2S.CREATE, { name: 'CY', look: { colour: 'pink', emblem: EMBLEMS[2] } });
  const lobby = await host.waitFor(S2C.LOBBY);

  assert.equal(lobby.players[0].look.colour, 'pink');
  assert.equal(lobby.players[0].look.emblem, EMBLEMS[2]);
});

// ─────────────────────── and what a public one says ───────────────────────

/** A free port, released just before the child claims it. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: found } = probe.address();
      probe.close(() => resolve(found));
    });
  });
}

test('a public server lists no tables at all', async () => {
  const publicPort = await freePort();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../server/index.js', import.meta.url))],
    { env: { ...process.env, PORT: String(publicPort), PUBLIC_SERVER: '1' }, stdio: 'ignore' },
  );

  try {
    // Wait for it to answer rather than guessing at a startup time.
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${publicPort}/discover`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const body = await tables(publicPort);
    assert.equal(body.public, true);
    // Listing tables on the open internet would hand out every room code on the
    // server, and the code is the only door.
    assert.equal(body.listing, false);
    assert.deepEqual(body.tables, []);
  } finally {
    child.kill();
  }
});
