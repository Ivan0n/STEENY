'use strict';

const DiscordRPC = require('discord-rpc');

const CLIENT_ID = '1395388116105429195';
const RECONNECT_DELAY_MS = 8000;
const INVALID_RPC_PAYLOAD = 4000;
// discord-rpc resolves a request when the reply arrives over the IPC socket.
// If Discord stops answering without closing that socket the promise simply
// never settles -- and since flush() holds a re-entrancy latch across the
// await, every later update would be dropped for the rest of the session.
const REQUEST_TIMEOUT_MS = 5000;

// The timer is deliberately not unref'd: it is the only thing standing between
// a hung request and an await that never returns, so it has to be able to
// hold the loop for its own short lifetime.
function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('discord rpc timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function timestampValue(value) {
  if (value instanceof Date) return Math.round(value.getTime());
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : undefined;
}

function formatTimestamp(totalSeconds) {
  const whole = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

const LETTERS_ONLY_PATTERN = /['",.]/g;
const TITLE_SUFFIX_PATTERN = /( ?- ?.+)|(\(.+\))/g;

function replaceAll(source, token, value) {
  return source.split(token).join(value);
}

// Lets a caller define its own status text instead of the fixed lyric/artist
// layout below, e.g. template: '{artist} — {text}'.
function applyStatusTemplate(template, vars = {}) {
  const text = String(vars.text || '');
  const title = String(vars.title || '');
  const artist = String(vars.artist || '');
  const tokens = {
    '{text}': text,
    '{text_upper}': text.toUpperCase(),
    '{text_lower}': text.toLowerCase(),
    '{text_letters_only}': text.replace(LETTERS_ONLY_PATTERN, ''),
    '{text_upper_letters_only}': text.toUpperCase().replace(LETTERS_ONLY_PATTERN, ''),
    '{text_lower_letters_only}': text.toLowerCase().replace(LETTERS_ONLY_PATTERN, ''),
    '{title}': title,
    '{title_upper}': title.toUpperCase(),
    '{title_lower}': title.toLowerCase(),
    '{title_cropped}': title.replace(TITLE_SUFFIX_PATTERN, ''),
    '{title_upper_cropped}': title.toUpperCase().replace(TITLE_SUFFIX_PATTERN, ''),
    '{title_lower_cropped}': title.toLowerCase().replace(TITLE_SUFFIX_PATTERN, ''),
    '{artist}': artist,
    '{artist_upper}': artist.toUpperCase(),
    '{artist_lower}': artist.toLowerCase(),
    '{timestamp}': formatTimestamp(vars.position),
  };

  let result = String(template || '');
  for (const [token, value] of Object.entries(tokens)) {
    result = replaceAll(result, token, value);
  }
  return result.replace(/\s+/g, ' ').trim().slice(0, 128);
}

function rawActivityPayload(activity, compatibilityLevel = 0) {
  const timestamps = activity.startTimestamp || activity.endTimestamp
    ? {
        start: timestampValue(activity.startTimestamp),
        end: timestampValue(activity.endTimestamp),
      }
    : undefined;
  const assets = (
    activity.largeImageKey || activity.largeImageText
    || activity.smallImageKey || activity.smallImageText
  ) ? {
      large_image: activity.largeImageKey,
      large_text: activity.largeImageText,
      small_image: activity.smallImageKey,
      small_text: activity.smallImageText,
    } : undefined;
  const payload = {
    type: activity.type,
    status_display_type: activity.statusDisplayType,
    state: activity.state,
    details: activity.details,
    timestamps,
    assets,
    buttons: activity.buttons,
    instance: !!activity.instance,
  };
  if (compatibilityLevel >= 1) delete payload.status_display_type;
  return payload;
}

class DiscordPresence {
  constructor(options = {}) {
    // The web app averages these round trips to compensate for network
    // latency when it schedules the next update.
    this.onLatency = typeof options.onLatency === 'function' ? options.onLatency : null;
    this.client = null;
    this.ready = false;
    this.connecting = false;
    this.pending = null;
    this.current = null;
    this.flushing = false;
    this.reconnectTimer = null;
    this.lastFingerprint = '';
    this.compatibilityLevel = 0;
  }

  connect() {
    if (this.connecting || this.ready) return;
    this.connecting = true;
    const client = new DiscordRPC.Client({ transport: 'ipc' });
    this.client = client;

    client.once('ready', () => {
      if (this.client !== client) return;
      this.ready = true;
      this.connecting = false;
      this.lastFingerprint = '';
      this.flush();
    });
    client.once('disconnected', () => this.handleDisconnect(client));
    client.login({ clientId: CLIENT_ID }).catch(() => {
      this.handleDisconnect(client);
    });
  }

  handleDisconnect(client) {
    if (this.client !== client) return;
    if (!this.pending && this.current) this.pending = this.current;
    const shouldReconnect = Boolean(this.pending);
    this.ready = false;
    this.connecting = false;
    this.client = null;
    this.lastFingerprint = '';
    try {
      client.destroy();
    } catch {
      // Discord may already have closed the IPC transport.
    }
    clearTimeout(this.reconnectTimer);
    if (shouldReconnect) {
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    }
  }

  update(dataJson) {
    try {
      const parsed = JSON.parse(String(dataJson));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      this.pending = parsed;
    } catch {
      return;
    }
    if (!this.ready) {
      this.connect();
      return;
    }
    this.flush();
  }

  // Applies `pending` immediately -- no artificial delay. A flush already in
  // flight is never interrupted; whatever landed in `pending` while it was
  // running gets picked up right after, so nothing in between is dropped.
  async flush() {
    if (this.flushing) return;
    if (!this.ready || !this.client || !this.pending) return;
    this.flushing = true;
    try {
      await this.flushOnce();
    } finally {
      this.flushing = false;
      if (this.pending) this.flush();
    }
  }

  async flushOnce() {
    const data = this.pending;
    this.pending = null;

    if (!data.playing) {
      await this.clear();
      return;
    }

    const title = String(data.title || 'Неизвестный трек').trim().slice(0, 128);
    const artist = String(data.artist || '').trim().slice(0, 128);
    const position = Math.max(0, Number(data.position) || 0);
    const duration = Math.max(0, Number(data.duration) || 0);
    // The lyric/status text is never shown in Rich Presence -- it only goes to
    // the account's own custom status via setStatus() in main.js.
    const cover = String(data.cover_url || '').trim();
    const now = Date.now();
    const activity = {
      type: 2,
      statusDisplayType: artist ? 1 : 2,
      details: title,
      state: artist || undefined,
      largeImageKey: cover.startsWith('https://') ? cover : 'prew',
      largeImageText: title,
      smallImageKey: 'logo',
      smallImageText: 'STEENY',
      instance: false,
    };

    if (data.show_time) {
      activity.startTimestamp = new Date(now - position * 1000);
      if (duration > 1) {
        activity.endTimestamp = new Date(now + (duration - position) * 1000);
      }
    }

    const fingerprint = JSON.stringify({
      title,
      state: activity.state,
      cover: activity.largeImageKey,
      start: activity.startTimestamp
        ? Math.round(activity.startTimestamp.getTime() / 3000)
        : 0,
    });
    if (fingerprint === this.lastFingerprint) return;

    const sentAt = Date.now();
    try {
      await this.setActivity(activity);
      this.current = data;
      this.lastFingerprint = fingerprint;
      this.reportLatency(Date.now() - sentAt);
    } catch {
      this.pending = data;
      this.handleDisconnect(this.client);
    }
  }

  reportLatency(elapsed) {
    if (!this.onLatency || !Number.isFinite(elapsed) || elapsed < 0) return;
    try {
      this.onLatency(Math.round(elapsed));
    } catch {
      // A closed renderer must not break the presence loop.
    }
  }

  async setActivity(activity) {
    while (this.compatibilityLevel < 2) {
      try {
        await withTimeout(this.client.request('SET_ACTIVITY', {
          pid: process.pid,
          activity: rawActivityPayload(
            activity,
            this.compatibilityLevel,
          ),
        }), REQUEST_TIMEOUT_MS);
        return;
      } catch (error) {
        if (Number(error?.code) !== INVALID_RPC_PAYLOAD) throw error;
        this.compatibilityLevel += 1;
      }
    }
    await withTimeout(this.client.setActivity(activity), REQUEST_TIMEOUT_MS);
  }

  async clear() {
    this.pending = null;
    this.current = null;
    if (!this.ready || !this.client || !this.lastFingerprint) return;
    try {
      await this.client.clearActivity();
    } catch {
      // A disconnected Discord client has nothing left to clear.
    }
    this.lastFingerprint = '';
  }

  destroy() {
    clearTimeout(this.reconnectTimer);
    this.pending = null;
    this.current = null;
    this.ready = false;
    try {
      this.client?.clearActivity();
      this.client?.destroy();
    } catch {
      // Shutdown must not be held up by Discord.
    }
    this.client = null;
  }
}

module.exports = { DiscordPresence, rawActivityPayload, applyStatusTemplate, formatTimestamp };
