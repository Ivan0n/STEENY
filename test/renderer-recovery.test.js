'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createRendererRecovery } = require('../src/renderer-recovery');

// A fake clock and timer queue: recovery decisions are all about *when*
// something happened, and real timers would make these tests slow and flaky.
function harness(options = {}) {
  const calls = { reload: 0, fallback: 0, forceCrash: 0, events: [] };
  let clock = 1000;
  let nextId = 1;
  const timers = new Map();

  const recovery = createRendererRecovery({
    reload: () => { calls.reload += 1; },
    forceCrash: () => { calls.forceCrash += 1; },
    showFallback: () => { calls.fallback += 1; },
    onEvent: entry => calls.events.push(entry),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: id => timers.delete(id),
    ...options,
  });

  return {
    recovery,
    calls,
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pendingTimers: () => timers.size,
  };
}

test('reloads the window when the renderer crashes', () => {
  const h = harness();
  assert.equal(h.recovery.rendererGone({ reason: 'crashed' }), 'reload');
  assert.equal(h.calls.reload, 1);
  assert.equal(h.calls.fallback, 0);
});

test('ignores a renderer that exited as part of normal teardown', () => {
  const h = harness();
  assert.equal(h.recovery.rendererGone({ reason: 'clean-exit' }), 'ignored');
  assert.equal(h.calls.reload, 0);
});

test('falls back to the offline notice once a crash loop burns the budget', () => {
  const h = harness({ maxRecoveries: 3 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(h.recovery.rendererGone({ reason: 'oom' }), 'reload');
  }
  // The fourth crash inside the same window is a loop, not an accident.
  assert.equal(h.recovery.rendererGone({ reason: 'oom' }), 'fallback');
  assert.equal(h.calls.reload, 3);
  assert.equal(h.calls.fallback, 1);
});

test('restores the recovery budget after the crash window passes', () => {
  const h = harness({ maxRecoveries: 2, crashWindowMs: 60000 });
  h.recovery.rendererGone({ reason: 'crashed' });
  h.recovery.rendererGone({ reason: 'crashed' });
  assert.equal(h.recovery.rendererGone({ reason: 'crashed' }), 'fallback');

  h.advance(60001);
  assert.equal(h.recovery.rendererGone({ reason: 'crashed' }), 'reload');
});

test('leaves a slow renderer alone when it recovers within the grace period', () => {
  const h = harness({ unresponsiveGraceMs: 12000 });
  assert.equal(h.recovery.unresponsive(), 'waiting');
  assert.equal(h.recovery.pending(), true);

  h.advance(5000);
  assert.equal(h.recovery.responsive(), 'recovered');
  h.advance(60000);

  assert.equal(h.calls.reload, 0, 'a long task that finishes must not reload');
  assert.equal(h.recovery.pending(), false);
});

test('kills a renderer still wedged after the grace period', () => {
  const h = harness({ unresponsiveGraceMs: 12000 });
  h.recovery.unresponsive();
  h.advance(11999);
  assert.equal(h.calls.forceCrash, 0);

  h.advance(2);
  // Reloading a wedged renderer does nothing -- the process has to die first.
  assert.equal(h.calls.forceCrash, 1);
  assert.equal(h.calls.reload, 0);
  assert.deepEqual(h.calls.events.at(-1), {
    cause: 'unresponsive',
    action: 'force-crash',
  });
});

test('rebuilds the page once the forced kill reports back', () => {
  const h = harness({ unresponsiveGraceMs: 12000, maxRecoveries: 3 });
  h.recovery.unresponsive();
  h.advance(12001);
  assert.equal(h.calls.forceCrash, 1);

  // The kill we asked for arrives as an ordinary crash event.
  assert.equal(h.recovery.rendererGone({ reason: 'killed' }), 'reload');
  assert.equal(h.calls.reload, 1);
  assert.deepEqual(h.calls.events.at(-1), {
    cause: 'forced-crash',
    action: 'reload',
  });

  // One hang must cost one unit of budget, not two.
  h.recovery.rendererGone({ reason: 'crashed' });
  h.recovery.rendererGone({ reason: 'crashed' });
  assert.equal(h.calls.fallback, 0, 'the incident was charged twice');
  assert.equal(h.recovery.rendererGone({ reason: 'crashed' }), 'fallback');
});

test('ignores repeat unresponsive events while a kill is in flight', () => {
  const h = harness({ unresponsiveGraceMs: 12000 });
  h.recovery.unresponsive();
  h.advance(12001);
  assert.equal(h.calls.forceCrash, 1);

  // Electron keeps firing 'unresponsive' until the process actually dies.
  for (let i = 0; i < 6; i += 1) {
    assert.equal(h.recovery.unresponsive(), 'waiting');
  }
  h.advance(999999);
  assert.equal(h.calls.forceCrash, 1, 'one hang must produce one kill');
  assert.equal(h.calls.fallback, 0);
});

test('does not stack grace timers while a hang is already pending', () => {
  const h = harness();
  h.recovery.unresponsive();
  h.recovery.unresponsive();
  h.recovery.unresponsive();
  assert.equal(h.pendingTimers(), 1);

  h.advance(999999);
  assert.equal(h.calls.forceCrash, 1);
});

test('a crash cancels the hang timer instead of recovering twice', () => {
  const h = harness();
  h.recovery.unresponsive();
  h.recovery.rendererGone({ reason: 'crashed' });
  h.advance(999999);

  assert.equal(h.calls.reload, 1, 'the pending hang must not fire as well');
  assert.equal(h.calls.forceCrash, 0);
});

test('dispose drops pending work so a closed window stops recovering', () => {
  const h = harness();
  h.recovery.unresponsive();
  h.recovery.dispose();
  h.advance(999999);

  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.forceCrash, 0);
  assert.equal(h.pendingTimers(), 0);
});

test('survives a reload callback that throws', () => {
  const h = harness({
    reload: () => { throw new Error('webContents destroyed'); },
  });
  assert.equal(h.recovery.rendererGone({ reason: 'crashed' }), 'reload');
});

test('client wires renderer crash and hang recovery into the window', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main.js'),
    'utf8',
  );
  assert.match(source, /on\('render-process-gone'/);
  assert.match(source, /on\('unresponsive'/);
  assert.match(source, /on\('responsive'/);
  assert.match(source, /recovery\.rendererGone\(details\)/);
  assert.match(source, /recovery\.dispose\(\)/);
  assert.match(source, /forcefullyCrashRenderer\(\)/);
});

test('a beating page is never touched', () => {
  const h = harness({ heartbeatTimeoutMs: 25000 });
  h.recovery.checkHeartbeat(true);
  for (let i = 0; i < 20; i += 1) {
    h.advance(5000);
    h.recovery.heartbeat();
    assert.equal(h.recovery.checkHeartbeat(true), 'alive');
  }
  assert.equal(h.calls.forceCrash, 0);
});

test('kills a renderer that stops beating', () => {
  const h = harness({ heartbeatTimeoutMs: 25000 });
  h.recovery.heartbeat();

  h.advance(24000);
  assert.equal(h.recovery.checkHeartbeat(true), 'alive');

  h.advance(2000);
  assert.equal(h.recovery.checkHeartbeat(true), 'force-crash');
  assert.equal(h.calls.forceCrash, 1);
  assert.deepEqual(h.calls.events.at(-1), {
    cause: 'heartbeat',
    action: 'force-crash',
  });
});

test('a throttled window is never judged for going quiet', () => {
  const h = harness({ heartbeatTimeoutMs: 25000 });
  h.recovery.heartbeat();

  // Hidden: Chromium throttles the page's timers on purpose.
  h.advance(600000);
  assert.equal(h.recovery.checkHeartbeat(false), 'skipped');

  // Back on screen the clock restarts rather than instantly firing.
  assert.equal(h.recovery.checkHeartbeat(true), 'armed');
  h.advance(24000);
  assert.equal(h.recovery.checkHeartbeat(true), 'alive');
  assert.equal(h.calls.forceCrash, 0);
});

test('a fresh renderer gets a full timeout before the watchdog judges it', () => {
  const h = harness({ heartbeatTimeoutMs: 25000 });
  h.recovery.heartbeat();
  h.advance(26000);
  assert.equal(h.recovery.checkHeartbeat(true), 'force-crash');

  // The kill lands and the page reloads; the replacement has not beaten yet.
  h.recovery.rendererGone({ reason: 'killed' });
  assert.equal(h.recovery.checkHeartbeat(true), 'armed');
  h.advance(24000);
  assert.equal(h.recovery.checkHeartbeat(true), 'alive');
  assert.equal(h.calls.forceCrash, 1, 'the new renderer must not be killed too');
});

test('client runs the heartbeat watchdog against the visible window', () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main.js'),
    'utf8',
  );
  const preloadSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'preload.js'),
    'utf8',
  );
  assert.match(preloadSource, /ipcRenderer\.send\('ui:heartbeat'\)/);
  assert.match(preloadSource, /setInterval\(beat, HEARTBEAT_MS\)/);
  assert.match(mainSource, /ipcMain\.on\('ui:heartbeat'/);
  assert.match(mainSource, /recovery\.checkHeartbeat\(visible && settled\)/);
  assert.match(mainSource, /isVisible\(\) && !mainWindow\.isMinimized\(\)/);
  // A page that is still loading has not begun beating and must not be judged.
  assert.match(mainSource, /const settled = !mainWindow\.webContents\.isLoading\(\)/);
});
