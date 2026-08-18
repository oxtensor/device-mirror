const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { openDb, upsertDevice, setDeviceOffline, getPrivilegeForConnection, findDeviceByCode } = require('./db');
const { createAdminRouter } = require('./admin-routes');
const {
  DEFAULT_SIGNAL_PORT,
  DEFAULT_ADMIN_PORT,
  Events,
  ConnectDecision,
} = require('../../shared/protocol');

const db = openDb();
const peers = new Map(); // deviceCode -> { socketId, displayName, ip, username }

function generateDeviceCode() {
  const n = Math.floor(100_000_000 + Math.random() * 900_000_000);
  return String(n);
}

function startServer(options = {}) {
  const signalPort = options.signalPort || DEFAULT_SIGNAL_PORT;
  const adminPort = options.adminPort || DEFAULT_ADMIN_PORT;

  const signalApp = express();
  signalApp.use(cors());
  signalApp.get('/health', (_req, res) => res.json({ ok: true }));

  const signalServer = http.createServer(signalApp);
  const io = new Server(signalServer, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    let deviceCode = null;

    socket.on(Events.REGISTER, (payload = {}) => {
      deviceCode = payload.deviceCode || generateDeviceCode();
      while ([...peers.keys()].includes(deviceCode) && peers.get(deviceCode)?.socketId !== socket.id) {
        deviceCode = generateDeviceCode();
      }

      const displayName = payload.displayName || `PC-${deviceCode.slice(-4)}`;
      const username = payload.username || null;
      const ip = socket.handshake.address?.replace('::ffff:', '') || null;

      peers.set(deviceCode, {
        socketId: socket.id,
        displayName,
        ip,
        username,
        passwordHashHint: !!payload.hasPassword,
      });

      upsertDevice(db, {
        deviceCode,
        displayName,
        ownerUserId: null,
        lastIp: ip,
      });

      socket.join(deviceCode);
      socket.emit(Events.REGISTERED, {
        deviceCode,
        displayName,
        signalPort,
      });

      broadcastPeerList();
    });

    socket.on(Events.PRIVILEGE_CHECK, (payload = {}, ack) => {
      const { username, targetDeviceCode } = payload;
      const priv = getPrivilegeForConnection(db, { username, targetDeviceCode });
      const result = {
        allowed: !!priv,
        noPassword: !!(priv && priv.no_password),
        autoAccept: !!(priv && priv.auto_accept),
      };
      if (typeof ack === 'function') ack(result);
      socket.emit(Events.PRIVILEGE_RESULT, result);
    });

    socket.on(Events.CONNECT_REQUEST, (payload = {}) => {
      const {
        fromDeviceCode,
        toDeviceCode,
        toIp,
        password,
        username,
        requestId,
        offerCapabilities,
      } = payload;

      let targetCode = toDeviceCode;
      if (!targetCode && toIp) {
        const found = [...peers.entries()].find(([, p]) => p.ip === toIp);
        targetCode = found?.[0];
      }

      const target = targetCode ? peers.get(targetCode) : null;
      if (!target) {
        socket.emit(Events.CONNECT_RESPONSE, {
          requestId,
          decision: ConnectDecision.DENY,
          reason: 'Target offline or not found',
        });
        return;
      }

      const priv = getPrivilegeForConnection(db, {
        username,
        targetDeviceCode: targetCode,
      });

      const from = peers.get(fromDeviceCode);
      io.to(target.socketId).emit(Events.CONNECT_REQUEST, {
        requestId,
        fromDeviceCode,
        fromDisplayName: from?.displayName || fromDeviceCode,
        fromUsername: username || null,
        password,
        privilege: priv
          ? { noPassword: !!priv.no_password, autoAccept: !!priv.auto_accept }
          : null,
        offerCapabilities: offerCapabilities || {},
      });
    });

    socket.on(Events.CONNECT_RESPONSE, (payload = {}) => {
      const { requestId, toDeviceCode, decision, reason } = payload;
      const requester = toDeviceCode ? peers.get(toDeviceCode) : null;
      if (requester) {
        io.to(requester.socketId).emit(Events.CONNECT_RESPONSE, {
          requestId,
          decision,
          reason,
          fromDeviceCode: deviceCode,
        });
      }
    });

    socket.on(Events.SIGNAL, (payload = {}) => {
      const { toDeviceCode, data } = payload;
      const target = peers.get(toDeviceCode);
      if (target) {
        io.to(target.socketId).emit(Events.SIGNAL, {
          fromDeviceCode: deviceCode,
          data,
        });
      }
    });

    socket.on(Events.SESSION_ENDED, (payload = {}) => {
      const { toDeviceCode } = payload;
      const target = peers.get(toDeviceCode);
      if (target) {
        io.to(target.socketId).emit(Events.SESSION_ENDED, {
          fromDeviceCode: deviceCode,
        });
      }
    });

    socket.on('disconnect', () => {
      if (deviceCode) {
        setDeviceOffline(db, deviceCode);
        peers.delete(deviceCode);
        broadcastPeerList();
      }
    });
  });

  function broadcastPeerList() {
    const list = [...peers.entries()].map(([code, p]) => ({
      deviceCode: code,
      displayName: p.displayName,
      ip: p.ip,
      online: true,
    }));
    io.emit(Events.PEER_LIST, { peers: list });
  }

  const adminApp = express();
  adminApp.use(cors());
  adminApp.use(createAdminRouter(db));

  signalServer.listen(signalPort, () => {
    console.log(`[signal] listening on :${signalPort}`);
  });
  signalServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[signal] :${signalPort} already in use — clients will reuse it`);
    } else {
      console.error(err);
    }
  });

  const adminServer = adminApp.listen(adminPort, () => {
    console.log(`[admin] dashboard http://localhost:${adminPort}`);
  });
  adminServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[admin] :${adminPort} already in use — clients will reuse it`);
    } else {
      console.error(err);
    }
  });

  return { io, db, signalPort, adminPort, signalServer, adminServer };
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, generateDeviceCode, findDeviceByCode };
