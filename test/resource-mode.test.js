'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  collectRendererGarbage,
  createWindowResourceManager,
} = require('../src/window-resource-manager');

test('client enables Chromium throttling and renderer media cleanup', () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main.js'),
    'utf8',
  );
  const preloadSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'preload.js'),
    'utf8',
  );
  assert.match(mainSource, /backgroundThrottling:\s*true/);
  assert.doesNotMatch(mainSource, /backgroundThrottling:\s*false/);
  assert.match(mainSource, /renderer-process-limit/);
  assert.match(mainSource, /resources\.sync\(\)/);
  assert.match(preloadSource, /appearanceWallpaperVideo/);
  assert.match(preloadSource, /fpVideo/);
  assert.match(preloadSource, /steeny-low-memory-mode/);
  assert.match(preloadSource, /removeAttribute\('src'\)/);
});

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.minimized = false;
    this.visible = true;
    this.messages = [];
    this.throttling = [];
    this.webContents = {
      isDestroyed: () => false,
      setBackgroundThrottling: value => this.throttling.push(value),
      send: (channel, payload) => this.messages.push({ channel, payload }),
    };
  }

  isDestroyed() {
    return false;
  }

  isMinimized() {
    return this.minimized;
  }

  isVisible() {
    return this.visible;
  }
}

test('enters low-memory mode while minimized and restores on show', async () => {
  const window = new FakeWindow();
  const scheduled = [];
  const collected = [];
  const manager = createWindowResourceManager({
    purgeDelayMs: 2500,
    setTimer: callback => {
      scheduled.push(callback);
      return { unref() {} };
    },
    clearTimer: () => undefined,
    collectGarbage: async webContents => collected.push(webContents),
  });

  manager.bind(window);
  assert.equal(manager.isLowMemory(), false);
  assert.equal(window.messages.at(-1).payload.lowMemory, false);

  window.minimized = true;
  window.emit('minimize');
  assert.equal(manager.isLowMemory(), true);
  assert.equal(window.messages.at(-1).payload.reason, 'minimized');
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.deepEqual(collected, [window.webContents]);

  window.minimized = false;
  window.emit('restore');
  assert.equal(manager.isLowMemory(), false);
  assert.equal(window.messages.at(-1).payload.lowMemory, false);
  assert.ok(window.throttling.every(Boolean));

  window.visible = false;
  window.emit('hide');
  assert.equal(manager.isLowMemory(), true);
  assert.equal(window.messages.at(-1).payload.reason, 'hidden');
  manager.unbind();
  assert.equal(window.listenerCount('hide'), 0);
});

test('renderer garbage collection attaches and detaches a private debugger', async () => {
  const commands = [];
  const debuggerClient = {
    attached: false,
    isAttached() {
      return this.attached;
    },
    attach(version) {
      assert.equal(version, '1.3');
      this.attached = true;
    },
    async sendCommand(command) {
      commands.push(command);
    },
    detach() {
      this.attached = false;
    },
  };
  const collected = await collectRendererGarbage({
    isDestroyed: () => false,
    debugger: debuggerClient,
  });
  assert.equal(collected, true);
  assert.deepEqual(commands, ['HeapProfiler.collectGarbage']);
  assert.equal(debuggerClient.attached, false);
});

test('does not interfere when DevTools already owns the debugger', async () => {
  const collected = await collectRendererGarbage({
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
    },
  });
  assert.equal(collected, false);
});
