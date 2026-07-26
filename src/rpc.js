'use strict';

const DiscordRPC = require('discord-rpc');

const CLIENT_ID = '1395388116105429195';
const UPDATE_DELAY_MS = 1200;
const RECONNECT_DELAY_MS = 8000;

class DiscordPresence {
  constructor() {
    this.client = null;
    this.ready = false;
    this.connecting = false;
    this.pending = null;
    this.current = null;
    this.timer = null;
    this.reconnectTimer = null;
    this.lastFingerprint = '';
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
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), UPDATE_DELAY_MS);
    if (!this.ready) this.connect();
  }

  async flush() {
    if (!this.ready || !this.client || !this.pending) return;
    const data = this.pending;
    this.pending = null;

    if (!data.playing) {
      await this.clear();
      return;
    }

    const title = String(data.title || 'Неизвестный трек').trim().slice(0, 128);
    const artist = String(data.artist || '').trim().slice(0, 128);
    const lyric = String(data.lyric || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const cover = String(data.cover_url || '').trim();
    const position = Math.max(0, Number(data.position) || 0);
    const duration = Math.max(0, Number(data.duration) || 0);
    const now = Date.now();
    const activity = {
      details: title,
      state: lyric.length >= 2 ? lyric : artist || undefined,
      largeImageKey: cover.startsWith('https://') ? cover : 'prew',
      largeImageText: lyric && artist ? `${title} — ${artist}`.slice(0, 128) : title,
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

    try {
      await this.client.setActivity(activity);
      this.current = data;
      this.lastFingerprint = fingerprint;
    } catch {
      this.pending = data;
      this.handleDisconnect(this.client);
    }
  }

  async clear() {
    this.pending = null;
    this.current = null;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.ready || !this.client || !this.lastFingerprint) return;
    try {
      await this.client.clearActivity();
    } catch {
      // A disconnected Discord client has nothing left to clear.
    }
    this.lastFingerprint = '';
  }

  destroy() {
    clearTimeout(this.timer);
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

module.exports = { DiscordPresence };
