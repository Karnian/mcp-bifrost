/* Bifrost Admin SPA */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  token: sessionStorage.getItem('bifrost_token') || '',
  workspaces: [],
  currentDetail: null,
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
      await enterDashboard();
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
async function enterDashboard() {
  showScreen('dashboard');
  await loadDashboard();
}

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
    renderSessionCount(statusRes.data);

    // Auto-enter wizard if no workspaces
    if (state.workspaces.length === 0) {
      showScreen('wizard');
      initWizard();
    }
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
    card.addEventListener('click', () => openDetail(card.dataset.id));
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

function renderSessionCount(status) {
  const el = $('#session-count');
  const count = status?.activeSessions || 0;
  el.textContent = count > 0 ? `${count} active session${count > 1 ? 's' : ''}` : '';
}

function renderAttention() {
  const area = $('#attention-area');
  const problems = state.workspaces.filter(ws =>
    ws.status === 'error' || ws.status === 'action_needed'
  );
  if (problems.length === 0) {
    area.classList.add('hidden');
    return;
  }
  area.classList.remove('hidden');
  area.innerHTML = problems.map(ws => {
    const icon = ws.status === 'error' ? 'red' : 'orange';
    const msg = ws.status === 'error' ? 'Connection error' : 'Action needed';
    return `
      <div class="attention-item" data-id="${ws.id}">
        <span class="status-dot" style="background:var(--${icon})"></span>
        <span>${esc(ws.displayName)}: ${msg}</span>
      </div>
    `;
  }).join('');
  area.querySelectorAll('.attention-item').forEach(item => {
    item.addEventListener('click', () => openDetail(item.dataset.id));
  });
}

const STATUS_LABELS = {
  healthy: 'Healthy',
  limited: 'Limited',
  action_needed: 'Action Needed',
  error: 'Error',
  disabled: 'Disabled',
  unknown: 'Checking...',
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}

// --- Workspace Detail ---
async function openDetail(id) {
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  state.currentDetail = ws;
  showScreen('detail');

  $('#detail-title').textContent = ws.displayName;
  $('#detail-namespace').textContent = ws.namespace;
  $('#detail-displayname').value = ws.displayName;
  $('#detail-alias').value = ws.alias;
  $('#detail-enabled').checked = ws.enabled;

  // Status
  $('#detail-status').innerHTML = `
    <span class="ws-card-status status-${ws.status}">
      <span class="status-dot"></span>
      <span class="status-label">${statusLabel(ws.status)}</span>
    </span>
  `;

  // Credential fields
  const credDiv = $('#detail-cred-fields');
  if (ws.provider === 'notion') {
    credDiv.innerHTML = `
      <label>Integration Token</label>
      <input type="password" id="detail-cred-token" placeholder="${esc(ws.credentials?.token || 'ntn_...')}">
    `;
  } else if (ws.provider === 'slack') {
    credDiv.innerHTML = `
      <label>Bot Token</label>
      <input type="password" id="detail-cred-bottoken" placeholder="${esc(ws.credentials?.botToken || 'xoxb_...')}">
      <label>Team ID</label>
      <input type="text" id="detail-cred-teamid" value="${esc(ws.credentials?.teamId || '')}">
    `;
  }

  // Tools list — fetch fresh from status
  renderDetailTools(ws);

  // Health info
  $('#detail-health-info').innerHTML = `<p>Status: ${statusLabel(ws.status)}</p>`;
}

function renderDetailTools(ws) {
  const toolsDiv = $('#detail-tools-list');
  // Show tools based on namespace pattern
  toolsDiv.innerHTML = `<p class="text-secondary" style="font-size:13px;color:var(--text-secondary)">
    MCP tool pattern: <code>${ws.provider}_${ws.namespace}__*</code>
  </p>`;
}

$('#btn-back-dashboard').addEventListener('click', async () => {
  state.currentDetail = null;
  await enterDashboard();
});

$('#btn-detail-test').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  try {
    const res = await api('POST', `/api/workspaces/${encodeURIComponent(state.currentDetail.id)}/test`);
    const info = $('#detail-health-info');
    if (res.ok && res.data?.ok) {
      info.innerHTML = `<p class="success-msg">Connection successful!</p>`;
    } else {
      info.innerHTML = `<p class="error-msg">Failed: ${esc(res.data?.message || res.error?.message)}</p>`;
    }
    // Refresh dashboard data in background
    const wsRes = await api('GET', '/api/workspaces');
    state.workspaces = wsRes.data || [];
    const ws = state.workspaces.find(w => w.id === state.currentDetail.id);
    if (ws) {
      state.currentDetail = ws;
      $('#detail-status').innerHTML = `
        <span class="ws-card-status status-${ws.status}">
          <span class="status-dot"></span>
          <span class="status-label">${statusLabel(ws.status)}</span>
        </span>
      `;
    }
  } catch (err) {
    $('#detail-health-info').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
});

$('#btn-detail-save').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  const body = {
    displayName: $('#detail-displayname').value.trim(),
    alias: $('#detail-alias').value.trim(),
    enabled: $('#detail-enabled').checked,
    credentials: {},
  };

  if (state.currentDetail.provider === 'notion') {
    const token = $('#detail-cred-token')?.value.trim();
    if (token) body.credentials.token = token;
  } else if (state.currentDetail.provider === 'slack') {
    const botToken = $('#detail-cred-bottoken')?.value.trim();
    const teamId = $('#detail-cred-teamid')?.value.trim();
    if (botToken) body.credentials.botToken = botToken;
    if (teamId) body.credentials.teamId = teamId;
  }

  try {
    const res = await api('PUT', `/api/workspaces/${encodeURIComponent(state.currentDetail.id)}`, body);
    if (res.ok) {
      const wsRes = await api('GET', '/api/workspaces');
      state.workspaces = wsRes.data || [];
      const ws = state.workspaces.find(w => w.id === state.currentDetail.id);
      if (ws) openDetail(ws.id);
    }
  } catch (err) {
    console.error('Save failed:', err);
  }
});

$('#btn-detail-delete').addEventListener('click', () => {
  if (!state.currentDetail) return;
  pendingDeleteId = state.currentDetail.id;
  $('#confirm-message').textContent = `"${state.currentDetail.displayName}" 워크스페이스를 삭제하시겠습니까?`;
  $('#confirm-tools-list').textContent = `영향받는 MCP 도구: ${state.currentDetail.provider}_${state.currentDetail.namespace}__*`;
  $('#confirm-overlay').classList.remove('hidden');
});

// --- Setup Wizard ---
let wizardState = { step: 1, provider: '', data: {} };

function initWizard() {
  wizardState = { step: 1, provider: '', data: {} };
  showWizardStep(1);
}

function showWizardStep(step) {
  wizardState.step = step;
  for (let i = 1; i <= 4; i++) {
    $(`#wizard-step-${i}`).classList.toggle('hidden', i !== step);
    const stepEl = $(`.wizard-step[data-step="${i}"]`);
    stepEl.classList.remove('active', 'done');
    if (i < step) stepEl.classList.add('done');
    if (i === step) stepEl.classList.add('active');
  }
}

// Step 1: Provider selection
$$('.provider-card').forEach(card => {
  card.addEventListener('click', () => {
    $$('.provider-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    wizardState.provider = card.dataset.provider;
    // Show step 2
    showWizardStep(2);
    $('#wiz-notion-fields').classList.toggle('hidden', wizardState.provider !== 'notion');
    $('#wiz-slack-fields').classList.toggle('hidden', wizardState.provider !== 'slack');
  });
});

// Step navigation
$$('.wizard-step').forEach(el => {
  el.addEventListener('click', () => {
    const target = parseInt(el.dataset.step);
    if (target < wizardState.step) showWizardStep(target);
  });
});

$$('.wiz-prev').forEach(btn => {
  btn.addEventListener('click', () => showWizardStep(wizardState.step - 1));
});

// Step 2 → 3
$('#wizard-step-2 .wiz-next').addEventListener('click', async () => {
  const displayName = $('#wiz-displayname').value.trim();
  if (!displayName) return;

  let credentials = {};
  if (wizardState.provider === 'notion') {
    credentials.token = $('#wiz-notion-token').value.trim();
    if (!credentials.token) return;
  } else if (wizardState.provider === 'slack') {
    credentials.botToken = $('#wiz-slack-token').value.trim();
    credentials.teamId = $('#wiz-slack-teamid').value.trim();
    if (!credentials.botToken) return;
  }

  wizardState.data = {
    provider: wizardState.provider,
    displayName,
    alias: $('#wiz-alias').value.trim() || undefined,
    credentials,
  };

  showWizardStep(3);
  await runWizardTest();
});

async function runWizardTest() {
  const steps = ['wiz-ts-validate', 'wiz-ts-capability', 'wiz-ts-sample'];
  steps.forEach(id => {
    $(`#${id} .test-icon`).textContent = '...';
    $(`#${id} .test-icon`).className = 'test-icon';
  });
  $('#wiz-test-result').classList.add('hidden');
  $('#wizard-step-3 .wiz-next').disabled = true;

  // Create workspace first
  try {
    const res = await api('POST', '/api/workspaces', wizardState.data);
    if (!res.ok) {
      setTestStep('wiz-ts-validate', false, res.error?.message);
      return;
    }
    wizardState.data.id = res.data.id;
    setTestStep('wiz-ts-validate', true);
  } catch (err) {
    setTestStep('wiz-ts-validate', false, err.message);
    return;
  }

  // Test connection
  try {
    const testRes = await api('POST', `/api/workspaces/${encodeURIComponent(wizardState.data.id)}/test`);
    if (testRes.ok && testRes.data?.ok) {
      setTestStep('wiz-ts-capability', true);
    } else {
      setTestStep('wiz-ts-capability', false, testRes.data?.message);
    }
  } catch {
    setTestStep('wiz-ts-capability', false, 'Test failed');
  }

  setTestStep('wiz-ts-sample', true, 'Skipped (optional)');
  $('#wizard-step-3 .wiz-next').disabled = false;
}

function setTestStep(id, ok, msg) {
  const icon = $(`#${id} .test-icon`);
  icon.textContent = ok ? 'OK' : 'X';
  icon.className = `test-icon ${ok ? 'pass' : 'fail'}`;
  if (msg) {
    const span = $(`#${id}`).querySelectorAll('span')[1];
    if (span) span.textContent += ` — ${msg}`;
  }
}

// Step 3 → 4
$('#wizard-step-3 .wiz-next').addEventListener('click', () => {
  showWizardStep(4);
  $('#wiz-summary').innerHTML = `
    <p><strong>Provider:</strong> ${wizardState.provider}</p>
    <p><strong>Display Name:</strong> ${esc(wizardState.data.displayName)}</p>
    <p><strong>MCP tools:</strong> <code>${wizardState.provider}_${wizardState.data.alias || wizardState.data.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}__*</code></p>
  `;
});

// Step 4 actions
$('#wiz-add-another').addEventListener('click', () => initWizard());
$('#wiz-go-dashboard').addEventListener('click', async () => await enterDashboard());
$('#wiz-skip').addEventListener('click', async () => await enterDashboard());

// --- Drawer (Add shortcut from dashboard) ---
$('#btn-add-ws').addEventListener('click', () => openAddDrawer());
$('#btn-add-ws-empty')?.addEventListener('click', () => {
  showScreen('wizard');
  initWizard();
});
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

function closeDrawer() {
  $('#drawer-overlay').classList.add('hidden');
}

// --- Drawer Form Submit ---
$('#workspace-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#ws-form-error');
  err.classList.add('hidden');
  err.style.color = '';

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

// --- Test Connection (Drawer) ---
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

$('#btn-delete-ws')?.addEventListener('click', () => {
  const id = $('#ws-edit-id').value;
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  pendingDeleteId = id;
  $('#confirm-message').textContent = `"${ws.displayName}" 워크스페이스를 삭제하시겠습니까?`;
  $('#confirm-tools-list').textContent = `영향받는 MCP 도구: ${ws.provider}_${ws.namespace}__*`;
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
    state.currentDetail = null;
    await enterDashboard();
  } catch (err) {
    console.error('Delete failed:', err);
  }
});

// --- Tools Overview ---
$('#btn-nav-tools').addEventListener('click', async () => {
  showScreen('tools');
  await loadToolsOverview();
});
$('#btn-back-from-tools').addEventListener('click', async () => await enterDashboard());

async function loadToolsOverview() {
  try {
    const res = await api('GET', '/api/tools');
    const tools = res.data || [];
    renderToolsTable(tools);
    const badge = $('#tools-total-badge');
    badge.textContent = `${tools.length} tools`;
    badge.className = 'badge';
    if (tools.length > 30) badge.classList.add('badge-danger');
    else if (tools.length > 20) badge.classList.add('badge-warn');
    else badge.classList.add('badge-ok');
  } catch (err) {
    console.error('Tools load failed:', err);
  }
}

function renderToolsTable(tools) {
  const tbody = $('#tools-tbody');
  tbody.innerHTML = tools.map(t => {
    const parts = t.name.split('__');
    const prefix = parts[0] || '';
    const firstUnder = prefix.indexOf('_');
    const provider = firstUnder > 0 ? prefix.slice(0, firstUnder) : prefix;
    const ws = state.workspaces.find(w => w.id === t.workspace);
    return `<tr>
      <td>${esc(provider)}</td>
      <td>${esc(ws?.displayName || t.workspace || 'Bifrost')}</td>
      <td>${esc(t.originalName)}</td>
      <td><code>${esc(t.name)}</code></td>
      <td>${esc(t.description)}</td>
    </tr>`;
  }).join('');
}

$('#tools-search')?.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  $$('#tools-tbody tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

// --- Connect Guide ---
$('#btn-nav-connect').addEventListener('click', async () => {
  showScreen('connect');
  await loadConnectGuide();
});
$('#btn-back-from-connect').addEventListener('click', async () => await enterDashboard());

$$('.connect-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.connect-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.connect-panel').forEach(p => p.classList.add('hidden'));
    $(`#connect-${tab.dataset.tab}`).classList.remove('hidden');
  });
});

$$('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = $(`#${btn.dataset.copy}`);
    if (target) {
      navigator.clipboard.writeText(target.textContent).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    }
  });
});

async function loadConnectGuide() {
  try {
    const res = await api('GET', '/api/connect-info');
    const info = res.data || {};

    const baseUrl = info.tunnelUrl
      ? `https://${info.tunnelUrl}`
      : `http://localhost:${info.port}`;

    // claude.ai
    $('#connect-claudeai-url').textContent = `${baseUrl}/sse`;

    // Claude Code
    const mcpJson = {
      mcpServers: {
        bifrost: {
          url: `${baseUrl}/mcp`,
          ...(info.mcpTokenConfigured ? { headers: { Authorization: 'Bearer <BIFROST_MCP_TOKEN>' } } : {}),
        },
      },
    };
    $('#connect-mcp-json').textContent = JSON.stringify(mcpJson, null, 2);

    // Other
    $('#connect-mcp-url').textContent = `${baseUrl}/mcp`;
    $('#connect-sse-url').textContent = `${baseUrl}/sse`;

    // Status
    $('#connect-status-info').innerHTML = `
      <p>Port: ${info.port}</p>
      <p>Tunnel: ${info.tunnelEnabled ? 'Enabled' : 'Disabled'}</p>
      <p>MCP Token: ${info.mcpTokenConfigured ? 'Configured' : 'Not set (localhost only)'}</p>
    `;
  } catch (err) {
    console.error('Connect info load failed:', err);
  }
}

// --- Init ---
(async function init() {
  if (state.token) {
    try {
      const res = await api('GET', '/api/status');
      if (res.ok) {
        await enterDashboard();
        return;
      }
    } catch { /* token invalid */ }
  }
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.ok) {
      await enterDashboard();
      return;
    }
  } catch { /* needs auth */ }
  showScreen('login');
})();
