package io.github.thatmre.sociovia;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * The framing the hosting phone speaks. Runs on a plain JVM, which is the
 * point: this is a port of server/ws.js and the two must agree on the wire.
 */
public class WebSocketFramesTest {

  /** Build a masked frame the way a browser would. */
  private static byte[] clientFrame(String text, int opcode, boolean fin) {
    byte[] body = text.getBytes(StandardCharsets.UTF_8);
    byte[] mask = {0x12, 0x34, 0x56, 0x78};

    byte[] header;
    if (body.length < 126) {
      header = new byte[2];
      header[1] = (byte) (0x80 | body.length);
    } else if (body.length < 65536) {
      header = new byte[4];
      header[1] = (byte) (0x80 | 126);
      header[2] = (byte) ((body.length >> 8) & 0xff);
      header[3] = (byte) (body.length & 0xff);
    } else {
      header = new byte[10];
      header[1] = (byte) (0x80 | 127);
      for (int i = 0; i < 8; i++) header[2 + i] = (byte) ((((long) body.length) >> (8 * (7 - i))) & 0xff);
    }
    header[0] = (byte) ((fin ? 0x80 : 0) | opcode);

    byte[] masked = new byte[body.length];
    for (int i = 0; i < body.length; i++) masked[i] = (byte) (body[i] ^ mask[i & 3]);

    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(header, 0, header.length);
    out.write(mask, 0, 4);
    out.write(masked, 0, masked.length);
    return out.toByteArray();
  }

  private static byte[] clientFrame(String text) {
    return clientFrame(text, WebSocketFrames.OP_TEXT, true);
  }

  private static byte[] concat(byte[]... parts) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] part : parts) out.write(part, 0, part.length);
    return out.toByteArray();
  }

  @Test
  public void matchesTheRfc6455HandshakeVector() {
    // RFC 6455 §1.3. server/ws.js is pinned to the same vector; if these two
    // ever disagree, one of the hosts has stopped being connectable.
    assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        WebSocketFrames.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="));
  }

  @Test
  public void decodesAShortMaskedTextFrame() throws Exception {
    byte[] frame = clientFrame("{\"t\":\"ready\"}");
    WebSocketFrames.Frame decoded = WebSocketFrames.decode(frame, frame.length);

    assertEquals(WebSocketFrames.OP_TEXT, decoded.opcode);
    assertTrue(decoded.fin);
    assertEquals("{\"t\":\"ready\"}", decoded.text());
    assertEquals(frame.length, decoded.consumed);
  }

  @Test
  public void decodesBothExtendedLengthForms() throws Exception {
    for (int size : new int[] {200, 60000}) {
      StringBuilder text = new StringBuilder();
      for (int i = 0; i < size; i++) text.append('x');
      byte[] frame = clientFrame(text.toString());
      assertEquals(text.toString(), WebSocketFrames.decode(frame, frame.length).text());
    }
  }

  @Test
  public void asksForMoreBytesRatherThanGuessing() throws Exception {
    byte[] frame = clientFrame("hello world");
    for (int cut = 0; cut < frame.length; cut++) {
      assertNull("should need more at " + cut + " bytes", WebSocketFrames.decode(frame, cut));
    }
    assertEquals("hello world", WebSocketFrames.decode(frame, frame.length).text());
  }

  @Test
  public void refusesAnEnormousClaimedPayload() {
    byte[] header = new byte[10];
    header[0] = (byte) 0x81;
    header[1] = (byte) (0x80 | 127);
    // 2^40 bytes: allocating this is how a host gets killed.
    header[2] = 0;
    header[3] = 0;
    header[4] = 0x01;
    try {
      WebSocketFrames.decode(header, header.length);
      fail("expected the oversized payload to be refused");
    } catch (WebSocketFrames.TooLargeException expected) {
      // exactly right
    }
  }

  @Test
  public void survivesNonAsciiPayloads() throws Exception {
    String text = "\u2604\ufe0f ASTEROIDS \u2014 EVERYBODY SHAKE! \ud83d\ude80";
    byte[] frame = clientFrame(text);
    assertEquals(text, WebSocketFrames.decode(frame, frame.length).text());
  }

  @Test
  public void encodesUnmaskedFramesWithTheFinBitSet() throws Exception {
    byte[] frame = WebSocketFrames.encodeText("NICE.");

    assertEquals((byte) (0x80 | WebSocketFrames.OP_TEXT), frame[0]);
    assertEquals("server frames must not be masked", 0, frame[1] & 0x80);
    // Decode it back with the same reader a client would use.
    WebSocketFrames.Frame decoded = WebSocketFrames.decode(frame, frame.length);
    assertEquals("NICE.", decoded.text());
  }

  @Test
  public void encodesACloseFrameCarryingItsCode() throws Exception {
    byte[] frame = WebSocketFrames.encodeClose(1001, "bye");
    WebSocketFrames.Frame decoded = WebSocketFrames.decode(frame, frame.length);

    assertEquals(WebSocketFrames.OP_CLOSE, decoded.opcode);
    assertEquals(1001, ((decoded.payload[0] & 0xff) << 8) | (decoded.payload[1] & 0xff));
  }

  // ───────────────────────────── the reader ─────────────────────────────

  private static WebSocketReader readerFor(byte[] bytes) {
    return new WebSocketReader(new ByteArrayInputStream(bytes));
  }

  @Test
  public void readsSeveralFramesArrivingInOneRead() throws Exception {
    WebSocketReader reader = readerFor(concat(clientFrame("one"), clientFrame("two"), clientFrame("three")));

    assertEquals("one", reader.next().text);
    assertEquals("two", reader.next().text);
    assertEquals("three", reader.next().text);
    assertEquals(WebSocketReader.Kind.EOF, reader.next().kind);
  }

  @Test
  public void reassemblesAFragmentedMessage() throws Exception {
    WebSocketReader reader = readerFor(concat(
        clientFrame("half ", WebSocketFrames.OP_TEXT, false),
        clientFrame("a message", WebSocketFrames.OP_CONTINUATION, true)));

    WebSocketReader.Event event = reader.next();
    assertEquals(WebSocketReader.Kind.TEXT, event.kind);
    assertEquals("half a message", event.text);
  }

  @Test
  public void reportsControlFramesInsteadOfSwallowingThem() throws Exception {
    WebSocketReader reader = readerFor(concat(
        clientFrame("", WebSocketFrames.OP_PING, true),
        clientFrame("after")));

    assertEquals(WebSocketReader.Kind.PING, reader.next().kind);
    assertEquals("after", reader.next().text);
  }

  @Test
  public void reportsACloseFrame() throws Exception {
    WebSocketReader reader = readerFor(clientFrame("", WebSocketFrames.OP_CLOSE, true));
    assertEquals(WebSocketReader.Kind.CLOSE, reader.next().kind);
  }

  @Test
  public void handlesAFrameSplitAcrossReads() throws Exception {
    // A TCP read can land mid-frame; the reader must buffer rather than fail.
    final byte[] frame = clientFrame("split across reads");
    ByteArrayInputStream dribble = new ByteArrayInputStream(frame) {
      @Override
      public synchronized int read(byte[] b, int off, int len) {
        return super.read(b, off, 1); // one byte at a time
      }
    };

    WebSocketReader reader = new WebSocketReader(dribble);
    assertEquals("split across reads", reader.next().text);
  }

  @Test
  public void anEmptyTextFrameIsStillAMessage() throws Exception {
    WebSocketReader reader = readerFor(clientFrame(""));
    WebSocketReader.Event event = reader.next();
    assertEquals(WebSocketReader.Kind.TEXT, event.kind);
    assertEquals("", event.text);
  }

  @Test
  public void ignoresBinaryFramesAndKeepsReading() throws Exception {
    WebSocketReader reader = readerFor(concat(
        clientFrame("ignored", WebSocketFrames.OP_BINARY, true),
        clientFrame("wanted")));
    assertEquals("wanted", reader.next().text);
  }

  @Test
  public void endsCleanlyOnAnEmptyStream() throws Exception {
    assertEquals(WebSocketReader.Kind.EOF, readerFor(new byte[0]).next().kind);
  }
}
