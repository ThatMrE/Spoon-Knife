import { strict as assert } from 'node:assert';
import test from 'node:test';

import { acceptKey, readFrame } from '../server/ws.js';

/** Build a client-style (masked) frame the way a browser would. */
function clientFrame(payload, { opcode = 0x1, fin = true } = {}) {
  const body = Buffer.from(payload, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);

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

test('the handshake accept value matches the RFC 6455 example', () => {
  // From RFC 6455 §1.3.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a short masked text frame round-trips', () => {
  const frame = readFrame(clientFrame('{"t":"ready"}'));
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.fin, true);
  assert.equal(frame.payload.toString('utf8'), '{"t":"ready"}');
});

test('extended payload lengths are decoded', () => {
  // 16-bit length path
  const medium = 'x'.repeat(500);
  assert.equal(readFrame(clientFrame(medium)).payload.toString(), medium);

  // still 16-bit, but near the cap we accept
  const large = 'y'.repeat(60_000);
  assert.equal(readFrame(clientFrame(large)).payload.toString(), large);
});

test('payloads past the cap are refused rather than buffered', () => {
  const huge = 'z'.repeat(70_000);
  assert.equal(typeof readFrame(clientFrame(huge)), 'symbol');
});

test('a partial frame asks for more bytes instead of guessing', () => {
  const frame = clientFrame('hello world');
  for (let cut = 0; cut < frame.length; cut++) {
    assert.equal(readFrame(frame.subarray(0, cut)), null, `should need more at ${cut} bytes`);
  }
  assert.ok(readFrame(frame));
});

test('several frames arriving in one TCP read are parsed in order', () => {
  const buffer = Buffer.concat([clientFrame('one'), clientFrame('two'), clientFrame('three')]);
  const seen = [];
  let rest = buffer;
  let frame;
  while ((frame = readFrame(rest))) {
    seen.push(frame.payload.toString());
    rest = rest.subarray(frame.consumed);
  }
  assert.deepEqual(seen, ['one', 'two', 'three']);
  assert.equal(rest.length, 0);
});

test('non-ASCII payloads survive the mask', () => {
  const text = '☄️ ASTEROIDS — EVERYBODY SHAKE! 🚀';
  assert.equal(readFrame(clientFrame(text)).payload.toString('utf8'), text);
});

test('a client claiming an enormous payload is rejected, not allocated', () => {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(2n ** 40n, 2);
  const result = readFrame(header);
  assert.ok(result && result !== null && typeof result === 'symbol');
});

test('fragmented messages report their continuation opcode', () => {
  const first = readFrame(clientFrame('half ', { fin: false }));
  assert.equal(first.fin, false);
  assert.equal(first.opcode, 0x1);

  const second = readFrame(clientFrame('a message', { opcode: 0x0 }));
  assert.equal(second.fin, true);
  assert.equal(second.opcode, 0x0);
});
