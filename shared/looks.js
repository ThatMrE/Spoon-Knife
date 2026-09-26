/**
 * How to find somebody in a bar.
 *
 * The hard part of meeting strangers through a phone is not the matching, it is
 * the twenty seconds afterwards where four people stand up and scan the room.
 * This is the vocabulary for that: a colour and an emblem big enough to hold up
 * across a dark room, plus what you are wearing and roughly where you are.
 *
 * Everything here is a fixed list on purpose. Free text would be a way to send
 * strangers anything at all, and there is no moderator in a pub. A closed
 * vocabulary is also faster: four taps, no typing, one hand.
 *
 * Shared verbatim by the server and the browser, like protocol.js, so the two
 * cannot disagree about what a valid look is.
 */

/** Chosen to stay apart from each other on a dim phone at arm's length. */
export const COLOURS = [
  { key: 'red', hex: '#ff4d6a', ink: '#2b0008' },
  { key: 'orange', hex: '#ff9f43', ink: '#2e1600' },
  { key: 'yellow', hex: '#ffe066', ink: '#2e2600' },
  { key: 'green', hex: '#58e06a', ink: '#052b0a' },
  { key: 'teal', hex: '#35e0d0', ink: '#04211f' },
  { key: 'blue', hex: '#4d9bff', ink: '#001a3a' },
  { key: 'purple', hex: '#b07bff', ink: '#1b0033' },
  { key: 'pink', hex: '#ff7ad1', ink: '#330020' },
];

/** Readable at a glance and unmistakable from each other at four metres. */
export const EMBLEMS = ['🦊', '🐙', '🌵', '🍕', '🚀', '🎩', '🐝', '🦕', '🍋', '🪩', '🛸', '🧀'];

/** What somebody would actually say to point you out across a room. */
export const WEARING = [
  'stripes',
  'all in black',
  'denim',
  'a hoodie',
  'a hat',
  'glasses',
  'something bright',
  'a big coat',
];

export const SPOTS = [
  'at the bar',
  'by the window',
  'in the back corner',
  'near the door',
  'by the pool table',
  'outside',
  'upstairs',
  'the big table',
];

export const DEFAULT_LOOK = {
  colour: COLOURS[0].key,
  emblem: EMBLEMS[0],
  wearing: null,
  spot: null,
};

const has = (list, value) => list.some((item) => (item.key ?? item) === value);

/**
 * Force anything off the wire into the vocabulary above.
 *
 * Nothing a client sends survives that is not one of these exact strings, so a
 * look can never carry a message.
 */
export function sanitizeLook(raw) {
  const look = raw && typeof raw === 'object' ? raw : {};
  return {
    colour: has(COLOURS, look.colour) ? look.colour : DEFAULT_LOOK.colour,
    emblem: has(EMBLEMS, look.emblem) ? look.emblem : DEFAULT_LOOK.emblem,
    wearing: has(WEARING, look.wearing) ? look.wearing : null,
    spot: has(SPOTS, look.spot) ? look.spot : null,
  };
}

/** "stripes, at the bar" — whatever of it they told us. */
export function describeLook(look) {
  return [look?.wearing, look?.spot].filter(Boolean).join(', ');
}

export function colourOf(key) {
  return COLOURS.find((colour) => colour.key === key) ?? COLOURS[0];
}
