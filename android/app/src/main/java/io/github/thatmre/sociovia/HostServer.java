package io.github.thatmre.sociovia;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The listening half of a phone-hosted game: serves the bundled web client over
 * HTTP and upgrades {@code /ws} to a WebSocket.
 *
 * It knows nothing about the game. Decoded text frames go out through
 * {@link Events} to the JS engine, which owns all the rules. Sockets are the
 * only thing native code is here for, because a WebView cannot listen on a
 * port.
 *
 * No Android imports: assets arrive through {@link AssetSource}, so the whole
 * class can be exercised from a plain JVM.
 */
public final class HostServer {

  /** Where the HTML, CSS, JS and game rules come from. */
  public interface AssetSource {
    /** Bytes for an asset path, or null if there is no such asset. */
    byte[] read(String path) throws IOException;
  }

  /** Connection lifecycle, reported to whoever owns the game. */
  public interface Events {
    void onOpen(String id);

    void onMessage(String id, String text);

    void onClose(String id);
  }

  private static final int READ_TIMEOUT_MS = 70_000;
  private static final int MAX_REQUEST_LINE = 8 * 1024;
  private static final int MAX_HEADER_BYTES = 32 * 1024;

  private final int requestedPort;
  private final AssetSource assets;
  private final Events events;

  private final Map<String, Connection> connections = new ConcurrentHashMap<>();
  private final AtomicLong nextId = new AtomicLong(1);
  private final AtomicBoolean running = new AtomicBoolean(false);

  private volatile ServerSocket serverSocket;
  private volatile Thread acceptThread;

  /** JSON body for /discover; the owner refreshes it as the crew changes. */
  private volatile String discoveryJson = "{\"app\":\"sociovia\"}";

  public HostServer(int port, AssetSource assets, Events events) {
    this.requestedPort = port;
    this.assets = assets;
    this.events = events;
  }

  /** Bind and start accepting. Throws if the port is unavailable. */
  public void start() throws IOException {
    if (running.getAndSet(true)) return;
    ServerSocket socket = new ServerSocket();
    socket.setReuseAddress(true);
    socket.bind(new java.net.InetSocketAddress(requestedPort));
    serverSocket = socket;

    acceptThread = new Thread(this::acceptLoop, "sociovia-accept");
    acceptThread.setDaemon(true);
    acceptThread.start();
  }

  /** The port actually bound, which matters when 0 was requested. */
  public int port() {
    ServerSocket socket = serverSocket;
    return socket == null ? -1 : socket.getLocalPort();
  }

  public void setDiscoveryJson(String json) {
    this.discoveryJson = json;
  }

  public int connectionCount() {
    return connections.size();
  }

  /** Queue a text frame for one connection. Never blocks the caller. */
  public void send(String id, String text) {
    Connection connection = connections.get(id);
    if (connection != null) connection.enqueue(text);
  }

  public void closeConnection(String id) {
    Connection connection = connections.get(id);
    if (connection != null) connection.shutdown();
  }

  /** Stop listening and drop every client. */
  public void stop() {
    if (!running.getAndSet(false)) return;
    try {
      ServerSocket socket = serverSocket;
      if (socket != null) socket.close();
    } catch (IOException ignored) {
      // Closing the listener is how the accept loop is woken up.
    }
    for (Connection connection : connections.values()) connection.shutdown();
    connections.clear();
  }

  // ─────────────────────────────── accepting ───────────────────────────────

  private void acceptLoop() {
    while (running.get()) {
      try {
        Socket socket = serverSocket.accept();
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(READ_TIMEOUT_MS);
        Thread worker = new Thread(() -> handle(socket), "sociovia-conn");
        worker.setDaemon(true);
        worker.start();
      } catch (IOException e) {
        if (running.get()) continue; // a single bad accept is not fatal
        return;
      }
    }
  }

  private void handle(Socket socket) {
    try {
      InputStream in = socket.getInputStream();
      OutputStream out = new BufferedOutputStream(socket.getOutputStream());

      String requestLine = readLine(in, MAX_REQUEST_LINE);
      if (requestLine == null) {
        socket.close();
        return;
      }

      // Headers are only needed for the upgrade handshake.
      String websocketKey = null;
      boolean wantsUpgrade = false;
      int headerBytes = 0;
      for (; ; ) {
        String header = readLine(in, MAX_REQUEST_LINE);
        if (header == null || header.isEmpty()) break;
        headerBytes += header.length();
        if (headerBytes > MAX_HEADER_BYTES) {
          socket.close();
          return;
        }
        String lower = header.toLowerCase(Locale.US);
        if (lower.startsWith("sec-websocket-key:")) {
          websocketKey = header.substring(header.indexOf(':') + 1).trim();
        } else if (lower.startsWith("upgrade:") && lower.contains("websocket")) {
          wantsUpgrade = true;
        }
      }

      String method = HttpRouting.methodFromRequestLine(requestLine);
      String path = HttpRouting.pathFromRequestLine(requestLine);
      if (path == null || method == null) {
        respond(out, 400, "text/plain; charset=utf-8", "Bad request".getBytes(StandardCharsets.UTF_8));
        socket.close();
        return;
      }
      String bare = path.split("[?#]")[0];

      if ("/ws".equals(bare)) {
        if (!wantsUpgrade || websocketKey == null) {
          respond(out, 400, "text/plain; charset=utf-8", "Expected a WebSocket upgrade".getBytes(StandardCharsets.UTF_8));
          socket.close();
          return;
        }
        upgrade(socket, in, out, websocketKey);
        return; // the reader loop owns the socket from here
      }

      if (!"GET".equals(method) && !"HEAD".equals(method)) {
        respond(out, 405, "text/plain; charset=utf-8", "Method not allowed".getBytes(StandardCharsets.UTF_8));
        socket.close();
        return;
      }

      if ("/discover".equals(bare)) {
        respond(out, 200, "application/json; charset=utf-8", discoveryJson.getBytes(StandardCharsets.UTF_8));
        socket.close();
        return;
      }

      serveAsset(out, bare);
      socket.close();
    } catch (IOException e) {
      closeQuietly(socket);
    }
  }

  private void serveAsset(OutputStream out, String urlPath) throws IOException {
    String assetPath = HttpRouting.assetPath(urlPath);
    byte[] body = assetPath == null ? null : assets.read(assetPath);
    if (body == null) {
      respond(out, 404, "text/plain; charset=utf-8", "Not found".getBytes(StandardCharsets.UTF_8));
      return;
    }
    respond(out, 200, HttpRouting.contentType(assetPath), body);
  }

  private static void respond(OutputStream out, int status, String contentType, byte[] body) throws IOException {
    String reason = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Bad Request";
    StringBuilder head = new StringBuilder();
    head.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
    head.append("Content-Type: ").append(contentType).append("\r\n");
    head.append("Content-Length: ").append(body.length).append("\r\n");
    // Phones reload this constantly while a game is being set up.
    head.append("Cache-Control: no-store\r\n");
    head.append("Connection: close\r\n\r\n");

    out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    out.write(body);
    out.flush();
  }

  // ─────────────────────────────── websockets ───────────────────────────────

  private void upgrade(Socket socket, InputStream in, OutputStream out, String key) throws IOException {
    String response = "HTTP/1.1 101 Switching Protocols\r\n"
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + "Sec-WebSocket-Accept: " + WebSocketFrames.acceptKey(key) + "\r\n\r\n";
    out.write(response.getBytes(StandardCharsets.US_ASCII));
    out.flush();

    String id = "c" + nextId.getAndIncrement();
    Connection connection = new Connection(id, socket, out);
    connections.put(id, connection);
    connection.startWriter();
    events.onOpen(id);

    try {
      WebSocketReader reader = new WebSocketReader(in);
      for (; ; ) {
        WebSocketReader.Event event = reader.next();
        if (event.kind == WebSocketReader.Kind.EOF || event.kind == WebSocketReader.Kind.CLOSE) break;
        if (event.kind == WebSocketReader.Kind.TEXT) {
          events.onMessage(id, event.text);
        } else if (event.kind == WebSocketReader.Kind.PING) {
          connection.enqueueRaw(WebSocketFrames.encodePong(event.payload));
        }
      }
    } catch (IOException | WebSocketFrames.TooLargeException e) {
      // A phone walked out of range, slept, or sent nonsense: same outcome.
    } finally {
      connections.remove(id);
      connection.shutdown();
      events.onClose(id);
    }
  }

  /** One connected phone: a socket plus an outbound queue and writer thread. */
  private static final class Connection {
    private final String id;
    private final Socket socket;
    private final OutputStream out;
    private final LinkedBlockingQueue<byte[]> outbound = new LinkedBlockingQueue<>();
    private final AtomicBoolean open = new AtomicBoolean(true);
    private static final byte[] POISON = new byte[0];

    Connection(String id, Socket socket, OutputStream out) {
      this.id = id;
      this.socket = socket;
      this.out = out;
    }

    void startWriter() {
      Thread writer = new Thread(() -> {
        try {
          while (open.get()) {
            byte[] frame = outbound.take();
            if (frame == POISON) break;
            out.write(frame);
            out.flush();
          }
        } catch (IOException | InterruptedException e) {
          // The reader loop notices the same failure and cleans up.
        } finally {
          shutdown();
        }
      }, "sociovia-writer-" + id);
      writer.setDaemon(true);
      writer.start();
    }

    /**
     * Queue text. Writing happens on the writer thread so a stalled phone can
     * never block the JS engine, which runs on the UI thread.
     */
    void enqueue(String text) {
      enqueueRaw(WebSocketFrames.encodeText(text));
    }

    void enqueueRaw(byte[] frame) {
      if (open.get()) outbound.offer(frame);
    }

    void shutdown() {
      if (!open.getAndSet(false)) return;
      outbound.offer(POISON);
      closeQuietly(socket);
    }
  }

  private static void closeQuietly(Socket socket) {
    try {
      socket.close();
    } catch (IOException ignored) {
      // Already gone.
    }
  }

  /** Read one CRLF-terminated line as ASCII, or null at end of stream. */
  private static String readLine(InputStream in, int limit) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream();
    for (; ; ) {
      int b = in.read();
      if (b == -1) return line.size() == 0 ? null : line.toString("US-ASCII");
      if (b == '\n') return line.toString("US-ASCII");
      if (b != '\r') line.write(b);
      if (line.size() > limit) throw new IOException("header line too long");
    }
  }
}
