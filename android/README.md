# Spaceteam LAN — Android client

A deliberately thin native shell around the web client in `../public`.

```
app/src/main/java/io/github/thatmre/spaceteamlan/
  MainActivity.java   address screen + fullscreen WebView, keeps the screen awake
  HostFinder.java     sweeps the local /24 for servers answering /discover
  HostAddress.java    address parsing and subnet maths — no Android imports
app/src/test/java/.../HostAddressTest.java
```

## Why it is shaped like this

**No third-party dependencies.** Only the Android framework, plus JUnit for
tests. Nothing to resolve, nothing to keep up to date, and the whole app is
three files.

**`HostAddress` has no Android imports on purpose.** All the logic worth getting
wrong — parsing whatever someone typed into the address box, and turning an
interface address into a list of probe targets — lives there so it can be
unit-tested on a plain JVM without a device or an emulator. Everything else is
framework glue.

**The client is loaded from the host, not bundled.** Bundling would put the page
on a `file://` origin while the WebSocket stayed on `ws://192.168.x.x`, which
browsers block as mixed content. Loading from the host keeps page and socket
same-origin cleartext, and the app can never go stale against a newer server.

**`usesCleartextTraffic` is on.** There is no certificate to be had for
`192.168.1.24`, and a network security config cannot express "private ranges
only". This is also why the app exists instead of a PWA: installable PWAs need
a secure context.

## Building

Needs the Android SDK (platform 35) and JDK 17:

```sh
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # the address/subnet tests
```

CI does both on every push and uploads the APK as an artifact.

## Status

Builds and its logic is tested, but it has **not been run on a physical
device** — the on-device behaviour of the WebView shell and the subnet sweep is
unverified. First cut.
