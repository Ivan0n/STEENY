'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  safeStorage,
  session,
  shell,
  Tray,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const {
  createLinkClient,
  createTokenStore,
  runLinkFlow,
} = require('./auth');
const { DiscordPresence } = require('./rpc');
const { createUpdateManager } = require('./updater');
const { createWindowResourceManager } = require('./window-resource-manager');

// The root route renders login for a new session and redirects an authenticated
// user to `/home`. Starting there avoids an anonymous `/home` → `/` redirect.
const DEFAULT_APP_URL = 'https://music.steeny.fun/';
function resolveAppUrl(rawUrl) {
  try {
    const value = new URL(String(rawUrl || DEFAULT_APP_URL).trim());
    if (!['http:', 'https:'].includes(value.protocol)) {
      throw new Error('unsupported protocol');
    }
    return value.href;
  } catch {
    console.warn(`Invalid STEENY_URL; using ${DEFAULT_APP_URL}`);
    return DEFAULT_APP_URL;
  }
}

const APP_URL = resolveAppUrl(process.env.STEENY_URL);
const APP_ORIGIN = new URL(APP_URL).origin;
// `/home` redirects an anonymous user to the login page. Checking the origin
// avoids treating that normal redirect as an unavailable production server.
const BACKEND_CHECK_URL = new URL('/', APP_ORIGIN).href;
const DEVTOOLS = process.env.STEENY_DEVTOOLS === '1'
  || process.argv.includes('--devtools');
const SMOKE_TEST = process.argv.includes('--smoke-test');
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
const offlinePath = path.join(__dirname, '..', 'assets', 'offline.html');
const offlineUrl = pathToFileURL(offlinePath).href;
const linkPath = path.join(__dirname, '..', 'assets', 'link.html');
const linkUrl = pathToFileURL(linkPath).href;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(50 * 1024 * 1024));
app.commandLine.appendSwitch('renderer-process-limit', '2');
app.commandLine.appendSwitch('js-flags', '--optimize-for-size');
app.commandLine.appendSwitch(
  'disable-features',
  'SpareRendererForSitePerProcess,BackForwardCache,AudioServiceOutOfProcess',
);

let mainWindow = null;
let tray = null;
let quitting = false;
let offlineLoaded = false;
let updates = null;
let appSession = null;
let tokenStore = null;
let linkClient = null;
let authState = { status: 'idle' };
let linkAbort = null;
// One self-heal attempt per navigation, so a server that keeps bouncing us to
// the login page cannot turn into a reload loop.
let recovering = false;
let lastRecoveryAt = 0;
const rpc = new DiscordPresence();
const resources = createWindowResourceManager();

function validBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const keys = ['x', 'y', 'width', 'height'];
  if (!keys.every(key => Number.isFinite(value[key]))) return null;
  if (value.width < 620 || value.height < 460) return null;
  return value;
}

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    return validBounds(JSON.parse(fs.readFileSync(statePath(), 'utf8')));
  } catch {
    return null;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(
      statePath(),
      JSON.stringify(mainWindow.getBounds()),
      { mode: 0o600 },
    );
  } catch {
    // Window state is optional.
  }
}

function appIcon() {
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

function isAllowedMainFrame(rawUrl) {
  try {
    const value = new URL(rawUrl);
    if (value.origin === APP_ORIGIN) return true;
    return value.href === offlineUrl || value.href === linkUrl;
  } catch {
    return false;
  }
}

function safeExternalUrl(rawUrl) {
  try {
    const text = String(rawUrl).trim();
    if (!text || text.length > 4096) return null;
    const value = new URL(text);
    return ['http:', 'https:'].includes(value.protocol) && value.hostname
      ? value.href
      : null;
  } catch {
    return null;
  }
}

function isTrustedOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function openExternal(rawUrl) {
  const url = safeExternalUrl(rawUrl);
  if (url) shell.openExternal(url).catch(() => undefined);
}

async function backendAvailable() {
  try {
    const response = await net.fetch(BACKEND_CHECK_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (await backendAvailable()) {
    offlineLoaded = false;
    await mainWindow.loadURL(APP_URL);
    return true;
  }
  offlineLoaded = true;
  await mainWindow.loadFile(offlinePath);
  return false;
}

// ── Sign-in state ───────────────────────────────────────────────────────────

function setAuthState(state) {
  authState = { ...state };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:state', authState);
  }
}

async function showLinkScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  offlineLoaded = false;
  await mainWindow.loadFile(linkPath);
  return false;
}

async function showOffline() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  offlineLoaded = true;
  await mainWindow.loadFile(offlinePath);
  return false;
}

/**
 * Decide what the window should show: the app, the sign-in screen, or the
 * offline notice. A stored token is thrown away only when the server actually
 * rejects it -- a dead network must never cost the user their session.
 */
async function enterApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const token = tokenStore?.read();
  if (!token) {
    setAuthState({ status: 'idle' });
    return showLinkScreen();
  }
  let handoff;
  try {
    handoff = await linkClient.establishSession(token);
  } catch {
    return showOffline();
  }
  if (handoff.ok) return loadApp();
  if (handoff.unauthorized) {
    tokenStore.clear();
    setAuthState({ status: 'idle' });
    return showLinkScreen();
  }
  return showOffline();
}

async function beginLink() {
  if (linkAbort) return authState;
  linkAbort = new AbortController();
  try {
    const result = await runLinkFlow({
      client: linkClient,
      openBrowser: openExternal,
      onState: setAuthState,
      signal: linkAbort.signal,
    });
    if (result.status === 'authorized') {
      tokenStore.write(result.token);
      linkAbort = null;
      await enterApp();
      return authState;
    }
    if (result.status === 'cancelled') setAuthState({ status: 'idle' });
    else setAuthState({ status: 'error', reason: result.status });
  } catch (error) {
    setAuthState({
      status: 'error',
      reason: error?.offline ? 'offline' : 'failed',
      message: error?.message,
    });
  } finally {
    linkAbort = null;
  }
  return authState;
}

async function signOut() {
  linkAbort?.abort();
  linkAbort = null;
  tokenStore?.clear();
  try {
    // Drop the cookie too, otherwise the next launch would silently walk back
    // into the account the user just left.
    await appSession?.clearStorageData({ storages: ['cookies'] });
  } catch {
    // A locked profile still signs out: the token file is already gone.
  }
  setAuthState({ status: 'idle' });
  return showLinkScreen();
}

/**
 * The web app renders its login form only at the root path, so landing there
 * means the cookie session is gone -- either the user logged out or the token
 * was revoked from another device. Re-establish it when the token is still
 * good, and fall back to the sign-in screen when it is not.
 */
async function handlePossibleSignOut(rawUrl) {
  if (recovering || !tokenStore) return;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.origin !== APP_ORIGIN || parsed.pathname !== '/') return;
  const token = tokenStore.read();
  if (!token) {
    await showLinkScreen();
    return;
  }
  if (Date.now() - lastRecoveryAt < 15000) {
    // We just handed the cookie over and still ended up here. Stop bouncing.
    tokenStore.clear();
    setAuthState({ status: 'idle' });
    await showLinkScreen();
    return;
  }
  recovering = true;
  lastRecoveryAt = Date.now();
  try {
    const check = await linkClient.checkToken(token);
    if (check.valid) {
      const handoff = await linkClient.establishSession(token);
      if (handoff.ok) {
        await loadApp();
        return;
      }
    }
    tokenStore.clear();
    setAuthState({ status: 'idle' });
    await showLinkScreen();
  } catch {
    // Offline: the page on screen is as good an answer as we have.
  } finally {
    recovering = false;
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  mainWindow?.hide();
}

function setupTray() {
  const icon = appIcon();
  if (!icon) return;
  try {
    tray = new Tray(icon.resize({ width: 24, height: 24 }));
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('STEENY — музыкальный плеер');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть STEENY', click: showWindow },
    { label: 'Скрыть в трей', click: hideWindow },
    { type: 'separator' },
    {
      label: 'Проверить обновления',
      click: () => updates?.check({ manual: true }),
    },
    { type: 'separator' },
    {
      label: 'Выйти из STEENY',
      click: () => {
        quitting = true;
        rpc.destroy();
        app.quit();
      },
    },
  ]));
  tray.on('click', () => {
    if (mainWindow?.isVisible()) hideWindow();
    else showWindow();
  });
  tray.on('double-click', showWindow);
}

function configureSession() {
  const appSession = session.fromPartition('persist:steeny');
  // Logging out inside the web app has to drop the desktop token as well,
  // otherwise the next launch would sign straight back in and "выйти" would
  // look broken.
  appSession.webRequest.onCompleted(
    { urls: [`${APP_ORIGIN}/logout`, `${APP_ORIGIN}/logout?*`] },
    details => {
      if (details.method !== 'POST') return;
      signOut().catch(() => undefined);
    },
  );
  appSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      const mediaType = details?.mediaType;
      const origin = details?.securityOrigin || requestingOrigin;
      return permission === 'media'
        && isTrustedOrigin(origin)
        && (mediaType === undefined || mediaType === 'audio');
    },
  );
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = isTrustedOrigin(
      details?.requestingUrl || webContents?.getURL(),
    );
    const requestedMedia = Array.isArray(details?.mediaTypes)
      ? details.mediaTypes
      : [];
    const audioOnly = permission === 'media'
      && requestedMedia.length > 0
      && requestedMedia.every(mediaType => mediaType === 'audio');
    callback(trusted && audioOnly);
  });
  if (typeof appSession.setDisplayMediaRequestHandler === 'function') {
    appSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  }
  return appSession;
}

function sendPowerState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('power-state', !powerMonitor.isOnBatteryPower());
}

function createWindow() {
  const bounds = loadWindowState();
  mainWindow = new BrowserWindow({
    width: bounds?.width || 1354,
    height: bounds?.height || 868,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 620,
    minHeight: 460,
    frame: false,
    transparent: false,
    resizable: true,
    show: false,
    title: 'STEENY',
    backgroundColor: '#15110e',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: true,
      spellcheck: false,
      session: appSession,
    },
  });

  // Keep Electron's own UA tokens intact. Cloudflare Turnstile cross-checks the
  // UA string against `navigator.userAgentData`, which always reports Chromium
  // here; hiding the `Electron/<version>` token makes the two disagree and the
  // widget hard-fails with "Сбой проверки" instead of showing its checkbox.
  const defaultUa = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(
    `${defaultUa} SteenyClient/${app.getVersion()}`,
  );
  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, legacyUrl) => {
    if (event.isMainFrame === false) return;
    const url = event.url || legacyUrl;
    if (isAllowedMainFrame(url)) return;
    event.preventDefault();
    openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    handlePossibleSignOut(url).catch(() => undefined);
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('did-finish-load', async () => {
    sendPowerState();
    resources.sync();
    if (SMOKE_TEST) {
      let smokeState = null;
      try {
        smokeState = await mainWindow.webContents.executeJavaScript(
          '({'
          + ' bridge: window.steenyElectron?.is_electron === true'
          + ' && document.documentElement.classList.contains("desktop-client"),'
          + ' legacyChannel: Boolean(document.querySelector("script[src^=\\"qrc:\\"]"))'
          + ' })',
        );
      } catch {
        smokeState = null;
      }
      if (!smokeState?.bridge || smokeState.legacyChannel) {
        console.error('STEENY_SMOKE_FAILED preload or bridge selection error');
        app.exit(1);
        return;
      }
      console.log(
        `STEENY_SMOKE_OK bridge=true legacy-channel=false`
        + ` url=${mainWindow.webContents.getURL()}`,
      );
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, 500);
    }
  });
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, _description, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || offlineLoaded) return;
      offlineLoaded = true;
      mainWindow.loadFile(offlinePath);
    },
  );
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const zoomShortcut = input.control
      && ['+', '-', '=', '0'].includes(input.key);
    if (zoomShortcut || (!DEVTOOLS && input.key === 'F12')) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE_TEST) {
      mainWindow.show();
      resources.bind(mainWindow);
    }
    if (DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('close', event => {
    if (quitting) return;
    if (!tray) {
      quitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    hideWindow();
  });
  mainWindow.on('moved', saveWindowState);
  mainWindow.on('resized', saveWindowState);
  mainWindow.on('closed', () => {
    resources.unbind();
    mainWindow = null;
  });

  enterApp();
}

function installIpcHandlers() {
  const fromMainWindow = event => (
    mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
  );

  ipcMain.on('window:close', event => {
    if (!fromMainWindow(event)) return;
    mainWindow.close();
  });
  ipcMain.on('window:minimize', event => {
    if (fromMainWindow(event)) mainWindow.minimize();
  });
  ipcMain.on('window:move', (event, position) => {
    if (!fromMainWindow(event)) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    try {
      mainWindow.setPosition(Math.round(x), Math.round(y));
    } catch {
      // Wayland owns window positioning; CSS app-region still provides drag.
    }
  });
  ipcMain.handle('window:get-position', event => {
    if (!fromMainWindow(event)) return { x: 0, y: 0 };
    const [x, y] = mainWindow?.getPosition() || [0, 0];
    return { x, y };
  });
  ipcMain.on('window:set-zoom', (event, rawFactor) => {
    if (!fromMainWindow(event)) return;
    const factor = Math.max(0.5, Math.min(2, Number(rawFactor) || 1));
    mainWindow?.webContents.setZoomFactor(factor);
  });
  ipcMain.on('external:open', (event, rawUrl) => {
    if (fromMainWindow(event)) openExternal(rawUrl);
  });
  ipcMain.on('rpc:update', (event, dataJson) => {
    if (fromMainWindow(event)) rpc.update(dataJson);
  });
  ipcMain.on('rpc:clear', event => {
    if (fromMainWindow(event)) rpc.clear();
  });
  ipcMain.handle('backend:retry', event => {
    if (!fromMainWindow(event)) return false;
    return enterApp();
  });
  ipcMain.handle('auth:get-state', event => {
    if (!fromMainWindow(event)) return null;
    return authState;
  });
  ipcMain.handle('auth:begin', event => {
    if (!fromMainWindow(event)) return null;
    return beginLink();
  });
  ipcMain.on('auth:cancel', event => {
    if (!fromMainWindow(event)) return;
    linkAbort?.abort();
  });
  ipcMain.on('auth:open-link', event => {
    if (!fromMainWindow(event)) return;
    if (authState.status === 'waiting' && authState.verificationUrl) {
      openExternal(authState.verificationUrl);
    }
  });
  ipcMain.handle('auth:sign-out', event => {
    if (!fromMainWindow(event)) return false;
    return signOut().then(() => true);
  });
  ipcMain.handle('update:get-state', event => {
    if (!fromMainWindow(event)) return null;
    return updates?.getState() || null;
  });
  ipcMain.handle('update:check', async event => {
    if (!fromMainWindow(event) || !updates) return null;
    await updates.check({ manual: true });
    return updates.getState();
  });
  ipcMain.on('update:install', event => {
    if (fromMainWindow(event)) updates?.install();
  });
  ipcMain.on('update:open-releases', event => {
    if (fromMainWindow(event)) updates?.openReleases();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    app.setName('STEENY');
    if (process.platform === 'win32') {
      app.setAppUserModelId('fun.steeny.desktop');
    }
    appSession = configureSession();
    tokenStore = createTokenStore({ app, safeStorage });
    linkClient = createLinkClient({
      origin: APP_ORIGIN,
      // The session's own fetch keeps the handoff cookie in the same partition
      // the window uses; net.fetch would drop it into the default session.
      fetchImpl: (input, init) => appSession.fetch(input, init),
      clientInfo: {
        name: 'STEENY',
        version: app.getVersion(),
        platform: process.platform,
      },
    });
    updates = createUpdateManager({
      app,
      autoUpdater,
      dialog,
      shell,
      getMainWindow: () => mainWindow,
      showMainWindow: showWindow,
      disabled: SMOKE_TEST,
      manualOnly: process.platform === 'linux' && !process.env.APPIMAGE,
    });
    installIpcHandlers();
    createWindow();
    setupTray();
    updates.start();
    powerMonitor.on('on-ac', sendPowerState);
    powerMonitor.on('on-battery', sendPowerState);
    powerMonitor.on('resume', () => updates?.check());
  });

  app.on('activate', () => {
    if (mainWindow) showWindow();
    else createWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    resources.unbind();
    updates?.stop();
    saveWindowState();
    rpc.destroy();
  });
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
    // The tray keeps background playback alive on Windows/Linux.
  });
}
