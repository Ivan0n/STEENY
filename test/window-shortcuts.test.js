'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWindowShortcutHandler } = require('../src/window-shortcuts');

function shortcutHarness(options) {
  let fullscreen = false;
  let transitions = 0;
  let prevented = 0;
  const browserWindow = {
    isFullScreen: () => fullscreen,
    setFullScreen: value => {
      fullscreen = value;
      transitions += 1;
    },
  };
  const handle = createWindowShortcutHandler(browserWindow, options);
  const dispatch = input => {
    handle({ preventDefault: () => { prevented += 1; } }, input);
  };
  return {
    dispatch,
    fullscreen: () => fullscreen,
    prevented: () => prevented,
    transitions: () => transitions,
  };
}

test('F11 toggles native fullscreen mode', () => {
  const harness = shortcutHarness();

  harness.dispatch({ type: 'keyDown', key: 'F11' });
  assert.equal(harness.fullscreen(), true);

  harness.dispatch({ type: 'keyUp', key: 'F11' });
  assert.equal(harness.fullscreen(), true);

  harness.dispatch({ type: 'keyDown', key: 'F11' });
  assert.equal(harness.fullscreen(), false);
  assert.equal(harness.transitions(), 2);
  assert.equal(harness.prevented(), 3);
});

test('holding F11 does not repeatedly toggle fullscreen', () => {
  const harness = shortcutHarness();

  harness.dispatch({ type: 'keyDown', key: 'F11' });
  harness.dispatch({ type: 'keyDown', key: 'F11', isAutoRepeat: true });

  assert.equal(harness.fullscreen(), true);
  assert.equal(harness.transitions(), 1);
});

test('existing zoom and DevTools shortcut filtering is preserved', () => {
  const production = shortcutHarness();
  production.dispatch({ type: 'keyDown', key: '+', control: true });
  production.dispatch({ type: 'keyDown', key: 'F12' });
  assert.equal(production.prevented(), 2);

  const development = shortcutHarness({ devtools: true });
  development.dispatch({ type: 'keyDown', key: 'F12' });
  assert.equal(development.prevented(), 0);
});
