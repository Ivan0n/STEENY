'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let lastChargingState = null;
let lowMemoryMode = false;
let domReady = false;
const suspendedVideos = new Map();
const RESOURCE_STYLE_ID = 'steeny-electron-resource-style';

function installResourceStyle() {
  if (!document.head || document.getElementById(RESOURCE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = RESOURCE_STYLE_ID;
  style.textContent = `
    html.steeny-low-memory-mode *,
    html.steeny-low-memory-mode *::before,
    html.steeny-low-memory-mode *::after {
      animation-play-state: paused !important;
      transition-duration: 0s !important;
    }
    html.steeny-low-memory-mode .app-bg::before {
      content: none !important;
      background-image: none !important;
    }
    html.steeny-low-memory-mode :is(
      .interface-wallpaper-video,
      .fp-video-bg-layer,
      .fp-bg,
      .fp-bg2
    ) {
      display: none !important;
      background-image: none !important;
      filter: none !important;
      backdrop-filter: none !important;
    }
  `;
  document.head.appendChild(style);
}

function suspendHeavyVideos() {
  for (const id of ['appearanceWallpaperVideo', 'fpVideo']) {
    const video = document.getElementById(id);
    if (!video || suspendedVideos.has(video)) continue;
    const src = video.currentSrc || video.getAttribute('src') || '';
    if (!src) continue;
    suspendedVideos.set(video, {
      src,
      currentTime: Number(video.currentTime) || 0,
      wasPlaying: !video.paused && !video.ended,
    });
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // A renderer navigation can invalidate a media element mid-cleanup.
    }
  }
}

function restoreHeavyVideos() {
  const audio = document.getElementById('audioEl');
  for (const [video, state] of suspendedVideos) {
    if (!video.isConnected || !state.src) continue;
    const resume = () => {
      const targetTime = video.id === 'fpVideo' && audio
        ? Number(audio.currentTime) || state.currentTime
        : state.currentTime;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        try {
          video.currentTime = Math.max(0, targetTime % video.duration);
        } catch {
          // Some streams do not allow seeking until more data is buffered.
        }
      }
      const shouldPlay = state.wasPlaying
        || (video.id === 'fpVideo' && audio && !audio.paused && !audio.ended);
      if (shouldPlay) video.play().catch(() => undefined);
    };
    try {
      video.setAttribute('src', state.src);
      video.addEventListener('loadedmetadata', resume, { once: true });
      video.load();
      if (video.readyState >= 1) resume();
    } catch {
      // The web app can recreate the video while the window is minimized.
    }
  }
  suspendedVideos.clear();
}

function dispatchResourceMode() {
  try {
    window.dispatchEvent(new CustomEvent('steeny-resource-mode', {
      detail: { lowMemory: lowMemoryMode },
    }));
  } catch {
    // The remote page does not need this event for the built-in cleanup.
  }
}

function applyResourceMode(payload) {
  lowMemoryMode = Boolean(payload?.lowMemory);
  if (!domReady || !document.documentElement) return;
  installResourceStyle();
  document.documentElement.classList.toggle(
    'steeny-low-memory-mode',
    lowMemoryMode,
  );
  if (lowMemoryMode) suspendHeavyVideos();
  else restoreHeavyVideos();
  dispatchResourceMode();
}

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
  is_low_memory_mode: () => lowMemoryMode,
  on_resource_mode: callback => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('resource-mode', (_event, state) => callback({ ...state }));
  },
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

ipcRenderer.on('resource-mode', (_event, state) => {
  applyResourceMode(state);
});

window.addEventListener('DOMContentLoaded', () => {
  domReady = true;
  document.documentElement.classList.add('desktop-client', 'electron-client');
  makeTitlebarControlsInteractive();
  if (lastChargingState !== null) deliverPowerState(lastChargingState);
  applyResourceMode({ lowMemory: lowMemoryMode });
});
