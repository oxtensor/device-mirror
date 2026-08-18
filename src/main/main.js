const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, screen, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const { startServer } = require('../server');
const { createInputController } = require('./input-controller');
const { createClipboardBridge } = require('./clipboard-bridge');
const { createVirtualFeed } = require('./virtual-feed');
const { createStore } = require('./settings-store');
const { ensureVirtualDevices } = require('./virtual-devices');
const {
  DEFAULT_REMOTE_PASSWORD,
  DEFAULT_SIGNAL_PORT,
  DEFAULT_ADMIN_PORT,
  Events,
  ConnectDecision,
} = require('../../shared/protocol');

let store = null;

let mainWindow = null;
let acceptWindow = null;
let viewerWindow = null;
let tray = null;
let socket = null;
let embeddedServer = null;
let isQuitting = false;
const pendingRequests = new Map();
const inputController = createInputController();
const clipboardBridge = createClipboardBridge();
const virtualFeed = createVirtualFeed();

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'tray.png');

function ensureIcon() {
  if (fs.existsSync(ICON_PATH)) return ICON_PATH;
  // 16x16 blue PNG fallback written as base64
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVQ4T2NkYGD4z0ABYBzVMKoBBgZGRkZGBgoAQw0wMjIyMjAwMDAyMjL+Z2Bg+A8C/xlGNTBqAAMDAAD5FwQJqk6uYQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.mkdirSync(path.dirname(ICON_PATH), { recursive: true });
  fs.writeFileSync(ICON_PATH, png);
  return ICON_PATH;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    show: !store.get('startMinimized'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Device Mirror',
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ensureIcon());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Device Mirror');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Device Mirror',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Admin dashboard',
      click: () => {
        require('electron').shell.openExternal(`http://127.0.0.1:${DEFAULT_ADMIN_PORT}`);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function applyLaunchAtLogin() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!store.get('launchAtLogin'),
      openAsHidden: true,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(path.join(__dirname, '..', '..'))],
    });
  } catch (err) {
    console.warn('launch-at-login failed', err.message);
  }
}

function connectSignal() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  const url = store.get('signalUrl');
  socket = io(url, { transports: ['websocket'], reconnection: true });

  socket.on('connect', () => {
    socket.emit(Events.REGISTER, {
      deviceCode: store.get('deviceCode') || undefined,
      displayName: store.get('displayName') || require('os').hostname(),
      username: store.get('username') || null,
      hasPassword: !!store.get('remotePassword'),
    });
    broadcastStatus({ signalConnected: true });
  });

  socket.on('disconnect', () => broadcastStatus({ signalConnected: false }));

  socket.on(Events.REGISTERED, (payload) => {
    store.set('deviceCode', payload.deviceCode);
    if (!store.get('displayName')) store.set('displayName', payload.displayName);
    broadcastStatus({
      deviceCode: payload.deviceCode,
      displayName: store.get('displayName'),
      signalConnected: true,
    });
  });

  socket.on(Events.PEER_LIST, (payload) => {
    mainWindow?.webContents.send('peers', payload.peers || []);
  });

  socket.on(Events.CONNECT_REQUEST, async (payload) => {
    const privilege = payload.privilege;
    const passwordOk =
      (privilege && privilege.noPassword) ||
      payload.password === store.get('remotePassword');

    if (!passwordOk) {
      socket.emit(Events.CONNECT_RESPONSE, {
        requestId: payload.requestId,
        toDeviceCode: payload.fromDeviceCode,
        decision: ConnectDecision.DENY,
        reason: 'Invalid remote-control password',
      });
      return;
    }

    if (privilege && privilege.autoAccept) {
      socket.emit(Events.CONNECT_RESPONSE, {
        requestId: payload.requestId,
        toDeviceCode: payload.fromDeviceCode,
        decision: ConnectDecision.ACCEPT,
      });
      pendingRequests.set(payload.requestId, payload);
      mainWindow?.webContents.send('incoming-session', payload);
      return;
    }

    const decision = await showAcceptDialog(payload);
    socket.emit(Events.CONNECT_RESPONSE, {
      requestId: payload.requestId,
      toDeviceCode: payload.fromDeviceCode,
      decision,
      reason: decision === ConnectDecision.DENY ? 'Denied by user' : undefined,
    });
    if (decision === ConnectDecision.ACCEPT) {
      pendingRequests.set(payload.requestId, payload);
      mainWindow?.webContents.send('incoming-session', payload);
    }
  });

  socket.on(Events.CONNECT_RESPONSE, (payload) => {
    mainWindow?.webContents.send('connect-response', payload);
  });

  socket.on(Events.SIGNAL, (payload) => {
    mainWindow?.webContents.send('webrtc-signal', payload);
    viewerWindow?.webContents.send('webrtc-signal', payload);
  });

  socket.on(Events.SESSION_ENDED, (payload) => {
    mainWindow?.webContents.send('session-ended', payload);
    viewerWindow?.webContents.send('session-ended', payload);
    virtualFeed.stop();
  });
}

function broadcastStatus(extra = {}) {
  const status = {
    deviceCode: store.get('deviceCode'),
    displayName: store.get('displayName'),
    remotePassword: store.get('remotePassword'),
    username: store.get('username'),
    signalUrl: store.get('signalUrl'),
    launchAtLogin: store.get('launchAtLogin'),
    adminUrl: `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`,
    ...extra,
  };
  mainWindow?.webContents.send('status', status);
}

function showAcceptDialog(payload) {
  return new Promise((resolve) => {
    if (acceptWindow) {
      acceptWindow.close();
    }
    acceptWindow = new BrowserWindow({
      width: 420,
      height: 260,
      resizable: false,
      alwaysOnTop: true,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
      },
      title: 'Incoming remote control',
    });
    acceptWindow.loadFile(path.join(__dirname, '../renderer/accept.html'));
    acceptWindow.once('ready-to-show', () => {
      acceptWindow.show();
      acceptWindow.webContents.send('accept-payload', payload);
    });

    const onDecision = (_e, decision) => {
      cleanup();
      resolve(decision);
    };
    const cleanup = () => {
      ipcMain.removeListener('accept-decision', onDecision);
      if (acceptWindow && !acceptWindow.isDestroyed()) acceptWindow.close();
      acceptWindow = null;
    };
    ipcMain.once('accept-decision', onDecision);
    acceptWindow.on('closed', () => {
      ipcMain.removeListener('accept-decision', onDecision);
      resolve(ConnectDecision.DENY);
      acceptWindow = null;
    });
  });
}

function openViewer(target) {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.focus();
    viewerWindow.webContents.send('viewer-target', target);
    return;
  }
  viewerWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
    title: `Remote — ${target.displayName || target.deviceCode}`,
  });
  viewerWindow.loadFile(path.join(__dirname, '../renderer/viewer.html'));
  viewerWindow.webContents.once('did-finish-load', () => {
    viewerWindow.webContents.send('viewer-target', target);
  });
  viewerWindow.on('closed', () => {
    viewerWindow = null;
    if (socket && target?.deviceCode) {
      socket.emit(Events.SESSION_ENDED, { toDeviceCode: target.deviceCode });
    }
  });
}

function registerIpc() {
  ipcMain.handle('get-status', () => ({
    deviceCode: store.get('deviceCode'),
    displayName: store.get('displayName'),
    remotePassword: store.get('remotePassword'),
    username: store.get('username'),
    signalUrl: store.get('signalUrl'),
    launchAtLogin: store.get('launchAtLogin'),
    adminUrl: `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`,
    signalConnected: !!(socket && socket.connected),
  }));

  ipcMain.handle('save-settings', (_e, settings) => {
    const allowed = ['displayName', 'remotePassword', 'username', 'signalUrl', 'launchAtLogin'];
    for (const key of allowed) {
      if (settings[key] !== undefined) store.set(key, settings[key]);
    }
    applyLaunchAtLogin();
    connectSignal();
    broadcastStatus();
    return true;
  });

  ipcMain.handle('request-connect', async (_e, { target, password }) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const username = store.get('username') || null;

    let privilege = null;
    if (username && socket) {
      privilege = await new Promise((resolve) => {
        socket.emit(
          Events.PRIVILEGE_CHECK,
          { username, targetDeviceCode: target.deviceCode || target },
          (result) => resolve(result)
        );
        setTimeout(() => resolve(null), 2000);
      });
    }

    const effectivePassword =
      privilege && privilege.noPassword ? '' : password || store.get('remotePassword');

    socket.emit(Events.CONNECT_REQUEST, {
      requestId,
      fromDeviceCode: store.get('deviceCode'),
      toDeviceCode: target.deviceCode || (String(target).match(/^\d{6,}$/) ? String(target) : undefined),
      toIp: target.ip || (!String(target).match(/^\d{6,}$/) ? String(target) : undefined),
      password: effectivePassword,
      username,
      offerCapabilities: {
        screen: true,
        audio: true,
        clipboard: true,
        feedMicCamera: true,
      },
    });
    return { requestId, privilege };
  });

  ipcMain.handle('open-viewer', (_e, target) => {
    openViewer(target);
    return true;
  });

  ipcMain.handle('relay-signal', (_e, { toDeviceCode, data }) => {
    socket?.emit(Events.SIGNAL, { toDeviceCode, data });
    return true;
  });

  ipcMain.handle('end-session', (_e, toDeviceCode) => {
    socket?.emit(Events.SESSION_ENDED, { toDeviceCode });
    virtualFeed.stop();
    return true;
  });

  ipcMain.handle('list-displays', async () => {
    const displays = screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      index: i,
      label: `Monitor ${i + 1} (${d.size.width}x${d.size.height})`,
      bounds: d.bounds,
      size: d.size,
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return { displays, sources: sources.map((s) => ({ id: s.id, name: s.name })) };
  });

  ipcMain.handle('get-desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('apply-input', (_e, msg) => {
    inputController.handle(msg);
    return true;
  });

  ipcMain.handle('clipboard-write', async (_e, text) => {
    await clipboardBridge.write(text);
    return true;
  });

  ipcMain.handle('clipboard-read', async () => clipboardBridge.read());

  ipcMain.handle('virtual-feed-start', async (_e, opts) => {
    return virtualFeed.start(opts);
  });

  ipcMain.handle('virtual-feed-stop', async () => {
    virtualFeed.stop();
    return true;
  });

  ipcMain.handle('virtual-feed-frame', (_e, payload) => {
    virtualFeed.pushFrame(payload);
    return true;
  });

  ipcMain.handle('virtual-feed-audio', (_e, payload) => {
    virtualFeed.pushAudio(payload);
    return true;
  });

  ipcMain.handle('show-main', () => {
    mainWindow?.show();
    return true;
  });

  // Allow renderer getUserMedia for desktop capture
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const preferred = sources[0];
    callback({ video: preferred, audio: 'loopback' });
  });
}

const gotLock = process.env.DEVICE_MIRROR_ALLOW_MULTI === '1' || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    store = createStore();

    try {
      embeddedServer = startServer({
        signalPort: DEFAULT_SIGNAL_PORT,
        adminPort: DEFAULT_ADMIN_PORT,
      });
    } catch (err) {
      console.warn('Embedded server failed (maybe already running):', err.message);
    }

    // If ports are already taken, server listen errors are async — ignore EADDRINUSE via process
    process.on('uncaughtException', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.warn('Port in use — using existing signaling/admin server');
        return;
      }
      console.error(err);
    });

    registerIpc();
    createMainWindow();
    createTray();
    applyLaunchAtLogin();
    connectSignal();
    ensureVirtualDevices()
      .then((info) => console.log('[virtual-devices]', info))
      .catch((err) => console.warn('[virtual-devices]', err));

    // Write PID for watchdog
    try {
      const pidPath = path.join(app.getPath('userData'), 'device-mirror.pid');
      fs.writeFileSync(pidPath, String(process.pid));
    } catch (_) {}
  });

  app.on('before-quit', () => {
    isQuitting = true;
    virtualFeed.stop();
    virtualFeed.stopPump?.();
    socket?.disconnect();
  });

  app.on('window-all-closed', (e) => {
    // Keep running in tray on Windows
    e.preventDefault?.();
  });
}
