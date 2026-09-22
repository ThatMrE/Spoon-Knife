/**
 * A transport that plays the game inside this one page, with no server.
 *
 * `core/` has no Node APIs and `host/bridge.js` already runs the rules in a
 * browser for the Android host, so a single tab can be both server and client.
 * That is what makes a practice game work on a static host like Netlify, where
 * there is nothing to open a WebSocket to.
 *
 * It presents the same surface as `Net`, so the client code cannot tell the
 * difference.
 */
import { createHost } from '/host/bridge.js';

/** Matches the room tick in core/rooms.js. */
const TICK_MS = 200;

export class Loopback {
  constructor() {
    this.handlers = new Map();
    this.onDown = () => {};
    this.host = null;
    this.ticker = null;
    this.id = 'solo';
  }

  get isOpen() {
    return this.host !== null;
  }

  connect() {
    this.host = createHost({
      send: (_id, text) => {
        const message = JSON.parse(text);
        // Deliver asynchronously, so a handler can never re-enter the engine
        // mid-update the way a real socket never would.
        queueMicrotask(() => this.handlers.get(message.t)?.(message));
      },
      close: () => this.stop(),
    });
    this.host.open(this.id);
    // The rooms drive themselves, but ticking here too keeps a backgrounded
    // tab honest, exactly as the Android host does.
    this.ticker = setInterval(() => this.host?.tick(), TICK_MS);
    return Promise.resolve();
  }

  on(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  send(type, payload = {}) {
    this.host?.message(this.id, JSON.stringify({ t: type, ...payload }));
  }

  stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.host?.shutdown();
    this.host = null;
  }
}
