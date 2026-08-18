const express = require('express');
const path = require('path');
const {
  authenticateUser,
  createUser,
  listUsers,
  listDevices,
  listPrivileges,
  assignPrivilege,
  removePrivilege,
  deleteUser,
  findDeviceByCode,
} = require('./db');

function createAdminRouter(db) {
  const router = express.Router();

  router.use(express.json());
  router.use(express.static(path.join(__dirname, 'admin-public')));

  const sessions = new Map();

  function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    const session = sessions.get(token);
    if (!session || session.role !== 'admin') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.admin = session;
    next();
  }

  router.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = authenticateUser(db, username, password);
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = require('nanoid').nanoid(32);
    sessions.set(token, user);
    res.json({ token, user });
  });

  router.get('/api/me', requireAdmin, (req, res) => {
    res.json({ user: req.admin });
  });

  router.get('/api/users', requireAdmin, (req, res) => {
    res.json({ users: listUsers(db) });
  });

  router.post('/api/users', requireAdmin, (req, res) => {
    try {
      const { username, password, role } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
      }
      const user = createUser(db, username, password, role || 'user');
      res.json({ user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/users/:id', requireAdmin, (req, res) => {
    deleteUser(db, req.params.id);
    res.json({ ok: true });
  });

  router.get('/api/devices', requireAdmin, (req, res) => {
    res.json({ devices: listDevices(db) });
  });

  router.get('/api/privileges', requireAdmin, (req, res) => {
    res.json({ privileges: listPrivileges(db) });
  });

  router.post('/api/privileges', requireAdmin, (req, res) => {
    const { userId, targetDeviceId, targetDeviceCode, noPassword, autoAccept } = req.body || {};
    let deviceId = targetDeviceId;
    if (!deviceId && targetDeviceCode) {
      const device = findDeviceByCode(db, targetDeviceCode);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      deviceId = device.id;
    }
    if (!userId || !deviceId) {
      return res.status(400).json({ error: 'userId and target device required' });
    }
    const id = assignPrivilege(db, {
      userId,
      targetDeviceId: deviceId,
      noPassword: noPassword !== false,
      autoAccept: !!autoAccept,
    });
    res.json({ id });
  });

  router.delete('/api/privileges/:id', requireAdmin, (req, res) => {
    removePrivilege(db, req.params.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAdminRouter };
