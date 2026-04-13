/* Bifrost Admin SPA */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  token: sessionStorage.getItem('bifrost_token') || '',
  workspaces: [],
};

// --- API Helper ---
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (state.token) opts.headers['Authorization'] = `Bearer ${state.token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok && res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  return data;
}

// --- Auth ---
function logout() {
  state.token = '';
  sessionStorage.removeItem('bifrost_token');
  showScreen('login');
}

function showScreen(name) {
  $$('.screen').forEach(s => s.classList.add('hidden'));
  $(`#${name}-screen`).classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#admin-token').value.trim();
  const err = $('#login-error');
  err.classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (data.ok) {
      state.token = token;
      sessionStorage.setItem('bifrost_token', token);
      showScreen('dashboard');
      loadDashboard();
    } else {
      err.textContent = data.error?.message || 'Authentication failed';
      err.classList.remove('hidden');
    }
  } catch {
    err.textContent = 'Connection error';
    err.classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', logout);

// --- Dashboard ---
async function loadDashboard() {
  try {
    const [wsRes, statusRes] = await Promise.all([
      api('GET', '/api/workspaces'),
      api('GET', '/api/status'),
    ]);
    state.workspaces = wsRes.data || [];
    renderWorkspaces();
    renderToolCount(statusRes.data);
    renderAttention();
  } catch (err) {
    console.error('Dashboard load failed:', err);
  }
}

function renderWorkspaces() {
  const grid = $('#workspace-grid');
  const empty = $('#empty-state');

  if (state.workspaces.length === 0) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.classList.remove('hidden');

  grid.innerHTML = state.workspaces.map(ws => `
    <div class="ws-card" data-id="${ws.id}">
      <div class="ws-card-header">
        <span class="ws-card-provider">${ws.provider}</span>
        <span class="ws-card-name">${esc(ws.displayName)}</span>
        <span class="ws-card-status status-${ws.status}">
          <span class="status-dot"></span>
          <span class="status-label">${statusLabel(ws.status)}</span>
        </span>
      </div>
      <div class="ws-card-namespace">namespace: ${esc(ws.namespace)}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.ws-card').forEach(card => {
    card.addEventListener('click', () => openEditDrawer(card.dataset.id));
  });
}

function renderToolCount(status) {
  const badge = $('#tool-count-badge');
  const count = status?.totalTools || 0;
  badge.textContent = `${count} tools`;
  badge.className = 'badge';
  if (count > 30) badge.classList.add('badge-danger');
  else if (count > 20) badge.classList.add('badge-warn');
  else badge.classList.add('badge-ok');
}

function renderAttention() {
  const area = $('#attention-area');
  const problems = state.workspaces.filter(ws => ws.status === 'error');
  if (problems.length === 0) {
    area.classList.add('hidden');
    return;
  }
  area.classList.remove('hidden');
  area.innerHTML = problems.map(ws => `
    <div class="attention-item" data-id="${ws.id}">
      <span class="status-dot" style="background:var(--red)"></span>
      <span>${esc(ws.displayName)}: Connection error</span>
    </div>
  `).join('');
  area.querySelectorAll('.attention-item').forEach(item => {
    item.addEventListener('click', () => openEditDrawer(item.dataset.id));
  });
}

function statusLabel(status) {
  const labels = { healthy: 'Healthy', error: 'Error', disabled: 'Disabled' };
  return labels[status] || status;
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// --- Drawer ---
$('#btn-add-ws').addEventListener('click', () => openAddDrawer());
$('#btn-add-ws-empty')?.addEventListener('click', () => openAddDrawer());
$('#btn-close-drawer').addEventListener('click', closeDrawer);
$('#drawer-overlay').addEventListener('click', (e) => {
  if (e.target === $('#drawer-overlay')) closeDrawer();
});

$('#ws-provider').addEventListener('change', () => {
  const provider = $('#ws-provider').value;
  $('#notion-fields').classList.toggle('hidden', provider !== 'notion');
  $('#slack-fields').classList.toggle('hidden', provider !== 'slack');
});

function openAddDrawer() {
  $('#drawer-title').textContent = 'Add Workspace';
  $('#ws-edit-id').value = '';
  $('#ws-provider').value = 'notion';
  $('#ws-provider').disabled = false;
  $('#ws-displayname').value = '';
  $('#ws-alias').value = '';
  $('#ws-notion-token').value = '';
  $('#ws-slack-token').value = '';
  $('#ws-slack-teamid').value = '';
  $('#ws-enabled').checked = true;
  $('#btn-delete-ws').classList.add('hidden');
  $('#ws-form-error').classList.add('hidden');
  $('#notion-fields').classList.remove('hidden');
  $('#slack-fields').classList.add('hidden');
  $('#drawer-overlay').classList.remove('hidden');
}

function openEditDrawer(id) {
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  $('#drawer-title').textContent = 'Edit Workspace';
  $('#ws-edit-id').value = ws.id;
  $('#ws-provider').value = ws.provider;
  $('#ws-provider').disabled = true;
  $('#ws-displayname').value = ws.displayName;
  $('#ws-alias').value = ws.alias;
  $('#ws-enabled').checked = ws.enabled;
  $('#btn-delete-ws').classList.remove('hidden');
  $('#ws-form-error').classList.add('hidden');

  // Show/hide provider fields
  $('#notion-fields').classList.toggle('hidden', ws.provider !== 'notion');
  $('#slack-fields').classList.toggle('hidden', ws.provider !== 'slack');

  // Clear credential fields (masked values shown as placeholder)
  if (ws.provider === 'notion') {
    $('#ws-notion-token').value = '';
    $('#ws-notion-token').placeholder = ws.credentials?.token || 'ntn_...';
  } else if (ws.provider === 'slack') {
    $('#ws-slack-token').value = '';
    $('#ws-slack-token').placeholder = ws.credentials?.botToken || 'xoxb-...';
    $('#ws-slack-teamid').value = ws.credentials?.teamId || '';
  }

  $('#drawer-overlay').classList.remove('hidden');
}

function closeDrawer() {
  $('#drawer-overlay').classList.add('hidden');
}

// --- Form Submit ---
$('#workspace-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#ws-form-error');
  err.classList.add('hidden');

  const editId = $('#ws-edit-id').value;
  const provider = $('#ws-provider').value;
  const displayName = $('#ws-displayname').value.trim();
  const alias = $('#ws-alias').value.trim() || undefined;
  const enabled = $('#ws-enabled').checked;

  let credentials = {};
  if (provider === 'notion') {
    const token = $('#ws-notion-token').value.trim();
    if (token) credentials = { token };
  } else if (provider === 'slack') {
    const botToken = $('#ws-slack-token').value.trim();
    const teamId = $('#ws-slack-teamid').value.trim();
    if (botToken) credentials.botToken = botToken;
    if (teamId) credentials.teamId = teamId;
  }

  const body = { provider, displayName, alias, enabled, credentials };

  try {
    let res;
    if (editId) {
      res = await api('PUT', `/api/workspaces/${encodeURIComponent(editId)}`, body);
    } else {
      if (provider === 'notion' && !credentials.token) {
        err.textContent = 'Notion token is required';
        err.classList.remove('hidden');
        return;
      }
      res = await api('POST', '/api/workspaces', body);
    }

    if (res.ok) {
      closeDrawer();
      await loadDashboard();
    } else {
      err.textContent = res.error?.message || 'Save failed';
      err.classList.remove('hidden');
    }
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
});

// --- Test Connection ---
$('#btn-test-ws').addEventListener('click', async () => {
  const editId = $('#ws-edit-id').value;
  const err = $('#ws-form-error');
  if (!editId) {
    err.textContent = 'Save the workspace first to test connection';
    err.classList.remove('hidden');
    return;
  }
  try {
    const res = await api('POST', `/api/workspaces/${encodeURIComponent(editId)}/test`);
    if (res.ok && res.data?.ok) {
      err.textContent = 'Connection successful!';
      err.style.color = 'var(--green)';
    } else {
      err.textContent = `Connection failed: ${res.data?.message || res.error?.message}`;
      err.style.color = '';
    }
    err.classList.remove('hidden');
    await loadDashboard();
  } catch (e) {
    err.textContent = e.message;
    err.style.color = '';
    err.classList.remove('hidden');
  }
});

// --- Test All ---
$('#btn-test-all').addEventListener('click', async () => {
  try {
    await api('POST', '/api/workspaces/test-all');
    await loadDashboard();
  } catch (err) {
    console.error('Test all failed:', err);
  }
});

// --- Delete ---
let pendingDeleteId = null;

$('#btn-delete-ws').addEventListener('click', () => {
  const id = $('#ws-edit-id').value;
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  pendingDeleteId = id;
  $('#confirm-message').textContent = `Are you sure you want to delete "${ws.displayName}"?`;
  $('#confirm-tools-list').textContent = `Affected MCP tools: ${ws.provider}_${ws.namespace}__*`;
  $('#confirm-overlay').classList.remove('hidden');
});

$('#btn-confirm-cancel').addEventListener('click', () => {
  pendingDeleteId = null;
  $('#confirm-overlay').classList.add('hidden');
});

$('#btn-confirm-delete').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  try {
    await api('DELETE', `/api/workspaces/${encodeURIComponent(pendingDeleteId)}`);
    pendingDeleteId = null;
    $('#confirm-overlay').classList.add('hidden');
    closeDrawer();
    await loadDashboard();
  } catch (err) {
    console.error('Delete failed:', err);
  }
});

// --- Init ---
(async function init() {
  if (state.token) {
    try {
      const res = await api('GET', '/api/status');
      if (res.ok) {
        showScreen('dashboard');
        loadDashboard();
        return;
      }
    } catch { /* token invalid */ }
  }
  // Try without token (dev mode — no admin token configured)
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.ok) {
      showScreen('dashboard');
      loadDashboard();
      return;
    }
  } catch { /* needs auth */ }
  showScreen('login');
})();
