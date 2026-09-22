/**
 * Renders one control ("gizmo") from the server's description.
 *
 * The client never decides whether an instruction is satisfied — it only
 * reports "this control is now in that state" and lets the server judge. The
 * local value is applied optimistically so the panel feels instant.
 */
import { CONTROL } from '/shared/protocol.js';

/** Range input while you're panicking: don't flood the socket on every pixel. */
const SLIDER_THROTTLE_MS = 70;

export function renderGizmo(control, onChange) {
  const root = document.createElement('div');
  root.className = 'gizmo';
  root.dataset.controlId = control.id;

  const label = document.createElement('div');
  label.className = 'gizmo-label';
  label.textContent = control.label;
  root.append(label);

  const flash = () => {
    root.classList.add('just-moved');
    setTimeout(() => root.classList.remove('just-moved'), 220);
  };

  switch (control.kind) {
    case CONTROL.TOGGLE:
      root.append(buildToggle(control, onChange, flash));
      break;
    case CONTROL.DIAL:
      root.append(buildChips(control, control.states, 'chips', onChange, flash));
      break;
    case CONTROL.LEVER:
      // Top-to-bottom so UP really is up.
      root.append(buildChips(control, [...control.states].reverse(), 'lever', onChange, flash));
      break;
    case CONTROL.SLIDER:
      root.append(buildSlider(control, onChange, flash));
      break;
    case CONTROL.BUTTON:
      root.append(buildButton(control, onChange, flash));
      break;
  }

  return root;
}

function buildToggle(control, onChange, flash) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gizmo-toggle';

  let value = control.value;
  const paint = () => {
    button.textContent = value;
    button.toggleAttribute('data-on', value === control.states[1]);
  };
  paint();

  button.addEventListener('click', () => {
    value = value === control.states[0] ? control.states[1] : control.states[0];
    paint();
    flash();
    onChange(control.id, value);
  });
  return button;
}

function buildChips(control, order, className, onChange, flash) {
  const wrap = document.createElement('div');
  wrap.className = className;

  const chips = order.map((state) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = state;
    chip.toggleAttribute('data-on', state === control.value);
    chip.addEventListener('click', () => {
      for (const other of chips) other.removeAttribute('data-on');
      chip.setAttribute('data-on', '');
      flash();
      onChange(control.id, state);
    });
    return chip;
  });

  wrap.append(...chips);
  return wrap;
}

function buildSlider(control, onChange, flash) {
  const wrap = document.createElement('div');
  wrap.className = 'slider-wrap';

  const readout = document.createElement('div');
  readout.className = 'slider-value';
  readout.textContent = control.value;

  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = String(control.max);
  range.step = '1';
  range.value = String(control.value);

  let lastSent = control.value;
  let lastSentAt = 0;

  const push = (force) => {
    const value = Number(range.value);
    const now = Date.now();
    if (value === lastSent) return;
    if (!force && now - lastSentAt < SLIDER_THROTTLE_MS) return;
    lastSent = value;
    lastSentAt = now;
    flash();
    onChange(control.id, value);
  };

  range.addEventListener('input', () => {
    readout.textContent = range.value;
    push(false);
  });
  // Always send the value the finger actually stopped on.
  range.addEventListener('change', () => push(true));

  wrap.append(readout, range);
  return wrap;
}

function buildButton(control, onChange, flash) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'push';
  button.textContent = 'PUSH';
  button.addEventListener('click', () => {
    flash();
    onChange(control.id, 1);
  });
  return button;
}
