'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  session,
  shell,
  Tray,
} = require('electron');
const { DiscordPresence } = require('./rpc');

const DEFAULT_APP_URL = 'http://127.0.0.1:5000';
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
const DEVTOOLS = process.env.STEENY_DEVTOOLS === '1'
  || process.argv.includes('--devtools');
const SMOKE_TEST = process.argv.includes('--smoke-test');
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
const offlinePath = path.join(__dirname, '..', 'assets', 'offline.html');
const offlineUrl = pathToFileURL(offlinePath).href;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(50 * 1024 * 1024));
app.commandLine.appendSwitch(
  'disable-features',
  'SpareRendererForSitePerProcess,BackForwardCache,AudioServiceOutOfProcess',
);

let mainWindow = null;
let tray = null;
let quitting = false;
let offlineLoaded = false;
const rpc = new DiscordPresence();

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
    return value.href === offlineUrl;
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
    const response = await net.fetch(APP_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    });
    return response.status >= 200 && response.status < 500;
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
  const appSession = configureSession();
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
      backgroundThrottling: false,
      spellcheck: false,
      session: appSession,
    },
  });

  const defaultUa = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(`${defaultUa} SteenyClient/2.0`);
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
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('did-finish-load', async () => {
    sendPowerState();
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
    if (!SMOKE_TEST) mainWindow.show();
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
    mainWindow = null;
  });

  loadApp();
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
    return loadApp();
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
    installIpcHandlers();
    createWindow();
    setupTray();
    powerMonitor.on('on-ac', sendPowerState);
    powerMonitor.on('on-battery', sendPowerState);
  });

  app.on('activate', () => {
    if (mainWindow) showWindow();
    else createWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    saveWindowState();
    rpc.destroy();
  });
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
    // The tray keeps background playback alive on Windows/Linux.
  });
}
