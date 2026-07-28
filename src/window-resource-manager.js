'use strict';

const DEFAULT_PURGE_DELAY_MS = 2500;

async function collectRendererGarbage(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  const debuggerClient = webContents.debugger;
  if (!debuggerClient || debuggerClient.isAttached()) return false;
  let attached = false;
  try {
    debuggerClient.attach('1.3');
    attached = true;
    await debuggerClient.sendCommand('HeapProfiler.collectGarbage');
    return true;
  } catch {
    return false;
  } finally {
    if (attached) {
      try {
        debuggerClient.detach();
      } catch {
        // The renderer may have closed while memory was being collected.
      }
    }
  }
}

function createWindowResourceManager({
  purgeDelayMs = DEFAULT_PURGE_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  collectGarbage = collectRendererGarbage,
} = {}) {
  let window = null;
  let lowMemory = null;
  let purgeTimer = null;
  const listeners = [];

  function backgrounded() {
    if (!window || window.isDestroyed?.()) return false;
    return Boolean(window.isMinimized?.() || !window.isVisible?.());
  }

  function cancelPurge() {
    if (purgeTimer !== null) clearTimer(purgeTimer);
    purgeTimer = null;
  }

  function publish(force = false) {
    if (!window || window.isDestroyed?.()) return false;
    const next = backgrounded();
    if (!force && next === lowMemory) return next;
    lowMemory = next;
    const webContents = window.webContents;
    try {
      // Audio playback is not suspended. Chromium only throttles visual
      // rendering, animation frames and background JavaScript timers.
      webContents.setBackgroundThrottling?.(true);
      webContents.send('resource-mode', {
        lowMemory,
        reason: window.isMinimized?.() ? 'minimized' : lowMemory ? 'hidden' : 'visible',
      });
    } catch {
      return next;
    }

    cancelPurge();
    if (lowMemory) {
      purgeTimer = setTimer(() => {
        purgeTimer = null;
        collectGarbage(webContents).catch?.(() => undefined);
      }, purgeDelayMs);
      purgeTimer?.unref?.();
    }
    return next;
  }

  function bind(nextWindow) {
    unbind();
    window = nextWindow;
    if (!window || window.isDestroyed?.()) return;
    for (const eventName of ['minimize', 'restore', 'hide', 'show']) {
      const listener = () => publish();
      window.on(eventName, listener);
      listeners.push([eventName, listener]);
    }
    publish(true);
  }

  function unbind() {
    cancelPurge();
    if (window && !window.isDestroyed?.()) {
      for (const [eventName, listener] of listeners) {
        window.removeListener(eventName, listener);
      }
    }
    listeners.length = 0;
    window = null;
    lowMemory = null;
  }

  return Object.freeze({
    bind,
    unbind,
    sync: () => publish(true),
    isLowMemory: () => lowMemory === true,
  });
}

module.exports = {
  DEFAULT_PURGE_DELAY_MS,
  collectRendererGarbage,
  createWindowResourceManager,
};
