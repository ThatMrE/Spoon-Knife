package io.github.thatmre.sociovia;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Keeps a hosted game alive when the host puts their phone away.
 *
 * Without this the whole ship went down the moment the host backgrounded the
 * app — everyone else was thrown out of a game they were still playing. The
 * service owns the listening socket and the game engine so they outlive the
 * Activity, and it holds a wake lock so the game keeps ticking with the screen
 * off.
 */
public final class HostService extends Service {

  private static final String TAG = "SocioviaHost";
  private static final String CHANNEL_ID = "hosting";
  private static final int NOTIFICATION_ID = 1;

  public static final String ACTION_START = "io.github.thatmre.sociovia.START_HOSTING";
  public static final String ACTION_STOP = "io.github.thatmre.sociovia.STOP_HOSTING";

  /**
   * The engine's own JS interval can be throttled once the WebView is
   * off-screen in a background process, so the game is also ticked from a real
   * scheduler here. Matches the room tick in core/rooms.js.
   */
  private static final long TICK_MS = 200;

  /** What the Activity watches while it is in the foreground. */
  public interface Listener {
    void onHosting(int port, String address);

    void onHostFailed(String reason);
  }

  public final class LocalBinder extends Binder {
    public HostService service() {
      return HostService.this;
    }
  }

  private final IBinder binder = new LocalBinder();
  private final Handler main = new Handler(Looper.getMainLooper());

  private HostEngine engine;
  private PowerManager.WakeLock wakeLock;
  private ScheduledExecutorService ticker;

  private volatile Listener listener;
  private volatile boolean hosting = false;
  private volatile int port = -1;
  private volatile String address;
  private volatile int crew = 0;

  // ─────────────────────────────── lifecycle ───────────────────────────────

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_STOP.equals(intent.getAction())) {
      stopHosting();
      stopSelf();
      return START_NOT_STICKY;
    }

    if (hosting) return START_NOT_STICKY;
    startInForeground(getString(R.string.notification_starting));
    startHosting();
    // Deliberately not sticky: a restarted service with no crew and no Activity
    // would be a ghost ship in the notification shade.
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return binder;
  }

  /** The player swiped the app away, which means they are done hosting. */
  @Override
  public void onTaskRemoved(Intent rootIntent) {
    stopHosting();
    stopSelf();
    super.onTaskRemoved(rootIntent);
  }

  @Override
  public void onDestroy() {
    stopHosting();
    super.onDestroy();
  }

  // ─────────────────────────────── hosting ───────────────────────────────

  private void startHosting() {
    hosting = true;
    acquireWakeLock();

    engine = new HostEngine(this);
    engine.setStatusListener(new HostEngine.StatusListener() {
      @Override public void onStatus(String json) {
        try {
          crew = new JSONObject(json).optInt("players", 0);
        } catch (Exception ignored) {
          // Diagnostics only; never worth disturbing a game over.
        }
        main.post(HostService.this::refreshNotification);
      }
    });

    engine.start(new HostEngine.Listener() {
      @Override public void onHosting(int boundPort, String lanAddress) {
        port = boundPort;
        address = lanAddress;
        refreshNotification();
        startTicking();
        Listener current = listener;
        if (current != null) current.onHosting(boundPort, lanAddress);
      }

      @Override public void onHostFailed(String reason) {
        Log.w(TAG, "hosting failed: " + reason);
        Listener current = listener;
        if (current != null) current.onHostFailed(reason);
        stopHosting();
        stopSelf();
      }
    });
  }

  private void stopHosting() {
    if (!hosting) return;
    hosting = false;
    stopTicking();

    if (engine != null) {
      engine.stop();
      engine = null;
    }
    releaseWakeLock();
    stopForeground(STOP_FOREGROUND_REMOVE);
  }

  private void startTicking() {
    if (ticker != null) return;
    ticker = Executors.newSingleThreadScheduledExecutor(runnable -> {
      Thread thread = new Thread(runnable, "sociovia-tick");
      thread.setDaemon(true);
      return thread;
    });
    ticker.scheduleWithFixedDelay(() -> {
      HostEngine current = engine;
      if (current != null) current.tick();
    }, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
  }

  private void stopTicking() {
    if (ticker == null) return;
    ticker.shutdownNow();
    ticker = null;
  }

  private void acquireWakeLock() {
    try {
      PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
      if (power == null) return;
      // Partial: the CPU stays up so the game ticks, but the screen may sleep.
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sociovia:hosting");
      wakeLock.setReferenceCounted(false);
      wakeLock.acquire();
    } catch (Exception e) {
      Log.w(TAG, "no wake lock; the game may stall with the screen off", e);
    }
  }

  private void releaseWakeLock() {
    try {
      if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    } catch (Exception ignored) {
      // Already released.
    }
    wakeLock = null;
  }

  // ─────────────────────────────── the Activity ───────────────────────────────

  /** Watch for the ship coming up. Replays the current state immediately. */
  public void setListener(Listener newListener) {
    this.listener = newListener;
    if (newListener == null) return;
    if (port > 0) newListener.onHosting(port, address);
  }

  public boolean isHosting() {
    return hosting;
  }

  public int port() {
    return port;
  }

  // ─────────────────────────────── notification ───────────────────────────────

  private void startInForeground(String text) {
    createChannel();
    Notification notification = buildNotification(text);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    } else {
      startForeground(NOTIFICATION_ID, notification);
    }
  }

  private void refreshNotification() {
    if (!hosting) return;
    String where = address == null ? getString(R.string.notification_no_wifi) : address + ":" + port;
    String text = getResources().getQuantityString(R.plurals.notification_crew, crew, where, crew);

    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(text));
  }

  private Notification buildNotification(String text) {
    Intent open = new Intent(this, MainActivity.class);
    open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent openPending = PendingIntent.getActivity(
        this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Intent stop = new Intent(this, HostService.class).setAction(ACTION_STOP);
    PendingIntent stopPending = PendingIntent.getService(
        this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.notification_title))
        .setContentText(text)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentIntent(openPending)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        // Leaving a ship running by accident is the failure mode worth guarding
        // against, so stopping is one tap from the shade.
        .addAction(new Notification.Action.Builder(
            Icon.createWithResource(this, R.drawable.ic_notification),
            getString(R.string.notification_stop),
            stopPending).build());

    return builder.build();
  }

  private void createChannel() {
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return;
    NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW);
    channel.setDescription(getString(R.string.notification_channel_description));
    channel.setShowBadge(false);
    manager.createNotificationChannel(channel);
  }

  /** Start hosting, or bring an existing host to the front. */
  public static void start(Context context) {
    Intent intent = new Intent(context, HostService.class).setAction(ACTION_START);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent);
    } else {
      context.startService(intent);
    }
  }

  public static void stop(Context context) {
    context.startService(new Intent(context, HostService.class).setAction(ACTION_STOP));
  }
}
