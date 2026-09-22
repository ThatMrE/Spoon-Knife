/**
 * Runs the game on the hosting phone.
 *
 * The split is deliberate: native Java owns the listening socket, the RFC 6455
 * framing and serving the client assets, while this module owns the game — by
 * importing the very same `core/` modules the Node server uses. There is one
 * implementation of the rules, not one per platform.
 *
 * The contract with the native side is four calls each way:
 *
 *   native → JS   spaceteamHost.open(id) / .message(id, text) / .close(id)
 *   JS → native   native.send(id, text) / native.close(id)
 *
 * `id` is an opaque per-connection string minted by the native side. Nothing
 * else crosses the boundary, which is what keeps the untestable half small.
 */
// Relative on purpose: this resolves to /core/rooms.js in the WebView *and*
// to core/rooms.js on disk, so the tests exercise the real module graph.
import { RoomManager } from '../../core/rooms.js';

/**
 * Presents a native connection id with the small slice of interface that
 * RoomManager expects from a socket: `on('message')`, `on('close')`, `send()`.
 */
class NativeConnection {
  constructor(id, native) {
    this.id = id;
    this.native = native;
    this.closed = false;
    this.handlers = new Map();
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event, argument) {
    const handler = this.handlers.get(event);
    if (handler) handler(argument);
  }

  /** RoomManager passes objects; the wire carries text. */
  send(value) {
    if (this.closed) return;
    this.native.send(this.id, typeof value === 'string' ? value : JSON.stringify(value));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.native.close(this.id);
  }
}

/**
 * Wire a RoomManager up to a native transport.
 * Exported (rather than run on import) so it can be driven by a test double.
 */
export function createHost(native) {
  const rooms = new RoomManager();
  const connections = new Map();
  let statusTimer = null;

  return {
    /** A phone connected. */
    open(id) {
      if (connections.has(id)) return;
      const connection = new NativeConnection(id, native);
      connections.set(id, connection);
      rooms.attach(connection);
    },

    /** One decoded text frame from a phone. */
    message(id, text) {
      const connection = connections.get(id);
      if (connection) connection.emit('message', text);
    },

    /** A phone went away: its socket closed, or the native side gave up on it. */
    close(id) {
      const connection = connections.get(id);
      if (!connection) return;
      connections.delete(id);
      connection.closed = true;
      connection.emit('close');
    },

    /** Diagnostics for the host's own screen. */
    status() {
      const roomList = [...rooms.rooms.values()];
      return {
        connections: connections.size,
        rooms: roomList.length,
        players: roomList.reduce((total, room) => total + room.players.size, 0),
        codes: roomList.filter((room) => !room.isEmpty).map((room) => room.code),
      };
    },

    /** Stop every room's tick loop; used when the host leaves the screen. */
    shutdown() {
      this.stopStatusUpdates();
      for (const room of rooms.rooms.values()) room.stopTimer();
      clearInterval(rooms.sweeper);
      for (const id of [...connections.keys()]) this.close(id);
    },

    /**
     * Keep the native side's /discover payload current, so joining phones see
     * this ship and its crew count while sweeping the network.
     */
    startStatusUpdates(everyMs = 2000) {
      if (statusTimer !== null) return;
      const push = () => {
        if (typeof native.status !== 'function') return;
        const name = typeof native.hostName === 'function' ? native.hostName() : 'phone';
        const { rooms: roomCount, players } = this.status();
        // Deliberately not the room codes: the code is the only thing keeping a
        // passer-by on the same WiFi out of your game, so it is not broadcast
        // to anyone who sweeps the network.
        native.status(JSON.stringify({ app: 'spaceteam-lan', host: name, rooms: roomCount, players }));
      };
      push();
      statusTimer = setInterval(push, everyMs);
    },

    stopStatusUpdates() {
      if (statusTimer === null) return;
      clearInterval(statusTimer);
      statusTimer = null;
    },

    /** Test seam. */
    rooms,
  };
}

// In the hosting WebView the native object is injected before this page loads.
if (typeof window !== 'undefined' && window.SpaceteamNative) {
  window.spaceteamHost = createHost(window.SpaceteamNative);
  window.spaceteamHost.startStatusUpdates();
  window.SpaceteamNative.hostReady();
}
