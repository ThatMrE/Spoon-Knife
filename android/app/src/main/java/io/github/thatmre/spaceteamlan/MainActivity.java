package io.github.thatmre.spaceteamlan;

import android.app.Activity;
import android.content.SharedPreferences;
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

  private static final String PREFS = "spaceteam";
  private static final String KEY_HOST = "host";

  private WebView webView;
  private HostFinder finder;
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

    String saved = prefs().getString(KEY_HOST, "");
    if (saved.isEmpty()) showSetup(null);
    else connectTo(saved);
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
    Button connect = findViewById(R.id.connect_button);
    Button find = findViewById(R.id.find_button);

    hostInput.setText(prefs().getString(KEY_HOST, ""));
    if (message != null) statusText.setText(message);

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

  // ─────────────────────────────── the game ───────────────────────────────

  /** Normalise whatever was typed into a URL and load it. */
  private void connectTo(String hostText) {
    final String address = HostAddress.normalise(hostText);
    if (address.isEmpty()) {
      showSetup(getString(R.string.need_address));
      return;
    }
    prefs().edit().putString(KEY_HOST, address).apply();
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
    // to a different host without force-quitting.
    if (webView != null) {
      WebView dying = webView;
      webView = null;
      dying.loadUrl("about:blank");
      dying.destroy();
      showSetup(null);
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    cancelFinder();
    if (webView != null) {
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
