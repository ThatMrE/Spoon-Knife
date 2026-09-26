/**
 * Who In This Bar — a superlative, and a secret vote.
 *
 * "Most likely to survive a zombie apocalypse." Everyone votes for somebody
 * other than themselves. The winner scores — *and so does anybody who picked
 * the winner*.
 *
 * That second rule is what makes it a game rather than a poll: you are not
 * voting for who you think deserves it, you are modelling what the rest of the
 * room thinks. It is also why it works between two groups of strangers, where a
 * popularity contest would not: guessing a stranger's read on their own friend
 * is the interesting problem.
 *
 * Every prompt here is one somebody would be pleased to win. A game that hands
 * strangers a way to be cruel to each other gets deleted after one round, so
 * nothing about looks, money, or anybody's competence.
 */
import { GAMES, INPUT } from '../../shared/protocol.js';

const WINNER_POINTS = 3;
const CALLED_IT_POINTS = 2;

/** Read these out loud before adding one: it has to be fun to lose, too. */
const PROMPTS = [
  'would survive longest in a zombie apocalypse',
  'has the best story they have not told yet',
  'would win a staring contest',
  'is secretly very good at something useless',
  'you would want on your pub quiz team',
  'would be first to start dancing',
  'could talk their way out of a parking ticket',
  'has the most unhinged search history',
  'would adopt a stray dog tonight',
  'is most likely to become internet famous by accident',
  'would be the best getaway driver',
  'has definitely lied about liking a band',
  'would last longest without their phone',
  'is most likely to know a guy',
  'would win a hot dog eating contest',
  'you would trust to order for the table',
  'has the strongest opinion about a sandwich',
  'would be the first to say hello to a stranger',
  'is most likely to have a nickname you do not know about',
  'would survive a week in the woods',
  'could sell you something you do not need',
  'has never once read the instructions',
  'would be the best wedding speech giver',
  'is most likely to be up at 4am on purpose',
  'would forget their own birthday',
  'you would call from a police station',
  'has the best terrible opinion about a film',
  'would win a bar fight by talking',
  'is most likely to own a weird collection',
  'would be the last to leave tonight',
  'could beat everyone here at a game nobody has played',
  'is most likely to cry at an advert',
  'would be a great cult leader',
  'has the most convincing fake laugh',
  'would befriend the bartender first',
  'is most likely to have a passport stamp nobody expects',
  'would be the best at keeping a secret',
  'could fall asleep anywhere',
  'is most likely to start a group chat nobody asked for',
  'would take the last slice without asking',
];

export const superlatives = {
  key: GAMES.SUPERLATIVES,
  title: 'Who In This Bar',
  blurb: 'Vote for somebody else. Points for winning — and for calling it.',
  // Two players makes it a mirror: each can only vote for the other.
  minPlayers: 3,
  rounds: 6,
  collectMs: 25_000,
  revealMs: 9000,

  setup() {
    return { used: new Set() };
  },

  deal({ round, rounds, state, random }) {
    const fresh = PROMPTS.filter((p) => !state.used.has(p));
    const pool = fresh.length ? fresh : PROMPTS;
    const prompt = pool[Math.floor(random() * pool.length)];
    state.used.add(prompt);

    return {
      prompt: `Who in this bar ${prompt}?`,
      note: `Round ${round} of ${rounds} · ${WINNER_POINTS} points to win it, ${CALLED_IT_POINTS} for calling it`,
      input: { kind: INPUT.PLAYER, excludeSelf: true },
    };
  },

  clean(value, { playerId, players }) {
    const target = String(value ?? '');
    // Voting for yourself is the one move that would break the game, and it is
    // also the one everybody tries first.
    if (target === playerId || !players.has(target)) return undefined;
    return target;
  },

  resolve({ submissions, players }) {
    const deltas = new Map();
    const tally = new Map();
    for (const target of submissions.values()) {
      tally.set(target, (tally.get(target) ?? 0) + 1);
    }

    const top = Math.max(0, ...tally.values());
    const winners = [...tally].filter(([, count]) => count === top && count > 0).map(([id]) => id);

    for (const id of winners) deltas.set(id, WINNER_POINTS);
    for (const [voter, target] of submissions) {
      if (!winners.includes(target)) continue;
      deltas.set(voter, (deltas.get(voter) ?? 0) + CALLED_IT_POINTS);
    }

    const name = (id) => players.get(id)?.name ?? 'Somebody';
    const entries = [...players.keys()].map((id) => {
      const vote = submissions.get(id);
      return {
        id,
        name: name(id),
        shown: vote ? name(vote) : '—',
        detail: tally.get(id) ? `${tally.get(id)} vote${tally.get(id) === 1 ? '' : 's'}` : '',
        delta: deltas.get(id) ?? 0,
        won: winners.includes(id),
      };
    });

    let note;
    if (!winners.length) note = 'Nobody voted. Awkward.';
    else if (winners.length === 1) note = `${name(winners[0])} took it with ${top}.`;
    else note = `${winners.map(name).join(' and ')} tied on ${top} each.`;

    return { deltas, entries, note };
  },
};
