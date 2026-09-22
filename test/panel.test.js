import { strict as assert } from 'node:assert';
import test from 'node:test';

import { CONTROL } from '../shared/protocol.js';
import {
  applyInput,
  isSatisfied,
  makeControl,
  makePanel,
  makeRequirement,
  panelSize,
  publicControl,
} from '../core/panel.js';
import { seeded } from './helpers.js';

test('a generated panel has unique, legally-valued controls', () => {
  const random = seeded(7);
  const taken = new Set();
  const panel = makePanel(6, taken, random);

  assert.equal(panel.length, 6);
  assert.equal(new Set(panel.map((c) => c.label)).size, 6, 'labels must be unique');
  assert.equal(new Set(panel.map((c) => c.id)).size, 6, 'ids must be unique');

  for (const control of panel) {
    if (control.states) assert.ok(control.states.includes(control.value));
    if (control.kind === CONTROL.SLIDER) {
      assert.ok(Number.isInteger(control.value) && control.value >= 0 && control.value <= control.max);
    }
  }
});

test('labels stay unique across every console on the ship', () => {
  const random = seeded(3);
  const taken = new Set();
  const everyone = [makePanel(8, taken, random), makePanel(8, taken, random), makePanel(8, taken, random)];
  const labels = everyone.flat().map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length);
});

test('a requirement never asks for the state a control is already in', () => {
  const random = seeded(11);
  const taken = new Set();
  for (let i = 0; i < 300; i++) {
    const control = makeControl(taken, random);
    const requirement = makeRequirement(control, random);
    if (control.kind === CONTROL.BUTTON) {
      assert.ok(requirement.value >= 1, 'buttons need at least one press');
      assert.equal(requirement.from, control.value);
      assert.equal(isSatisfied(control, requirement), false);
    } else {
      assert.notEqual(requirement.value, control.value);
      assert.equal(isSatisfied(control, requirement), false);
    }
  }
});

test('applyInput rejects values a real console could not produce', () => {
  const taken = new Set();
  const random = seeded(2);

  const toggle = makeControl(taken, random, CONTROL.TOGGLE);
  assert.equal(applyInput(toggle, 'NONSENSE'), false);
  assert.equal(applyInput(toggle, toggle.value), false, 'no-op changes report false');
  const other = toggle.states.find((state) => state !== toggle.value);
  assert.equal(applyInput(toggle, other), true);
  assert.equal(toggle.value, other);

  const slider = makeControl(taken, random, CONTROL.SLIDER);
  assert.equal(applyInput(slider, slider.max + 1), false);
  assert.equal(applyInput(slider, -1), false);
  assert.equal(applyInput(slider, 1.5), false);
  assert.equal(applyInput(slider, 'three'), false);

  const dial = makeControl(taken, random, CONTROL.DIAL);
  assert.equal(applyInput(dial, 'Nowhere'), false);
});

test('buttons count presses rather than holding a state', () => {
  const control = makeControl(new Set(), seeded(5), CONTROL.BUTTON);
  const requirement = { value: 3, from: control.value };

  for (let i = 0; i < 2; i++) applyInput(control, 1);
  assert.equal(isSatisfied(control, requirement), false);
  applyInput(control, 1);
  assert.equal(isSatisfied(control, requirement), true);
});

test('panel size grows with the waves and shrinks with the crew', () => {
  assert.ok(panelSize(2, 1) > panelSize(6, 1), 'small crews carry more gizmos each');
  assert.ok(panelSize(4, 7) > panelSize(4, 1), 'consoles get busier later');
  assert.ok(panelSize(4, 40) <= 8, 'but never unreadably busy');
});

test('the client view never leaks a control it should not see', () => {
  const view = publicControl(makeControl(new Set(), seeded(9), CONTROL.SLIDER));
  assert.deepEqual(Object.keys(view).sort(), ['id', 'kind', 'label', 'max', 'value']);
});
