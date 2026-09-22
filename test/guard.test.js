/**
 * Abuse limits for a publicly reachable server.
 *
 * These matter only once the port is on the internet: on a LAN, everyone who
 * can reach it is already in the room. The clock is injected so the rate limit
 * can be tested without waiting.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ConnectionGuard, GUARD_DEFAULTS, clientAddress } from '../server/guard.js';

/** A guard on a clock we control. */
function guardAt(options = {}) {
  const clock = { now: 1_000_000 };
  const guard = new ConnectionGuard({ ...options, now: () => clock.now });
  return { guard, clock };
}

test('connections are admitted until the total cap', () => {
  const { guard } = guardAt({ maxConnections: 3 });

  for (let i = 0; i < 3; i++) {
    assert.equal(guard.admit(`10.0.0.${i}`).ok, true, `connection ${i}`);
  }
  const refused = guard.admit('10.0.0.9');
  assert.equal(refused.ok, undefined);
  assert.match(refused.error, /full/i);
});

test('one address cannot hog the server', () => {
  const { guard } = guardAt({ maxPerAddress: 2 });

  assert.equal(guard.admit('203.0.113.7').ok, true);
  assert.equal(guard.admit('203.0.113.7').ok, true);
  assert.match(guard.admit('203.0.113.7').error, /too many connections/i);

  // A different address is unaffected.
  assert.equal(guard.admit('203.0.113.8').ok, true);
});

test('closing a socket frees its slot', () => {
  const { guard } = guardAt({ maxPerAddress: 1, maxConnections: 2 });

  assert.equal(guard.admit('198.51.100.4').ok, true);
  assert.ok(guard.admit('198.51.100.4').error);

  guard.release('198.51.100.4');
  assert.equal(guard.admit('198.51.100.4').ok, true);
  assert.equal(guard.status().connections, 1);
});

test('releasing more than was admitted does not go negative', () => {
  const { guard } = guardAt();
  guard.release('192.0.2.1');
  guard.release('192.0.2.1');
  assert.equal(guard.status().connections, 0);
  assert.equal(guard.status().addresses, 0);
});

test('guessing room codes earns a cooldown', () => {
  const { guard, clock } = guardAt({ failedJoinLimit: 3, failedJoinBlockMs: 60_000 });
  const attacker = '203.0.113.99';

  for (let i = 0; i < 2; i++) {
    guard.noteJoinFailure(attacker);
    assert.equal(guard.allowJoin(attacker), true, `still allowed after ${i + 1} misses`);
  }

  guard.noteJoinFailure(attacker);
  assert.equal(guard.allowJoin(attacker), false, 'the third miss trips the limit');
  assert.ok(guard.retryAfterSeconds(attacker) > 0);

  // Somebody else is not punished for it.
  assert.equal(guard.allowJoin('203.0.113.1'), true);

  clock.now += 59_000;
  assert.equal(guard.allowJoin(attacker), false, 'still waiting');
  clock.now += 2_000;
  assert.equal(guard.allowJoin(attacker), true, 'cooldown served');
  assert.equal(guard.retryAfterSeconds(attacker), 0);
});

test('misses spread out over time never trip the limit', () => {
  const { guard, clock } = guardAt({ failedJoinLimit: 3, failedJoinWindowMs: 60_000 });
  const clumsy = '198.51.100.20';

  // Someone mistyping a code once in a while is not an attacker.
  for (let i = 0; i < 20; i++) {
    guard.noteJoinFailure(clumsy);
    assert.equal(guard.allowJoin(clumsy), true, `miss ${i + 1} should be forgiven`);
    clock.now += 61_000;
  }
});

test('getting a code right clears the suspicion', () => {
  const { guard } = guardAt({ failedJoinLimit: 3 });
  const player = '198.51.100.30';

  guard.noteJoinFailure(player);
  guard.noteJoinFailure(player);
  guard.noteJoinSuccess(player);

  // The earlier fumbles are forgotten, so two more do not trip the limit.
  guard.noteJoinFailure(player);
  guard.noteJoinFailure(player);
  assert.equal(guard.allowJoin(player), true);
});

test('bookkeeping is swept so a long-running server does not grow', () => {
  const { guard, clock } = guardAt({ failedJoinWindowMs: 60_000, failedJoinLimit: 50 });

  for (let i = 0; i < 25; i++) guard.noteJoinFailure(`203.0.113.${i}`);
  assert.equal(guard.status().watched, 25);

  guard.sweep();
  assert.equal(guard.status().watched, 25, 'recent misses are still interesting');

  clock.now += 120_000;
  guard.sweep();
  assert.equal(guard.status().watched, 0, 'stale ones are dropped');
});

test('a blocked address is kept until its cooldown expires', () => {
  const { guard, clock } = guardAt({ failedJoinLimit: 1, failedJoinBlockMs: 300_000 });
  guard.noteJoinFailure('203.0.113.50');

  clock.now += 120_000;
  guard.sweep();
  assert.equal(guard.allowJoin('203.0.113.50'), false, 'sweeping must not pardon a block');
});

test('the defaults are a cap, not a formality', () => {
  // A regression here would quietly turn a public server into free hosting.
  assert.ok(GUARD_DEFAULTS.maxConnections > 0 && GUARD_DEFAULTS.maxConnections <= 2000);
  assert.ok(GUARD_DEFAULTS.maxPerAddress > 0 && GUARD_DEFAULTS.maxPerAddress <= 64);
  assert.ok(GUARD_DEFAULTS.failedJoinLimit > 0 && GUARD_DEFAULTS.failedJoinLimit <= 50);

  // Four-character codes are ~1.05M combinations, and they are the only thing
  // keeping strangers out. Sweeping the whole space must be hopeless...
  const perDay = (GUARD_DEFAULTS.failedJoinLimit / GUARD_DEFAULTS.failedJoinBlockMs) * 86_400_000;
  const daysToSweep = 32 ** 4 / perDay;
  assert.ok(daysToSweep > 365, `one address could sweep every code in ${Math.round(daysToSweep)} days`);

  // ...and, the figure that actually matters, blundering into one of a dozen
  // live games must take months rather than hours.
  const daysToHitALiveGame = 32 ** 4 / 12 / perDay;
  assert.ok(
    daysToHitALiveGame > 30,
    `one address could expect to hit a live game in ${daysToHitALiveGame.toFixed(1)} days`,
  );
});

// ───────────────────────────── client address ─────────────────────────────

test('the socket address is used when there is no proxy', () => {
  const request = { socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } };
  // Forwarded headers are trivially spoofed by a direct client, so they are
  // ignored unless the deployment says something trustworthy sets them.
  assert.equal(clientAddress(request), '203.0.113.5');
  assert.equal(clientAddress(request, { trustProxy: false }), '203.0.113.5');
});

test('behind a trusted proxy the forwarded client address wins', () => {
  const request = {
    socket: { remoteAddress: '10.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.2' },
  };
  assert.equal(clientAddress(request, { trustProxy: true }), '203.0.113.5');
});

test('Fly\'s own client header is preferred over x-forwarded-for', () => {
  const request = {
    socket: { remoteAddress: '10.0.0.1' },
    headers: { 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' },
  };
  assert.equal(clientAddress(request, { trustProxy: true }), '203.0.113.9');
});

test('a missing or malformed address degrades to something usable', () => {
  assert.equal(clientAddress(undefined), 'unknown');
  assert.equal(clientAddress({}), 'unknown');
  assert.equal(
    clientAddress({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '  ' } }, { trustProxy: true }),
    '10.0.0.1',
  );
});
