/**
 * Don't Say It — the one that does the app's actual job.
 *
 * You are given a common word in secret. Your goal is to get somebody *else* in
 * the room to say it out loud in ordinary conversation. When they do, you tap
 * the accusation and they confirm it.
 *
 * Everything else here is a game you play instead of talking. This is a game
 * you can only win *by* talking, to people you have not met, about nothing in
 * particular — which is the whole reason somebody opened this app in a bar. It
 * has no board, no turns and no timer pressure; it just sits there making
 * conversation worth points.
 *
 * Being caught costs nothing on purpose. A penalty would teach people to say
 * less, and the entire point is to get them saying more.
 *
 * Not a sealed round — its rhythm is a running claim/confirm handshake rather
 * than a deadline — so it drives itself off the same tick and speaks the same
 * lifecycle as the other games.
 */
import { C2S, GAMES, INPUT, PHASE, S2C } from '../../shared/protocol.js';

export const CATCH_POINTS = 3;
/** How long the accused has to own up before the claim lapses. */
export const CLAIM_MS = 20_000;
/** A rejected claim cannot be re-made against the same person immediately. */
export const COOLDOWN_MS = 45_000;
const DEFAULT_DURATION_MS = 6 * 60_000;

/**
 * Words common enough to turn up in a real conversation, rare enough that they
 * do not turn up in the first sentence. Nothing here is worth saying on purpose,
 * which is what stops the game becoming "shout words at each other".
 */
const WORDS = [
  'anyway', 'honestly', 'obviously', 'tomorrow', 'expensive', 'weird',
  'brilliant', 'actually', 'basically', 'apparently', 'definitely', 'boring',
  'terrible', 'amazing', 'whatever', 'literally', 'awkward', 'random',
  'typical', 'annoying', 'hungry', 'exhausted', 'ridiculous', 'perfect',
  'genius', 'nightmare', 'obsessed', 'legend', 'disaster', 'suspicious',
];

export const taboo = {
  key: GAMES.TABOO,
  title: "Don't Say It",
  blurb: 'Get someone to say your secret word. Talking is the only way to win.',
  minPlayers: 2,
};

export class Taboo {
  /**
   * @param {object} options
   * @param {{toPlayer(id, msg): void, toAll(msg): void}} options.transport
   * @param {() => number} [options.random] injectable for deterministic tests
   * @param {number|null} [options.durationMs] null runs until it is turned off
   * @param {boolean} [options.side] run underneath another game rather than as one
   */
  constructor({
    transport,
    random = Math.random,
    durationMs = DEFAULT_DURATION_MS,
    side = false,
  }) {
    this.transport = transport;
    this.random = random;
    this.durationMs = durationMs;
    /**
     * Side mode is where this game belongs. It takes no screen of its own: no
     * round is dealt, so whatever is in front of you stays in front of you, and
     * the only thing it puts on the glass is your word and the moment somebody
     * is accused.
     */
    this.side = side;

    this.phase = PHASE.LOBBY;
    /** @type {Map<string, {id, name, connected, score, word}>} */
    this.players = new Map();
    /** @type {Map<number, {id, by, target, word, at}>} */
    this.claims = new Map();
    /** `${by}>${target}` -> timestamp the pair is claimable again. */
    this.cooldowns = new Map();
    this.endsAt = 0;
    this.endedReason = null;
    this._nextClaimId = 1;
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

  get standings() {
    return [...this.players.values()]
      .map(({ id, name, score, connected }) => ({ id, name, score, connected }))
      .sort((a, b) => b.score - a.score);
  }

  start(roster, now = Date.now()) {
    this.players.clear();
    this.claims.clear();
    this.cooldowns.clear();
    this.phase = PHASE.PLAYING;
    // An open-ended side game outlasts every round played on top of it.
    this.endsAt = this.durationMs === null ? Infinity : now + this.durationMs;
    this.endedReason = null;

    const taken = new Set();
    for (const { id, name } of roster) {
      this.players.set(id, { id, name, connected: true, score: 0, word: this._word(taken) });
    }
    // Each briefing carries the state with it, so no extra broadcast is needed.
    for (const player of this.players.values()) this._sendBriefing(player, now);
  }

  /**
   * Somebody arrived after the game started.
   *
   * Only side mode uses this: a round-based game has a roster for its duration,
   * but a game running underneath the evening has to let people walk in.
   */
  addPlayer({ id, name }, now = Date.now()) {
    if (this.phase !== PHASE.PLAYING || this.players.has(id)) return;
    this.players.set(id, {
      id,
      name,
      connected: true,
      score: 0,
      word: this._word(this._takenWords()),
    });
    this._sendBriefing(this.players.get(id), now);
    this._pushState();
  }

  /** The host turned it off. */
  stop(now = Date.now(), reason = 'Stopped.') {
    this._end(reason, now);
  }

  tick(now = Date.now()) {
    if (this.phase !== PHASE.PLAYING) return;

    for (const claim of [...this.claims.values()]) {
      if (now - claim.at >= CLAIM_MS) this._settle(claim, false, now, 'no answer');
    }
    if (now >= this.endsAt) this._end(null);
  }

  input(playerId, msg, now = Date.now()) {
    if (this.phase !== PHASE.PLAYING) return;
    if (msg?.t === C2S.CLAIM) this._claim(playerId, String(msg.targetId ?? ''), now);
    else if (msg?.t === C2S.CONFIRM) this._answer(playerId, msg, now);
  }

  setConnected(playerId, connected, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    // A phone that comes back has forgotten its word, and the word is the game.
    if (connected && this.phase === PHASE.PLAYING) this._sendBriefing(player, now);
  }

  removePlayer(playerId, now = Date.now()) {
    if (!this.players.delete(playerId)) return;
    // Claims in either direction are void: there is nobody left to confirm them.
    for (const claim of [...this.claims.values()]) {
      if (claim.by === playerId || claim.target === playerId) {
        this.claims.delete(claim.id);
      }
    }
    if (this.players.size === 0) this._end('Everyone wandered off.');
    // A side game with one person left is not over, it is quiet: there is simply
    // nobody to catch until somebody else walks in.
    else if (!this.side && this.players.size < taboo.minPlayers) {
      this._end('Not enough people left to catch.');
    } else this._pushState();
  }

  result() {
    const standings = this.standings;
    const top = standings[0]?.score ?? 0;
    return {
      game: taboo.key,
      title: taboo.title,
      standings,
      winners: standings.filter((p) => p.score === top && top > 0).map((p) => p.name),
      reason: this.endedReason,
    };
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** A word nobody else is chasing, so two people cannot claim the same catch. */
  _word(taken) {
    const fresh = WORDS.filter((w) => !taken.has(w));
    const pool = fresh.length ? fresh : WORDS;
    const word = pool[Math.floor(this.random() * pool.length)];
    taken.add(word);
    return word;
  }

  _takenWords() {
    return new Set([...this.players.values()].map((p) => p.word));
  }

  _sendBriefing(player, now) {
    this.transport.toPlayer(player.id, { t: S2C.SECRET, word: player.word, side: this.side });
    // Side mode deals no round: hijacking the screen is exactly what it must not
    // do. The word arrives above whatever game is already there.
    if (this.side) {
      this.transport.toPlayer(player.id, this._stateMessage());
      return;
    }
    this.transport.toPlayer(player.id, {
      t: S2C.ROUND,
      game: taboo.key,
      title: taboo.title,
      round: 1,
      of: 1,
      prompt: `Get somebody to say “${player.word}”`,
      note: 'Talk to them. Tap the moment they say it.',
      input: {
        kind: INPUT.CLAIM,
        // The people you can accuse. Yourself is not one of them.
        excludeSelf: true,
      },
      you: { word: player.word, points: CATCH_POINTS },
      duration: this.durationMs,
      endsIn: Math.max(0, this.endsAt - now),
      standings: this.standings,
    });
  }

  _claim(byId, targetId, now) {
    const by = this.players.get(byId);
    const target = this.players.get(targetId);
    if (!by || !target || byId === targetId) return;
    if (!target.connected) return;
    // One accusation at a time, or a tap-happy player buries the room in them.
    for (const claim of this.claims.values()) if (claim.by === byId) return;

    const key = `${byId}>${targetId}`;
    if ((this.cooldowns.get(key) ?? 0) > now) return;

    const claim = { id: this._nextClaimId++, by: byId, target: targetId, word: by.word, at: now };
    this.claims.set(claim.id, claim);

    // Everybody sees the accusation: the group turning to look is the point.
    this.transport.toAll({
      t: S2C.CLAIM_ASK,
      claimId: claim.id,
      byId,
      by: by.name,
      target: targetId,
      targetName: target.name,
      word: by.word,
      duration: CLAIM_MS,
      side: this.side,
    });
  }

  _answer(playerId, msg, now) {
    const claim = this.claims.get(Number(msg.claimId));
    // Only the accused gets a say. Anyone else confirming their own catch would
    // make the whole handshake pointless.
    if (!claim || claim.target !== playerId) return;
    this._settle(claim, Boolean(msg.ok), now, null);
  }

  _settle(claim, ok, now, reason) {
    this.claims.delete(claim.id);
    const by = this.players.get(claim.by);

    if (ok && by) {
      by.score += CATCH_POINTS;
      // A fresh word, so a caught player keeps playing instead of sitting on a
      // word the room is now watching for.
      by.word = this._word(this._takenWords());
      this._sendBriefing(by, now);
    } else {
      this.cooldowns.set(`${claim.by}>${claim.target}`, now + COOLDOWN_MS);
    }

    this.transport.toAll({
      t: S2C.CLAIM_DONE,
      claimId: claim.id,
      ok,
      by: by?.name ?? 'Somebody',
      byId: claim.by,
      target: this.players.get(claim.target)?.name ?? 'Somebody',
      word: claim.word,
      points: ok ? CATCH_POINTS : 0,
      reason,
      side: this.side,
    });
    this._pushState();
  }

  _stateMessage() {
    return { t: S2C.SIDE, on: true, title: taboo.title, standings: this.standings };
  }

  _pushState() {
    this.transport.toAll(
      this.side ? this._stateMessage() : { t: S2C.STANDINGS, standings: this.standings },
    );
  }

  _end(reason) {
    if (this.phase === PHASE.OVER) return;
    this.phase = PHASE.OVER;
    this.endedReason = reason;
    const { standings, winners } = this.result();
    // A side game bows out where it lived — in its own strip, not over the top
    // of whatever game is on screen.
    this.transport.toAll({
      t: this.side ? S2C.SIDE : S2C.PARTY_OVER,
      on: this.side ? false : undefined,
      game: taboo.key,
      title: taboo.title,
      standings,
      winners,
      reason,
      // The reveal everybody wants at the end: what was everyone chasing?
      words: [...this.players.values()].map((p) => ({ name: p.name, word: p.word })),
    });
  }
}
