# 🚀 Spaceteam LAN

[![CI](https://github.com/ThatMrE/Spoon-Knife/actions/workflows/ci.yml/badge.svg)](https://github.com/ThatMrE/Spoon-Knife/actions/workflows/ci.yml)

A shout-at-your-friends co-op party game for phones on the same WiFi. It's a
recreation of [Spaceteam](https://spaceteam.ca/): everyone holds a console full
of gizmos nobody else can see, and everyone is given instructions for gizmos
that are usually on *somebody else's* console. The only way to fly the ship is
to yell.

No app store, no accounts, no internet. One laptop runs the server, everybody
else opens a URL.

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  ADA's phone            │        │  BO's phone             │
│                         │        │                         │
│  "Open POLY CONDUIT!"   │───────▶│  POLY CONDUIT  [CLOSED] │
│                         │ (shout)│                  ▲      │
│  CRYO WINCH   [MANUAL]  │◀───────│  "Set CRYO WINCH to     │
│         ▲               │ (shout)│   AUTO!"                │
└─────────────────────────┘        └─────────────────────────┘
```

## Two ways to run it

**On a phone, with no laptop at all.** Install the Android app, tap *Host a game
on this phone*, and everyone else taps *Find ships on this WiFi*. See
[The Android app](#the-android-app).

**From a laptop**, if you would rather play in the browser. Needs Node 20 or
newer, and there are **no dependencies** — nothing to install.

```sh
git clone <this repo>
cd Spoon-Knife
node server/index.js
```

It prints the addresses it's reachable on:

```
  🚀 SPACETEAM LAN

  Open this on every phone (same WiFi):

    http://192.168.1.24:3000
```

Everyone opens that URL in their phone's browser — or installs the Android app
(below) and skips the typing. One person taps **NEW SHIP** and reads the
four-letter code out loud; everybody else types it in. The host taps **LAUNCH**
once the crew is ready.

Set `PORT` to use a different port: `PORT=8080 node server/index.js`.

### It has to be the same WiFi

Phones reach the server over the local network, so every phone and the host
machine must be on the same WiFi, and it must not be a "client isolation" /
guest network that blocks device-to-device traffic. If a phone can't load the
page, that's almost always why.

## The Android app

The app under `android/` can both **host** a game and join one, so a phone is
all you need:

* **Host from a phone.** One phone runs the whole game: a native listening
  socket, the game rules in an off-screen WebView, and that player's own client
  connecting back to `127.0.0.1` like anybody else.
* **Hosting survives a pocket.** The server runs in a foreground service with a
  wake lock, so the host can put their phone down, take a call, or let the
  screen sleep without throwing everyone else out of the game.
* **It finds the host for you.** Tap *Find ships on this WiFi* and it sweeps
  your subnet, so nobody reads an IP address out loud.
* **The screen never sleeps.** A phone that dims mid-wave was the worst part of
  playing this in a browser.
* **Real fullscreen, real app icon.** No URL bar eating the top of the console.

### Hosting in the background

The server and the game engine live in a foreground service, not in the
Activity, so the ship outlives the screen:

* A **wake lock** keeps the CPU up once the screen sleeps.
* The game is **ticked from a real scheduler** as well as from the engine's own
  JS interval. An off-screen WebView in a backgrounded process can have its
  timers throttled, which would quietly stall a game everyone else is still
  playing. The game is driven by deadlines rather than tick counts, so being
  ticked twice is harmless.
* The notification carries a **Stop hosting** action, because leaving a ship
  running by accident is the failure mode worth guarding against.
* Swiping the app away stops the service; pressing home does not.

The service type is `specialUse`: a phone acting as the game server for the room
it is in is honestly not `dataSync`, `mediaPlayback` or `connectedDevice`.
Notification permission is requested but never required — denying it only hides
the notification, it does not stop the service.

### How a phone hosts without a second copy of the rules

The obvious ways to host on Android are both bad: bundling Node adds a large
native dependency, and porting `core/game.js` to Java would leave two
implementations of the game free to drift apart.

So the split follows what actually needs to be native. A WebView cannot listen
on a port, but it runs JavaScript perfectly well — and the game rules were
already free of any Node API:

```
  ┌─ host phone ───────────────────────────────────────────┐
  │  Java    HostServer: TCP, RFC 6455 framing, assets     │
  │            ↕  open/message/close  ←→  send/close       │
  │  WebView core/rooms.js + game.js + panel.js + jargon.js│
  │            (the same files the Node server imports)    │
  └────────────────────────────────────────────────────────┘
        ↑ ws://…:3000/ws           ↑ ws://127.0.0.1:3000/ws
     other phones                  the host's own client
```

Only transport is written twice — `server/ws.js` in JavaScript and
`WebSocketFrames.java` in Java — and transport has no game semantics to drift.
The two are cross-checked against each other: both are pinned to the RFC 6455
handshake vector, and the Java framing is tested against frames produced by the
JS implementation and vice versa.

`core/` exists for exactly this reason. It holds the host-agnostic rules and is
served to browsers, while `server/` is the Node-only transport and is not.

### Getting the APK

Every push builds a debug APK in CI. Open the latest **CI** run under the
repository's Actions tab, and download the `spaceteam-lan-debug-apk` artifact.
It is signed with the standard Android debug key, so it installs by sideloading
(you will have to allow install from your browser or file manager).

To build it yourself you need the Android SDK (Android Studio, or the
command-line tools):

```sh
cd android
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

### The client is always loaded over HTTP, never from `file://`

The APK bundles the client, but a phone never opens it as a local file. When
hosting it is served from the phone's own HTTP server; when joining it is
fetched from whoever is hosting. Either way the page and its WebSocket share one
cleartext HTTP origin.

That is deliberate. A page on `file://` or `appassets.androidplatform.net`
talking to `ws://192.168.x.x` is mixed content, and browsers block it. Serving
over loopback sidesteps the whole problem, and a joining phone also can't go
stale against a newer host.

It is also why this is an APK and not a PWA: an installable PWA needs a secure
context, and there is no certificate to be had for `http://192.168.1.24`.

## How to play

* **Your console is yours alone.** Nobody else can see your gizmos.
* **Your instruction is usually not yours.** Read it out loud, fast.
* **Someone is shouting at you.** Find the gizmo they named and set it.
* Miss a deadline and the hull takes damage. Run out of hull and the ship is lost.
* Clear a wave and you get a new console, patched hull, and less time per order.
* From wave 2, whole-crew emergencies interrupt everything: everybody has to
  shake, tilt, or flip their phone at once. There's always a giant button too,
  so it still works if the phone has no motion sensors or you deny the prompt.
* **If your phone drops out, it rejoins by itself.** Sleep it, walk out of
  range, lose WiFi — the app retries in the background and puts you back on
  *your own* console. Your seat is held for 90 seconds, your orders are
  cancelled rather than failed, and nobody is sent after your gizmos while you
  are gone, so a dropout costs the ship nothing.

Works with 1–8 players. Solo is a decent tutorial; it's a party game from three
up.

## How it's put together

The server is authoritative about everything that matters. Clients render what
they're told and report "I touched this gizmo" — they never decide whether an
instruction was satisfied, and they're never sent anybody else's console.

```
core/            the rules — no Node APIs, so a phone can run them too
  rooms.js       room codes, crew rosters, ready state, the per-room tick loop
  game.js        waves, instructions, hull, whole-crew emergencies
  panel.js       console generation and "is this instruction satisfied?"
  jargon.js      the nonsense that makes gizmos worth shouting about
server/          Node-only transport
  index.js       static serving + /ws upgrade + /discover, prints LAN addresses
  ws.js          a small RFC 6455 WebSocket server (this is why there are no deps)
shared/
  protocol.js    message types, shared verbatim by every host and client
public/
  index.html, css/, js/   the client
  host/          the engine page a hosting phone loads into a WebView
android/         hosts and joins (Java, no third-party dependencies)
test/            node --test suites
```

`shared/protocol.js` is served to the browser as-is and imported by the server,
so the two halves can't drift apart on message names.

### Why one phone hosts, rather than true peer-to-peer

Browsers can't open sockets to each other, and WebRTC needs a signalling server
anyway — so "peer-to-peer" would still mean somebody running a rendezvous
service over the internet, which is a strange requirement for a game played in
one room.

Electing one device to host keeps everything on the local network and gives the
game a single authority over the hull and the instructions, which is exactly
what a shared-state game wants. The Node server and the Android host are two
transports in front of the same `core/`, so which device hosts changes nothing
about the rules.

## Tests

```sh
npm test
```

54 tests, no test framework — just `node --test`:

* **Unit** — WebSocket framing (including the RFC 6455 handshake vector),
  path-traversal safety on the static server, console generation and the
  satisfaction rules.
* **Game loop** — driven by a fake clock, so a ten-minute game runs in
  milliseconds: cross-console targeting, scoring, expiry damage, wave
  progression, emergency cadence, and players dropping off the WiFi mid-game.
* **Integration** (`test/server.test.js`) — boots the real server and talks to
  it over a real socket with a hand-rolled WebSocket client, covering the
  handshake, static serving, and the lobby/game protocol end to end. This is
  the layer that catches a server which frames or hashes things wrong; the
  unit tests all passed while no browser could connect.

There is a second suite for the Android app (`android/app/src/test`), run by
Gradle on a plain JVM: WebSocket framing against the RFC 6455 vector, JS-string
escaping, HTTP path safety, and address parsing. Everything fiddly on the Java
side is deliberately free of Android imports so it can be tested without a
device.

CI runs the Node suite on Node 20, 22, 24 and 26, and builds the APK.

## Known limitations

* A phone that stays away longer than 90 seconds loses its seat, and the crew
  carries on without it.
* **The Android app has not been run on a physical device by its author.** It
  builds, its logic is unit-tested, and the Java host has been driven
  end-to-end by real browsers on a desktop — but the Android-specific parts
  (AssetManager, the WebView bridge, the UI) are unverified on a phone. Treat
  it as a first cut.
* **The host player goes idle if they background the app.** The *ship* keeps
  running for everybody else, but a paused WebView stops answering the host's
  own instructions, so their orders will start expiring and costing hull.
  Hosting and playing at the same time means staying on screen.
* **No spectating or mid-game joining** — the ship is sealed at launch.
* **Rooms live in memory**, so restarting the server ends every game.
* Audio needs one tap on the page before it will make noise (browser policy),
  and `navigator.vibrate` is Android-only in practice.

## Roadmap

* More gizmo kinds (keypads, sequences, "hold for 3 seconds")
* A proper score history, and per-crew records
* Optional QR code in the terminal so nobody has to type an IP address

---

*This repository started life as a fork of GitHub's
[Spoon-Knife](https://github.com/octocat/Spoon-Knife) demo. The original
`index.html` and `styles.css` are still at the repo root; the game is entirely
under `server/`, `shared/`, `public/`, and `test/`.*
