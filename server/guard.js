/**
 * Abuse limits for a publicly reachable server.
 *
 * On a LAN none of this matters: everybody who can reach the port is already in
 * your living room. Exposed to the internet the picture changes — a room code
 * is the only thing protecting a game, and anybody can open sockets and create
 * rooms for free. This caps both and slows code-guessing to a crawl.
 *
 * Pure bookkeeping over an injectable clock, so it can be tested without
 * sockets or sleeping.
 */

export const GUARD_DEFAULTS = {
  /** Total sockets the process will hold. */
  maxConnections: 400,
  /**
   * Sockets from one address. Generous on purpose: a whole crew can share one
   * NAT, and two crews in the same office should not lock each other out. It
   * is still a cap of dozens rather than thousands.
   */
  maxPerAddress: 24,
  /**
   * Wrong room codes tolerated per address before it is made to wait.
   *
   * Codes are four characters from a 32-character alphabet — about a million
   * combinations — and they are the only thing keeping a stranger out of a
   * game. The number that matters is not how long sweeping every code takes
   * but how long it takes to stumble into *any* live one, which is far
   * shorter when a handful of rooms are up.
   *
   * At 8 misses per minute and a ten-minute cooldown, one address gets ~1150
   * tries a day: centuries to sweep the space, and months to blunder into one
   * of a dozen live games. A human who mistypes a code needs eight goes inside
   * a minute to notice this at all.
   *
   * This is what buys a code short enough to shout across a room. A distributed
   * attacker scales it down linearly, which is why the docs are honest that the
   * stake here is a stranger in your party game, not your data.
   */
  failedJoinLimit: 8,
  failedJoinWindowMs: 60_000,
  failedJoinBlockMs: 600_000,
};

/**
 * The address a request really came from.
 *
 * Behind a proxy the socket address is the proxy's, so the forwarded headers
 * are the only way to tell clients apart — but they are trivially spoofed by a
 * direct client, so they are trusted only when the deployment says there is a
 * proxy in front.
 */
export function clientAddress(request, { trustProxy = false } = {}) {
  const socketAddress = request?.socket?.remoteAddress ?? 'unknown';
  if (!trustProxy) return socketAddress;

  const headers = request?.headers ?? {};
  // Fly sets this itself and strips any client-supplied copy.
  const flyClientIp = headers['fly-client-ip'];
  if (typeof flyClientIp === 'string' && flyClientIp.trim()) return flyClientIp.trim();

  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    // Left-most entry is the original client; the rest are hops.
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return socketAddress;
}

export class ConnectionGuard {
  constructor(options = {}) {
    this.limits = { ...GUARD_DEFAULTS, ...options };
    this.now = options.now ?? (() => Date.now());

    this.total = 0;
    /** address -> open socket count */
    this.perAddress = new Map();
    /** address -> { times: number[], blockedUntil: number } */
    this.failures = new Map();
  }

  /** Let a new socket in, or say why not. */
  admit(address) {
    if (this.total >= this.limits.maxConnections) {
      return { error: 'This server is full. Try again in a minute.' };
    }
    const open = this.perAddress.get(address) ?? 0;
    if (open >= this.limits.maxPerAddress) {
      return { error: 'Too many connections from your network.' };
    }

    this.total++;
    this.perAddress.set(address, open + 1);
    return { ok: true };
  }

  /** A socket closed. */
  release(address) {
    this.total = Math.max(0, this.total - 1);
    const open = this.perAddress.get(address);
    if (open === undefined) return;
    if (open <= 1) this.perAddress.delete(address);
    else this.perAddress.set(address, open - 1);
  }

  /** False while an address is serving a cooldown for guessing codes. */
  allowJoin(address) {
    const record = this.failures.get(address);
    if (!record) return true;
    if (record.blockedUntil > this.now()) return false;

    if (record.blockedUntil) {
      // Cooldown served; start again with a clean slate.
      this.failures.delete(address);
    }
    return true;
  }

  /** How long an address must wait, in whole seconds. */
  retryAfterSeconds(address) {
    const record = this.failures.get(address);
    if (!record) return 0;
    return Math.max(0, Math.ceil((record.blockedUntil - this.now()) / 1000));
  }

  /** Record a join that named a room that does not exist. */
  noteJoinFailure(address) {
    const now = this.now();
    const record = this.failures.get(address) ?? { times: [], blockedUntil: 0 };

    record.times = record.times.filter((at) => now - at < this.limits.failedJoinWindowMs);
    record.times.push(now);

    if (record.times.length >= this.limits.failedJoinLimit) {
      record.blockedUntil = now + this.limits.failedJoinBlockMs;
      record.times = [];
    }
    this.failures.set(address, record);
  }

  /** A correct code clears the suspicion. */
  noteJoinSuccess(address) {
    this.failures.delete(address);
  }

  /** Drop expired bookkeeping so a long-running server does not grow forever. */
  sweep() {
    const now = this.now();
    for (const [address, record] of this.failures) {
      const stale = record.times.every((at) => now - at >= this.limits.failedJoinWindowMs);
      if (stale && record.blockedUntil <= now) this.failures.delete(address);
    }
  }

  status() {
    return { connections: this.total, addresses: this.perAddress.size, watched: this.failures.size };
  }
}
