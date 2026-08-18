const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { DEFAULT_REMOTE_PASSWORD } = require('../../shared/protocol');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'device-mirror.json');

const defaultData = () => ({
  users: [],
  devices: [],
  privileges: [],
  settings: {},
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readData() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    const data = defaultData();
    writeData(data);
    return data;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeData(data) {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function openDb() {
  const db = { _data: readData(), persist() { writeData(this._data); } };
  seedDefaults(db);
  return db;
}

function seedDefaults(db) {
  if (!db._data.users.some((u) => u.username === 'admin')) {
    db._data.users.push({
      id: nanoid(),
      username: 'admin',
      password_hash: bcrypt.hashSync('admin123', 10),
      role: 'admin',
      created_at: new Date().toISOString(),
    });
  }
  if (!db._data.settings.default_remote_password) {
    db._data.settings.default_remote_password = DEFAULT_REMOTE_PASSWORD;
  }
  db.persist();
}

function createUser(db, username, password, role = 'user') {
  if (db._data.users.some((u) => u.username === username)) {
    throw new Error('Username already exists');
  }
  const user = {
    id: nanoid(),
    username,
    password_hash: bcrypt.hashSync(password, 10),
    role,
    created_at: new Date().toISOString(),
  };
  db._data.users.push(user);
  db.persist();
  return { id: user.id, username: user.username, role: user.role, created_at: user.created_at };
}

function authenticateUser(db, username, password) {
  const user = db._data.users.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, role: user.role };
}

function upsertDevice(db, { deviceCode, displayName, ownerUserId, lastIp }) {
  let device = db._data.devices.find((d) => d.device_code === deviceCode);
  if (device) {
    device.display_name = displayName;
    device.last_ip = lastIp || null;
    device.last_seen = new Date().toISOString();
    device.online = 1;
    if (ownerUserId) device.owner_user_id = ownerUserId;
  } else {
    device = {
      id: nanoid(),
      device_code: deviceCode,
      display_name: displayName,
      owner_user_id: ownerUserId || null,
      last_ip: lastIp || null,
      last_seen: new Date().toISOString(),
      online: 1,
    };
    db._data.devices.push(device);
  }
  db.persist();
  return device;
}

function setDeviceOffline(db, deviceCode) {
  const device = db._data.devices.find((d) => d.device_code === deviceCode);
  if (device) {
    device.online = 0;
    device.last_seen = new Date().toISOString();
    db.persist();
  }
}

function listDevices(db) {
  return [...db._data.devices].sort((a, b) =>
    String(a.display_name).localeCompare(String(b.display_name))
  );
}

function listUsers(db) {
  return db._data.users.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    created_at: u.created_at,
  }));
}

function listPrivileges(db) {
  return db._data.privileges.map((p) => {
    const user = db._data.users.find((u) => u.id === p.user_id);
    const device = db._data.devices.find((d) => d.id === p.target_device_id);
    return {
      ...p,
      username: user?.username,
      device_code: device?.device_code,
      target_name: device?.display_name,
    };
  });
}

function assignPrivilege(db, { userId, targetDeviceId, noPassword = true, autoAccept = false }) {
  let existing = db._data.privileges.find(
    (p) => p.user_id === userId && p.target_device_id === targetDeviceId
  );
  if (existing) {
    existing.no_password = noPassword ? 1 : 0;
    existing.auto_accept = autoAccept ? 1 : 0;
    db.persist();
    return existing.id;
  }
  const id = nanoid();
  db._data.privileges.push({
    id,
    user_id: userId,
    target_device_id: targetDeviceId,
    no_password: noPassword ? 1 : 0,
    auto_accept: autoAccept ? 1 : 0,
    created_at: new Date().toISOString(),
  });
  db.persist();
  return id;
}

function removePrivilege(db, id) {
  db._data.privileges = db._data.privileges.filter((p) => p.id !== id);
  db.persist();
}

function getPrivilegeForConnection(db, { username, targetDeviceCode }) {
  if (!username || !targetDeviceCode) return null;
  const user = db._data.users.find((u) => u.username === username);
  const device = db._data.devices.find((d) => d.device_code === targetDeviceCode);
  if (!user || !device) return null;
  return (
    db._data.privileges.find(
      (p) => p.user_id === user.id && p.target_device_id === device.id
    ) || null
  );
}

function findDeviceByCode(db, code) {
  return db._data.devices.find((d) => d.device_code === code) || null;
}

function deleteUser(db, id) {
  const user = db._data.users.find((u) => u.id === id);
  if (!user || user.role === 'admin') return;
  db._data.privileges = db._data.privileges.filter((p) => p.user_id !== id);
  db._data.users = db._data.users.filter((u) => u.id !== id);
  db.persist();
}

module.exports = {
  openDb,
  createUser,
  authenticateUser,
  upsertDevice,
  setDeviceOffline,
  listDevices,
  listUsers,
  listPrivileges,
  assignPrivilege,
  removePrivilege,
  getPrivilegeForConnection,
  findDeviceByCode,
  deleteUser,
  DATA_DIR,
  DB_PATH,
};
