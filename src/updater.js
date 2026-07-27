'use strict';

const RELEASES_URL = 'https://github.com/Ivan0n/SteenyClient/releases/latest';
const INITIAL_CHECK_DELAY_MS = 12_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function safeVersion(info) {
  const value = String(info?.version || '').trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : '';
}

function createUpdateManager({
  app,
  autoUpdater,
  dialog,
  shell,
  getMainWindow,
  showMainWindow,
  disabled = false,
  manualOnly = false,
}) {
  let state = {
    status: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    percent: null,
    error: null,
  };
  let started = false;
  let checkPromise = null;
  let manualCheck = false;
  let readyPromptShown = false;
  let initialTimer = null;
  let intervalTimer = null;
  let lastHandledError = '';
  let lastHandledErrorAt = 0;
  let manualUpdatePromptShown = false;

  function windowForDialog() {
    const window = getMainWindow?.();
    return window && !window.isDestroyed() ? window : undefined;
  }

  function publish(patch) {
    state = { ...state, ...patch };
    const window = getMainWindow?.();
    if (window && !window.isDestroyed()) {
      window.webContents.send('update:state', { ...state });
    }
    return { ...state };
  }

  function showMessage(options) {
    const window = windowForDialog();
    return window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }

  async function openReleases() {
    await shell.openExternal(RELEASES_URL);
  }

  async function showUnsupported() {
    const result = await showMessage({
      type: 'info',
      title: 'Обновления STEENY',
      message: 'Автообновление доступно в установленной версии STEENY.',
      detail: 'Для portable-сборки или режима разработки скачайте установщик на странице релизов.',
      buttons: ['Открыть релизы', 'Закрыть'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) await openReleases();
  }

  function install() {
    if (state.status !== 'ready') return false;
    // false keeps the native installer visible. true restarts STEENY after
    // the NSIS/AppImage update has completed.
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  async function promptReady(version) {
    if (readyPromptShown) return;
    readyPromptShown = true;
    showMainWindow?.();
    const result = await showMessage({
      type: 'info',
      title: 'Обновление STEENY готово',
      message: version
        ? `STEENY ${version} уже загружен`
        : 'Новая версия STEENY уже загружена',
      detail: 'Перезапустить приложение и установить обновление сейчас?',
      buttons: ['Перезапустить и обновить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) install();
  }

  async function promptManualUpdate(version) {
    if (manualUpdatePromptShown) return;
    manualUpdatePromptShown = true;
    showMainWindow?.();
    const result = await showMessage({
      type: 'info',
      title: 'Доступно обновление STEENY',
      message: version
        ? `Доступна версия STEENY ${version}`
        : 'Доступна новая версия STEENY',
      detail: 'Пакеты DEB и RPM обновляются механизмами вашей Linux-системы. Скачайте подходящий пакет и установите его через менеджер пакетов.',
      buttons: ['Скачать пакет', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) await openReleases();
  }

  async function handleError(error) {
    const message = String(error?.message || error || 'Неизвестная ошибка');
    const now = Date.now();
    if (message === lastHandledError && now - lastHandledErrorAt < 1500) return;
    lastHandledError = message;
    lastHandledErrorAt = now;
    const failedDuringDownload = ['downloading', 'ready'].includes(state.status);
    publish({
      status: 'error',
      percent: null,
      error: 'Не удалось проверить или загрузить обновление',
    });
    console.warn('STEENY updater:', message);
    if (!manualCheck && !failedDuringDownload) return;
    const result = await showMessage({
      type: 'warning',
      title: 'Не удалось обновить STEENY',
      message: 'Автоматическое обновление сейчас недоступно.',
      detail: 'Можно повторить позже или скачать пакет для вашей системы вручную.',
      buttons: ['Открыть релизы', 'Закрыть'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) await openReleases();
  }

  function bindEvents() {
    autoUpdater.on('checking-for-update', () => {
      publish({ status: 'checking', percent: null, error: null });
    });
    autoUpdater.on('update-available', info => {
      const version = safeVersion(info) || null;
      if (manualOnly) {
        publish({
          status: 'manual-update',
          availableVersion: version,
          percent: null,
          error: null,
        });
        promptManualUpdate(version).catch(handleError);
        return;
      }
      publish({
        status: 'downloading',
        availableVersion: version,
        percent: 0,
        error: null,
      });
    });
    autoUpdater.on('download-progress', progress => {
      const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
      publish({ status: 'downloading', percent, error: null });
    });
    autoUpdater.on('update-not-available', async () => {
      publish({
        status: 'up-to-date',
        availableVersion: null,
        percent: null,
        error: null,
      });
      if (!manualCheck) return;
      await showMessage({
        type: 'info',
        title: 'Обновления STEENY',
        message: 'У вас установлена последняя версия.',
        detail: `Текущая версия: ${app.getVersion()}`,
        buttons: ['Хорошо'],
        defaultId: 0,
        noLink: true,
      });
    });
    autoUpdater.on('update-downloaded', info => {
      const version = safeVersion(info) || state.availableVersion;
      publish({
        status: 'ready',
        availableVersion: version || null,
        percent: 100,
        error: null,
      });
      promptReady(version).catch(handleError);
    });
    autoUpdater.on('error', error => {
      handleError(error).catch(() => undefined);
    });
  }

  async function check({ manual = false } = {}) {
    if (!app.isPackaged || disabled) {
      publish({ status: 'unsupported' });
      if (manual) await showUnsupported();
      return null;
    }
    if (checkPromise) return checkPromise;
    manualCheck = manual;
    checkPromise = autoUpdater.checkForUpdates()
      .catch(async error => {
        await handleError(error);
        return null;
      })
      .finally(() => {
        checkPromise = null;
        manualCheck = false;
      });
    return checkPromise;
  }

  function start() {
    if (started) return;
    started = true;
    bindEvents();
    autoUpdater.autoDownload = !manualOnly;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = /-/.test(app.getVersion());
    // AppImage is verified through update metadata and replaced in-place.
    // DEB/RPM never enter electron-updater's privileged installer path:
    // manualOnly keeps autoDownload disabled and hands them to apt/dnf.
    if (!app.isPackaged || disabled) {
      publish({ status: 'unsupported' });
      return;
    }
    initialTimer = setTimeout(() => check(), INITIAL_CHECK_DELAY_MS);
    intervalTimer = setInterval(() => check(), CHECK_INTERVAL_MS);
  }

  function stop() {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  return {
    start,
    stop,
    check,
    install,
    openReleases,
    getState: () => ({ ...state }),
  };
}

module.exports = {
  CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  RELEASES_URL,
  createUpdateManager,
};
