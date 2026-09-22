# Spaceteam LAN — Android app

Hosts a game and joins one, so a phone is all you need.

```
app/src/main/java/io/github/thatmre/spaceteamlan/
  MainActivity.java      host-or-join screen, fullscreen WebView, keeps the screen awake
  HostService.java       hosting: foreground service, wake lock, notification, tick
  HostEngine.java        hosting: the off-screen WebView that runs the game rules
  HostServer.java        hosting: TCP, HTTP, WebSocket upgrade  (no Android imports)
  WebSocketFrames.java   RFC 6455 framing                        (no Android imports)
  WebSocketReader.java   fragmentation, control frames, caps     (no Android imports)
  HttpRouting.java       URL → asset mapping and path safety     (no Android imports)
  JsString.java          quoting network text into JS source     (no Android imports)
  HostAddress.java       address parsing and subnet maths        (no Android imports)
  LocalNetwork.java      this device's own LAN address           (no Android imports)
  HostFinder.java        joining: sweeps the /24 for /discover
app/src/test/java/…      JUnit for every class above that has no Android imports
```

## How hosting works

A WebView cannot listen on a port, but it runs JavaScript fine — and the game
rules in `../core/` use no Node APIs. So the split follows what genuinely has to
be native:

* **Java** owns the listening socket, the WebSocket framing, and serving the
  bundled client out of the APK's assets. It knows nothing about the game.
* **An off-screen WebView** loads `/host/host.html` from that server, which
  imports `core/rooms.js` — the same file the Node server imports. The rules
  exist once.
* **The host's own game** is not special: a second, visible WebView connects
  back to `127.0.0.1` exactly like any other phone.

The native↔JS contract is four calls each way (`open`/`message`/`close` in,
`send`/`close` out), plus `tick` and `status`, and nothing else crosses the
boundary — which is what keeps the part that cannot be tested off-device small.

All of it lives in `HostService`, a foreground service, so hosting survives the
host backgrounding the app. The service holds a partial wake lock and ticks the
game from a `ScheduledExecutorService`, because an off-screen WebView in a
background process can have its JS timers throttled. Ticking twice is harmless:
the game is driven by deadlines, not tick counts.

## Why so many classes say "no Android imports"

Because that is what makes them testable here. Everything fiddly — framing,
path safety, JS escaping, address parsing — is plain JDK and covered by JUnit
running on a desktop JVM. `HostServer` is in that set too, so the whole
transport can be run locally and driven by real browsers.

What is left needing a phone: `AssetManager`, the WebView bridge, and the UI.

## Building

Needs the Android SDK (platform 35) and JDK 17:

```sh
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # the JVM test suite
```

`assembleDebug` also stages `../public`, `../shared` and `../core` into the
APK's assets (the `bundleWebClient` task), and fails the build if any of the
files a host cannot start without are missing. CI additionally checks for them
inside the finished APK.

## Status

Builds, signed, and its logic is tested. The Java host has been driven
end-to-end by real browsers on a desktop — full games, waves, emergencies — but
**it has not been run on a physical Android device**, so `AssetManager`, the
WebView bridge and the UI are unverified. First cut.

The host *player* still goes idle if they background the app — the ship keeps
running for everyone else, but a paused WebView stops answering that player's
own instructions.
