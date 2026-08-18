(() => {
  const api = window.deviceMirror;
  const video = document.getElementById('remote-video');
  const audio = document.getElementById('remote-audio');
  const stateEl = document.getElementById('state');
  const titleEl = document.getElementById('title');
  const monitorSelect = document.getElementById('monitor-select');

  let session = null;
  let target = null;
  let feedStream = null;
  let feeding = false;
  const remoteStream = new MediaStream();

  api.onViewerTarget(async (t) => {
    target = t;
    titleEl.textContent = `Remote — ${t.displayName || t.deviceCode}`;
    stateEl.textContent = 'waiting for host…';
    await api.relaySignal({
      toDeviceCode: target.deviceCode,
      data: { type: 'controller-ready' },
    });
  });

  api.onSignal(async (payload) => {
    if (!target) return;
    if (payload.fromDeviceCode !== target.deviceCode) return;
    if (payload.data?.type === 'host-ready') {
      await startSession();
      return;
    }
    if (!session) return;
    await session.handleSignal(payload.data);
  });

  api.onSessionEnded(() => {
    cleanup();
    stateEl.textContent = 'Session ended';
  });

  let inputBound = false;

  async function startSession() {
    cleanup(false);
    while (remoteStream.getTracks().length) {
      remoteStream.removeTrack(remoteStream.getTracks()[0]);
    }
    session = new MirrorSession({
      role: 'controller',
      remoteDeviceCode: target.deviceCode,
      onLocalDescription: (data) => {
        api.relaySignal({ toDeviceCode: target.deviceCode, data });
      },
      onRemoteStream: (stream, kind) => {
        for (const track of stream.getTracks()) {
          if (!remoteStream.getTracks().some((t) => t.id === track.id)) {
            remoteStream.addTrack(track);
          }
        }
        video.srcObject = remoteStream;
        audio.srcObject = remoteStream;
        if (kind === 'video') stateEl.textContent = 'receiving video';
      },
      onControlMessage: async (msg) => {
        if (msg.type === 'monitor-list' && Array.isArray(msg.sources)) {
          monitorSelect.innerHTML = msg.sources
            .map((s) => `<option value="${s.id}">${s.name}</option>`)
            .join('');
          return;
        }
        if (msg.type === ControlMessageType.CLIPBOARD && msg.text != null) {
          await api.clipboardWrite(msg.text);
        }
      },
      onConnectionState: (s) => {
        stateEl.textContent = s;
      },
    });
    await session.init();
    await session.createOffer();
    if (!inputBound) {
      bindInput();
      inputBound = true;
    }
    loadMonitors();
  }

  function bindInput() {
    const stage = document.querySelector('.viewer-stage');

    const toRemotePoint = (e) => {
      const rect = video.getBoundingClientRect();
      const vw = video.videoWidth || rect.width;
      const vh = video.videoHeight || rect.height;
      if (!vw || !vh) return null;
      const scale = Math.min(rect.width / vw, rect.height / vh);
      const dispW = vw * scale;
      const dispH = vh * scale;
      const ox = rect.left + (rect.width - dispW) / 2;
      const oy = rect.top + (rect.height - dispH) / 2;
      const x = ((e.clientX - ox) / dispW) * vw;
      const y = ((e.clientY - oy) / dispH) * vh;
      if (x < 0 || y < 0 || x > vw || y > vh) return null;
      return { x, y };
    };

    stage.addEventListener('mousemove', (e) => {
      const p = toRemotePoint(e);
      if (!p || !session) return;
      session.sendControl({
        type: ControlMessageType.MOUSE_MOVE,
        x: p.x,
        y: p.y,
        frameWidth: video.videoWidth,
        frameHeight: video.videoHeight,
      });
    });
    stage.addEventListener('mousedown', (e) => {
      const button = e.button === 2 ? 'right' : 'left';
      session?.sendControl({ type: ControlMessageType.MOUSE_DOWN, button });
    });
    stage.addEventListener('mouseup', (e) => {
      const button = e.button === 2 ? 'right' : 'left';
      session?.sendControl({ type: ControlMessageType.MOUSE_UP, button });
    });
    stage.addEventListener('wheel', (e) => {
      session?.sendControl({ type: ControlMessageType.MOUSE_WHEEL, deltaY: -e.deltaY });
    });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      e.preventDefault();
      session?.sendControl({ type: ControlMessageType.KEY_DOWN, key: e.key });
    });
    window.addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      e.preventDefault();
      session?.sendControl({ type: ControlMessageType.KEY_UP, key: e.key });
    });
  }

  async function loadMonitors() {
    // Populated when host sends monitor-list over the control channel
  }

  monitorSelect.addEventListener('change', () => {
    session?.sendControl({
      type: ControlMessageType.MONITOR_SELECT,
      sourceId: monitorSelect.value,
    });
  });

  document.getElementById('btn-clipboard').addEventListener('click', async () => {
    const text = await api.clipboardRead();
    session?.sendControl({ type: ControlMessageType.CLIPBOARD, text });
  });

  document.getElementById('btn-feed').addEventListener('click', async () => {
    try {
      feedStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      await session.addFeedStream(feedStream);
      session.sendControl({ type: ControlMessageType.FEED_MIC_CAMERA });
      feeding = true;
      document.getElementById('btn-feed').disabled = true;
      document.getElementById('btn-feed-stop').disabled = false;
      stateEl.textContent = 'feeding mic/camera to target';
    } catch (err) {
      stateEl.textContent = `Feed failed: ${err.message}`;
    }
  });

  document.getElementById('btn-feed-stop').addEventListener('click', () => {
    feedStream?.getTracks().forEach((t) => t.stop());
    feedStream = null;
    session?.sendControl({ type: ControlMessageType.FEED_STOP });
    feeding = false;
    document.getElementById('btn-feed').disabled = false;
    document.getElementById('btn-feed-stop').disabled = true;
  });

  document.getElementById('btn-disconnect').addEventListener('click', async () => {
    if (target) await api.endSession(target.deviceCode);
    cleanup();
    window.close();
  });

  function cleanup(update = true) {
    feedStream?.getTracks().forEach((t) => t.stop());
    feedStream = null;
    session?.close();
    session = null;
    if (update) {
      video.srcObject = null;
      audio.srcObject = null;
    }
  }
})();
