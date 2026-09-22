package io.github.thatmre.spaceteamlan;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Finds running game servers on the phone's own WiFi subnet, so nobody has to
 * read an IP address out loud.
 *
 * It sweeps the /24 around this device's address, asking each host for
 * {@code /discover} and keeping the ones that answer with the game's marker.
 * Best-effort by design: if it finds nothing, the setup screen still takes a
 * typed address.
 */
public final class HostFinder {

  /** The marker the server puts in /discover. Must match server/index.js. */
  private static final String APP_ID = "spaceteam-lan";

  private static final int THREADS = 32;
  private static final int CONNECT_TIMEOUT_MS = 500;
  private static final int READ_TIMEOUT_MS = 900;
  private static final int MAX_BODY_BYTES = 4096;

  /** A server that answered. */
  public static final class Ship {
    public final String address;  // "192.168.1.24:3000"
    public final String name;     // the host machine's hostname
    public final int players;

    Ship(String address, String name, int players) {
      this.address = address;
      this.name = name;
      this.players = players;
    }
  }

  public interface Listener {
    void onProgress(int done, int total);

    void onFinished(List<Ship> ships);
  }

  private final Handler main = new Handler(Looper.getMainLooper());
  private final AtomicBoolean cancelled = new AtomicBoolean(false);
  private ExecutorService pool;

  /** Stop reporting; in-flight probes are left to time out on their own. */
  public void cancel() {
    cancelled.set(true);
    if (pool != null) pool.shutdownNow();
  }

  /**
   * Sweep the local subnet on {@code port}. Callbacks arrive on the main
   * thread; {@code onFinished} is called exactly once unless cancelled.
   */
  public void start(final int port, final Listener listener) {
    final List<String> candidates = LocalNetwork.subnetCandidates();
    if (candidates.isEmpty()) {
      main.post(new Runnable() {
        @Override public void run() {
          listener.onFinished(new ArrayList<Ship>());
        }
      });
      return;
    }

    pool = Executors.newFixedThreadPool(THREADS);
    final List<Ship> found = Collections.synchronizedList(new ArrayList<Ship>());
    final AtomicInteger done = new AtomicInteger(0);
    final int total = candidates.size();

    for (final String ip : candidates) {
      pool.execute(new Runnable() {
        @Override public void run() {
          if (!cancelled.get()) {
            Ship ship = probe(ip, port);
            if (ship != null) found.add(ship);
          }
          int finished = done.incrementAndGet();
          if (cancelled.get()) return;

          main.post(new Runnable() {
            @Override public void run() {
              if (!cancelled.get()) listener.onProgress(done.get(), total);
            }
          });

          if (finished == total) {
            main.post(new Runnable() {
              @Override public void run() {
                if (!cancelled.get()) listener.onFinished(new ArrayList<Ship>(found));
              }
            });
          }
        }
      });
    }
    pool.shutdown();
  }

  /** Ask one address whether it is a game server. Returns null if it is not. */
  private static Ship probe(String ip, int port) {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL("http://" + ip + ":" + port + "/discover").openConnection();
      connection.setRequestMethod("GET");
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setUseCaches(false);
      if (connection.getResponseCode() != 200) return null;

      String body = readCapped(connection.getInputStream());
      JSONObject json = new JSONObject(body);
      if (!APP_ID.equals(json.optString("app"))) return null;

      return new Ship(ip + ":" + port, json.optString("host", ip), json.optInt("players", 0));
    } catch (Exception ignored) {
      // Nothing listening, something else listening, or not our protocol.
      return null;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private static String readCapped(InputStream stream) throws Exception {
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    byte[] chunk = new byte[1024];
    int read;
    while ((read = stream.read(chunk)) != -1) {
      buffer.write(chunk, 0, read);
      if (buffer.size() > MAX_BODY_BYTES) break;
    }
    return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
  }
}
