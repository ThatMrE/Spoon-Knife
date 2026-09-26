package io.github.thatmre.sociovia;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.IBinder;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;
import java.util.Locale;

/**
 * The whole app: point a full-screen WebView at a game server on the local
 * network.
 *
 * The client is loaded from the host rather than bundled in the APK on purpose.
 * Bundling it would put the page on a file:// or appassets origin while the
 * WebSocket stayed on ws://192.168.x.x, which browsers treat as mixed content.
 * Loading everything from the host keeps page and socket same-origin cleartext,
 * and means the app never goes stale against a newer server.
 */
public class MainActivity extends Activity {

  private static final String PREFS = "sociovia";
  private static final String KEY_HOST = "host";

  private static final int REQUEST_NOTIFICATIONS = 101;

  private WebView webView;
  private HostFinder finder;
  private HostService hostService;
  private boolean boundToHost = false;
  private EditText hostInput;
  private TextView statusText;
  private LinearLayout foundList;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // A party game nobody is touching for ten seconds at a time must not let
    // the screen sleep — that was the single worst thing about playing it in a
    // browser.
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    // Always land on the setup screen: the choice between hosting and joining
    // is the first thing a player needs, and a remembered address is useless if
    // last time's host is not around.
    showSetup(null);

    // ...unless this phone is already hosting, which it will be when the player
    // comes back from the notification or after a configuration change. Binding
    // without BIND_AUTO_CREATE attaches to a live service and starts nothing.
    bindService(new Intent(this, HostService.class), hostConnection, 0);
  }

  private SharedPreferences prefs() {
    return getSharedPreferences(PREFS, MODE_PRIVATE);
  }

  // ─────────────────────────────── setup screen ───────────────────────────────

  private void showSetup(String message) {
    cancelFinder();
    showSystemBars();
    setContentView(R.layout.activity_setup);

    hostInput = findViewById(R.id.host_input);
    statusText = findViewById(R.id.status_text);
    foundList = findViewById(R.id.found_list);
    Button host = findViewById(R.id.host_button);
    Button connect = findViewById(R.id.connect_button);
    Button find = findViewById(R.id.find_button);

    hostInput.setText(prefs().getString(KEY_HOST, ""));
    if (message != null) statusText.setText(message);

    host.setOnClickListener(new View.OnClickListener() {
      @Override public void onClick(View v) {
        startHosting();
      }
    });

    connect.setOnClickListener(new View.OnClickListener() {
      @Override public void onClick(View v) {
        String typed = hostInput.getText().toString().trim();
        if (typed.isEmpty()) {
          statusText.setText(R.string.need_address);
          return;
        }
        connectTo(typed);
      }
    });

    find.setOnClickListener(new View.OnClickListener() {
      @Override public void onClick(View v) {
        sweep();
      }
    });
  }

  /** Look for servers on this WiFi and offer whatever answers. */
  private void sweep() {
    cancelFinder();
    foundList.removeAllViews();
    statusText.setText(R.string.searching);

    finder = new HostFinder();
    finder.start(HostAddress.portFrom(hostInput.getText().toString()), new HostFinder.Listener() {
      @Override public void onProgress(int done, int total) {
        statusText.setText(String.format(Locale.US, "Sweeping the network… %d/%d", done, total));
      }

      @Override public void onFinished(List<HostFinder.Ship> ships) {
        if (ships.isEmpty()) {
          statusText.setText(R.string.none_found);
          return;
        }
        statusText.setText("");
        for (final HostFinder.Ship ship : ships) offerShip(ship);
      }
    });
  }

  private void offerShip(final HostFinder.Ship ship) {
    Button button = new Button(this);
    String crew = ship.players == 1 ? "1 aboard" : ship.players + " aboard";
    button.setText(ship.name + "  ·  " + ship.address + "  ·  " + crew);
    button.setAllCaps(false);
    button.setTextColor(Color.parseColor("#04211F"));
    button.setBackgroundColor(Color.parseColor("#35E0D0"));
    button.setOnClickListener(new View.OnClickListener() {
      @Override public void onClick(View v) {
        connectTo(ship.address);
      }
    });
    foundList.addView(button);
  }

  private void cancelFinder() {
    if (finder != null) {
      finder.cancel();
      finder = null;
    }
  }

  // ─────────────────────────────── hosting ───────────────────────────────

  /**
   * Run the whole game on this phone.
   *
   * The server and the game engine live in {@link HostService}, not here, so
   * putting the phone in a pocket does not take the ship down with it — the
   * Activity is just a client that happens to be on the same device.
   */
  private void startHosting() {
    cancelFinder();
    statusText.setText(R.string.starting_host);
    askForNotificationPermission();

    HostService.start(this);
    bindService(new Intent(this, HostService.class), hostConnection, Context.BIND_AUTO_CREATE);
  }

  private void stopHosting() {
    unbindFromHost();
    HostService.stop(this);
  }

  private void unbindFromHost() {
    if (!boundToHost) return;
    boundToHost = false;
    if (hostService != null) {
      hostService.setListener(null);
      hostService = null;
    }
    try {
      unbindService(hostConnection);
    } catch (IllegalArgumentException ignored) {
      // Already unbound.
    }
  }

  private final ServiceConnection hostConnection = new ServiceConnection() {
    @Override
    public void onServiceConnected(ComponentName name, IBinder binder) {
      boundToHost = true;
      hostService = ((HostService.LocalBinder) binder).service();
      hostService.setListener(new HostService.Listener() {
        @Override public void onHosting(final int port, final String address) {
          runOnUiThread(new Runnable() {
            @Override public void run() {
              if (statusText != null) {
                statusText.setText(address == null
                    ? getString(R.string.hosting_no_wifi)
                    : getString(R.string.hosting_at, address + ":" + port));
              }
              // Join our own ship. The client has no idea it is the host.
              if (webView == null) connectTo("127.0.0.1:" + port);
            }
          });
        }

        @Override public void onHostFailed(final String reason) {
          runOnUiThread(new Runnable() {
            @Override public void run() {
              unbindFromHost();
              showSetup(reason);
            }
          });
        }
      });
    }

    @Override
    public void onServiceDisconnected(ComponentName name) {
      boundToHost = false;
      hostService = null;
    }
  };

  /**
   * Ask for notification permission, but never block on it: on Android 13+ a
   * denied prompt only hides the hosting notification, it does not stop the
   * service.
   */
  private void askForNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      return;
    }
    requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(requestCode, permissions, results);
    if (requestCode != REQUEST_NOTIFICATIONS) return;
    boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
    if (!granted && statusText != null) {
      statusText.setText(R.string.notifications_denied);
    }
  }

  // ─────────────────────────────── the game ───────────────────────────────

  /** Normalise whatever was typed into a URL and load it. */
  private void connectTo(String hostText) {
    final String address = HostAddress.normalise(hostText);
    if (address.isEmpty()) {
      showSetup(getString(R.string.need_address));
      return;
    }
    // Remember real hosts only. Saving the loopback address we use when hosting
    // would prefill the join box with something that only works while hosting.
    if (!HostAddress.isLoopback(address)) {
      prefs().edit().putString(KEY_HOST, address).apply();
    }
    cancelFinder();

    webView = new WebView(this);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    settings.setSupportZoom(false);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    // The game never has to wait for a tap to start playing sounds; the client
    // still unlocks audio on the first touch itself.
    settings.setMediaPlaybackRequiresUserGesture(false);

    webView.setBackgroundColor(Color.parseColor("#0A0D18"));
    webView.setWebViewClient(new WebViewClient() {
      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        // Only the main document failing is worth bailing out for; a missing
        // sub-resource should not throw the player back to setup.
        if (request.isForMainFrame()) {
          webView = null;
          showSetup(getString(R.string.cant_reach) + " " + address);
        }
      }
    });

    setContentView(webView);
    hideSystemBars();
    webView.loadUrl("http://" + address + "/");
  }

  // ─────────────────────────────── chrome ───────────────────────────────

  private void hideSystemBars() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController controller = getWindow().getInsetsController();
      if (controller != null) {
        controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        controller.setSystemBarsBehavior(
            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      getWindow().getDecorView().setSystemUiVisibility(
          View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
  }

  private void showSystemBars() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController controller = getWindow().getInsetsController();
      if (controller != null) {
        controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
      }
    } else {
      getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
  }

  @Override
  public void onBackPressed() {
    // Back leaves the ship and returns to the address screen, so you can hop
    // to a different host without force-quitting. Leaving a game you were
    // hosting also takes the ship down with it — the crew would be left aboard
    // a server nobody is running otherwise.
    if (webView != null) {
      WebView dying = webView;
      webView = null;
      dying.loadUrl("about:blank");
      dying.destroy();
      stopHosting();
      showSetup(null);
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    cancelFinder();
    // Unbind but leave the service running: backgrounding or a configuration
    // change must not throw the rest of the crew out of their game. The service
    // stops itself when the task is swiped away, or from its own notification.
    unbindFromHost();
    if (webView != null) {
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
