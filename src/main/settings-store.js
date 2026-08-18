const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULT_REMOTE_PASSWORD, DEFAULT_SIGNAL_PORT } = require('../../shared/protocol');

const defaults = {
  deviceCode: '',
  displayName: '',
  remotePassword: DEFAULT_REMOTE_PASSWORD,
  username: '',
  signalUrl: `http://127.0.0.1:${DEFAULT_SIGNAL_PORT}`,
  launchAtLogin: true,
  startMinimized: true,
};

function storePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readAll() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
}

function createStore() {
  let cache = readAll();
  return {
    get(key) {
      return cache[key];
    },
    set(key, value) {
      cache[key] = value;
      writeAll(cache);
    },
    store: cache,
  };
}

module.exports = { createStore, defaults };
