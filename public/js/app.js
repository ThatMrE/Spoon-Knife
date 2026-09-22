/**
 * Screen flow and message handling for the client.
 */
import { ALL_HANDS, C2S, PHASE, S2C } from '/shared/protocol.js';
import { Net } from '/js/net.js';
import { buzz, sfx, unlockAudio } from '/js/feedback.js';
import { MotionWatcher } from '/js/motion.js';
import { renderGizmo } from '/js/gizmos.js';

const $ = (id) => document.getElementById(id);

const el = {
  screens: { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game') },
  name: $('input-name'),
  code: $('input-code'),
  homeHint: $('home-hint'),
  lobbyCode: $('lobby-code'),
  lobbyCrew: $('lobby-crew'),
  lobbyCount: $('lobby-count'),
  lobbyHint: $('lobby-hint'),
  lobbyResult: $('lobby-result'),
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
  toast: $('toast'),
};

const state = {
  playerId: null,
  isHost: false,
  ready: false,
  connected: false,
  allHandsId: null,
};

const net = new Net();
const motion = new MotionWatcher((kind) => net.send(C2S.MOTION, { kind }));

// ───────────────────────────────── helpers ─────────────────────────────────

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) node.toggleAttribute('data-active', key === name);
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
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

el.name.value = localStorage.getItem('spaceteam:name') ?? '';
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
  localStorage.setItem('spaceteam:name', name);
  el.homeHint.textContent = 'Connecting…';

  try {
    if (!state.connected) {
      await net.connect();
      state.connected = true;
    }
    net.send(type, { name, ...extra });
    el.homeHint.textContent = '';
  } catch {
    el.homeHint.textContent = 'Could not reach the ship. Same WiFi as the host?';
  }
}

$('btn-create').addEventListener('click', () => enter(C2S.CREATE));
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

el.btnStart.addEventListener('click', async () => {
  await motion.request();
  net.send(C2S.START);
});

$('btn-leave').addEventListener('click', () => {
  net.send(C2S.LEAVE);
  location.reload();
});

el.btnAgain.addEventListener('click', () => {
  el.over.hidden = true;
  show('lobby');
});

$('btn-reload').addEventListener('click', () => location.reload());

// ─────────────────────────────── all hands ───────────────────────────────

el.allHandsBtn.addEventListener('click', () => {
  if (!state.allHandsId) return;
  net.send(C2S.MOTION, { kind: el.allHandsBtn.dataset.kind });
});

// ───────────────────────────── server messages ─────────────────────────────

net
  .on(S2C.WELCOME, (msg) => {
    state.playerId = msg.playerId;
    state.isHost = msg.isHost;
    el.lobbyCode.textContent = msg.code;
    show('lobby');
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

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = player.name;

        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = player.isHost ? 'HOST' : player.ready ? 'READY' : 'WAITING';

        li.append(who, tag);
        return li;
      }),
    );

    el.btnStart.hidden = !state.isHost;
    el.btnReady.hidden = state.isHost;
    el.lobbyHint.textContent = state.isHost
      ? 'Everyone needs to be ready before you can launch.'
      : '';

    if (msg.lastResult) {
      el.lobbyResult.hidden = false;
      el.lobbyResult.textContent = `Last run: wave ${msg.lastResult.wave} · ${msg.lastResult.score} pts`;
    }

    if (msg.phase === PHASE.LOBBY && el.screens.game.hasAttribute('data-active')) show('lobby');
  })

  .on(S2C.PANEL, (msg) => {
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
    sfx.over();
    buzz([200, 80, 200]);
  })

  .on(S2C.ERROR, (msg) => {
    if (el.screens.home.hasAttribute('data-active')) el.homeHint.textContent = msg.message;
    else toast(msg.message);
  });

net.onDown = () => {
  state.connected = false;
  el.dead.hidden = false;
};

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

// Browsers keep audio muted until a real gesture; the first tap anywhere pays for it.
document.addEventListener('pointerdown', unlockAudio, { once: true });
