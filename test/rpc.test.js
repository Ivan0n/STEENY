'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DiscordPresence, rawActivityPayload, applyStatusTemplate } = require('../src/rpc');

test('never puts the lyric or status text into Rich Presence', async () => {
  const presence = new DiscordPresence();
  const requests = [];
  presence.ready = true;
  presence.client = {
    request: async (command, args) => requests.push({ command, args }),
  };
  presence.pending = {
    playing: true,
    title: 'Track',
    artist: 'Artist',
    lyric: 'Текущая строка песни',
    text: 'Любой произвольный текст',
    template: '{artist} — {text_upper}',
    position: 12,
    duration: 180,
    show_time: true,
  };

  await presence.flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, 'SET_ACTIVITY');
  assert.equal(requests[0].args.activity.type, 2);
  assert.equal(requests[0].args.activity.status_display_type, 1);
  assert.equal(requests[0].args.activity.state, 'Artist');
  assert.equal(requests[0].args.activity.details, 'Track');
});

test('falls back to details-only display when there is no artist', async () => {
  const presence = new DiscordPresence();
  const requests = [];
  presence.ready = true;
  presence.client = {
    request: async (command, args) => requests.push({ command, args }),
  };
  presence.pending = {
    playing: true,
    title: 'Track',
    text: 'Любой произвольный текст',
  };

  await presence.flush();

  assert.equal(requests[0].args.activity.status_display_type, 2);
  assert.equal(requests[0].args.activity.state, undefined);
});

test('reports how long a presence update took, for offset compensation', async () => {
  const measured = [];
  const presence = new DiscordPresence({ onLatency: ms => measured.push(ms) });
  presence.ready = true;
  presence.client = {
    request: async () => new Promise(resolve => setTimeout(resolve, 12)),
  };
  presence.pending = {
    playing: true,
    title: 'Track',
    artist: 'Artist',
    lyric: '🎶 [1:23] Строка',
    position: 12,
    duration: 180,
  };

  await presence.flush();

  assert.equal(measured.length, 1);
  assert.ok(Number.isInteger(measured[0]));
  assert.ok(measured[0] >= 10, `expected a measured round trip, got ${measured[0]}`);
});

test('keeps the presence loop alive when the latency listener throws', async () => {
  const presence = new DiscordPresence({
    onLatency: () => { throw new Error('renderer went away'); },
  });
  presence.ready = true;
  presence.client = { request: async () => undefined };
  presence.pending = { playing: true, title: 'Track', artist: 'Artist' };

  await presence.flush();

  assert.notEqual(presence.lastFingerprint, '');
});

test('a Discord request that never answers does not wedge the presence loop', async () => {
  const presence = new DiscordPresence();
  presence.ready = true;
  // A socket that stays open but never replies: the promise never settles.
  presence.client = {
    request: () => new Promise(() => undefined),
    destroy: () => undefined,
  };
  presence.pending = { playing: true, title: 'Track', artist: 'Artist' };

  await presence.flush();

  // The latch has to be released, or every later update would be dropped for
  // the rest of the session.
  assert.equal(presence.flushing, false);

  // The timeout hands off to the reconnect path, which schedules a retry;
  // drop it so the test does not leave a live timer behind.
  presence.destroy();
});

test('falls back when an older Discord rejects status_display_type', async () => {
  const presence = new DiscordPresence();
  const payloads = [];
  presence.client = {
    request: async (_command, args) => {
      payloads.push(args.activity);
      if (payloads.length === 1) {
        const error = new Error('invalid payload');
        error.code = 4000;
        throw error;
      }
    },
  };
  const activity = {
    type: 2,
    statusDisplayType: 1,
    details: 'Track',
    state: 'Lyric',
  };

  await presence.setActivity(activity);

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].status_display_type, 1);
  assert.equal(payloads[1].status_display_type, undefined);
  assert.equal(presence.compatibilityLevel, 1);
});

test('uses the library serializer when Discord rejects the modern payload', async () => {
  const presence = new DiscordPresence();
  let legacyActivity = null;
  presence.client = {
    request: async () => {
      const error = new Error('invalid payload');
      error.code = 4000;
      throw error;
    },
    setActivity: async activity => {
      legacyActivity = activity;
    },
  };
  const activity = {
    type: 2,
    statusDisplayType: 1,
    details: 'Track',
    state: 'Lyric',
  };

  await presence.setActivity(activity);

  assert.equal(presence.compatibilityLevel, 2);
  assert.equal(legacyActivity, activity);
});

test('normalizes dates for the raw Discord RPC payload', () => {
  const payload = rawActivityPayload({
    type: 2,
    statusDisplayType: 2,
    details: 'Track',
    startTimestamp: new Date(1_700_000_000_000),
    endTimestamp: new Date(1_700_000_180_000),
  });

  assert.deepEqual(payload.timestamps, {
    start: 1_700_000_000_000,
    end: 1_700_000_180_000,
  });
});

test('applyStatusTemplate substitutes case, punctuation-stripped and cropped variants', () => {
  const result = applyStatusTemplate(
    '{text_upper_letters_only} / {title_cropped} / {artist_lower}',
    {
      text: `it's, "loud".`,
      title: 'Song Title - Remastered 2011',
      artist: 'THE Artist',
      position: 0,
    },
  );

  assert.equal(result, "ITS LOUD / Song Title / the artist");
});

test('applyStatusTemplate replaces every occurrence of a repeated token', () => {
  const result = applyStatusTemplate('{text} / {text}', { text: 'echo' });

  assert.equal(result, 'echo / echo');
});

test('applyStatusTemplate truncates to Discord\'s 128 character status limit', () => {
  const result = applyStatusTemplate('{text}', { text: 'x'.repeat(200) });

  assert.equal(result.length, 128);
});
