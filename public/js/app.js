/**
 * Screen flow and message handling for the client.
 */
import { ALL_HANDS, APP_ID, C2S, PHASE, S2C } from '/shared/protocol.js';
import { Net } from '/js/net.js';
import { Loopback } from '/js/loopback.js';
import { buzz, sfx, unlockAudio } from '/js/feedback.js';
import { MotionWatcher } from '/js/motion.js';
import { renderGizmo } from '/js/gizmos.js';
import { createParty } from '/js/party.js';
import { createSide } from '/js/side.js';
import { createFinder } from '/js/find.js';
import { colourOf, describeLook } from '/shared/looks.js';

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
    party: $('screen-party'),
  },
  staticNote: $('static-note'),
  multiplayer: $('multiplayer-controls'),
  name: $('input-name'),
  code: $('input-code'),
  homeHint: $('home-hint'),
  lobbyCode: $('lobby-code'),
  lobbyCrew: $('lobby-crew'),
  lobbyCount: $('lobby-count'),
  lobbyHint: $('lobby-hint'),
  lobbyResult: $('lobby-result'),
  lobbyGames: $('lobby-games'),
  btnSide: $('btn-side'),
  sideTitle: $('side-title'),
  sideBlurb: $('side-blurb'),
  sideState: $('side-state'),
  btnReady: $('btn-ready'),
  btnStart: $('btn-start'),
  hudWave: $('hud-wave'),
  hudScore: $('hud-score'),
  hullFill: $('hull-fill'),
  hullLabel: $('hull-label'),
  hullMeter: document.querySelector('.meter-hull'),
  waveFill: $('wave-fill'),
  waveLabel: $('wave-label'),
  order: $('order'),
  orderText: $('order-text'),
  orderTimer: $('order-timer-fill'),
  panel: $('panel'),
  countdown: $('overlay-countdown'),
  countdownNumber: $('countdown-number'),
  allHands: $('overlay-allhands'),
  allHandsText: $('allhands-text'),
  allHandsBtn: $('allhands-btn'),
  allHandsPending: $('allhands-pending'),
  allHandsTimer: $('allhands-timer-fill'),
  waveOverlay: $('overlay-wave'),
  waveDone: $('wave-done'),
  waveSub: $('wave-sub'),
  over: $('overlay-over'),
  overReason: $('over-reason'),
  overStats: $('over-stats'),
  btnAgain: $('btn-again'),
  dead: $('overlay-dead'),
  deadReason: $('dead-reason'),
  rejoin: $('overlay-rejoin'),
  rejoinSub: $('rejoin-sub'),
  toast: $('toast'),
};

const state = {
  playerId: null,
  isHost: false,
  ready: false,
  connected: false,
  allHandsId: null,
  /** What a dropped phone needs to get its own seat back. */
  seat: null,
  rejoining: false,
  rejoinAttempt: 0,
};

/**
 * The seat is kept in sessionStorage rather than localStorage on purpose: it is
 * only good for the game in progress, and a stale token from yesterday would
 * just produce a confusing refusal on the next launch.
 */
const SEAT_KEY = 'sociovia:seat';

/** Hold the seat in memory; it only becomes resumable once a game is running. */
function holdSeat(seat) {
  state.seat = seat;
}

/**
 * Make the seat resumable. Called when the console arrives, because only a
 * running game has a console worth holding — dropping out of a lobby should
 * send you back to the start screen, not into a retry loop.
 */
function armSeat() {
  if (!state.seat) return;
  try {
    sessionStorage.setItem(SEAT_KEY, JSON.stringify(state.seat));
  } catch {
    // Private mode or blocked storage: reconnection then will not survive a
    // page reload, which is not worth failing over.
  }
}

function recallSeat() {
  try {
    const raw = sessionStorage.getItem(SEAT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Fall through to whatever is in memory.
  }
  return null;
}

function forgetSeat() {
  state.seat = null;
  try {
    sessionStorage.removeItem(SEAT_KEY);
  } catch {
    // Nothing to do.
  }
}

let net = new Net();
const TABLES_POLL_MS = 5000;
let tablesTimer = null;
const motion = new MotionWatcher((kind) => net.send(C2S.MOTION, { kind }));

// ───────────────────────────────── helpers ─────────────────────────────────

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) {
    node.toggleAttribute('data-active', key === name);
  }
  // The tables list is only worth fetching while somebody is looking at it.
  watchTables(name === 'home');
}

let toastTimer = null;
function toast(message, kind = 'warn') {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-info', kind === 'info');
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3200);
}

/** Shared countdown bar driver. Returns a cancel function. */
function runTimerBar(node, durationMs) {
  const started = performance.now();
  let frame = 0;
  const step = (now) => {
    const left = Math.max(0, 1 - (now - started) / durationMs);
    node.style.width = `${left * 100}%`;
    node.classList.toggle('is-urgent', left < 0.3);
    if (left > 0) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

const party = createParty({
  send: (type, payload) => net.send(type, payload),
  me: () => state.playerId,
  timerBar: (node, ms) => runTimerBar(node, ms),
});

const side = createSide({
  send: (type, payload) => net.send(type, payload),
  me: () => state.playerId,
  toast: (message, kind) => toast(message, kind),
  alarm: () => {
    // Being accused is the one moment a phone in a pocket has to interrupt you.
    sfx.alarm();
    buzz([80, 60, 80]);
  },
});

const finder = createFinder({
  name: () => el.name.value.trim(),
  onJoin: (code) => {
    el.code.value = code;
    enter(C2S.JOIN, { code });
  },
});

let cancelOrderTimer = () => {};
let cancelAllHandsTimer = () => {};

/**
 * Flash the order card green or red.
 *
 * The next instruction lands within milliseconds of a success, so the feedback
 * cannot live in the instruction text — it gets its own class with its own
 * timer, and the incoming instruction leaves it alone.
 */
let flashTimer = null;
function flashOrder(kind) {
  el.order.classList.remove('flash-good', 'flash-bad');
  void el.order.offsetWidth; // restart the animation even on a rapid repeat
  el.order.classList.add(`flash-${kind}`);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.order.classList.remove('flash-good', 'flash-bad'), 450);
}

// ───────────────────────────────── home ─────────────────────────────────

el.name.value = localStorage.getItem('sociovia:name') ?? '';
el.name.addEventListener('input', () => finder.paint());
el.code.addEventListener('input', () => {
  el.code.value = el.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

async function enter(type, extra) {
  const name = el.name.value.trim();
  if (!name) {
    el.homeHint.textContent = 'Pick a name first.';
    el.name.focus();
    return;
  }
  localStorage.setItem('sociovia:name', name);
  el.homeHint.textContent = 'Connecting…';

  try {
    if (!state.connected) {
      await net.connect();
      state.connected = true;
    }
    net.send(type, { name, look: finder.look, ...extra });
    el.homeHint.textContent = '';
  } catch {
    el.homeHint.textContent = 'Could not reach the ship. Same WiFi as the host?';
  }
}

$('btn-create').addEventListener('click', () => enter(C2S.CREATE));
$('btn-beacon').addEventListener('click', () => finder.beacon());

$('btn-solo').addEventListener('click', async () => {
  const name = el.name.value.trim() || 'SOLO';
  localStorage.setItem('sociovia:name', name);
  el.homeHint.textContent = '';

  // No server involved: the page runs the rules itself.
  net = wire(new Loopback());
  net.onDown = () => giveUp('Practice ended.');
  await net.connect();
  net.send(C2S.CREATE, { name });
  net.send(C2S.START);
});
$('btn-join').addEventListener('click', () => {
  const code = el.code.value.trim().toUpperCase();
  if (code.length !== 4) {
    el.homeHint.textContent = 'Ship codes are four characters.';
    return;
  }
  enter(C2S.JOIN, { code });
});

// ───────────────────────────────── lobby ─────────────────────────────────

el.btnReady.addEventListener('click', async () => {
  state.ready = !state.ready;
  el.btnReady.setAttribute('aria-pressed', String(state.ready));
  el.btnReady.textContent = state.ready ? "READY — WAITING" : "I'M READY";
  net.send(C2S.READY, { ready: state.ready });
  if (state.ready) await motion.request();
});

el.btnSide.addEventListener('click', () => {
  net.send(C2S.SIDE_GAME, { on: el.btnSide.getAttribute('aria-pressed') !== 'true' });
});

el.btnStart.addEventListener('click', async () => {
  await motion.request();
  net.send(C2S.START);
});

$('btn-leave').addEventListener('click', () => {
  state.rejoining = false;
  side.reset();
  forgetSeat();
  net.send(C2S.LEAVE);
  location.reload();
});

el.btnAgain.addEventListener('click', () => {
  el.over.hidden = true;
  show('lobby');
});

$('btn-party-again').addEventListener('click', () => {
  party.hideOver();
  show('lobby');
});

$('btn-reload').addEventListener('click', () => location.reload());

// ─────────────────────────────── all hands ───────────────────────────────

el.allHandsBtn.addEventListener('click', () => {
  if (!state.allHandsId) return;
  net.send(C2S.MOTION, { kind: el.allHandsBtn.dataset.kind });
});

// ───────────────────────────── server messages ─────────────────────────────

/**
 * Attach the game's message handlers to a transport.
 *
 * Called for the WebSocket at startup and again for the in-page transport when
 * somebody practises solo; the handlers cannot tell which one they are on.
 */
function wire(transport) {
  transport
  .on(S2C.WELCOME, (msg) => {
    state.playerId = msg.playerId;
    state.isHost = msg.isHost;
    state.connected = true;
    el.lobbyCode.textContent = msg.code;
    if (msg.token) holdSeat({ code: msg.code, token: msg.token });

    if (msg.resumed) {
      // Back in an existing game: the PANEL that follows puts us on screen.
      state.rejoining = false;
      state.rejoinAttempt = 0;
      el.rejoin.hidden = true;
      el.dead.hidden = true;
      toast('Back aboard.', 'info');
      return;
    }
    show('lobby');
  })

  .on(S2C.CREW, (msg) => {
    toast(
      msg.connected ? `${msg.name} is back aboard.` : `${msg.name} dropped out — holding their seat.`,
      msg.connected ? 'info' : 'warn',
    );
  })

  .on(S2C.LOBBY, (msg) => {
    state.isHost = msg.hostId === state.playerId;
    el.lobbyCode.textContent = msg.code;
    el.lobbyCount.textContent = `(${msg.players.length})`;

    el.lobbyCrew.replaceChildren(
      ...msg.players.map((player) => {
        const li = document.createElement('li');
        li.classList.toggle('is-ready', player.ready || player.isHost);
        li.classList.toggle('is-me', player.id === state.playerId);

        const face = document.createElement('span');
        face.className = 'face';
        face.style.background = colourOf(player.look?.colour).hex;
        face.textContent = player.look?.emblem ?? '?';

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = player.name;
        const where = describeLook(player.look);
        if (where) {
          const detail = document.createElement('small');
          detail.textContent = where;
          who.append(detail);
        }

        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = player.isHost ? 'HOST' : player.ready ? 'READY' : 'WAITING';

        li.append(face, who, tag);
        return li;
      }),
    );

    el.lobbyGames.replaceChildren(
      ...(msg.games ?? []).map((game) => {
        const li = document.createElement('li');
        const choice = document.createElement('button');
        choice.className = 'game-choice';
        choice.toggleAttribute('data-chosen', game.key === msg.game);
        // Everyone sees what is picked; only the host can change it.
        choice.disabled = !state.isHost;

        const title = document.createElement('span');
        title.className = 'game-title';
        title.textContent = game.title;

        const blurb = document.createElement('span');
        blurb.className = 'game-blurb';
        blurb.textContent =
          game.minPlayers > msg.players.length
            ? `Needs ${game.minPlayers} players.`
            : game.blurb;

        choice.append(title, blurb);
        choice.addEventListener('click', () => net.send(C2S.PICK_GAME, { game: game.key }));
        li.append(choice);
        return li;
      }),
    );

    if (msg.side) {
      el.sideTitle.textContent = msg.side.title;
      el.sideBlurb.textContent = msg.side.blurb;
      el.sideState.textContent = msg.side.on ? 'RUNNING' : 'OFF';
      el.btnSide.setAttribute('aria-pressed', String(msg.side.on));
      el.btnSide.disabled = !state.isHost;
    }

    el.btnStart.hidden = !state.isHost;
    el.btnReady.hidden = state.isHost;
    el.lobbyHint.textContent = state.isHost
      ? 'Pick a game, then launch once everyone is ready.'
      : '';

    if (msg.lastResult) {
      el.lobbyResult.hidden = false;
      const last = msg.lastResult;
      // Spaceteam reports a run; the party games report a table.
      el.lobbyResult.textContent = last.standings
        ? `${last.title}: ${last.standings.map((p) => `${p.name} ${p.score}`).join(' · ')}`
        : `${last.title}: wave ${last.wave} · ${last.score} pts`;
    }

    if (msg.phase === PHASE.LOBBY && el.screens.game.hasAttribute('data-active')) show('lobby');
  })

  .on(S2C.PANEL, (msg) => {
    // A console means a game is under way, so this seat is now worth rejoining.
    armSeat();
    el.panel.replaceChildren(
      ...msg.controls.map((control) =>
        renderGizmo(control, (controlId, value) => {
          sfx.tap();
          net.send(C2S.CONTROL, { controlId, value });
        }),
      ),
    );
    el.panel.scrollTop = 0;
    show('game');
  })

  .on(S2C.STATE, (msg) => {
    el.hudWave.textContent = msg.wave;
    el.hudScore.textContent = `${msg.score} PTS`;

    const hullPct = Math.round((msg.hull / msg.maxHull) * 100);
    el.hullFill.style.width = `${hullPct}%`;
    el.hullLabel.textContent = `HULL ${hullPct}%`;
    el.hullMeter.classList.toggle('is-hurt', hullPct <= 55);
    el.hullMeter.classList.toggle('is-critical', hullPct <= 25);

    el.waveFill.style.width = msg.goal ? `${(msg.progress / msg.goal) * 100}%` : '0%';
    el.waveLabel.textContent = `${msg.progress} / ${msg.goal}`;

    if (msg.phase === PHASE.COUNTDOWN) startCountdown(msg.startsIn);
    if (msg.phase === PHASE.PLAYING) el.countdown.hidden = true;
  })

  .on(S2C.INSTRUCTION, (msg) => {
    el.orderText.textContent = msg.text;
    cancelOrderTimer();
    cancelOrderTimer = runTimerBar(el.orderTimer, msg.duration);
    sfx.order();
  })

  .on(S2C.RESOLVED, (msg) => {
    cancelOrderTimer();
    el.orderTimer.style.width = '0%';
    if (msg.ok) {
      flashOrder('good');
      el.orderText.textContent = 'NICE.';
      sfx.good();
      buzz(30);
    } else if (msg.reason === 'expired') {
      flashOrder('bad');
      el.orderText.textContent = 'TOO SLOW!';
      sfx.bad();
      buzz([60, 40, 60]);
    } else {
      el.orderText.textContent = 'STAND BY…';
    }
  })

  .on(S2C.ALL_HANDS, (msg) => {
    state.allHandsId = msg.id;
    cancelOrderTimer();
    el.allHandsText.textContent = msg.text;
    el.allHandsBtn.textContent = msg.short;
    el.allHandsBtn.dataset.kind = msg.kind;
    el.allHandsBtn.disabled = false;
    el.allHandsPending.textContent = motionHint(msg.kind);
    el.allHands.hidden = false;
    cancelAllHandsTimer();
    cancelAllHandsTimer = runTimerBar(el.allHandsTimer, msg.duration);
    motion.arm(msg.kind);
    sfx.alarm();
    buzz([80, 60, 80, 60, 80]);
  })

  .on(S2C.ALL_HANDS_PROGRESS, (msg) => {
    if (msg.id !== state.allHandsId) return;
    const waiting = msg.pending.length;
    if (!msg.pending.includes(state.playerId)) {
      el.allHandsBtn.disabled = true;
      el.allHandsBtn.textContent = 'DONE';
    }
    el.allHandsPending.textContent = waiting
      ? `Waiting on ${waiting} crewmate${waiting === 1 ? '' : 's'}…`
      : '';
  })

  .on(S2C.ALL_HANDS_DONE, (msg) => {
    if (msg.id !== state.allHandsId) return;
    state.allHandsId = null;
    motion.disarm();
    cancelAllHandsTimer();
    el.allHands.hidden = true;
    if (msg.ok) sfx.good();
    else {
      sfx.bad();
      buzz([120, 60, 120]);
    }
  })

  .on(S2C.WAVE, (msg) => {
    cancelOrderTimer();
    el.orderTimer.style.width = '0%';
    el.orderText.textContent = 'STAND BY…';
    el.waveDone.textContent = `WAVE ${msg.wave} CLEAR`;
    el.waveSub.textContent = `Hull patched to ${msg.hull}% · ${msg.score} pts`;
    el.waveOverlay.hidden = false;
    sfx.wave();
    setTimeout(() => {
      el.waveOverlay.hidden = true;
    }, 3200);
  })

  .on(S2C.GAME_OVER, (msg) => {
    cancelOrderTimer();
    cancelAllHandsTimer();
    motion.disarm();
    el.allHands.hidden = true;
    el.waveOverlay.hidden = true;
    el.countdown.hidden = true;
    el.overReason.textContent = msg.reason;
    el.overStats.replaceChildren(
      ...[
        ['Score', msg.score],
        ['Wave reached', msg.wave],
        ['Orders done', msg.completed],
        ['Orders fumbled', msg.missed],
      ].flatMap(([term, value]) => {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }),
    );
    el.over.hidden = false;
    forgetSeat();
    sfx.over();
    buzz([200, 80, 200]);
  })

  .on(S2C.ROUND, (msg) => {
    // A round in progress is worth rejoining, same as a console.
    armSeat();
    party.round(msg);
    show('party');
    sfx.order();
  })

  .on(S2C.SUBMITTED, (msg) => party.submitted(msg))

  .on(S2C.REVEAL, (msg) => {
    party.reveal(msg);
    sfx.wave();
    buzz(30);
  })

  .on(S2C.STANDINGS, (msg) => party.standings(msg))

  .on(S2C.SIDE, (msg) => side.state(msg))

  .on(S2C.SECRET, (msg) => side.word(msg))

  .on(S2C.CLAIM_ASK, (msg) => side.accusation(msg))

  .on(S2C.CLAIM_DONE, (msg) => {
    side.settled(msg);
    if (msg.ok) sfx.good();
  })

  .on(S2C.PARTY_OVER, (msg) => {
    party.over(msg);
    forgetSeat();
    sfx.over();
    buzz([200, 80, 200]);
  })

  .on(S2C.ERROR, (msg) => {
    if (state.rejoining) {
      // The seat is gone or taken; retrying cannot help.
      giveUp(msg.message);
      return;
    }
    if (el.screens.home.hasAttribute('data-active')) el.homeHint.textContent = msg.message;
    else toast(msg.message);
  });

  return transport;
}

wire(net);

// ─────────────────────────────── reconnecting ───────────────────────────────

/**
 * Get back into the game we were already in.
 *
 * A phone that sleeps loses its socket without warning, so this retries with a
 * backoff rather than dumping the player back at the start screen. The seat and
 * its console are held server-side for the grace period.
 */
const REJOIN_BACKOFF_MS = [500, 1000, 2000, 3000, 5000, 5000, 8000];

async function attemptRejoin() {
  const seat = recallSeat();
  if (!seat) {
    giveUp('Lost the connection to the ship.');
    return;
  }

  state.rejoining = true;
  el.rejoin.hidden = false;
  el.dead.hidden = true;

  while (state.rejoining) {
    const wait = REJOIN_BACKOFF_MS[Math.min(state.rejoinAttempt, REJOIN_BACKOFF_MS.length - 1)];
    el.rejoinSub.textContent =
      state.rejoinAttempt === 0 ? 'Holding your console.' : `Attempt ${state.rejoinAttempt + 1}…`;
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (!state.rejoining) return;

    state.rejoinAttempt++;
    try {
      await net.connect();
      net.send(C2S.RESUME, { code: seat.code, token: seat.token });
      return; // WELCOME or ERROR decides what happens next
    } catch {
      // Server still unreachable; the loop backs off and tries again.
    }
  }
}

function giveUp(reason) {
  state.rejoining = false;
  forgetSeat();
  el.rejoin.hidden = true;
  el.deadReason.textContent = reason;
  el.dead.hidden = false;
}

$('btn-give-up').addEventListener('click', () => giveUp('Left the ship.'));

net.onDown = () => {
  state.connected = false;
  if (state.rejoining) return;
  // Only a seat in a running game is worth rejoining; anything else is a plain
  // failure and belongs back at the start screen.
  if (recallSeat()) attemptRejoin();
  else giveUp('Lost the connection to the ship.');
};

// A phone that was asleep often only discovers the socket is dead on waking.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.rejoining || net.isOpen || !recallSeat()) return;
  attemptRejoin();
});

// ─────────────────────────────── countdown ───────────────────────────────

let countdownTimer = null;
function startCountdown(msLeft) {
  el.countdown.hidden = false;
  clearInterval(countdownTimer);
  const endsAt = performance.now() + msLeft;
  const paint = () => {
    const seconds = Math.ceil((endsAt - performance.now()) / 1000);
    el.countdownNumber.textContent = seconds > 0 ? seconds : 'GO';
    if (seconds <= 0) clearInterval(countdownTimer);
  };
  paint();
  countdownTimer = setInterval(paint, 200);
}

function motionHint(kind) {
  if (!motion.granted) return 'Tap the button!';
  return kind === ALL_HANDS.SHOUT ? 'Tap the button!' : 'Move your phone — or tap the button!';
}

// ───────────────────────── is there a server here? ─────────────────────────

/**
 * This same client is served by the Node server, by a hosting phone, and from
 * a static host with nothing behind it. Only the first two can do multiplayer,
 * so ask before offering it.
 */
async function detectServer() {
  try {
    const response = await fetch('/discover', { cache: 'no-store' });
    if (!response.ok) throw new Error('no server');
    const body = await response.json();
    if (body.app !== APP_ID) throw new Error('not our server');
    return body;
  } catch {
    return null;
  }
}

finder.paint();

/**
 * Keep the tables list honest while somebody is looking at it.
 *
 * Only on the home screen, and only every few seconds: a bar's WiFi is not the
 * place to poll hard, and a table that appears four seconds late is still a
 * table you can walk over to.
 */
function watchTables(on) {
  clearInterval(tablesTimer);
  tablesTimer = null;
  if (!on) return;
  finder.refresh();
  tablesTimer = setInterval(() => {
    if (document.visibilityState === 'visible') finder.refresh();
  }, TABLES_POLL_MS);
}

detectServer().then((server) => {
  if (!server) {
    // Static copy: there is no server here, so there is nobody to meet.
    el.multiplayer.hidden = true;
    el.staticNote.hidden = false;
    el.staticNote.innerHTML =
      'This is a static copy with no server behind it, so there is nobody here to ' +
      'play with — have a look around solo. For the real thing, run it on a laptop ' +
      'on the bar WiFi or <strong>host it from an Android phone</strong>; both are in ' +
      'the <a href="https://github.com/ThatMrE/Spoon-Knife" rel="noreferrer">repository</a>.';
    return;
  }

  if (server.public) {
    // On a bar's WiFi the code only reaches the room you are in. Here it reaches
    // anyone who types it, which is worth saying before you shout it.
    el.staticNote.hidden = false;
    el.staticNote.textContent =
      'This one is on the open internet rather than a bar WiFi, so your four-letter ' +
      'code is the only thing keeping strangers out. Read it to the next table, not ' +
      'to a livestream.';
  }
  watchTables(true);
});

// Browsers keep audio muted until a real gesture; the first tap anywhere pays for it.
document.addEventListener('pointerdown', unlockAudio, { once: true });
