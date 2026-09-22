package io.github.thatmre.spaceteamlan;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Turns a byte stream into WebSocket events: the read half of {@code
 * server/ws.js}, handling fragmentation, control frames and the size cap.
 *
 * It reports control frames rather than acting on them, so the whole thing is
 * pure logic over an InputStream and can be tested from a byte array.
 */
public final class WebSocketReader {

  public enum Kind { TEXT, PING, PONG, CLOSE, EOF }

  /** One thing that happened on the wire. */
  public static final class Event {
    public final Kind kind;
    public final String text;
    public final byte[] payload;

    Event(Kind kind, String text, byte[] payload) {
      this.kind = kind;
      this.text = text;
      this.payload = payload;
    }
  }

  private static final Event EOF = new Event(Kind.EOF, null, null);
  private static final Event CLOSE = new Event(Kind.CLOSE, null, null);
  private static final int HEADER_SLACK = 16;

  private final InputStream in;
  private byte[] buffer = new byte[8192];
  private int length = 0;

  private final ByteArrayOutputStream fragments = new ByteArrayOutputStream();
  private int fragmentOpcode = -1;

  public WebSocketReader(InputStream in) {
    this.in = in;
  }

  /**
   * The next event, blocking until one is complete.
   * Returns an EOF event once the peer stops sending.
   */
  public Event next() throws IOException, WebSocketFrames.TooLargeException {
    for (; ; ) {
      WebSocketFrames.Frame frame = WebSocketFrames.decode(buffer, length);
      if (frame == null) {
        if (!fill()) return EOF;
        continue;
      }

      // Shift the consumed bytes off the front.
      System.arraycopy(buffer, frame.consumed, buffer, 0, length - frame.consumed);
      length -= frame.consumed;

      switch (frame.opcode) {
        case WebSocketFrames.OP_PING:
          return new Event(Kind.PING, null, frame.payload);
        case WebSocketFrames.OP_PONG:
          return new Event(Kind.PONG, null, frame.payload);
        case WebSocketFrames.OP_CLOSE:
          return CLOSE;
        case WebSocketFrames.OP_TEXT:
        case WebSocketFrames.OP_BINARY:
        case WebSocketFrames.OP_CONTINUATION: {
          if (frame.opcode != WebSocketFrames.OP_CONTINUATION) {
            fragmentOpcode = frame.opcode;
            fragments.reset();
          }
          fragments.write(frame.payload, 0, frame.payload.length);
          if (fragments.size() > WebSocketFrames.MAX_MESSAGE_BYTES) {
            throw new WebSocketFrames.TooLargeException("reassembled message too large");
          }
          if (!frame.fin) break;

          byte[] body = fragments.toByteArray();
          fragments.reset();
          int completed = fragmentOpcode;
          fragmentOpcode = -1;
          // Binary is never used by this game; drop it and keep reading.
          if (completed == WebSocketFrames.OP_TEXT) {
            return new Event(Kind.TEXT, new String(body, java.nio.charset.StandardCharsets.UTF_8), body);
          }
          break;
        }
        default:
          throw new IOException("unsupported opcode " + frame.opcode);
      }
    }
  }

  /** Read more bytes. Returns false at end of stream. */
  private boolean fill() throws IOException {
    if (length == buffer.length) {
      int max = WebSocketFrames.MAX_MESSAGE_BYTES + HEADER_SLACK;
      if (buffer.length >= max) {
        // A frame header promising more than the cap is rejected by decode(),
        // so reaching here means the peer is dribbling an oversized frame.
        throw new IOException("read buffer full");
      }
      byte[] bigger = new byte[Math.min(buffer.length * 2, max)];
      System.arraycopy(buffer, 0, bigger, 0, length);
      buffer = bigger;
    }
    int read = in.read(buffer, length, buffer.length - length);
    if (read == -1) return false;
    length += read;
    return true;
  }
}
