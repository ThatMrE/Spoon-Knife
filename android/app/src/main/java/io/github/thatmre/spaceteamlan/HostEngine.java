package io.github.thatmre.spaceteamlan;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Hosts a game on this phone.
 *
 * The listening socket and the WebSocket framing are native ({@link HostServer});
 * the game itself runs in an off-screen WebView loading {@code /host/host.html},
 * which imports the very same {@code core/} modules the Node server uses. There
 * is one implementation of the rules — this class is only a courier between the
 * sockets and the engine.
 *
 * The host player's own game is not special: it runs in a separate, visible
 * WebView that connects back to 127.0.0.1 like any other phone.
 */
public final class HostEngine {

  private static final String TAG = "SpaceteamHost";
  /** Fixed so other phones can guess it, and so the sweep has one port to probe. */
  public static final int PORT = 3000;

  private final Context context;
  private final Handler main = new Handler(Looper.getMainLooper());

  private WebView engine;
  private HostServer server;
  private boolean engineReady = false;
  /** Frames that arrived before the engine finished booting. */
  private final java.util.ArrayDeque<String> pending = new java.util.ArrayDeque<>();

  public interface Listener {
    /** The server is listening and the engine is up. */
    void onHosting(int port, String address);

    /** Hosting could not start (port taken, no network). */
    void onHostFailed(String reason);
  }

  public HostEngine(Context context) {
    this.context = context;
  }

  public int port() {
    return server == null ? -1 : server.port();
  }

  /** Start listening and boot the engine. Must be called on the main thread. */
  @SuppressLint("SetJavaScriptEnabled")
  public void start(final Listener listener) {
    HostServer.AssetSource assets = new HostServer.AssetSource() {
      @Override
      public byte[] read(String path) throws IOException {
        AssetManager manager = context.getAssets();
        InputStream in = null;
        try {
          in = manager.open(path);
          ByteArrayOutputStream out = new ByteArrayOutputStream();
          byte[] chunk = new byte[8192];
          int read;
          while ((read = in.read(chunk)) != -1) out.write(chunk, 0, read);
          return out.toByteArray();
        } catch (IOException missing) {
          return null; // no such asset: the server turns this into a 404
        } finally {
          if (in != null) {
            try {
              in.close();
            } catch (IOException ignored) {
              // Nothing useful to do.
            }
          }
        }
      }
    };

    server = new HostServer(PORT, assets, new HostServer.Events() {
      @Override public void onOpen(final String id) {
        deliver("spaceteamHost.open(" + JsString.quote(id) + ")");
      }

      @Override public void onMessage(final String id, final String text) {
        // `text` came off the network, so it must be quoted rather than spliced.
        deliver("spaceteamHost.message(" + JsString.quote(id) + "," + JsString.quote(text) + ")");
      }

      @Override public void onClose(final String id) {
        deliver("spaceteamHost.close(" + JsString.quote(id) + ")");
      }
    });

    try {
      server.start();
    } catch (IOException e) {
      Log.e(TAG, "could not bind port " + PORT, e);
      listener.onHostFailed("Port " + PORT + " is already in use on this phone.");
      return;
    }

    engine = new WebView(context);
    engine.getSettings().setJavaScriptEnabled(true);
    engine.getSettings().setDomStorageEnabled(true);
    engine.addJavascriptInterface(new Bridge(), "SpaceteamNative");
    engine.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onConsoleMessage(ConsoleMessage message) {
        // The engine is off-screen, so this is the only way to see it complain.
        Log.d(TAG, "engine: " + message.message() + " @" + message.lineNumber());
        return true;
      }
    });

    final String address = LocalNetwork.privateIPv4Text();
    main.post(new Runnable() {
      @Override public void run() {
        listener.onHosting(server.port(), address);
      }
    });

    // The engine loads over the server we just started, so `/core/rooms.js`
    // resolves exactly as it does in a browser.
    engine.loadUrl("http://127.0.0.1:" + server.port() + "/host/host.html");
  }

  /** Push one statement into the engine, queueing until it has booted. */
  private void deliver(final String javascript) {
    main.post(new Runnable() {
      @Override public void run() {
        if (engine == null) return;
        if (!engineReady) {
          pending.add(javascript);
          return;
        }
        engine.evaluateJavascript(javascript, null);
      }
    });
  }

  public void stop() {
    if (server != null) {
      server.stop();
      server = null;
    }
    if (engine != null) {
      engine.evaluateJavascript("window.spaceteamHost && window.spaceteamHost.shutdown()", null);
      engine.destroy();
      engine = null;
    }
    engineReady = false;
    pending.clear();
  }

  /** What the engine calls back into. Methods run on the WebView's JS thread. */
  private final class Bridge {

    /** Called once the engine has imported the game rules and is listening. */
    @JavascriptInterface
    public void hostReady() {
      main.post(new Runnable() {
        @Override public void run() {
          engineReady = true;
          while (!pending.isEmpty() && engine != null) {
            engine.evaluateJavascript(pending.poll(), null);
          }
        }
      });
    }

    @JavascriptInterface
    public void send(String id, String text) {
      if (server != null) server.send(id, text);
    }

    @JavascriptInterface
    public void close(String id) {
      if (server != null) server.closeConnection(id);
    }

    /** A friendly name for this phone, shown to crews sweeping the network. */
    @JavascriptInterface
    public String hostName() {
      String model = android.os.Build.MODEL;
      return (model == null || model.isEmpty()) ? "phone" : model;
    }

    /** The engine reports the crew so /discover can advertise it. */
    @JavascriptInterface
    public void status(String json) {
      if (server != null) {
        server.setDiscoveryJson(json);
      }
    }
  }
}
