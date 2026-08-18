const ControlMessageType = {
  MOUSE_MOVE: 'mouse-move',
  MOUSE_DOWN: 'mouse-down',
  MOUSE_UP: 'mouse-up',
  MOUSE_WHEEL: 'mouse-wheel',
  KEY_DOWN: 'key-down',
  KEY_UP: 'key-up',
  CLIPBOARD: 'clipboard',
  MONITOR_SELECT: 'monitor-select',
  FEED_MIC_CAMERA: 'feed-mic-camera',
  FEED_STOP: 'feed-stop',
  PING: 'ping',
  PONG: 'pong',
};

/**
 * WebRTC session helper shared by host (main window) and controller (viewer).
 */
class MirrorSession {
  constructor({ role, remoteDeviceCode, onLocalDescription, onRemoteStream, onControlMessage, onConnectionState }) {
    this.role = role;
    this.remoteDeviceCode = remoteDeviceCode;
    this.onLocalDescription = onLocalDescription;
    this.onRemoteStream = onRemoteStream;
    this.onControlMessage = onControlMessage;
    this.onConnectionState = onConnectionState;
    this.pc = null;
    this.dataChannel = null;
    this.localStream = null;
    this.feedStream = null;
  }

  async init() {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.onLocalDescription?.({ type: 'candidate', candidate: e.candidate });
      }
    };
    this.pc.onconnectionstatechange = () => {
      this.onConnectionState?.(this.pc.connectionState);
    };
    this.pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.onRemoteStream?.(stream, e.track.kind);
    };

    if (this.role === 'controller') {
      this.dataChannel = this.pc.createDataChannel('control', { ordered: true });
      this._bindChannel(this.dataChannel);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._bindChannel(this.dataChannel);
      };
    }
  }

  _bindChannel(channel) {
    channel.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this.onControlMessage?.(msg);
      } catch (_) {}
    };
  }

  sendControl(msg) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(msg));
    }
  }

  async addLocalStream(stream) {
    this.localStream = stream;
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async addFeedStream(stream) {
    this.feedStream = stream;
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer() {
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await this.pc.setLocalDescription(offer);
    this.onLocalDescription?.({ type: 'offer', sdp: offer });
  }

  async createAnswer() {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.onLocalDescription?.({ type: 'answer', sdp: answer });
  }

  async handleSignal(data) {
    if (!data) return;
    if (data.type === 'offer') {
      await this.pc.setRemoteDescription(data.sdp);
      await this.createAnswer();
    } else if (data.type === 'answer') {
      await this.pc.setRemoteDescription(data.sdp);
    } else if (data.type === 'candidate' && data.candidate) {
      try {
        await this.pc.addIceCandidate(data.candidate);
      } catch (_) {}
    }
  }

  async captureScreen(sourceId, withAudio = true) {
    const constraints = {
      audio: withAudio
        ? {
            mandatory: {
              chromeMediaSource: 'desktop',
            },
          }
        : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 30,
        },
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    await this.addLocalStream(stream);
    return stream;
  }

  close() {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.feedStream?.getTracks().forEach((t) => t.stop());
    this.dataChannel?.close();
    this.pc?.close();
    this.pc = null;
  }
}

window.MirrorSession = MirrorSession;
window.ControlMessageType = ControlMessageType;
