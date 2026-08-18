(() => {
  const api = window.deviceMirror;
  let status = {};
  let peers = [];
  let hostSession = null;
  let activePeerCode = null;
  let selectedSourceId = null;
  let pendingConnect = null;

  const els = {
    deviceCode: document.getElementById('device-code'),
    displayName: document.getElementById('display-name'),
    connPill: document.getElementById('conn-pill'),
    peerList: document.getElementById('peer-list'),
    connectForm: document.getElementById('connect-form'),
    targetInput: document.getElementById('target-input'),
    passwordInput: document.getElementById('password-input'),
    connectStatus: document.getElementById('connect-status'),
    settingsForm: document.getElementById('settings-form'),
    hostState: document.getElementById('host-state'),
    stopHost: document.getElementById('stop-host-session'),
    monitorPicker: document.getElementById('monitor-picker'),
    adminLink: document.getElementById('admin-link'),
  };

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach((p) => {
        p.hidden = p.id !== `panel-${btn.dataset.panel}`;
      });
      if (btn.dataset.panel === 'session') refreshMonitors();
    });
  });

  function renderStatus(s) {
    status = { ...status, ...s };
    els.deviceCode.textContent = status.deviceCode || '————————';
    els.displayName.textContent = status.displayName || '—';
    els.connPill.textContent = status.signalConnected ? 'Online' : 'Offline';
    els.connPill.classList.toggle('online', !!status.signalConnected);
    if (status.adminUrl) els.adminLink.href = status.adminUrl;

    const form = els.settingsForm;
    form.displayName.value = status.displayName || '';
    form.username.value = status.username || '';
    form.remotePassword.value = status.remotePassword || 'qweqwe';
    form.signalUrl.value = status.signalUrl || '';
    form.launchAtLogin.checked = !!status.launchAtLogin;
  }

  function renderPeers(list) {
    peers = list || [];
    const mine = status.deviceCode;
    const items = peers.filter((p) => p.deviceCode !== mine);
    els.peerList.innerHTML =
      items
        .map(
          (p) => `<li>
        <div>
          <div>${escapeHtml(p.displayName)}</div>
          <div class="meta">${escapeHtml(p.deviceCode)} · ${escapeHtml(p.ip || 'no ip')}</div>
        </div>
        <button data-connect="${escapeHtml(p.deviceCode)}">Connect</button>
      </li>`
        )
        .join('') || '<li class="meta">No other peers online</li>';

    els.peerList.querySelectorAll('[data-connect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        els.targetInput.value = btn.dataset.connect;
        startConnect();
      });
    });
  }

  async function startConnect() {
    const raw = els.targetInput.value.trim();
    if (!raw) return;
    const password = els.passwordInput.value;
    els.connectStatus.textContent = 'Requesting connection…';

    const target = /^\d{6,}$/.test(raw)
      ? { deviceCode: raw }
      : peers.find((p) => p.deviceCode === raw || p.ip === raw) || { ip: raw, deviceCode: raw };

    const { requestId, privilege } = await api.requestConnect({ target, password });
    pendingConnect = { requestId, target };
    if (privilege?.noPassword) {
      els.connectStatus.textContent = 'Privilege: connecting without password…';
    }
  }

  els.connectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    startConnect();
  });

  els.settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(els.settingsForm);
    await api.saveSettings({
      displayName: fd.get('displayName'),
      username: fd.get('username'),
      remotePassword: fd.get('remotePassword'),
      signalUrl: fd.get('signalUrl'),
      launchAtLogin: !!els.settingsForm.launchAtLogin.checked,
    });
    els.connectStatus.textContent = 'Settings saved';
  });

  els.adminLink.addEventListener('click', (e) => {
    // let default open via href; Electron will open externally if we set it — keep href
  });

  api.onStatus(renderStatus);
  api.onPeers(renderPeers);

  api.onConnectResponse(async (payload) => {
    if (!pendingConnect || payload.requestId !== pendingConnect.requestId) return;
    if (payload.decision !== 'accept') {
      els.connectStatus.textContent = `Denied: ${payload.reason || 'rejected'}`;
      pendingConnect = null;
      return;
    }
    els.connectStatus.textContent = 'Accepted — opening remote viewer…';
    const target = {
      deviceCode: payload.fromDeviceCode || pendingConnect.target.deviceCode,
      displayName: pendingConnect.target.displayName || pendingConnect.target.deviceCode,
      password: els.passwordInput.value,
    };
    await api.openViewer(target);
    pendingConnect = null;
  });

  api.onIncomingSession(async (payload) => {
    activePeerCode = payload.fromDeviceCode;
    els.hostState.textContent = `Connected with ${payload.fromDisplayName || payload.fromDeviceCode}`;
    els.hostState.classList.add('active');
    els.stopHost.disabled = false;
    await startHostSession(payload.fromDeviceCode);
  });

  api.onSignal(async (payload) => {
    if (!hostSession) return;
    if (payload.fromDeviceCode !== activePeerCode) return;
    if (payload.data?.type === 'controller-ready') {
      await api.relaySignal({
        toDeviceCode: activePeerCode,
        data: { type: 'host-ready' },
      });
      return;
    }
    await hostSession.handleSignal(payload.data);
  });

  api.onSessionEnded(() => {
    teardownHost();
  });

  els.stopHost.addEventListener('click', async () => {
    if (activePeerCode) await api.endSession(activePeerCode);
    teardownHost();
  });

  async function startHostSession(remoteDeviceCode) {
    teardownHost(false);
    activePeerCode = remoteDeviceCode;
    hostSession = new MirrorSession({
      role: 'host',
      remoteDeviceCode,
      onLocalDescription: (data) => {
        api.relaySignal({ toDeviceCode: remoteDeviceCode, data });
      },
      onRemoteStream: async (stream) => {
        const info = await api.virtualFeedStart({ width: 640, height: 480, fps: 15 });
        let preview = document.getElementById('feed-preview');
        if (!preview) {
          preview = document.createElement('video');
          preview.id = 'feed-preview';
          preview.autoplay = true;
          preview.playsInline = true;
          preview.muted = true;
          preview.style.cssText =
            'width:100%;max-width:420px;border-radius:10px;border:1px solid var(--line);margin-top:1rem;background:#000';
          els.hostState.after(preview);
        }
        preview.srcObject = stream;
        startEmbeddedFeedPump(stream);
        if (info?.hint) {
          els.hostState.textContent = `Feed active — ${info.cameraName || 'Device Mirror Camera'} / ${info.micName || 'virtual mic'}`;
        }
      },
      onControlMessage: async (msg) => {
        if (msg.type === ControlMessageType.CLIPBOARD) {
          await api.clipboardWrite(msg.text || '');
          return;
        }
        if (msg.type === ControlMessageType.MONITOR_SELECT && msg.sourceId) {
          selectedSourceId = msg.sourceId;
          await replaceScreenTrack(msg.sourceId);
          return;
        }
        if (msg.type === ControlMessageType.FEED_MIC_CAMERA) {
          await api.virtualFeedStart({ width: 640, height: 480, fps: 15 });
          return;
        }
        if (msg.type === ControlMessageType.FEED_STOP) {
          stopEmbeddedFeedPump();
          await api.virtualFeedStop();
          const preview = document.getElementById('feed-preview');
          if (preview) {
            preview.srcObject = null;
            preview.remove();
          }
          return;
        }
        await api.applyInput(msg);
      },
      onConnectionState: (state) => {
        els.hostState.textContent = `Session ${state}`;
      },
    });

    await hostSession.init();

    const sources = await api.getDesktopSources();
    selectedSourceId = sources[0]?.id;
    if (selectedSourceId) {
      await hostSession.captureScreen(selectedSourceId, true);
    }

    // Tell controller we are ready for the offer (avoids race)
    await api.relaySignal({
      toDeviceCode: remoteDeviceCode,
      data: { type: 'host-ready' },
    });

    // Push monitor list once data channel may open — also on interval until sent
    const pushMonitors = async () => {
      if (!hostSession) return;
      const sources = await api.getDesktopSources();
      hostSession.sendControl({
        type: 'monitor-list',
        sources: sources.map((s, i) => ({ id: s.id, name: s.name || `Monitor ${i + 1}` })),
      });
    };
    if (window.__monTimer) clearInterval(window.__monTimer);
    window.__monTimer = setInterval(pushMonitors, 1500);
    setTimeout(pushMonitors, 500);

    // Clipboard push periodically
    if (window.__clipTimer) clearInterval(window.__clipTimer);
    window.__clipTimer = setInterval(async () => {
      if (!hostSession) return;
      const text = await api.clipboardRead();
      hostSession.sendControl({ type: ControlMessageType.CLIPBOARD, text });
    }, 2000);
  }

  async function replaceScreenTrack(sourceId) {
    if (!hostSession) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 30,
        },
      },
    });
    const newTrack = stream.getVideoTracks()[0];
    const sender = hostSession.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
  }

  function teardownHost(updateUi = true) {
    stopEmbeddedFeedPump();
    hostSession?.close();
    hostSession = null;
    activePeerCode = null;
    api.virtualFeedStop();
    if (window.__clipTimer) clearInterval(window.__clipTimer);
    if (window.__monTimer) clearInterval(window.__monTimer);
    const preview = document.getElementById('feed-preview');
    if (preview) preview.remove();
    if (updateUi) {
      els.hostState.textContent = 'Waiting for incoming connections…';
      els.hostState.classList.remove('active');
      els.stopHost.disabled = true;
    }
  }

  let feedPump = { timer: null, audioCtx: null, processor: null, video: null, canvas: null };

  function stopEmbeddedFeedPump() {
    if (feedPump.timer) cancelAnimationFrame(feedPump.timer);
    feedPump.timer = null;
    try {
      feedPump.processor?.disconnect();
    } catch (_) {}
    try {
      feedPump.audioCtx?.close();
    } catch (_) {}
    feedPump.processor = null;
    feedPump.audioCtx = null;
    feedPump.video = null;
    feedPump.canvas = null;
  }

  function startEmbeddedFeedPump(stream) {
    stopEmbeddedFeedPump();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    feedPump.video = video;
    feedPump.canvas = canvas;

    const tick = () => {
      if (!feedPump.video) return;
      if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const rgba = image.data;
        // Convert Uint8ClampedArray to base64 efficiently via chunked binary string
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < rgba.length; i += chunk) {
          binary += String.fromCharCode.apply(null, rgba.subarray(i, i + chunk));
        }
        api.virtualFeedFrame({
          width: canvas.width,
          height: canvas.height,
          rgbaBase64: btoa(binary),
        });
      }
      feedPump.timer = requestAnimationFrame(tick);
    };
    feedPump.timer = requestAnimationFrame(tick);

    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        api.virtualFeedAudio({
          sampleRate: audioCtx.sampleRate,
          channels: 1,
          pcmBase64: btoa(binary),
        });
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
      feedPump.audioCtx = audioCtx;
      feedPump.processor = processor;
    } catch (err) {
      console.warn('audio pump failed', err);
    }
  }

  async function refreshMonitors() {
    const sources = await api.getDesktopSources();
    els.monitorPicker.innerHTML = sources
      .map(
        (s, i) => `<div class="monitor-card ${s.id === selectedSourceId ? 'selected' : ''}" data-id="${s.id}">
        <img src="${s.thumbnailDataUrl}" alt="" />
        <div class="cap">${escapeHtml(s.name || `Monitor ${i + 1}`)}</div>
      </div>`
      )
      .join('');
    els.monitorPicker.querySelectorAll('.monitor-card').forEach((card) => {
      card.addEventListener('click', () => {
        selectedSourceId = card.dataset.id;
        refreshMonitors();
        if (hostSession) replaceScreenTrack(selectedSourceId);
      });
    });
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  api.getStatus().then(renderStatus);
})();
