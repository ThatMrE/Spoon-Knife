package io.github.thatmre.sociovia;

import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

/**
 * RFC 6455 framing for the hosting phone: a faithful port of {@code
 * server/ws.js}, deliberately written against nothing but the JDK so it can be
 * unit-tested on a plain JVM with no device or emulator.
 *
 * Clients are always browsers, so we only decode masked frames and only encode
 * unmasked ones.
 */
public final class WebSocketFrames {

  /** RFC 6455 §1.3. Getting a character of this wrong means no browser connects. */
  static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

  public static final int OP_CONTINUATION = 0x0;
  public static final int OP_TEXT = 0x1;
  public static final int OP_BINARY = 0x2;
  public static final int OP_CLOSE = 0x8;
  public static final int OP_PING = 0x9;
  public static final int OP_PONG = 0xa;

  /** Nothing this game sends or receives comes close to this. */
  public static final int MAX_MESSAGE_BYTES = 64 * 1024;

  private WebSocketFrames() {}

  /** Thrown when a peer describes a frame we refuse to buffer. */
  public static final class TooLargeException extends Exception {
    public TooLargeException(String message) {
      super(message);
    }
  }

  /** One decoded frame, plus how many bytes of the buffer it consumed. */
  public static final class Frame {
    public final boolean fin;
    public final int opcode;
    public final byte[] payload;
    public final int consumed;

    Frame(boolean fin, int opcode, byte[] payload, int consumed) {
      this.fin = fin;
      this.opcode = opcode;
      this.payload = payload;
      this.consumed = consumed;
    }

    public String text() {
      return new String(payload, StandardCharsets.UTF_8);
    }
  }

  /** The {@code Sec-WebSocket-Accept} value for a client's key. */
  public static String acceptKey(String clientKey) {
    try {
      MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
      byte[] digest = sha1.digest((clientKey + GUID).getBytes(StandardCharsets.US_ASCII));
      return Base64.getEncoder().encodeToString(digest);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-1 is required by RFC 6455", e);
    }
  }

  /**
   * Decode one frame from the front of {@code buffer}.
   *
   * @return the frame, or null when more bytes are needed
   * @throws TooLargeException when the peer claims a payload we will not buffer
   */
  public static Frame decode(byte[] buffer, int length) throws TooLargeException {
    if (length < 2) return null;

    boolean fin = (buffer[0] & 0x80) != 0;
    int opcode = buffer[0] & 0x0f;
    boolean masked = (buffer[1] & 0x80) != 0;
    long payloadLength = buffer[1] & 0x7f;
    int offset = 2;

    if (payloadLength == 126) {
      if (length < offset + 2) return null;
      payloadLength = ((buffer[offset] & 0xffL) << 8) | (buffer[offset + 1] & 0xffL);
      offset += 2;
    } else if (payloadLength == 127) {
      if (length < offset + 8) return null;
      payloadLength = 0;
      for (int i = 0; i < 8; i++) {
        payloadLength = (payloadLength << 8) | (buffer[offset + i] & 0xffL);
      }
      offset += 8;
    }
    if (payloadLength > MAX_MESSAGE_BYTES) {
      throw new TooLargeException("payload of " + payloadLength + " bytes refused");
    }

    byte[] mask = null;
    if (masked) {
      if (length < offset + 4) return null;
      mask = new byte[4];
      System.arraycopy(buffer, offset, mask, 0, 4);
      offset += 4;
    }

    int size = (int) payloadLength;
    if (length < offset + size) return null;

    byte[] payload = new byte[size];
    System.arraycopy(buffer, offset, payload, 0, size);
    if (mask != null) {
      for (int i = 0; i < size; i++) payload[i] ^= mask[i & 3];
    }
    return new Frame(fin, opcode, payload, offset + size);
  }

  /** A single unmasked frame carrying {@code text}. */
  public static byte[] encodeText(String text) {
    return encode(OP_TEXT, text.getBytes(StandardCharsets.UTF_8));
  }

  public static byte[] encodePong(byte[] payload) {
    return encode(OP_PONG, payload);
  }

  public static byte[] encodePing() {
    return encode(OP_PING, new byte[0]);
  }

  public static byte[] encodeClose(int code, String reason) {
    byte[] reasonBytes = reason.getBytes(StandardCharsets.UTF_8);
    byte[] payload = new byte[2 + reasonBytes.length];
    payload[0] = (byte) ((code >> 8) & 0xff);
    payload[1] = (byte) (code & 0xff);
    System.arraycopy(reasonBytes, 0, payload, 2, reasonBytes.length);
    return encode(OP_CLOSE, payload);
  }

  static byte[] encode(int opcode, byte[] payload) {
    int length = payload.length;
    byte[] header;
    if (length < 126) {
      header = new byte[2];
      header[1] = (byte) length;
    } else if (length < 65536) {
      header = new byte[4];
      header[1] = 126;
      header[2] = (byte) ((length >> 8) & 0xff);
      header[3] = (byte) (length & 0xff);
    } else {
      header = new byte[10];
      header[1] = 127;
      for (int i = 0; i < 8; i++) {
        header[2 + i] = (byte) ((((long) length) >> (8 * (7 - i))) & 0xff);
      }
    }
    header[0] = (byte) (0x80 | opcode); // FIN, no extensions

    byte[] frame = new byte[header.length + length];
    System.arraycopy(header, 0, frame, 0, header.length);
    System.arraycopy(payload, 0, frame, header.length, length);
    return frame;
  }
}
