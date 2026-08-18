const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deviceMirror', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  requestConnect: (payload) => ipcRenderer.invoke('request-connect', payload),
  openViewer: (target) => ipcRenderer.invoke('open-viewer', target),
  relaySignal: (payload) => ipcRenderer.invoke('relay-signal', payload),
  endSession: (toDeviceCode) => ipcRenderer.invoke('end-session', toDeviceCode),
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  applyInput: (msg) => ipcRenderer.invoke('apply-input', msg),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  virtualFeedStart: (opts) => ipcRenderer.invoke('virtual-feed-start', opts),
  virtualFeedStop: () => ipcRenderer.invoke('virtual-feed-stop'),
  virtualFeedFrame: (payload) => ipcRenderer.invoke('virtual-feed-frame', payload),
  virtualFeedAudio: (payload) => ipcRenderer.invoke('virtual-feed-audio', payload),
  showMain: () => ipcRenderer.invoke('show-main'),
  acceptDecision: (decision) => ipcRenderer.send('accept-decision', decision),

  onStatus: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('status', fn);
    return () => ipcRenderer.removeListener('status', fn);
  },
  onPeers: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('peers', fn);
    return () => ipcRenderer.removeListener('peers', fn);
  },
  onConnectResponse: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('connect-response', fn);
    return () => ipcRenderer.removeListener('connect-response', fn);
  },
  onIncomingSession: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('incoming-session', fn);
    return () => ipcRenderer.removeListener('incoming-session', fn);
  },
  onSignal: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('webrtc-signal', fn);
    return () => ipcRenderer.removeListener('webrtc-signal', fn);
  },
  onSessionEnded: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('session-ended', fn);
    return () => ipcRenderer.removeListener('session-ended', fn);
  },
  onAcceptPayload: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('accept-payload', fn);
    return () => ipcRenderer.removeListener('accept-payload', fn);
  },
  onViewerTarget: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('viewer-target', fn);
    return () => ipcRenderer.removeListener('viewer-target', fn);
  },
  onVirtualFeedData: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('virtual-feed-data', fn);
    return () => ipcRenderer.removeListener('virtual-feed-data', fn);
  },
});
