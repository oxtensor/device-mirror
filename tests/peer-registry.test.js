'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { removePeerIfCurrent } = require('../src/server/peer-registry');

test('removes a peer when its current socket disconnects', () => {
  const peers = new Map([['123456789', { socketId: 'socket-a' }]]);

  assert.equal(removePeerIfCurrent(peers, '123456789', 'socket-a'), true);
  assert.equal(peers.has('123456789'), false);
});

test('keeps a newer registration when a stale socket disconnects', () => {
  const activePeer = { socketId: 'socket-b', displayName: 'Reconnected PC' };
  const peers = new Map([['123456789', activePeer]]);

  assert.equal(removePeerIfCurrent(peers, '123456789', 'socket-a'), false);
  assert.equal(peers.get('123456789'), activePeer);
});

test('ignores a disconnect for an unknown device', () => {
  const peers = new Map();

  assert.equal(removePeerIfCurrent(peers, 'missing', 'socket-a'), false);
  assert.equal(peers.size, 0);
});
