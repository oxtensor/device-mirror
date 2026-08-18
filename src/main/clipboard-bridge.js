async function createClipboardBridge() {
  // Prefer Electron clipboard in main; fallback to clipboardy dynamic import
  const { clipboard } = require('electron');
  return {
    async read() {
      try {
        return clipboard.readText();
      } catch {
        return '';
      }
    },
    async write(text) {
      try {
        clipboard.writeText(String(text ?? ''));
      } catch (_) {}
    },
  };
}

// Factory that returns sync-ready object
function createClipboardBridgeSync() {
  const { clipboard } = require('electron');
  return {
    async read() {
      return clipboard.readText();
    },
    async write(text) {
      clipboard.writeText(String(text ?? ''));
    },
  };
}

module.exports = { createClipboardBridge: createClipboardBridgeSync };
