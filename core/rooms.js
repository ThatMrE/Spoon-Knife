/**
 * Rooms: the lobby half of the server. Owns codes, crew rosters, ready state
 * and the tick loop that drives each room's Game.
 */
import { C2S, LIMITS, PHASE, S2C } from '../shared/protocol.js';
import { CATALOGUE, DEFAULT_GAME, catalogueEntry, createEngine, isGame } from './games/index.js';

/** No I/O/0/1 — these get read aloud and typed in on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TICK_MS = 200;
const EMPTY_ROOM_GRACE_MS = 60_000;
/**
 * Rooms one process will hold at once.
 *
 * Unbounded room creation is free resource exhaustion for anyone who can reach
 * the server, which stopped being only your living room when it went public.
 */
const MAX_ROOMS = 200;

let nextPlayerId = 1;

/**
 * A secret handed to each player so a dropped phone can prove which seat was
 * theirs. Names are not enough: they collide, and they are guessable by anyone
 * else on the WiFi who watched the lobby.
 */
function makeToken() {
  let token = '';
  for (let i = 0; i < 4; i++) token += Math.random().toString(36).slice(2, 10);
  return token;
}

function sanitizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.NAME_MAX);
  return name || `Crew ${Math.floor(Math.random() * 90 + 10)}`;
}

/** Stands in for a departed connection so nothing has to null-check sends. */
const SILENT_CONNECTION = { send() {} };

export class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.phase = PHASE.LOBBY;
    this.hostId = null;
    /** @type {Map<string, {id, name, ready, connection}>} */
    this.players = new Map();
    this.emptySince = Date.now();
    this.lastResult = null;

    this.gameKey = DEFAULT_GAME;
    this.game = this.makeEngine();
    this.timer = null;
  }

  /**
   * Build the engine for the chosen game.
   *
   * Rebuilt rather than reset on every launch, because a game's whole state —
   * chips, secret words, which prompts have been used — belongs to one run.
   */
  makeEngine() {
    return createEngine(this.gameKey, {
      transport: {
        toPlayer: (playerId, message) => this.players.get(playerId)?.connection.send(message),
        toAll: (message) => this.broadcast(message),
      },
    });
  }

  /** The host chooses what the room is playing. */
  pickGame(playerId, key) {
    if (playerId !== this.hostId) return { error: 'Only the host can pick the game.' };
    if (this.phase !== PHASE.LOBBY) return { error: 'Finish this one first.' };
    if (!isGame(key)) return { error: 'No such game.' };
    if (key === this.gameKey) return {};

    this.gameKey = key;
    this.game = this.makeEngine();
    this.pushLobby();
    return {};
  }

  broadcast(message) {
    for (const player of this.players.values()) {
      if (player.connected) player.connection.send(message);
    }
  }

  get isEmpty() {
    return this.players.size === 0;
  }

  add(connection, rawName) {
    if (this.players.size >= LIMITS.MAX_PLAYERS) {
      return { error: 'That ship is full.' };
    }
    if (this.phase !== PHASE.LOBBY) {
      return { error: 'That game is already under way. Wait for the crew to land.' };
    }

    const id = `p${nextPlayerId++}`;
    const player = {
      id,
      name: sanitizeName(rawName),
      ready: false,
      connection,
      token: makeToken(),
      connected: true,
      graceTimer: null,
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.emptySince = null;

    connection.send({
      t: S2C.WELCOME,
      playerId: id,
      code: this.code,
      isHost: this.hostId === id,
      token: player.token,
      resumed: false,
    });
    this.pushLobby();
    return { player };
  }

  /**
   * Put a dropped player back in their own seat, with their own console.
   *
   * Only valid mid-game: a drop in the lobby just removes you, and rejoining
   * there is a normal join.
   */
  resume(connection, token) {
    const player = [...this.players.values()].find((p) => p.token === token);
    if (!player) {
      return { error: 'That seat is gone. The crew may have given up on you.' };
    }
    if (player.connected) {
      return { error: 'Somebody is already aboard in that seat.' };
    }

    this.clearGrace(player);
    player.connection = connection;
    player.connected = true;

    connection.send({
      t: S2C.WELCOME,
      playerId: player.id,
      code: this.code,
      isHost: this.hostId === player.id,
      token: player.token,
      resumed: true,
    });
    this.pushLobby();
    this.broadcast({ t: S2C.CREW, name: player.name, connected: true });

    if (this.phase === PHASE.PLAYING) this.game.setConnected(player.id, true);
    return { player };
  }

  /**
   * A connection went away. Mid-game that starts a grace period rather than
   * emptying the seat, so a phone that slept or lost WiFi can come back to the
   * console it was using.
   */
  disconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.connected) return;

    if (this.phase !== PHASE.PLAYING) {
      this.remove(playerId);
      return;
    }

    player.connected = false;
    player.connection = SILENT_CONNECTION;
    this.game.setConnected(playerId, false);
    this.broadcast({ t: S2C.CREW, name: player.name, connected: false });
    this.pushLobby();

    // If nobody comes back, the seat is eventually cleared for good.
    player.graceTimer = setTimeout(() => {
      player.graceTimer = null;
      this.remove(playerId);
    }, LIMITS.RESUME_GRACE_MS);
    // A seat waiting to be reclaimed must not be a reason for the process to
    // stay alive: without this, anything embedding the server waits out the
    // full grace period before it can exit (it made the test suite take 100
    // seconds instead of 10). Browsers hand back a plain number, hence the
    // optional call.
    player.graceTimer.unref?.();

    if (this.game.isOver) this.finish();
  }

  clearGrace(player) {
    if (!player.graceTimer) return;
    clearTimeout(player.graceTimer);
    player.graceTimer = null;
  }

  remove(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.clearGrace(player);
    this.players.delete(playerId);

    if (this.hostId === playerId) {
      this.hostId = this.players.keys().next().value ?? null;
    }
    if (this.phase === PHASE.PLAYING) {
      this.game.removePlayer(playerId);
      if (this.game.isOver) this.finish();
    }
    if (this.isEmpty) {
      this.emptySince = Date.now();
      this.stopTimer();
    } else {
      this.pushLobby();
    }
  }

  setReady(playerId, ready) {
    const player = this.players.get(playerId);
    if (!player || this.phase !== PHASE.LOBBY) return;
    player.ready = Boolean(ready);
    this.pushLobby();
  }

  start(playerId) {
    if (playerId !== this.hostId) return { error: 'Only the host can launch.' };
    if (this.phase !== PHASE.LOBBY) return { error: 'Already flying.' };
    if (this.players.size < LIMITS.MIN_PLAYERS) return { error: 'Nobody aboard.' };

    const game = catalogueEntry(this.gameKey);
    const aboard = [...this.players.values()].filter((p) => p.connected);
    if (aboard.length < game.minPlayers) {
      return {
        error: `${game.title} needs ${game.minPlayers} player${game.minPlayers === 1 ? '' : 's'}.`,
      };
    }

    const slackers = [...this.players.values()].filter(
      (p) => p.id !== this.hostId && p.connected && !p.ready,
    );
    if (slackers.length) {
      return { error: `Waiting on ${slackers.map((p) => p.name).join(', ')}.` };
    }

    this.phase = PHASE.PLAYING;
    this.lastResult = null;
    this.game = this.makeEngine();
    this.game.start(aboard.map(({ id, name }) => ({ id, name })));
    this.pushLobby();
    this.startTimer();
    return {};
  }

  restart(playerId) {
    if (playerId !== this.hostId) return { error: 'Only the host can reset the ship.' };
    this.stopTimer();
    this.phase = PHASE.LOBBY;
    for (const player of this.players.values()) player.ready = false;
    this.pushLobby();
    return {};
  }

  finish() {
    this.stopTimer();
    this.phase = PHASE.LOBBY;
    // Seats are only held for the duration of a run.
    for (const player of [...this.players.values()]) {
      this.clearGrace(player);
      if (!player.connected) this.players.delete(player.id);
    }
    this.lastResult = this.game.result();
    for (const player of this.players.values()) player.ready = false;
    this.pushLobby();
  }

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.game.tick();
      if (this.game.isOver) this.finish();
    }, TICK_MS);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pushLobby() {
    this.broadcast({
      t: S2C.LOBBY,
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      lastResult: this.lastResult,
      game: this.gameKey,
      games: CATALOGUE,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        isHost: p.id === this.hostId,
        connected: p.connected,
      })),
    });
  }
}

/** Allows everything; a public deployment supplies a real one. */
const OPEN_GUARD = {
  allowJoin: () => true,
  retryAfterSeconds: () => 0,
  noteJoinFailure() {},
  noteJoinSuccess() {},
};

export class RoomManager {
  /**
   * @param {object} [options]
   * @param {object} [options.guard] abuse limits, for an internet-facing server
   */
  constructor(options = {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.guard = options.guard ?? OPEN_GUARD;
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  newCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < LIMITS.CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a room code');
  }

  create() {
    if (this.rooms.size >= MAX_ROOMS) return null;
    const code = this.newCode();
    const room = new Room(code, this);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').toUpperCase().trim());
  }

  /** Reclaim rooms whose crew all wandered off. */
  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isEmpty && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
        room.stopTimer();
        this.rooms.delete(code);
      }
    }
  }

  /** Wire one client connection into the lobby/game protocol. */
  attach(connection) {
    const session = { room: null, playerId: null };

    const fail = (message, fatal = false) =>
      connection.send({ t: S2C.ERROR, message, fatal });

    connection.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;

      switch (msg.t) {
        case C2S.CREATE: {
          if (session.room) return;
          const room = this.create();
          if (!room) return fail('This server is holding as many ships as it can.');
          const { player, error } = room.add(connection, msg.name);
          if (error) return fail(error);
          session.room = room;
          session.playerId = player.id;
          break;
        }

        case C2S.JOIN: {
          if (session.room) return;
          const address = connection.data?.address ?? 'local';
          if (!this.guard.allowJoin(address)) {
            const wait = this.guard.retryAfterSeconds(address);
            return fail(`Too many wrong codes. Try again in ${wait}s.`);
          }

          const room = this.get(msg.code);
          if (!room) {
            // Only a miss counts: a wrong code is what guessing looks like.
            this.guard.noteJoinFailure(address);
            return fail(`No ship with code ${String(msg.code ?? '').toUpperCase()}.`);
          }
          const { player, error } = room.add(connection, msg.name);
          if (error) return fail(error);
          this.guard.noteJoinSuccess(address);
          session.room = room;
          session.playerId = player.id;
          break;
        }

        case C2S.RESUME: {
          if (session.room) return;
          const address = connection.data?.address ?? 'local';
          if (!this.guard.allowJoin(address)) {
            return fail(`Too many wrong codes. Try again in ${this.guard.retryAfterSeconds(address)}s.`, true);
          }
          const room = this.get(msg.code);
          if (!room) {
            this.guard.noteJoinFailure(address);
            return fail(`No ship with code ${String(msg.code ?? '').toUpperCase()}.`, true);
          }
          const { player, error } = room.resume(connection, String(msg.token ?? ''));
          if (error) {
            // A bad token is a guess at somebody's seat, same as a bad code.
            this.guard.noteJoinFailure(address);
            return fail(error, true);
          }
          this.guard.noteJoinSuccess(address);
          session.room = room;
          session.playerId = player.id;
          break;
        }

        case C2S.READY:
          session.room?.setReady(session.playerId, msg.ready);
          break;

        case C2S.START: {
          const result = session.room?.start(session.playerId);
          if (result?.error) fail(result.error);
          break;
        }

        case C2S.RESTART: {
          const result = session.room?.restart(session.playerId);
          if (result?.error) fail(result.error);
          break;
        }

        case C2S.PICK_GAME: {
          const result = session.room?.pickGame(session.playerId, String(msg.game ?? ''));
          if (result?.error) fail(result.error);
          break;
        }

        // Everything a game itself understands goes to the engine unread: the
        // room does not know or care which game it is hosting.
        case C2S.CONTROL:
        case C2S.MOTION:
        case C2S.SUBMIT:
        case C2S.CLAIM:
        case C2S.CONFIRM:
          session.room?.game.input(session.playerId, msg);
          break;

        case C2S.LEAVE:
          if (session.room) {
            session.room.remove(session.playerId);
            session.room = null;
            session.playerId = null;
          }
          break;
      }
    });

    connection.on('close', () => {
      // Mid-game this holds the seat open for a while instead of emptying it;
      // in the lobby it is an immediate removal.
      if (session.room) session.room.disconnect(session.playerId);
      session.room = null;
      session.playerId = null;
    });
  }
}
