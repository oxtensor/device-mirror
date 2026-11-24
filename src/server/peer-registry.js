'use strict';

/**
 * Remove a peer only when its registration still belongs to the disconnecting
 * socket. A stale socket must not tear down a newer registration for the same
 * device code.
 */
function removePeerIfCurrent(peers, deviceCode, socketId) {
  const peer = peers.get(deviceCode);
  if (!peer || peer.socketId !== socketId) return false;
  peers.delete(deviceCode);
  return true;
}

module.exports = { removePeerIfCurrent };
