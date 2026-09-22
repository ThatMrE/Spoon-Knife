/**
 * The Spaceteam loop.
 *
 * Every player holds a console of gizmos nobody else can see, and is handed an
 * instruction for a gizmo that is usually on somebody *else's* console. The only
 * way to resolve it is to shout it across the room. Miss the deadline and the
 * hull takes it.
 *
 * This module is pure game state driven by `tick(now)`, with no knowledge of
 * sockets, so it can be tested by stepping a fake clock.
 */
import { ALL_HANDS, PHASE, S2C } from '../shared/protocol.js';
import { ALL_HANDS_COPY, phrase, pick } from './jargon.js';
import {
  applyInput,
  isSatisfied,
  makePanel,
  makeRequirement,
  panelSize,
  publicControl,
} from './panel.js';

const MAX_HULL = 100;
const COUNTDOWN_MS = 3500;
const WAVE_BREAK_MS = 4000;
const ALL_HANDS_COOLDOWN_MS = 15_000;
/** Wave 1 never has emergencies, so the first roll is timed for wave 2's start. */
const FIRST_ALL_HANDS_MS = 8000;
const ALL_HANDS_RETRY_MS = 2500;
const ALL_HANDS_WINDOW_MS = 6000;
const ALL_HANDS_KINDS = Object.values(ALL_HANDS);

/** Difficulty curve. Exported so the tuning is visible and testable. */
export function difficulty(wave, playerCount) {
  return {
    // Instructions get tighter every wave, but never unreadable.
    instructionMs: Math.max(4000, Math.round(13_000 * 0.88 ** (wave - 1))),
    // More crew means more instructions land in parallel, so the goal scales.
    goal: playerCount * (4 + wave),
    // A miss hurts more the deeper you get.
    damage: Math.min(24, 8 + wave * 2),
    // Whole-crew emergencies show up from wave 2, increasingly often.
    allHandsChance: wave < 2 ? 0 : Math.min(0.55, 0.2 + wave * 0.05),
  };
}

export class Game {
  /**
   * @param {object} options
   * @param {{toPlayer(id, msg): void, toAll(msg): void}} options.transport
   * @param {() => number} [options.random] injectable for deterministic tests
   */
  constructor({ transport, random = Math.random }) {
    this.transport = transport;
    this.random = random;
    this._now = 0;

    this.phase = PHASE.LOBBY;
    this.wave = 0;
    this.hull = MAX_HULL;
    this.progress = 0;
    this.goal = 0;
    this.score = 0;
    this.completed = 0;
    this.missed = 0;

    /** @type {Map<string, {id: string, name: string, panel: object[], instruction: object|null}>} */
    this.players = new Map();
    /** controlId -> { control, ownerId } */
    this.controls = new Map();
    this.allHands = null;
    this.phaseUntil = 0;
    this.nextAllHandsAt = 0;
    this._nextInstructionId = 1;
    this._labels = new Set();
  }

  get playerCount() {
    return this.players.size;
  }

  get isOver() {
    return this.phase === PHASE.OVER;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Begin a run with the given crew. `roster` is [{id, name}]. */
  start(roster, now = Date.now()) {
    this._now = now;
    this.phase = PHASE.COUNTDOWN;
    this.wave = 1;
    this.hull = MAX_HULL;
    this.score = 0;
    this.completed = 0;
    this.missed = 0;
    this.players.clear();
    for (const { id, name } of roster) {
      this.players.set(id, { id, name, panel: [], instruction: null });
    }
    this._dealPanels();
    this.progress = 0;
    this.goal = difficulty(this.wave, this.playerCount).goal;
    this.phaseUntil = now + COUNTDOWN_MS;
    this.nextAllHandsAt = now + COUNTDOWN_MS + FIRST_ALL_HANDS_MS;
    this._pushState();
  }

  /** Drive the clock. Safe to call as often as you like. */
  tick(now = Date.now()) {
    this._now = now;
    switch (this.phase) {
      case PHASE.COUNTDOWN:
        if (now >= this.phaseUntil) {
          this.phase = PHASE.PLAYING;
          this._pushState();
          this._issueAll(now);
        }
        break;

      case PHASE.PLAYING:
        if (this.allHands) this._tickAllHands(now);
        else this._tickInstructions(now);
        break;

      case PHASE.WAVE_BREAK:
        if (now >= this.phaseUntil) this._beginWave(now);
        break;
    }
  }

  // ------------------------------------------------------------ crew changes

  /**
   * A player dropped off the WiFi mid-run. Their console goes with them, so
   * anything pointing at it has to be torn down and reissued.
   */
  removePlayer(playerId, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player) return;

    for (const control of player.panel) this.controls.delete(control.id);
    this.players.delete(playerId);

    if (this.phase !== PHASE.PLAYING && this.phase !== PHASE.COUNTDOWN) return;

    if (this.players.size === 0) {
      this._gameOver('The whole crew abandoned ship.');
      return;
    }

    if (this.allHands) {
      this.allHands.pending.delete(playerId);
      if (this.allHands.pending.size === 0) this._resolveAllHands(true, now);
      return;
    }

    // Reissue anything that referred to a console that just vanished.
    for (const other of this.players.values()) {
      if (other.instruction && !this.controls.has(other.instruction.controlId)) {
        this._resolve(other, false, 'gone', now);
      }
    }
  }

  // ------------------------------------------------------------ player input

  /** A client reports touching one of its own controls. */
  handleControl(playerId, controlId, value, now = Date.now()) {
    if (this.phase !== PHASE.PLAYING || this.allHands) return;
    const entry = this.controls.get(controlId);
    if (!entry || entry.ownerId !== playerId) return;
    if (!applyInput(entry.control, value)) return;

    // Whoever is holding the matching instruction gets the credit.
    for (const player of this.players.values()) {
      const instruction = player.instruction;
      if (!instruction || instruction.controlId !== controlId) continue;
      if (isSatisfied(entry.control, instruction.requirement)) {
        this._resolve(player, true, 'done', now);
      }
      return;
    }
  }

  /** A client reports a shake/tilt/flip, or taps the on-screen fallback. */
  handleMotion(playerId, kind, now = Date.now()) {
    if (!this.allHands || !this.players.has(playerId)) return;
    if (kind !== this.allHands.kind) return;
    if (!this.allHands.pending.delete(playerId)) return;

    if (this.allHands.pending.size === 0) {
      this._resolveAllHands(true, now);
      return;
    }
    this.transport.toAll({
      t: S2C.ALL_HANDS_PROGRESS,
      id: this.allHands.id,
      pending: [...this.allHands.pending],
    });
  }

  // --------------------------------------------------------------- internals

  _dealPanels() {
    this.controls.clear();
    this._labels.clear();
    const size = panelSize(this.playerCount, this.wave);
    for (const player of this.players.values()) {
      player.panel = makePanel(size, this._labels, this.random);
      player.instruction = null;
      for (const control of player.panel) {
        this.controls.set(control.id, { control, ownerId: player.id });
      }
      this.transport.toPlayer(player.id, {
        t: S2C.PANEL,
        wave: this.wave,
        controls: player.panel.map(publicControl),
      });
    }
  }

  _beginWave(now) {
    this.phase = PHASE.PLAYING;
    this.progress = 0;
    this.goal = difficulty(this.wave, this.playerCount).goal;
    this._dealPanels();
    // Deliberately NOT touching nextAllHandsAt here. The emergency schedule is
    // anchored to the last emergency, not to wave boundaries: nudging it at
    // every wave start starves exactly the crews who are playing well, because
    // they clear waves faster than the nudge.
    this._pushState();
    this._issueAll(now);
  }

  _issueAll(now) {
    for (const player of this.players.values()) {
      if (!player.instruction) this._issue(player, now);
    }
  }

  /**
   * Hand `player` something to shout. The control is picked from the whole
   * ship, preferring somebody else's console — that's the entire game.
   */
  _issue(player, now) {
    const targeted = new Set();
    for (const other of this.players.values()) {
      if (other.instruction) targeted.add(other.instruction.controlId);
    }

    const free = [...this.controls.values()].filter((entry) => !targeted.has(entry.control.id));
    if (free.length === 0) return; // tiny crew, everything is spoken for

    const others = free.filter((entry) => entry.ownerId !== player.id);
    const mine = free.filter((entry) => entry.ownerId === player.id);
    // 80% somebody else's gizmo when we have the choice; the rest keeps players
    // honest about reading their own panel too.
    const pool = others.length && (this.random() < 0.8 || mine.length === 0) ? others : mine;
    const entry = pick(pool, this.random);
    const requirement = makeRequirement(entry.control, this.random);
    const { instructionMs } = difficulty(this.wave, this.playerCount);

    player.instruction = {
      id: `i${this._nextInstructionId++}`,
      controlId: entry.control.id,
      requirement,
      text: phrase(entry.control, requirement.value, this.random),
      issuedAt: now,
      expiresAt: now + instructionMs,
    };

    this.transport.toPlayer(player.id, {
      t: S2C.INSTRUCTION,
      id: player.instruction.id,
      text: player.instruction.text,
      duration: instructionMs,
      deadline: player.instruction.expiresAt,
    });
  }

  _resolve(player, ok, reason, now) {
    const instruction = player.instruction;
    if (!instruction) return;
    player.instruction = null;

    this.transport.toPlayer(player.id, { t: S2C.RESOLVED, id: instruction.id, ok, reason });

    if (ok) {
      this.completed++;
      this.progress++;
      this.score += 10 * this.wave;
    } else if (reason === 'expired') {
      this.missed++;
      this.hull -= difficulty(this.wave, this.playerCount).damage;
    }

    this._pushState();

    if (this.hull <= 0) {
      this._gameOver('The hull gave out.');
      return;
    }
    if (this.progress >= this.goal) {
      this._completeWave(now);
      return;
    }
    if (this.phase === PHASE.PLAYING && !this.allHands) this._issue(player, now);
  }

  _tickInstructions(now) {
    if (now >= this.nextAllHandsAt && this._maybeAllHands(now)) return;

    for (const player of this.players.values()) {
      if (player.instruction && now >= player.instruction.expiresAt) {
        this._resolve(player, false, 'expired', now);
        if (this.phase !== PHASE.PLAYING) return;
      }
    }
  }

  _maybeAllHands(now) {
    const { allHandsChance } = difficulty(this.wave, this.playerCount);
    if (allHandsChance === 0 || this.random() > allHandsChance) {
      // Not this time — check again shortly rather than every tick.
      this.nextAllHandsAt = now + ALL_HANDS_RETRY_MS;
      return false;
    }

    // Clear the board: an emergency interrupts everything.
    for (const player of this.players.values()) {
      if (!player.instruction) continue;
      this.transport.toPlayer(player.id, {
        t: S2C.RESOLVED,
        id: player.instruction.id,
        ok: false,
        reason: 'interrupted',
      });
      player.instruction = null;
    }

    const kind = pick(ALL_HANDS_KINDS, this.random);
    this.allHands = {
      id: `ah${this._nextInstructionId++}`,
      kind,
      pending: new Set(this.players.keys()),
      expiresAt: now + ALL_HANDS_WINDOW_MS,
    };
    this.transport.toAll({
      t: S2C.ALL_HANDS,
      id: this.allHands.id,
      kind,
      text: ALL_HANDS_COPY[kind].text,
      short: ALL_HANDS_COPY[kind].short,
      duration: ALL_HANDS_WINDOW_MS,
      deadline: this.allHands.expiresAt,
    });
    return true;
  }

  _tickAllHands(now) {
    if (now < this.allHands.expiresAt) return;
    this._resolveAllHands(false, now);
  }

  _resolveAllHands(ok, now) {
    const { id, pending } = this.allHands;
    this.allHands = null;
    this.transport.toAll({ t: S2C.ALL_HANDS_DONE, id, ok, pending: [...pending] });

    if (ok) {
      // Pulling together is worth a chunk of the wave.
      this.completed += this.playerCount;
      this.progress += this.playerCount;
      this.score += 25 * this.wave * this.playerCount;
    } else {
      this.missed++;
      this.hull -= Math.round(difficulty(this.wave, this.playerCount).damage * 1.5);
    }

    this.nextAllHandsAt = now + ALL_HANDS_COOLDOWN_MS;
    this._pushState();

    if (this.hull <= 0) {
      this._gameOver('The hull gave out.');
      return;
    }
    if (this.progress >= this.goal) {
      this._completeWave(now);
      return;
    }
    this._issueAll(now);
  }

  _completeWave(now) {
    this.phase = PHASE.WAVE_BREAK;
    this.score += 100 * this.wave;
    this.hull = Math.min(MAX_HULL, this.hull + 12);

    for (const player of this.players.values()) {
      if (!player.instruction) continue;
      this.transport.toPlayer(player.id, {
        t: S2C.RESOLVED,
        id: player.instruction.id,
        ok: false,
        reason: 'waveEnd',
      });
      player.instruction = null;
    }
    this.allHands = null;

    this.transport.toAll({ t: S2C.WAVE, wave: this.wave, hull: this.hull, score: this.score });
    this.wave++;
    this.phaseUntil = now + WAVE_BREAK_MS;
    this._pushState();
  }

  _gameOver(reason) {
    this.phase = PHASE.OVER;
    this.hull = Math.max(0, this.hull);
    this.allHands = null;
    for (const player of this.players.values()) player.instruction = null;
    this.transport.toAll({
      t: S2C.GAME_OVER,
      reason,
      score: this.score,
      wave: this.wave,
      completed: this.completed,
      missed: this.missed,
    });
    this._pushState();
  }

  _pushState() {
    this.transport.toAll({
      t: S2C.STATE,
      phase: this.phase,
      wave: this.wave,
      hull: Math.max(0, this.hull),
      maxHull: MAX_HULL,
      progress: Math.min(this.progress, this.goal),
      goal: this.goal,
      score: this.score,
      startsIn: this.phase === PHASE.COUNTDOWN ? Math.max(0, this.phaseUntil - this._now) : 0,
    });
  }
}
