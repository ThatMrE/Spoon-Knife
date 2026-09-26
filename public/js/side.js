/**
 * The game running underneath: Don't Say It.
 *
 * It has no screen. It is a strip along the bottom of whatever you are already
 * looking at — the lobby, a console, a bidding round — plus one overlay for the
 * moment somebody accuses you.
 *
 * That is the whole point of it. A game you play *instead* of talking is a game
 * that stops you talking; this one only ever asks for a tap, and the rest of it
 * happens in the conversation it is trying to start.
 */
import { C2S } from '/shared/protocol.js';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} options
 * @param {(type: string, payload?: object) => void} options.send
 * @param {() => string} options.me
 * @param {(message: string, kind?: string) => void} options.toast
 * @param {(kind: string) => void} [options.alarm] called when *you* are accused
 */
export function createSide({ send, me, toast, alarm = () => {} }) {
  const el = {
    chip: $('side-chip'),
    word: $('side-word'),
    score: $('side-score'),
    sheet: $('overlay-side'),
    sheetWord: $('side-sheet-word'),
    people: $('side-people'),
    standings: $('side-standings'),
    accused: $('overlay-accused'),
    accusedText: $('accused-text'),
    accusedYes: $('accused-yes'),
    accusedNo: $('accused-no'),
  };

  const state = { on: false, word: null, people: [], claimId: null };

  function renderScore() {
    const mine = state.people.find((p) => p.id === me());
    el.score.textContent = mine ? `${mine.score}` : '0';
  }

  function renderSheet() {
    el.sheetWord.textContent = state.word ?? '…';
    el.people.replaceChildren(
      ...state.people
        .filter((person) => person.id !== me())
        .map((person) => {
          const choice = document.createElement('button');
          choice.className = 'pick';
          choice.textContent = person.name;
          choice.disabled = person.connected === false;
          choice.addEventListener('click', () => {
            send(C2S.CLAIM, { targetId: person.id });
            close();
            toast(`Waiting for ${person.name} to own up…`, 'info');
          });
          return choice;
        }),
    );

    el.standings.replaceChildren(
      ...state.people.map((person) => {
        const li = document.createElement('li');
        li.classList.toggle('is-me', person.id === me());
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = person.name;
        const score = document.createElement('span');
        score.className = 'score';
        score.textContent = `${person.score}`;
        li.append(who, score);
        return li;
      }),
    );
  }

  const open = () => {
    if (!state.on) return;
    renderSheet();
    el.sheet.hidden = false;
  };
  const close = () => {
    el.sheet.hidden = true;
  };

  el.chip.addEventListener('click', open);
  $('side-close').addEventListener('click', close);
  el.accusedYes.addEventListener('click', () => {
    send(C2S.CONFIRM, { claimId: state.claimId, ok: true });
    el.accused.hidden = true;
  });
  el.accusedNo.addEventListener('click', () => {
    send(C2S.CONFIRM, { claimId: state.claimId, ok: false });
    el.accused.hidden = true;
  });

  return {
    /** Shared state: who is playing, what they have scored, whether it is on. */
    state(msg) {
      state.on = Boolean(msg.on);
      state.people = msg.standings ?? [];
      el.chip.hidden = !state.on;
      document.body.classList.toggle('has-side', state.on);
      if (!state.on) {
        close();
        el.accused.hidden = true;
        state.word = null;
        if (msg.words?.length) {
          toast(
            `Don't Say It over — ${msg.words.map((w) => `${w.name}: “${w.word}”`).join(', ')}`,
            'info',
          );
        }
        return;
      }
      renderScore();
      if (!el.sheet.hidden) renderSheet();
    },

    /** Yours alone. */
    word(msg) {
      state.word = msg.word;
      el.word.textContent = msg.word;
      if (!el.sheet.hidden) renderSheet();
    },

    /**
     * Somebody has been accused. Everyone is told — the room turning to look is
     * the point — but only the accused is asked anything.
     */
    accusation(msg) {
      if (msg.target !== me()) {
        toast(`${msg.by} says ${msg.targetName} said “${msg.word}”.`);
        return;
      }
      state.claimId = msg.claimId;
      el.accusedText.textContent = `${msg.by} says you said “${msg.word}”.`;
      el.accused.hidden = false;
      close();
      alarm();
    },

    settled(msg) {
      if (msg.claimId === state.claimId) el.accused.hidden = true;
      toast(
        msg.ok
          ? `${msg.by} caught ${msg.target} on “${msg.word}” — +${msg.points}.`
          : `${msg.target} denies it${msg.reason ? ` (${msg.reason})` : ''}.`,
        msg.ok ? 'info' : 'warn',
      );
    },

    /** Leaving the room entirely. */
    reset() {
      state.on = false;
      state.word = null;
      state.people = [];
      el.chip.hidden = true;
      document.body.classList.remove('has-side');
      close();
      el.accused.hidden = true;
    },
  };
}
