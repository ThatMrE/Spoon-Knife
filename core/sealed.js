/**
 * Sealed rounds: the primitive under most of the party games.
 *
 * Deal something private, collect exactly one sealed answer per player before a
 * deadline, then reveal every answer at the same instant and score it.
 *
 * The simultaneous reveal is the whole design. Nobody can react to somebody
 * else's answer, so bluffing and second-guessing are real; and because the
 * answers are only compared after the deadline, a slow phone on bar WiFi is
 * never a disadvantage. That is what makes these games work in a room where
 * Spaceteam's millisecond deadlines would not.
 *
 * A game is a *definition* — prompts, an input shape and a scoring function —
 * and nothing else. See core/games/ for three of them.
 *
 * Pure state driven by `tick(now)`, with no knowledge of sockets, exactly like
 * core/game.js, so tests step a fake clock instead of sleeping.
 */
import { C2S, PHASE, S2C } from '../shared/protocol.js';

/** Resolve a definition field that may be a per-player function. */
function per(value, player, state) {
  return typeof value === 'function' ? value(player, state) : value;
}

export class SealedRounds {
  /**
   * @param {object} options
   * @param {object} options.definition the game — see core/games/
   * @param {{toPlayer(id, msg): void, toAll(msg): void}} options.transport
   * @param {() => number} [options.random] injectable for deterministic tests
   */
  constructor({ definition, transport, random = Math.random }) {
    this.definition = definition;
    this.transport = transport;
    this.random = random;

    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.rounds = definition.rounds;
    /** @type {Map<string, {id: string, name: string, connected: boolean, score: number}>} */
    this.players = new Map();
    /** @type {Map<string, any>} */
    this.submissions = new Map();
    this.deal = null;
    this.state = {};
    /** 'collect' while answers are being taken, 'reveal' while one is on screen. */
    this.stage = null;
    this.until = 0;
    this.endedReason = null;
  }

  get playerCount() {
    return this.players.size;
  }

  get connectedCount() {
    let count = 0;
    for (const player of this.players.values()) if (player.connected) count++;
    return count;
  }

  get isOver() {
    return this.phase === PHASE.OVER;
  }

  /** Scores, highest first. Ties keep the order players joined in. */
  get standings() {
    return [...this.players.values()]
      .map(({ id, name, score, connected }) => ({ id, name, score, connected }))
      .sort((a, b) => b.score - a.score);
  }

  start(roster, now = Date.now()) {
    this.players.clear();
    for (const { id, name } of roster) {
      this.players.set(id, { id, name, connected: true, score: 0 });
    }
    this.phase = PHASE.PLAYING;
    this.round = 0;
    this.endedReason = null;
    this.state = this.definition.setup?.({ players: this.players, random: this.random }) ?? {};
    this._deal(now);
  }

  tick(now = Date.now()) {
    if (this.phase !== PHASE.PLAYING || now < this.until) return;

    if (this.stage === 'collect') this._resolve(now);
    else if (this.stage === 'reveal') this._advance(now);
  }

  /**
   * Route a client message. Rooms hand every game the same shape, so they do
   * not need to know which game they are hosting.
   */
  input(playerId, msg, now = Date.now()) {
    if (msg?.t !== C2S.SUBMIT) return;
    if (this.phase !== PHASE.PLAYING || this.stage !== 'collect') return;

    const player = this.players.get(playerId);
    if (!player) return;
    // A submission stamped with the previous round is a tap that lost a race
    // with the deadline. Silently dropping it beats scoring it in this round.
    if (msg.round !== this.round) return;

    const cleaned = this.definition.clean(msg.value, {
      playerId,
      player,
      players: this.players,
      state: this.state,
      deal: this.deal,
    });
    if (cleaned === undefined) return;

    // Changing your mind is allowed and silent. Only a *new* answer is worth a
    // broadcast — otherwise one phone tapping repeatedly turns into a message
    // to every other phone in the room, which is free amplification on a
    // server anyone can reach.
    const isNew = !this.submissions.has(playerId);
    this.submissions.set(playerId, cleaned);
    if (isNew) {
      this.transport.toAll({
        t: S2C.SUBMITTED,
        round: this.round,
        count: this.submissions.size,
        of: this.connectedCount,
      });
    }

    // Nobody should wait out a deadline everyone has already answered.
    if (this._everyoneIn()) this._resolve(now);
  }

  setConnected(playerId, connected, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;

    if (connected) {
      // Put them straight into the round in progress rather than leaving a
      // blank screen until the next deal.
      if (this.phase === PHASE.PLAYING && this.stage === 'collect') this._sendRound(player, now);
      return;
    }
    // A phone that dropped must not hold up the people still in the bar.
    if (this.phase === PHASE.PLAYING && this.stage === 'collect' && this._everyoneIn()) {
      this._resolve(now);
    }
  }

  removePlayer(playerId, now = Date.now()) {
    if (!this.players.delete(playerId)) return;
    this.submissions.delete(playerId);

    if (this.players.size === 0) return this._end('Everyone wandered off.');
    if (this.players.size < this.definition.minPlayers) {
      return this._end(`${this.definition.title} needs ${this.definition.minPlayers} players.`);
    }
    if (this.phase === PHASE.PLAYING && this.stage === 'collect' && this._everyoneIn()) {
      this._resolve(now);
    }
  }

  result() {
    const standings = this.standings;
    const top = standings[0]?.score ?? 0;
    return {
      game: this.definition.key,
      title: this.definition.title,
      standings,
      winners: standings.filter((p) => p.score === top && top > 0).map((p) => p.name),
      reason: this.endedReason,
    };
  }

  // ───────────────────────────── internals ─────────────────────────────

  _everyoneIn() {
    const connected = [...this.players.values()].filter((p) => p.connected);
    return connected.length > 0 && connected.every((p) => this.submissions.has(p.id));
  }

  _deal(now) {
    this.round++;
    this.submissions.clear();
    this.stage = 'collect';
    this.until = now + this.definition.collectMs;
    this.deal = this.definition.deal({
      round: this.round,
      rounds: this.rounds,
      players: this.players,
      state: this.state,
      random: this.random,
    });

    for (const player of this.players.values()) {
      if (player.connected) this._sendRound(player, now);
    }
  }

  /**
   * `endsIn` rather than a wall-clock deadline: phones in a bar disagree about
   * the time, and somebody rejoining mid-round needs what is *left*, not what
   * the round started with.
   */
  _sendRound(player, now) {
    this.transport.toPlayer(player.id, {
      t: S2C.ROUND,
      game: this.definition.key,
      title: this.definition.title,
      round: this.round,
      of: this.rounds,
      prompt: per(this.deal.prompt, player, this.state),
      note: per(this.deal.note, player, this.state) ?? '',
      input: per(this.deal.input, player, this.state),
      you: per(this.deal.you, player, this.state) ?? null,
      duration: this.definition.collectMs,
      endsIn: Math.max(0, this.until - now),
      standings: this.standings,
    });
  }

  _resolve(now) {
    const { deltas, entries, note } = this.definition.resolve({
      submissions: this.submissions,
      players: this.players,
      state: this.state,
      deal: this.deal,
      round: this.round,
    });

    for (const [playerId, delta] of deltas) {
      const player = this.players.get(playerId);
      if (player) player.score += delta;
    }

    this.stage = 'reveal';
    this.until = now + this.definition.revealMs;
    this.transport.toAll({
      t: S2C.REVEAL,
      round: this.round,
      of: this.rounds,
      entries,
      note,
      standings: this.standings,
    });
  }

  _advance(now) {
    if (this.round >= this.rounds) return this._end(null);
    this._deal(now);
  }

  _end(reason) {
    if (this.phase === PHASE.OVER) return;
    this.phase = PHASE.OVER;
    this.endedReason = reason;
    const { standings, winners } = this.result();
    this.transport.toAll({
      t: S2C.PARTY_OVER,
      game: this.definition.key,
      title: this.definition.title,
      standings,
      winners,
      reason,
    });
  }
}
