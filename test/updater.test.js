'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateManager } = require('../src/updater');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCount = 0;
    this.installCount = 0;
    this.checkResult = Promise.resolve(null);
  }

  checkForUpdates() {
    this.checkCount += 1;
    return this.checkResult;
  }

  quitAndInstall() {
    this.installCount += 1;
  }
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function fixture({ manualOnly = false, dialogResponse = 1 } = {}) {
  const updater = new FakeUpdater();
  const messages = [];
  const opened = [];
  const manager = createUpdateManager({
    app: {
      isPackaged: true,
      getVersion: () => '2.1.0',
    },
    autoUpdater: updater,
    dialog: {
      showMessageBox: async (...args) => {
        messages.push(args.at(-1));
        return { response: dialogResponse };
      },
    },
    shell: {
      openExternal: async url => {
        opened.push(url);
      },
    },
    getMainWindow: () => null,
    showMainWindow: () => undefined,
    manualOnly,
  });
  return {
    manager,
    updater,
    messages,
    opened,
  };
}

test('downloads and installs an NSIS/AppImage update after confirmation', async () => {
  const env = fixture({ dialogResponse: 0 });
  env.manager.start();
  env.updater.emit('update-available', { version: '2.2.0' });
  env.updater.emit('download-progress', { percent: 48.5 });

  assert.equal(env.manager.getState().status, 'downloading');
  assert.equal(env.manager.getState().percent, 48.5);

  env.updater.emit('update-downloaded', { version: '2.2.0' });
  await nextTurn();

  assert.equal(env.manager.getState().status, 'ready');
  assert.equal(env.updater.installCount, 1);
  env.manager.stop();
});

test('deduplicates concurrent update checks', async () => {
  const env = fixture();
  let finishCheck;
  env.updater.checkResult = new Promise(resolve => {
    finishCheck = resolve;
  });
  env.manager.start();

  const first = env.manager.check();
  const second = env.manager.check();
  assert.equal(env.updater.checkCount, 1);

  finishCheck(null);
  await Promise.all([first, second]);
  env.manager.stop();
});

test('hands DEB and RPM updates to the Linux package manager', async () => {
  const env = fixture({ manualOnly: true, dialogResponse: 0 });
  env.manager.start();
  assert.equal(env.updater.autoDownload, false);

  env.updater.emit('update-available', { version: '2.2.0' });
  await nextTurn();

  assert.equal(env.manager.getState().status, 'manual-update');
  assert.equal(env.updater.installCount, 0);
  assert.equal(env.opened.length, 1);
  env.manager.stop();
});
