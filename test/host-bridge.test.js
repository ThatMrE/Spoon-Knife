/**
 * Tests the module that hosts a game on a phone.
 *
 * The hosting phone runs `public/host/bridge.js` inside a WebView, with native
 * Java owning the sockets. Everything above the socket is plain JS, so it can
 * be driven here with a test double in place of the native side — which is the
 * whole reason the native/JS boundary is only four calls wide.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { C2S, PHASE, S2C } from '../shared/protocol.js';
import { createHost } from '../public/host/bridge.js';

/** Stands in for the Java side: records outbound frames, notes closes. */
function fakeNative() {
  const frames = [];
  const closed = [];
  const wire = {
    frames,
    closed,
    statuses: [],
    native: {
      send: (id, text) => frames.push({ id, message: JSON.parse(text) }),
      close: (id) => closed.push(id),
      hostName: () => 'ADA-PHONE',
      status(json) {
        wire.statuses.push(JSON.parse(json));
      },
    },
    to(id, type) {
      return frames.filter((f) => f.id === id && f.message.t === type).map((f) => f.message);
    },
    last(id, type) {
      const matches = this.to(id, type);
      return matches[matches.length - 1];
    },
    clear() {
      frames.length = 0;
    },
  };
  return wire;
}

/** Connect a phone and send it through the lobby. */
function phone(host, wire, id, message, payload) {
  host.open(id);
  host.message(id, JSON.stringify({ t: message, ...payload }));
  return wire.last(id, S2C.WELCOME);
}

test('a phone can open a ship and be told its code', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const welcome = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  assert.match(welcome.code, /^[A-Z0-9]{4}$/);
  assert.equal(welcome.isHost, true);

  const lobby = wire.last('c1', S2C.LOBBY);
  assert.equal(lobby.phase, PHASE.LOBBY);
  assert.deepEqual(lobby.players.map((p) => p.name), ['ADA']);

  host.shutdown();
});

test('a second phone joins by code and both see the crew', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  phone(host, wire, 'c2', C2S.JOIN, { code, name: 'BO' });

  for (const id of ['c1', 'c2']) {
    const lobby = wire.last(id, S2C.LOBBY);
    assert.deepEqual(lobby.players.map((p) => p.name), ['ADA', 'BO'], `${id} roster`);
  }

  assert.equal(host.status().players, 2);
  assert.deepEqual(host.status().codes, [code]);
  host.shutdown();
});

test('launching deals each phone its own console', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  phone(host, wire, 'c2', C2S.JOIN, { code, name: 'BO' });
  host.message('c2', JSON.stringify({ t: C2S.READY, ready: true }));
  host.message('c1', JSON.stringify({ t: C2S.START }));

  const panels = ['c1', 'c2'].map((id) => wire.last(id, S2C.PANEL));
  for (const panel of panels) assert.ok(panel.controls.length >= 4);

  const [mine, theirs] = panels.map((p) => p.controls.map((c) => c.id));
  assert.equal(mine.some((id) => theirs.includes(id)), false, 'consoles must not overlap');

  const labels = panels.flatMap((p) => p.controls.map((c) => c.label));
  assert.equal(new Set(labels).size, labels.length, 'labels unique across the ship');

  host.shutdown();
});

test('the host refuses to launch while a crewmate is not ready', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  phone(host, wire, 'c2', C2S.JOIN, { code, name: 'BO' });
  host.message('c1', JSON.stringify({ t: C2S.START }));

  assert.match(wire.last('c1', S2C.ERROR).message, /BO/);
  host.shutdown();
});

test('a bad code is reported without dropping the phone', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  host.open('c9');
  host.message('c9', JSON.stringify({ t: C2S.JOIN, code: 'ZZZZ', name: 'LOST' }));

  assert.match(wire.last('c9', S2C.ERROR).message, /ZZZZ/);
  assert.equal(wire.closed.includes('c9'), false, 'the connection should survive');
  host.shutdown();
});

test('rubbish from a phone is ignored rather than crashing the host', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  host.open('c1');
  for (const junk of ['not json', '{"no":"type"}', 'null', '[]', '']) {
    host.message('c1', junk);
  }
  // Unknown ids must be harmless too — the native side may race a close.
  host.message('ghost', JSON.stringify({ t: C2S.CREATE, name: 'NOBODY' }));
  host.close('ghost');

  host.message('c1', JSON.stringify({ t: C2S.CREATE, name: 'STILL HERE' }));
  assert.ok(wire.last('c1', S2C.WELCOME), 'the connection still works');
  host.shutdown();
});

test('a phone dropping off is removed from the crew', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  phone(host, wire, 'c2', C2S.JOIN, { code, name: 'BO' });
  wire.clear();

  host.close('c2');

  assert.deepEqual(wire.last('c1', S2C.LOBBY).players.map((p) => p.name), ['ADA']);
  assert.equal(host.status().connections, 1);
  host.shutdown();
});

test('opening the same id twice does not double-seat a player', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  host.open('c1');
  host.open('c1');
  host.message('c1', JSON.stringify({ t: C2S.CREATE, name: 'ADA' }));

  assert.equal(wire.to('c1', S2C.WELCOME).length, 1);
  assert.equal(host.status().connections, 1);
  host.shutdown();
});

test('instructions start flowing after the countdown', async () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  phone(host, wire, 'c2', C2S.JOIN, { code, name: 'BO' });
  host.message('c2', JSON.stringify({ t: C2S.READY, ready: true }));
  host.message('c1', JSON.stringify({ t: C2S.START }));

  const panels = ['c1', 'c2'].map((id) => wire.last(id, S2C.PANEL));
  const everyLabel = panels.flatMap((p) => p.controls.map((c) => c.label.toUpperCase()));

  // The room's own tick loop drives this, on real timers, past a 3.5s countdown.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(wire.last('c1', S2C.INSTRUCTION) && wire.last('c2', S2C.INSTRUCTION))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  for (const id of ['c1', 'c2']) {
    const instruction = wire.last(id, S2C.INSTRUCTION);
    assert.ok(instruction, `${id} never got an instruction`);
    assert.ok(
      everyLabel.some((label) => instruction.text.includes(label)),
      `"${instruction.text}" names no gizmo on the ship`,
    );
  }

  host.shutdown();
});

test('shutdown stops the ticking so the phone can sleep', async () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  phone(host, wire, 'c2', C2S.JOIN, { code, name: 'BO' });
  host.message('c2', JSON.stringify({ t: C2S.READY, ready: true }));
  host.message('c1', JSON.stringify({ t: C2S.START }));

  host.shutdown();
  wire.clear();
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(wire.frames.length, 0, 'a shut-down host must go quiet');
  assert.equal(host.status().connections, 0);
});

test('the host advertises itself and its crew for /discover', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  host.startStatusUpdates(50);

  const status = wire.statuses[wire.statuses.length - 1];
  assert.equal(status.app, 'sociovia', 'the marker the sweep matches on');
  assert.equal(status.host, 'ADA-PHONE', 'taken from the native side');
  assert.equal(status.players, 1);
  assert.equal(status.rooms, 1);
  // The code is the only thing keeping strangers on the same WiFi out, so it
  // must not be advertised to anyone sweeping the network.
  assert.equal('codes' in status, false, 'room codes must not be broadcast');
  assert.equal(JSON.stringify(status).includes(code), false, 'no code anywhere in the payload');

  host.shutdown();
});

test('status updates stop when the host shuts down', async () => {
  const wire = fakeNative();
  const host = createHost(wire.native);
  host.startStatusUpdates(20);
  host.shutdown();

  const before = wire.statuses.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(wire.statuses.length, before, 'a shut-down host must stop advertising');
});

test('a native side without status support is tolerated', () => {
  // The Node-side test adapter has no status()/hostName(); pushing must not throw.
  const host = createHost({ send: () => {}, close: () => {} });
  host.startStatusUpdates(50);
  host.shutdown();
});

test('an external tick keeps the game moving when JS timers are throttled', async () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  const { code } = phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  phone(host, wire, 'c2', C2S.JOIN, { code, name: 'BO' });
  host.message('c2', JSON.stringify({ t: C2S.READY, ready: true }));
  host.message('c1', JSON.stringify({ t: C2S.START }));

  // Simulate the WebView's own timers being starved: stop every room's
  // interval, leaving the native tick as the only thing driving the game.
  const room = [...host.rooms.rooms.values()][0];
  room.stopTimer();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && !wire.last('c1', S2C.INSTRUCTION)) {
    host.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(wire.last('c1', S2C.INSTRUCTION), 'the external tick must get past the countdown');
  assert.equal(room.game.phase, PHASE.PLAYING);
  host.shutdown();
});

test('ticking is safe before a game starts and after it ends', () => {
  const wire = fakeNative();
  const host = createHost(wire.native);

  host.tick(); // no rooms at all
  phone(host, wire, 'c1', C2S.CREATE, { name: 'ADA' });
  host.tick(); // a room, but still in the lobby
  assert.equal(host.status().rooms, 1);

  host.shutdown();
  host.tick(); // after shutdown
});
