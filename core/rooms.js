/**
 * Rooms: the lobby half of the server. Owns codes, crew rosters, ready state
 * and the tick loop that drives each room's Game.
 */
import { C2S, LIMITS, PHASE, S2C } from '../shared/protocol.js';
import { Game } from './game.js';

/** No I/O/0/1 — these get read aloud and typed in on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TICK_MS = 200;
const EMPTY_ROOM_GRACE_MS = 60_000;

let nextPlayerId = 1;

function sanitizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.NAME_MAX);
  return name || `Crew ${Math.floor(Math.random() * 90 + 10)}`;
}

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

    this.game = new Game({
      transport: {
        toPlayer: (playerId, message) => this.players.get(playerId)?.connection.send(message),
        toAll: (message) => this.broadcast(message),
      },
    });
    this.timer = null;
  }

  broadcast(message) {
    for (const player of this.players.values()) player.connection.send(message);
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
    const player = { id, name: sanitizeName(rawName), ready: false, connection };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.emptySince = null;

    connection.send({ t: S2C.WELCOME, playerId: id, code: this.code, isHost: this.hostId === id });
    this.pushLobby();
    return { player };
  }

  remove(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
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

    const slackers = [...this.players.values()].filter((p) => p.id !== this.hostId && !p.ready);
    if (slackers.length) {
      return { error: `Waiting on ${slackers.map((p) => p.name).join(', ')}.` };
    }

    this.phase = PHASE.PLAYING;
    this.lastResult = null;
    this.game.start([...this.players.values()].map(({ id, name }) => ({ id, name })));
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
    this.lastResult = { score: this.game.score, wave: this.game.wave };
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
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        isHost: p.id === this.hostId,
      })),
    });
  }
}

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
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
          const { player, error } = room.add(connection, msg.name);
          if (error) return fail(error);
          session.room = room;
          session.playerId = player.id;
          break;
        }

        case C2S.JOIN: {
          if (session.room) return;
          const room = this.get(msg.code);
          if (!room) return fail(`No ship with code ${String(msg.code ?? '').toUpperCase()}.`);
          const { player, error } = room.add(connection, msg.name);
          if (error) return fail(error);
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

        case C2S.CONTROL:
          session.room?.game.handleControl(session.playerId, msg.controlId, msg.value);
          break;

        case C2S.MOTION:
          session.room?.game.handleMotion(session.playerId, msg.kind);
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
      if (session.room) session.room.remove(session.playerId);
      session.room = null;
      session.playerId = null;
    });
  }
}
