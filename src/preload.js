'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let lastChargingState = null;

function deliverPowerState(charging) {
  lastChargingState = !!charging;
  try {
    window.__steenySetCharging?.(lastChargingState);
  } catch {
    // The page may not have installed its hook yet.
  }
}

function makeTitlebarControlsInteractive() {
  // The web UI owns the frameless titlebar. Keep its home/logo control out of
  // Electron's drag region even while an older cached page stylesheet is used.
  document.querySelector('.titlebar .logo')
    ?.style.setProperty('-webkit-app-region', 'no-drag', 'important');
}

const bridge = Object.freeze({
  close_app: () => ipcRenderer.send('window:close'),
  minimize_app: () => ipcRenderer.send('window:minimize'),
  start_window_drag: () => undefined,
  move_window: (x, y) => ipcRenderer.send('window:move', { x, y }),
  get_pos: callback => {
    ipcRenderer.invoke('window:get-position').then(position => {
      callback?.(JSON.stringify(position));
    }).catch(() => callback?.('{"x":0,"y":0}'));
  },
  set_zoom_factor: factor => ipcRenderer.send('window:set-zoom', factor),
  open_external_url: url => ipcRenderer.send('external:open', url),
  update_rpc: dataJson => ipcRenderer.send('rpc:update', dataJson),
  clear_rpc: () => ipcRenderer.send('rpc:clear'),
  retry_backend: () => ipcRenderer.invoke('backend:retry'),
  get_update_state: () => ipcRenderer.invoke('update:get-state'),
  check_for_updates: () => ipcRenderer.invoke('update:check'),
  install_update: () => ipcRenderer.send('update:install'),
  open_update_page: () => ipcRenderer.send('update:open-releases'),
  on_update_state: callback => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('update:state', (_event, state) => callback(state));
  },
  is_electron: true,
});

contextBridge.exposeInMainWorld('steenyElectron', bridge);

ipcRenderer.on('power-state', (_event, charging) => {
  deliverPowerState(charging);
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-client', 'electron-client');
  makeTitlebarControlsInteractive();
  if (lastChargingState !== null) deliverPowerState(lastChargingState);
});
