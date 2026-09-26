/**
 * Finding each other in the room.
 *
 * Two problems, both of them the actual product:
 *
 *   1. Which table do I join? — the tables list, fetched from the server that
 *      everybody on this WiFi is already talking to.
 *   2. Which of these people are they? — a colour and a symbol you can hold up
 *      across a dark room, plus what you are wearing and roughly where you are.
 *
 * The look is a closed vocabulary (shared/looks.js), so it is four taps rather
 * than typing, and it cannot be used to send a stranger anything.
 */
import { COLOURS, EMBLEMS, SPOTS, WEARING, colourOf, describeLook } from '/shared/looks.js';

const $ = (id) => document.getElementById(id);
const LOOK_KEY = 'sociovia:look';

/**
 * @param {object} options
 * @param {() => string} options.name whatever is currently in the name field
 * @param {(code: string) => void} options.onJoin tapping a table
 */
export function createFinder({ name, onJoin }) {
  const el = {
    preview: $('look-preview'),
    emblem: $('look-emblem'),
    previewName: $('look-name'),
    detail: $('look-detail'),
    colours: $('look-colours'),
    emblems: $('look-emblems'),
    wearing: $('look-wearing'),
    spot: $('look-spot'),
    tables: $('tables'),
    tablesHint: $('tables-hint'),
    beacon: $('overlay-beacon'),
    beaconEmblem: $('beacon-emblem'),
    beaconName: $('beacon-name'),
  };

  const look = { colour: COLOURS[0].key, emblem: EMBLEMS[0], wearing: null, spot: null };
  try {
    Object.assign(look, JSON.parse(localStorage.getItem(LOOK_KEY) ?? '{}'));
  } catch {
    // A corrupt or blocked store just means starting from the default.
  }

  function remember() {
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(look));
    } catch {
      // Private mode: the look still works for this session.
    }
  }

  function paint() {
    const colour = colourOf(look.colour);
    el.preview.style.background = colour.hex;
    el.preview.style.color = colour.ink;
    el.emblem.textContent = look.emblem;
    el.previewName.textContent = name() || 'You';
    el.detail.textContent = describeLook(look) || 'Tap to hold up your phone';

    for (const node of el.colours.children) {
      node.toggleAttribute('data-chosen', node.dataset.value === look.colour);
    }
    for (const node of el.emblems.children) {
      node.toggleAttribute('data-chosen', node.dataset.value === look.emblem);
    }
    for (const [key, node] of [
      ['wearing', el.wearing],
      ['spot', el.spot],
    ]) {
      for (const chip of node.children) {
        chip.toggleAttribute('data-chosen', chip.dataset.value === look[key]);
      }
    }
    remember();
  }

  function option(className, value, label) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.dataset.value = value;
    node.textContent = label;
    return node;
  }

  el.colours.replaceChildren(
    ...COLOURS.map((colour) => {
      const node = option('swatch', colour.key, '');
      node.style.background = colour.hex;
      node.setAttribute('aria-label', colour.key);
      node.addEventListener('click', () => {
        look.colour = colour.key;
        paint();
      });
      return node;
    }),
  );

  el.emblems.replaceChildren(
    ...EMBLEMS.map((emblem) => {
      const node = option('emblem', emblem, emblem);
      node.addEventListener('click', () => {
        look.emblem = emblem;
        paint();
      });
      return node;
    }),
  );

  for (const [key, node, values] of [
    ['wearing', el.wearing, WEARING],
    ['spot', el.spot, SPOTS],
  ]) {
    node.replaceChildren(
      ...values.map((value) => {
        const chip = option('chip', value, value);
        chip.addEventListener('click', () => {
          // Tapping the chosen one again clears it: none of this is required.
          look[key] = look[key] === value ? null : value;
          paint();
        });
        return chip;
      }),
    );
  }

  /** The phone as a flag. The only thing that reliably works across a bar. */
  function beacon() {
    const colour = colourOf(look.colour);
    el.beacon.style.background = colour.hex;
    el.beacon.style.color = colour.ink;
    el.beaconEmblem.textContent = look.emblem;
    el.beaconName.textContent = name() || 'HERE';
    el.beacon.hidden = false;
  }

  el.preview.addEventListener('click', beacon);
  el.beacon.addEventListener('click', () => {
    el.beacon.hidden = true;
  });

  function renderTables(body) {
    if (!body?.listing) {
      // A public server will not list tables — the code is the only door out
      // there, and publishing every code would take the door off.
      el.tables.replaceChildren();
      el.tablesHint.textContent = body
        ? 'This server is on the open internet, so tables are not listed. Use a code.'
        : 'No server here — practise solo, or run one on the WiFi.';
      return;
    }

    el.tables.replaceChildren(
      ...body.tables.map((table) => {
        const li = document.createElement('li');
        const join = document.createElement('button');
        join.className = 'table';

        const faces = document.createElement('span');
        faces.className = 'table-faces';
        for (const player of table.players.slice(0, 6)) {
          const face = document.createElement('span');
          face.className = 'face';
          face.style.background = colourOf(player.look?.colour).hex;
          face.textContent = player.look?.emblem ?? '?';
          faces.append(face);
        }

        const words = document.createElement('span');
        words.className = 'table-words';
        const who = document.createElement('span');
        who.className = 'table-who';
        who.textContent = table.players.map((p) => p.name).join(', ');
        const where = document.createElement('span');
        where.className = 'table-where';
        // Where they are is the thing that gets you out of your seat.
        where.textContent =
          table.players.map((p) => describeLook(p.look)).find(Boolean) ?? 'somewhere in here';
        words.append(who, where);

        const code = document.createElement('span');
        code.className = 'table-code';
        code.textContent = table.code;

        join.append(faces, words, code);
        join.addEventListener('click', () => onJoin(table.code));
        li.append(join);
        return li;
      }),
    );

    el.tablesHint.textContent = body.tables.length
      ? 'Tap one to sit down. Or start your own below.'
      : 'Nobody has started one yet. Be the first — then read the code out loud.';
  }

  return {
    get look() {
      return { ...look };
    },
    paint,
    beacon,

    async refresh() {
      try {
        const response = await fetch('/tables', { cache: 'no-store' });
        renderTables(await response.json());
      } catch {
        renderTables(null);
      }
    },
  };
}
