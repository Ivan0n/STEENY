'use strict';

// A renderer that dies takes the whole interface with it. The window stays
// mapped and keeps painting its background colour, so from the outside the app
// has simply lost its UI -- no error, no blank-page notice, nothing to click.
// Chromium will not bring it back on its own; only the main process can ask for
// a reload, and until this module existed nobody did. A wedged renderer ends up
// in the same place by a different road: 'unresponsive' fires, the window
// freezes, and it stays frozen.
//
// Recovery is budgeted on purpose. Reloading a page that crashed once is
// almost always right. Reloading a page that crashes every time it loads is a
// loop that burns CPU while still showing the user nothing, so after the budget
// is spent the caller's fallback surface is shown instead -- static markup that
// always renders and carries a retry control.

const DEFAULT_UNRESPONSIVE_GRACE_MS = 12000;
const DEFAULT_CRASH_WINDOW_MS = 60000;
const DEFAULT_MAX_RECOVERIES = 3;
// Chromium's own 'unresponsive' is not a dependable hang signal. It is raised
// off unacknowledged input, so it needs the user to be interacting, and
// measured against this app it arrived anywhere from 16 seconds late to never
// at all -- a renderer sat wedged for 75 seconds without a single event. The
// heartbeat does not ask Chromium anything: the page reports in on a timer, and
// silence is the hang. A renderer stuck in script cannot run that timer.
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 25000;

// A renderer exits cleanly as part of ordinary navigation teardown. Treating
// that as a failure would have the recovery fight the app's own lifecycle.
const IGNORED_REASONS = new Set(['clean-exit']);

function createRendererRecovery({
  reload,
  forceCrash,
  showFallback,
  unresponsiveGraceMs = DEFAULT_UNRESPONSIVE_GRACE_MS,
  crashWindowMs = DEFAULT_CRASH_WINDOW_MS,
  maxRecoveries = DEFAULT_MAX_RECOVERIES,
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
  onEvent = () => undefined,
} = {}) {
  let recoveries = [];
  let graceTimer = null;
  let lastBeatAt = null;
  // Set between "we killed the renderer to break a hang" and the
  // 'render-process-gone' that killing produces, so the crash handler knows the
  // corpse is its own doing and reloads without charging the budget twice.
  let awaitingForcedCrash = false;

  // Only recoveries inside the trailing window count, so an app that crashed
  // twice last week still gets a full budget today.
  function withinBudget() {
    const cutoff = now() - crashWindowMs;
    recoveries = recoveries.filter(at => at > cutoff);
    return recoveries.length < maxRecoveries;
  }

  function cancelGrace() {
    if (graceTimer !== null) clearTimer(graceTimer);
    graceTimer = null;
  }

  function recover(cause) {
    if (!withinBudget()) {
      onEvent({ cause, action: 'fallback' });
      try {
        showFallback?.();
      } catch {
        // The window can be torn down between the crash and this call.
      }
      return 'fallback';
    }
    recoveries.push(now());
    onEvent({ cause, action: 'reload' });
    lastBeatAt = null;
    try {
      reload?.();
    } catch {
      // Same here: a destroyed webContents throws rather than reloading.
    }
    return 'reload';
  }

  // A wedged renderer cannot be reloaded. reload() hands the renderer a
  // navigation to process, and processing is exactly what a renderer stuck in
  // an endless script cannot do -- measured against this app, the request just
  // queues while 'unresponsive' keeps firing and the window stays frozen.
  // Killing the process outright is what actually lands: it produces a
  // 'render-process-gone', and rebuilding from a dead renderer is the path that
  // demonstrably works.
  function breakHang(cause) {
    if (!withinBudget()) {
      onEvent({ cause, action: 'fallback' });
      try {
        showFallback?.();
      } catch {
        // The window can be torn down while the hang is being handled.
      }
      return 'fallback';
    }
    recoveries.push(now());
    onEvent({ cause, action: 'force-crash' });
    awaitingForcedCrash = true;
    // The replacement renderer has not reported in yet; leaving the old
    // timestamp would make the watchdog judge it hung the moment it starts.
    lastBeatAt = null;
    try {
      forceCrash?.();
    } catch {
      awaitingForcedCrash = false;
    }
    return 'force-crash';
  }

  return Object.freeze({
    // `details` is the payload Electron hands to 'render-process-gone'.
    rendererGone(details) {
      const reason = details?.reason;
      // A crash outranks a pending hang: the process it was waiting on is gone.
      cancelGrace();
      if (awaitingForcedCrash) {
        // Our own kill landed. This is the second half of one incident, already
        // paid for when the hang was detected, so rebuild without re-charging.
        awaitingForcedCrash = false;
        lastBeatAt = null;
        onEvent({ cause: 'forced-crash', action: 'reload' });
        try {
          reload?.();
        } catch {
          // A destroyed webContents throws rather than reloading.
        }
        return 'reload';
      }
      if (IGNORED_REASONS.has(reason)) return 'ignored';
      return recover(reason || 'crashed');
    },

    // Electron fires 'unresponsive' for any long task, including ones that
    // finish on their own, and it re-fires every few seconds while the hang
    // lasts. Only the first one may arm the timer: re-arming on each repeat
    // would kill the renderer over and over and drain the budget in seconds.
    unresponsive() {
      if (graceTimer !== null || awaitingForcedCrash) return 'waiting';
      graceTimer = setTimer(() => {
        graceTimer = null;
        breakHang('unresponsive');
      }, unresponsiveGraceMs);
      graceTimer?.unref?.();
      return 'waiting';
    },

    responsive() {
      const wasWaiting = graceTimer !== null;
      cancelGrace();
      awaitingForcedCrash = false;
      return wasWaiting ? 'recovered' : 'idle';
    },

    // The page checked in, so it is running script: any hang we were timing is
    // over before it earned a kill.
    heartbeat() {
      lastBeatAt = now();
      cancelGrace();
      return 'alive';
    },

    // `eligible` is false whenever a missing heartbeat would not mean a hang --
    // a hidden or minimized window has its timers throttled by Chromium on
    // purpose, and killing a renderer for obeying that would be the watchdog
    // inventing the very freeze it exists to prevent.
    checkHeartbeat(eligible) {
      if (!eligible) {
        // Restart the clock: the page owes nothing for time spent throttled.
        lastBeatAt = null;
        return 'skipped';
      }
      if (awaitingForcedCrash || graceTimer !== null) return 'skipped';
      if (lastBeatAt === null) {
        lastBeatAt = now();
        return 'armed';
      }
      if (now() - lastBeatAt <= heartbeatTimeoutMs) return 'alive';
      return breakHang('heartbeat');
    },

    dispose() {
      cancelGrace();
      recoveries = [];
      awaitingForcedCrash = false;
      lastBeatAt = null;
    },

    pending: () => graceTimer !== null || awaitingForcedCrash,
  });
}

module.exports = {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_UNRESPONSIVE_GRACE_MS,
  DEFAULT_CRASH_WINDOW_MS,
  DEFAULT_MAX_RECOVERIES,
  createRendererRecovery,
};
