'use strict';

function createWindowShortcutHandler(browserWindow, { devtools = false } = {}) {
  return (event, input = {}) => {
    if (input.key === 'F11') {
      event.preventDefault();
      if (input.type === 'keyDown' && !input.isAutoRepeat) {
        browserWindow.setFullScreen(!browserWindow.isFullScreen());
      }
      return;
    }

    const zoomShortcut = input.control
      && ['+', '-', '=', '0'].includes(input.key);
    if (zoomShortcut || (!devtools && input.key === 'F12')) {
      event.preventDefault();
    }
  };
}

module.exports = { createWindowShortcutHandler };
