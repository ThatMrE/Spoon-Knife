/**
 * The screen for the party games.
 *
 * One prompt, one answer, one reveal. Every sealed-round game reuses this, so a
 * new game needs a definition in core/games/ and nothing here — the round tells
 * the phone what kind of answer to collect and the phone renders that shape.
 *
 * Designed for a bar: one thumb, no typing, targets big enough to hit while
 * holding a drink, and nothing that depends on hearing anything.
 */
import { C2S, INPUT } from '/shared/protocol.js';

const $ = (id) => document.getElementById(id);

function button(label, className = 'btn') {
  const node = document.createElement('button');
  node.className = className;
  node.textContent = label;
  return node;
}

/**
 * @param {object} options
 * @param {(type: string, payload?: object) => void} options.send
 * @param {() => string} options.me our own player id
 * @param {(node: Element, ms: number) => () => void} options.timerBar
 */
export function createParty({ send, me, timerBar }) {
  const el = {
    title: $('party-title'),
    round: $('party-round'),
    timer: $('party-timer-fill'),
    prompt: $('party-prompt'),
    note: $('party-note'),
    input: $('party-input'),
    waiting: $('party-waiting'),
    reveal: $('party-reveal'),
    revealNote: $('party-reveal-note'),
    entries: $('party-entries'),
    standings: $('party-standings'),
    over: $('overlay-party-over'),
    overTitle: $('party-over-title'),
    overWinner: $('party-over-winner'),
    overStandings: $('party-over-standings'),
  };

  const state = {
    round: 0,
    people: [],
    word: null,
    sealed: false,
    /** The accusation currently pointed at us, if any. */
    askingMe: null,
  };
  let cancelTimer = () => {};

  const others = () => state.people.filter((p) => p.id !== me());

  function renderStandings(node, standings) {
    node.replaceChildren(
      ...standings.map((player, index) => {
        const li = document.createElement('li');
        li.classList.toggle('is-me', player.id === me());
        li.classList.toggle('is-out', player.connected === false);

        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = `${index + 1}`;

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = player.name;

        const score = document.createElement('span');
        score.className = 'score';
        score.textContent = `${player.score}`;

        li.append(rank, who, score);
        return li;
      }),
    );
  }

  /** A number, chosen without typing: nobody uses a keypad holding a pint. */
  function renderNumber(spec) {
    const max = Math.max(0, Number(spec.max ?? 0));
    const min = Math.max(0, Number(spec.min ?? 0));
    let value = min;

    const wrap = document.createElement('div');
    wrap.className = 'dial-number';

    const readout = document.createElement('div');
    readout.className = 'dial-value';

    const steppers = document.createElement('div');
    steppers.className = 'dial-steppers';
    const down = button('−', 'dial-step');
    const up = button('+', 'dial-step');
    steppers.append(down, up);

    const quick = document.createElement('div');
    quick.className = 'dial-quick';

    const seal = button('SEAL IT', 'btn btn-go');

    const paint = () => {
      readout.textContent = `${value}`;
      readout.dataset.label = spec.label ?? '';
      down.disabled = value <= min;
      up.disabled = value >= max;
    };
    const set = (next) => {
      value = Math.min(max, Math.max(min, next));
      paint();
    };

    down.addEventListener('click', () => set(value - 1));
    up.addEventListener('click', () => set(value + 1));
    for (const [label, amount] of [
      ['NONE', 0],
      ['HALF', Math.floor(max / 2)],
      ['ALL IN', max],
    ]) {
      const shortcut = button(label, 'dial-preset');
      shortcut.addEventListener('click', () => set(amount));
      quick.append(shortcut);
    }
    seal.addEventListener('click', () => {
      send(C2S.SUBMIT, { round: state.round, value });
      sealed(`${value} ${spec.label ?? ''}`.trim());
    });

    paint();
    wrap.append(readout, steppers, quick, seal);
    el.input.replaceChildren(wrap);
  }

  /** Somebody in the room, never yourself. */
  function renderPlayerPick() {
    const grid = document.createElement('div');
    grid.className = 'pick-grid';

    for (const person of others()) {
      const choice = button(person.name, 'pick');
      choice.addEventListener('click', () => {
        send(C2S.SUBMIT, { round: state.round, value: person.id });
        for (const node of grid.children) node.classList.remove('is-chosen');
        choice.classList.add('is-chosen');
        el.waiting.textContent = 'Locked in. Change it any time before the reveal.';
      });
      grid.append(choice);
    }
    el.input.replaceChildren(grid);
  }

  /** Don't Say It: your word, and the people you can accuse. */
  function renderClaim() {
    const wrap = document.createElement('div');
    wrap.className = 'claim';

    const word = document.createElement('div');
    word.className = 'claim-word';
    word.textContent = state.word ?? '…';

    const hint = document.createElement('p');
    hint.className = 'claim-hint';
    hint.textContent = 'Tap whoever says it. They have to agree it happened.';

    const grid = document.createElement('div');
    grid.className = 'pick-grid';
    for (const person of others()) {
      const choice = button(person.name, 'pick');
      choice.addEventListener('click', () => {
        send(C2S.CLAIM, { targetId: person.id });
        el.waiting.textContent = `Waiting for ${person.name} to own up…`;
      });
      grid.append(choice);
    }

    wrap.append(word, hint, grid);
    el.input.replaceChildren(wrap);
  }

  /** Replace the input with what we committed to, so it cannot be fiddled with. */
  function sealed(shown) {
    state.sealed = true;
    const done = document.createElement('div');
    done.className = 'sealed';
    done.textContent = `SEALED — ${shown}`;
    el.input.replaceChildren(done);
  }

  function renderInput(spec) {
    if (!spec) return el.input.replaceChildren();
    if (spec.kind === INPUT.NUMBER) return renderNumber(spec);
    if (spec.kind === INPUT.PLAYER) return renderPlayerPick();
    if (spec.kind === INPUT.CLAIM) return renderClaim();
    el.input.replaceChildren();
  }

  return {
    /** A new round: prompt, answer shape, clock. */
    round(msg) {
      state.round = msg.round;
      state.sealed = false;
      state.people = msg.standings ?? [];
      if (msg.you?.word) state.word = msg.you.word;

      el.title.textContent = msg.title;
      el.round.textContent = msg.of > 1 ? `${msg.round}/${msg.of}` : '';
      el.prompt.textContent = msg.prompt;
      el.note.textContent = msg.note ?? '';
      el.waiting.textContent = '';
      el.reveal.hidden = true;
      renderInput(msg.input);
      renderStandings(el.standings, msg.standings ?? []);

      cancelTimer();
      cancelTimer = timerBar(el.timer, msg.endsIn ?? msg.duration ?? 0);
    },

    submitted(msg) {
      if (msg.round !== state.round) return;
      const left = Math.max(0, msg.of - msg.count);
      el.waiting.textContent = left
        ? `${msg.count} of ${msg.of} in — waiting on ${left}…`
        : 'Everybody in.';
    },

    reveal(msg) {
      cancelTimer();
      el.timer.style.width = '0%';
      el.waiting.textContent = '';
      el.input.replaceChildren();

      el.revealNote.textContent = msg.note;
      el.entries.replaceChildren(
        ...msg.entries.map((entry) => {
          const li = document.createElement('li');
          li.classList.toggle('is-me', entry.id === me());
          li.classList.toggle('is-winner', Boolean(entry.won));

          const who = document.createElement('span');
          who.className = 'who';
          who.textContent = entry.name;

          const shown = document.createElement('span');
          shown.className = 'shown';
          shown.textContent = entry.shown;

          const detail = document.createElement('span');
          detail.className = 'detail';
          detail.textContent = [entry.delta ? `+${entry.delta}` : '', entry.detail ?? '']
            .filter(Boolean)
            .join(' · ');

          li.append(who, shown, detail);
          return li;
        }),
      );
      el.reveal.hidden = false;
      renderStandings(el.standings, msg.standings ?? []);
    },

    standings(msg) {
      renderStandings(el.standings, msg.standings ?? []);
    },

    secret(msg) {
      state.word = msg.word;
      // Mid-game a new word arrives after every catch; re-render so the screen
      // is never showing a word that is no longer yours.
      if (!state.sealed && el.input.querySelector('.claim-word')) renderClaim();
    },

    /**
     * An accusation. Everybody sees it — the room turning to look is the point —
     * but only the accused gets the buttons.
     */
    claimAsk(msg) {
      if (msg.target !== me()) {
        el.waiting.textContent = `${msg.by} says ${msg.targetName} said “${msg.word}”.`;
        return;
      }
      state.askingMe = msg.claimId;

      const wrap = document.createElement('div');
      wrap.className = 'accused';

      const text = document.createElement('p');
      text.className = 'accused-text';
      text.textContent = `${msg.by} says you said “${msg.word}”.`;

      const row = document.createElement('div');
      row.className = 'accused-row';
      const yes = button('I DID', 'btn btn-go');
      const no = button('NEVER', 'btn');
      yes.addEventListener('click', () => send(C2S.CONFIRM, { claimId: msg.claimId, ok: true }));
      no.addEventListener('click', () => send(C2S.CONFIRM, { claimId: msg.claimId, ok: false }));
      row.append(yes, no);

      wrap.append(text, row);
      el.input.replaceChildren(wrap);
    },

    claimDone(msg) {
      if (msg.claimId === state.askingMe) {
        state.askingMe = null;
        renderClaim();
      }
      el.waiting.textContent = msg.ok
        ? `${msg.by} caught ${msg.target} on “${msg.word}” — +${msg.points}.`
        : `${msg.target} denies it${msg.reason ? ` (${msg.reason})` : ''}.`;
    },

    over(msg) {
      cancelTimer();
      el.timer.style.width = '0%';
      el.overTitle.textContent = msg.title;
      el.overWinner.textContent = msg.reason
        ? msg.reason
        : msg.winners?.length
          ? `${msg.winners.join(' & ')} ${msg.winners.length > 1 ? 'tie' : 'wins'}`
          : 'Nobody scored. Extraordinary.';
      renderStandings(el.overStandings, msg.standings ?? []);

      if (msg.words?.length) {
        // The reveal everybody wants: what was everyone actually chasing?
        for (const { name, word } of msg.words) {
          const li = document.createElement('li');
          li.className = 'word-reveal';
          li.textContent = `${name} was chasing “${word}”`;
          el.overStandings.append(li);
        }
      }
      el.over.hidden = false;
    },

    hideOver() {
      el.over.hidden = true;
    },
  };
}
