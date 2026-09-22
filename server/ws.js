/**
 * A small RFC 6455 WebSocket server, just enough for this game.
 *
 * Clients are always browsers, so we only have to *read* masked frames and
 * *write* unmasked ones, and we only care about text, ping/pong and close.
 * Keeping it here means the whole game runs on a bare `node server/index.js`.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const MAX_MESSAGE_BYTES = 64 * 1024; // nothing we send or receive is remotely this big
const HEARTBEAT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 50_000;

/**
 * One connected client. Emits 'message' (string) and 'close'.
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.lastSeen = Date.now();
    /** Scratch space for anything the app wants to hang off a connection. */
    this.data = {};

    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this.terminate());
    socket.on('close', () => this._finish());
    // An upgraded socket stays half-open when the peer sends FIN: 'end' fires
    // but 'close' never does, so without this a phone that simply closes its
    // browser tab would sit in the crew until the heartbeat noticed, holding a
    // console that instructions keep pointing at.
    socket.on('end', () => this.terminate());
  }

  send(value) {
    if (this.closed) return;
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    this._writeFrame(OP.TEXT, Buffer.from(payload, 'utf8'));
  }

  ping() {
    if (this.closed) return;
    this._writeFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBytes = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this._writeFrame(OP.CLOSE, payload);
    // Give the close frame a moment to flush, then drop the socket either way.
    this.socket.end();
    setTimeout(() => this.terminate(), 1000).unref?.();
  }

  terminate() {
    if (this.closed) return;
    this.socket.destroy();
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode, no extensions
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.terminate();
    }
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    // A single TCP read can carry several frames, or part of one.
    while (!this.closed) {
      const frame = readFrame(this._buffer);
      if (frame === null) break;
      if (frame === OVERSIZED) {
        this.close(1009, 'message too large');
        return;
      }
      this._buffer = this._buffer.subarray(frame.consumed);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case OP.PING:
        this._writeFrame(OP.PONG, frame.payload);
        break;
      case OP.PONG:
        break; // lastSeen was already refreshed
      case OP.CLOSE:
        this.close(1000, '');
        break;
      case OP.TEXT:
      case OP.BINARY:
      case OP.CONTINUATION: {
        if (frame.opcode !== OP.CONTINUATION) {
          this._fragmentOp = frame.opcode;
          this._fragments = [];
        }
        this._fragments.push(frame.payload);
        const total = this._fragments.reduce((n, b) => n + b.length, 0);
        if (total > MAX_MESSAGE_BYTES) {
          this.close(1009, 'message too large');
          return;
        }
        if (!frame.fin) break;
        const body = Buffer.concat(this._fragments);
        this._fragments = [];
        if (this._fragmentOp === OP.TEXT) this.emit('message', body.toString('utf8'));
        this._fragmentOp = null;
        break;
      }
      default:
        this.close(1002, 'unsupported opcode');
    }
  }
}

const OVERSIZED = Symbol('oversized');

/**
 * Parse one frame off the front of `buffer`.
 * Returns null if more bytes are needed, or OVERSIZED if the client is lying to us.
 * Exported for tests.
 */
export function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return OVERSIZED;
    length = Number(big);
    offset += 8;
  }
  if (length > MAX_MESSAGE_BYTES) return OVERSIZED;

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { fin, opcode, payload, consumed: offset + length };
}

/** The `Sec-WebSocket-Accept` value for a given client key. Exported for tests. */
export function acceptKey(clientKey) {
  return createHash('sha1').update(clientKey + GUID).digest('base64');
}

/**
 * Upgrade matching HTTP requests on `httpServer` into WebSocketConnections.
 * `onConnection(connection, request)` is called once per client.
 */
export function attachWebSocketServer(httpServer, { path = '/ws', onConnection }) {
  const connections = new Set();

  httpServer.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const connection = new WebSocketConnection(socket);
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    onConnection(connection, req);
  });

  // Drop clients whose phone went to sleep or wandered off the WiFi.
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (Date.now() - connection.lastSeen > HEARTBEAT_TIMEOUT_MS) connection.terminate();
      else connection.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  httpServer.on('close', () => clearInterval(heartbeat));
  return connections;
}
