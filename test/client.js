/**
 * A minimal WebSocket client for integration tests.
 *
 * Deliberately hand-rolled rather than reusing server/ws.js: a test that
 * speaks the wire format independently is what catches a server that frames
 * or hashes things wrong. (The handshake GUID was wrong once; nothing but a
 * real client noticed.)
 */
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Mask and frame a text payload the way a browser would.
 * `opcode` and `fin` are exposed so tests can build control frames and
 * fragmented messages, not just whole text ones.
 */
export function encodeClientFrame(text, { opcode = 0x1, fin = true } = {}) {
  const body = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);

  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;

  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Pull one server frame (unmasked) off the front of a buffer. */
function decodeServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  if ((buffer[1] & 0x80) !== 0) throw new Error('server must not mask its frames');

  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return { fin, opcode, payload: buffer.subarray(offset, offset + length), consumed: offset + length };
}

export class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.received = [];
    this.waiters = [];
    this._buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      let frame;
      while ((frame = decodeServerFrame(this._buffer))) {
        this._buffer = this._buffer.subarray(frame.consumed);
        if (frame.opcode !== 0x1) continue; // ignore ping/pong/close here
        const message = JSON.parse(frame.payload.toString('utf8'));
        this.received.push(message);
        for (const waiter of this.waiters.splice(0)) waiter();
      }
    });
  }

  /** Open a connection and complete the handshake, verifying the accept header. */
  static connect(port) {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      const socket = net.connect(port, '127.0.0.1');
      let head = '';

      const onData = (chunk) => {
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        socket.off('data', onData);

        const [rawHeaders, ...rest] = head.split('\r\n\r\n');
        const lines = rawHeaders.split('\r\n');
        if (!/^HTTP\/1\.1 101 /.test(lines[0])) {
          reject(new Error(`handshake refused: ${lines[0]}`));
          return;
        }
        const accept = lines
          .map((line) => line.match(/^sec-websocket-accept:\s*(.+)$/i))
          .find(Boolean)?.[1]
          .trim();
        if (accept !== expected) {
          reject(new Error(`bad Sec-WebSocket-Accept: got ${accept}, expected ${expected}`));
          return;
        }

        const client = new TestClient(socket);
        // Anything the server already sent after the headers still counts.
        const tail = rest.join('\r\n\r\n');
        if (tail.length) socket.emit('data', Buffer.from(tail, 'latin1'));
        resolve(client);
      };

      socket.on('data', onData);
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
    });
  }

  send(type, payload = {}) {
    this.socket.write(encodeClientFrame(JSON.stringify({ t: type, ...payload })));
  }

  /** Raw bytes, for testing how the server handles nonsense. */
  sendRaw(text) {
    this.socket.write(encodeClientFrame(text));
  }

  /**
   * Resolve with the first message of `type`, waiting for it if necessary.
   * The window is generous because a shared CI runner can stall, and the
   * game deliberately holds a 3.5s countdown before issuing instructions.
   */
  async waitFor(type, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find((m) => m.t === type);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `timed out waiting for "${type}"; saw: ${this.received.map((m) => m.t).join(', ') || '(nothing)'}`,
        );
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 100));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  all(type) {
    return this.received.filter((m) => m.t === type);
  }

  close() {
    this.socket.destroy();
  }

  /**
   * Close the way a browser tab does: send FIN and leave the socket half-open.
   * This is the case that used to leave a ghost crewmate aboard.
   */
  closeGracefully() {
    this.socket.end();
  }
}
