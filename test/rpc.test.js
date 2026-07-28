'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DiscordPresence, rawActivityPayload } = require('../src/rpc');

test('promotes the live lyric into the Discord profile status text', async () => {
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
    position: 12,
    duration: 180,
    show_time: true,
  };

  await presence.flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, 'SET_ACTIVITY');
  assert.equal(requests[0].args.activity.type, 2);
  assert.equal(requests[0].args.activity.status_display_type, 1);
  assert.equal(
    requests[0].args.activity.state,
    'Текущая строка песни',
  );
  assert.equal(requests[0].args.activity.details, 'Track');
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
