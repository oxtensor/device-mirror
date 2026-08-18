const state = {
  token: localStorage.getItem('dm_admin_token') || '',
};

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (state.token) headers['x-admin-token'] = state.token;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showApp(show) {
  document.getElementById('login-view').hidden = show;
  document.getElementById('app-view').hidden = !show;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  err.hidden = true;
  const fd = new FormData(e.target);
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: fd.get('username'),
        password: fd.get('password'),
      }),
    });
    state.token = data.token;
    localStorage.setItem('dm_admin_token', state.token);
    showApp(true);
    await refreshAll();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  state.token = '';
  localStorage.removeItem('dm_admin_token');
  showApp(false);
});

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab').forEach((t) => {
      t.hidden = t.id !== `tab-${btn.dataset.tab}`;
    });
  });
});

async function refreshAll() {
  const [{ devices }, { users }, { privileges }] = await Promise.all([
    api('/api/devices'),
    api('/api/users'),
    api('/api/privileges'),
  ]);

  document.getElementById('devices-body').innerHTML = devices
    .map(
      (d) => `<tr>
      <td>${esc(d.display_name)}</td>
      <td><code>${esc(d.device_code)}</code></td>
      <td>${esc(d.last_ip || '—')}</td>
      <td><span class="badge ${d.online ? 'on' : 'off'}">${d.online ? 'Online' : 'Offline'}</span></td>
      <td>${esc(d.last_seen || '—')}</td>
    </tr>`
    )
    .join('') || '<tr><td colspan="5">No devices yet</td></tr>';

  document.getElementById('users-body').innerHTML = users
    .map(
      (u) => `<tr>
      <td>${esc(u.username)}</td>
      <td>${esc(u.role)}</td>
      <td>${esc(u.created_at)}</td>
      <td>${
        u.role === 'admin'
          ? ''
          : `<button class="danger" data-del-user="${u.id}">Delete</button>`
      }</td>
    </tr>`
    )
    .join('');

  const userSel = document.getElementById('priv-user');
  const deviceSel = document.getElementById('priv-device');
  userSel.innerHTML = users
    .map((u) => `<option value="${u.id}">${esc(u.username)}</option>`)
    .join('');
  deviceSel.innerHTML = devices
    .map(
      (d) =>
        `<option value="${d.id}">${esc(d.display_name)} (${esc(d.device_code)})</option>`
    )
    .join('');

  document.getElementById('priv-body').innerHTML = privileges
    .map(
      (p) => `<tr>
      <td>${esc(p.username)}</td>
      <td>${esc(p.target_name)}</td>
      <td><code>${esc(p.device_code)}</code></td>
      <td>${p.no_password ? 'Yes' : 'No'}</td>
      <td>${p.auto_accept ? 'Yes' : 'No'}</td>
      <td><button class="danger" data-del-priv="${p.id}">Remove</button></td>
    </tr>`
    )
    .join('') || '<tr><td colspan="6">No privileges assigned</td></tr>';

  document.querySelectorAll('[data-del-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/users/${btn.dataset.delUser}`, { method: 'DELETE' });
      refreshAll();
    });
  });
  document.querySelectorAll('[data-del-priv]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/privileges/${btn.dataset.delPriv}`, { method: 'DELETE' });
      refreshAll();
    });
  });
}

document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: fd.get('username'),
      password: fd.get('password'),
      role: fd.get('role'),
    }),
  });
  e.target.reset();
  refreshAll();
});

document.getElementById('priv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/privileges', {
    method: 'POST',
    body: JSON.stringify({
      userId: fd.get('userId'),
      targetDeviceId: fd.get('targetDeviceId'),
      noPassword: fd.get('noPassword') === 'on',
      autoAccept: fd.get('autoAccept') === 'on',
    }),
  });
  refreshAll();
});

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

(async () => {
  if (!state.token) return;
  try {
    await api('/api/me');
    showApp(true);
    await refreshAll();
  } catch {
    state.token = '';
    localStorage.removeItem('dm_admin_token');
  }
})();
