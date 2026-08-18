/**
 * Embedded virtual mic/camera feed (no OBS / VB-Cable).
 * Pushes controller A/V into Device Mirror Camera + Virtual Mic via dm-vdevices.
 */
const { BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');
const { ensureVirtualDevices, stopPump } = require('./virtual-devices');

function createVirtualFeed() {
  let previewWin = null;
  let running = false;
  let socket = null;
  let connectPromise = null;
  let deviceInfo = null;

  function connectPump() {
    if (socket && !socket.destroyed) return Promise.resolve(socket);
    if (connectPromise) return connectPromise;
    connectPromise = new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: 3925 }, () => {
        socket = s;
        connectPromise = null;
        resolve(s);
      });
      s.on('error', (err) => {
        connectPromise = null;
        socket = null;
        reject(err);
      });
      s.on('close', () => {
        socket = null;
      });
    });
    return connectPromise;
  }

  function sendMessage(cmdObj, payload) {
    return connectPump().then((s) => {
      const header = Buffer.from(JSON.stringify(cmdObj), 'utf8');
      const headerLen = Buffer.alloc(4);
      headerLen.writeUInt32LE(header.length, 0);
      s.write(headerLen);
      s.write(header);
      if (payload) {
        const payloadLen = Buffer.alloc(4);
        payloadLen.writeUInt32LE(payload.length, 0);
        s.write(payloadLen);
        s.write(payload);
      }
    });
  }

  async function start(opts = {}) {
    if (running) stop();
    running = true;

    deviceInfo = await ensureVirtualDevices();

    previewWin = new BrowserWindow({
      width: 480,
      height: 400,
      title: 'Device Mirror — virtual mic/camera',
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
      },
    });
    previewWin.loadFile(path.join(__dirname, '../renderer/virtual-feed.html'));
    previewWin.on('closed', () => {
      previewWin = null;
    });

    // Give pump a moment to bind
    await new Promise((r) => setTimeout(r, 400));
    try {
      await sendMessage({ cmd: 'ping' });
    } catch (err) {
      console.warn('pump not ready', err.message);
    }

    return {
      ok: !!deviceInfo?.ok,
      preview: true,
      embedded: true,
      ...deviceInfo,
      width: opts.width || 640,
      height: opts.height || 480,
    };
  }

  function pushFrame(payload = {}) {
    if (!running) return;
    if (previewWin && !previewWin.isDestroyed()) {
      previewWin.webContents.send('virtual-feed-data', payload);
    }
    if (payload.rgbaBase64) {
      const rgba = Buffer.from(payload.rgbaBase64, 'base64');
      sendMessage(
        {
          cmd: 'frame',
          width: payload.width || 640,
          height: payload.height || 480,
          format: 'rgba',
        },
        rgba
      ).catch(() => {});
    }
  }

  function pushAudio(payload = {}) {
    if (!running) return;
    if (payload.pcmBase64) {
      const pcm = Buffer.from(payload.pcmBase64, 'base64');
      sendMessage(
        {
          cmd: 'audio',
          sample_rate: payload.sampleRate || 48000,
          channels: payload.channels || 1,
        },
        pcm
      ).catch(() => {});
    }
  }

  function stop() {
    running = false;
    if (previewWin && !previewWin.isDestroyed()) previewWin.close();
    previewWin = null;
    if (socket && !socket.destroyed) {
      try {
        socket.destroy();
      } catch (_) {}
    }
    socket = null;
    // Keep pump/registrar alive for next session; only stop on app quit via stopPump()
  }

  return { start, stop, pushFrame, pushAudio, stopPump };
}

module.exports = { createVirtualFeed };
