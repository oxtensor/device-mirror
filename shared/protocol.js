/** Shared protocol constants between desktop clients and signaling server. */

const DEFAULT_REMOTE_PASSWORD = 'qweqwe';
const DEFAULT_SIGNAL_PORT = 3920;
const DEFAULT_ADMIN_PORT = 3921;

const Events = {
  REGISTER: 'register',
  REGISTERED: 'registered',
  PEER_LIST: 'peer-list',
  CONNECT_REQUEST: 'connect-request',
  CONNECT_RESPONSE: 'connect-response',
  SIGNAL: 'signal',
  SESSION_ENDED: 'session-ended',
  PRIVILEGE_CHECK: 'privilege-check',
  PRIVILEGE_RESULT: 'privilege-result',
  UPDATE_PASSWORD: 'update-password',
  UPDATE_PROFILE: 'update-profile',
  ERROR: 'error',
};

const ConnectDecision = {
  ACCEPT: 'accept',
  DENY: 'deny',
};

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

module.exports = {
  DEFAULT_REMOTE_PASSWORD,
  DEFAULT_SIGNAL_PORT,
  DEFAULT_ADMIN_PORT,
  Events,
  ConnectDecision,
  ControlMessageType,
};
