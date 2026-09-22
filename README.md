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

## Running it

Needs Node 20 or newer. There are **no dependencies** — nothing to install.

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

Everyone opens that URL in their phone's browser. One person taps **NEW SHIP**
and reads the four-letter code out loud; everybody else types it in. The host
taps **LAUNCH** once the crew is ready.

Set `PORT` to use a different port: `PORT=8080 node server/index.js`.

### It has to be the same WiFi

Phones reach the server over the local network, so every phone and the host
machine must be on the same WiFi, and it must not be a "client isolation" /
guest network that blocks device-to-device traffic. If a phone can't load the
page, that's almost always why.

## How to play

* **Your console is yours alone.** Nobody else can see your gizmos.
* **Your instruction is usually not yours.** Read it out loud, fast.
* **Someone is shouting at you.** Find the gizmo they named and set it.
* Miss a deadline and the hull takes damage. Run out of hull and the ship is lost.
* Clear a wave and you get a new console, patched hull, and less time per order.
* From wave 2, whole-crew emergencies interrupt everything: everybody has to
  shake, tilt, or flip their phone at once. There's always a giant button too,
  so it still works if the phone has no motion sensors or you deny the prompt.

Works with 1–8 players. Solo is a decent tutorial; it's a party game from three
up.

## How it's put together

The server is authoritative about everything that matters. Clients render what
they're told and report "I touched this gizmo" — they never decide whether an
instruction was satisfied, and they're never sent anybody else's console.

```
server/
  index.js   HTTP static file serving + /ws upgrade, prints LAN addresses
  ws.js      a small RFC 6455 WebSocket server (this is why there are no deps)
  rooms.js   room codes, crew rosters, ready state, the per-room tick loop
  game.js    the game itself: waves, instructions, hull, emergencies
  panel.js   console generation and "is this instruction satisfied?"
  jargon.js  the nonsense that makes gizmos worth shouting about
shared/
  protocol.js  message types, shared verbatim by both halves
public/
  index.html, css/, js/   the client
test/        node --test suites
```

`shared/protocol.js` is served to the browser as-is and imported by the server,
so the two halves can't drift apart on message names.

### Why a LAN server instead of phone-to-phone

Browsers can't open sockets directly to each other, and WebRTC needs a
signalling server anyway — so a phone-to-phone build would still need this
server, plus a native app to escape the browser. Running one process on a
laptop keeps it to `node server/index.js` and works on every phone with a
browser.

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

CI runs the suite on Node 20, 22, 24 and 26 for every pull request.

## Known limitations

* **No reconnection.** If a phone sleeps or drops WiFi mid-game, that player
  leaves the crew and their console goes with them; the run continues without
  them. Rejoining means waiting for the next game.
* **No spectating or mid-game joining** — the ship is sealed at launch.
* **Rooms live in memory**, so restarting the server ends every game.
* Audio needs one tap on the page before it will make noise (browser policy),
  and `navigator.vibrate` is Android-only in practice.

## Roadmap

* Reconnect-by-name within a grace period
* More gizmo kinds (keypads, sequences, "hold for 3 seconds")
* A proper score history, and per-crew records
* Optional QR code in the terminal so nobody has to type an IP address

---

*This repository started life as a fork of GitHub's
[Spoon-Knife](https://github.com/octocat/Spoon-Knife) demo. The original
`index.html` and `styles.css` are still at the repo root; the game is entirely
under `server/`, `shared/`, `public/`, and `test/`.*
