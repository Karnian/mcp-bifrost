/* Bifrost Admin SPA (Phase 5) */
import { TEMPLATES, materializeTemplate } from './templates.js';
import { guideFor, renderStaticClientBody } from './static-client-guides.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Phase 8e: Modal dialog (replaces window.prompt) ---
// Phase 11-9 §12-2: accepts an optional `bodyHtml` block rendered above
// the form so callers can inline provider-specific guidance (Notion
// integration link, copyable redirect URI, etc.) without spawning a
// second modal layer.
function bifrostModal({ title, fields, submitLabel = '확인', cancelLabel = '취소', bodyHtml = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'bifrost-modal-overlay';
    overlay.innerHTML = `
      <div class="bifrost-modal">
        <h3>${title}</h3>
        ${bodyHtml ? `<div class="bifrost-modal-body">${bodyHtml}</div>` : ''}
        <form class="bifrost-modal-form">
          ${fields.map((f, i) => `
            <label>${f.label}
              <input type="${f.type || 'text'}" name="f${i}" value="${f.value ?? ''}" placeholder="${f.placeholder || ''}" ${f.required ? 'required' : ''}>
            </label>
          `).join('')}
          <div class="bifrost-modal-actions">
            <button type="button" class="btn-cancel">${cancelLabel}</button>
            <button type="submit" class="btn-submit">${submitLabel}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    // Phase 11-9: wire up any copy-to-clipboard buttons embedded in
    // bodyHtml. Buttons must carry `data-copy-target="#selector"`. We
    // flash a "Copied" label so operators get feedback without leaving
    // the modal.
    overlay.querySelectorAll('[data-copy-target]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const sel = btn.getAttribute('data-copy-target');
        const target = overlay.querySelector(sel);
        if (!target) return;
        const text = target.textContent || target.value || '';
        try {
          await navigator.clipboard.writeText(text);
          const original = btn.textContent;
          btn.textContent = '복사됨';
          btn.disabled = true;
          setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
        } catch {
          // Codex R1 non-blocking: clipboard blocked (non-HTTPS / older
          // browser). `<code>` nodes have no .select(), so use the
          // selection range API to highlight the text instead — operator
          // can Cmd+C / Ctrl+C manually.
          try {
            const selection = window.getSelection?.();
            if (selection) {
              selection.removeAllRanges?.();
              selection.selectAllChildren?.(target);
            } else if (target.select) {
              target.select();
            }
          } catch { /* best-effort */ }
        }
      });
    });
    const form = overlay.querySelector('form');
    const firstInput = form.querySelector('input');
    if (firstInput) firstInput.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = fields.map((_, i) => form.elements[`f${i}`].value);
      overlay.remove();
      resolve(values);
    });
    overlay.querySelector('.btn-cancel').addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });
  });
}

// Phase 11-10 §2 — provider-specific static-client guidance moved to
// `./static-client-guides.js` so `guideFor` / `renderStaticClientBody`
// can be unit-tested from Node without a DOM. app.js imports them at
// the top of the file. The matching rule is now hostname exact-or-suffix
// (replacing the earlier substring match) so a workspace URL like
// `https://user-github.com.example` no longer shadows the GitHub guide.

const state = {
  token: sessionStorage.getItem('bifrost_token') || '',
  workspaces: [],
  currentDetail: null,
};

// --- API Helper ---
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
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

async function checkSecurityBanner() {
  try {
    const res = await api('GET', '/api/oauth/security');
    const el = $('#security-banner');
    if (!el) return;
    if (res.ok && res.data?.fileSecurityWarning) {
      el.textContent = `⚠️  ${res.data.platform === 'win32' ? 'Windows' : 'OS'}: 토큰 파일 권한(chmod 0600)이 적용되지 않았습니다. 공유 PC 사용을 자제하세요.`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  } catch { /* best-effort */ }
}

async function loadDashboard() {
  try {
    checkSecurityBanner().catch(() => {});
    const [wsRes, statusRes] = await Promise.all([
      api('GET', '/api/workspaces'),
      api('GET', '/api/status'),
    ]);
    state.workspaces = wsRes.data || [];
    renderWorkspaces();
    renderToolCount(statusRes.data);
    renderAttention();
    renderSessionCount(statusRes.data);
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
  grid.innerHTML = state.workspaces.map(ws => {
    const kindBadge = ws.kind === 'mcp-client'
      ? `<span class="ws-card-provider">MCP · ${ws.transport}</span>`
      : `<span class="ws-card-provider">${ws.provider}</span>`;
    return `
    <div class="ws-card" data-id="${ws.id}">
      <div class="ws-card-header">
        ${kindBadge}
        <span class="ws-card-name">${esc(ws.displayName)}</span>
        <span class="ws-card-status status-${ws.status}">
          <span class="status-dot"></span>
          <span class="status-label">${statusLabel(ws.status)}</span>
        </span>
      </div>
      <div class="ws-card-namespace">namespace: ${esc(ws.namespace)}</div>
    </div>`;
  }).join('');
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
  const problems = state.workspaces.filter(ws => ws.status === 'error' || ws.status === 'action_needed');
  if (problems.length === 0) { area.classList.add('hidden'); return; }
  area.classList.remove('hidden');
  area.innerHTML = problems.map(ws => {
    const icon = ws.status === 'error' ? 'red' : 'orange';
    const msg = ws.status === 'error' ? 'Connection error' : 'Action needed';
    return `<div class="attention-item" data-id="${ws.id}">
      <span class="status-dot" style="background:var(--${icon})"></span>
      <span>${esc(ws.displayName)}: ${msg}</span>
    </div>`;
  }).join('');
  area.querySelectorAll('.attention-item').forEach(item => {
    item.addEventListener('click', () => openDetail(item.dataset.id));
  });
}

const STATUS_LABELS = {
  healthy: 'Healthy', limited: 'Limited', action_needed: 'Action Needed',
  error: 'Error', disabled: 'Disabled', unknown: 'Checking...',
};
function statusLabel(status) { return STATUS_LABELS[status] || status; }

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}

// --- Workspace Detail (edit) ---
function renderOAuthPanel(ws) {
  const o = ws.oauth || {};
  // Phase 7c: prefer byIdentity map; merge legacy default tokens for display.
  const byIdRaw = o.byIdentity || {};
  const identityRows = {};
  for (const [name, entry] of Object.entries(byIdRaw)) {
    identityRows[name] = entry.tokens || {};
  }
  // Legacy fallback for default
  if (!identityRows.default && o.tokens) identityRows.default = o.tokens;
  if (Object.keys(identityRows).length === 0) identityRows.default = {};

  const now = new Date();
  const formatExp = (t) => {
    const exp = t?.expiresAt ? new Date(t.expiresAt) : null;
    return !exp ? '—'
      : exp.getTime() - now.getTime() < 0 ? '만료됨'
      : `${Math.round((exp.getTime() - now.getTime()) / 60000)}분 후`;
  };
  const formatLast = (t) => t?.lastRefreshAt
    ? `${Math.round((now.getTime() - new Date(t.lastRefreshAt).getTime()) / 60000)}분 전`
    : '—';

  const rows = Object.entries(identityRows).map(([name, t]) => `
    <tr>
      <td><code>${esc(name)}</code></td>
      <td>${t.hasAccessToken ? `<code>${esc(t.accessTokenPrefix || '***')}</code>` : '<em style="color:var(--text-secondary)">(미발급)</em>'}</td>
      <td>${formatExp(t)}</td>
      <td>${formatLast(t)}</td>
      <td><button type="button" class="btn btn-sm btn-outline" data-reauth-identity="${esc(name)}">Re-authorize</button></td>
    </tr>`).join('');

  // Phase 11 §3 — nested-only reads. The Phase 10a §3.4 flat-field mirror
  // (o.clientId / o.authMethod) is removed on disk and via maskOAuth, so
  // the UI consults only the nested `client` block.
  const client = o.client || {};
  const clientId = client.clientId || null;
  const authMethod = client.authMethod || 'none';
  const source = client.source || null;
  const sourceBadge = source === 'manual'
    ? '<span class="badge" style="background:#eab308;color:#422006;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">MANUAL</span>'
    : source === 'dcr'
      ? '<span class="badge" style="background:#22c55e;color:#052e16;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">DCR</span>'
      : source === 'legacy-flat'
        ? '<span class="badge" style="background:#94a3b8;color:#0f172a;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">LEGACY</span>'
        : '';

  return `
    <div class="oauth-panel" style="margin-top:16px;padding:14px;border:1px solid var(--border);border-radius:8px;background:rgba(59,130,246,0.06)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong>OAuth 2.0 (byIdentity)</strong>
        <button type="button" id="btn-add-identity" class="btn btn-sm btn-primary">+ Add identity</button>
      </div>
      <div style="display:grid;grid-template-columns:140px 1fr;gap:6px;font-size:13px;line-height:1.6;margin-bottom:12px">
        <span style="color:var(--text-secondary)">Issuer</span><span><code>${esc(o.issuer || '—')}</code></span>
        <span style="color:var(--text-secondary)">Client ID</span><span><code>${esc(clientId || '—')}</code> <em style="color:var(--text-secondary)">(${esc(authMethod)})</em> ${sourceBadge}</span>
      </div>
      <!-- Phase 10a §4.10a-5: OAuth client management actions -->
      <div style="margin-bottom:12px;padding:10px;background:rgba(15,23,42,0.04);border-radius:6px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" id="btn-oauth-reregister" class="btn btn-sm btn-outline" title="Force a fresh DCR registration (new client_id — requires re-authorize)">Re-register (DCR)</button>
        <button type="button" id="btn-oauth-manual-client" class="btn btn-sm btn-outline" title="Set a static/manual client_id (pre-registered on provider)">Use Manual Client</button>
        <span style="font-size:11px;color:var(--text-secondary);align-self:center;margin-left:auto">Re-register invalidates all tokens; identities must re-authorize.</span>
      </div>
      <table class="tools-table" style="width:100%">
        <thead><tr><th>Identity</th><th>Access token</th><th>Expires</th><th>Last refresh</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <!-- Legacy single-button anchor retained for Phase 6 behavior -->
      <button type="button" id="btn-reauthorize" class="hidden">_</button>
    </div>
  `;
}

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
  $('#detail-status').innerHTML = `<span class="ws-card-status status-${ws.status}"><span class="status-dot"></span><span class="status-label">${statusLabel(ws.status)}</span></span>`;

  // Transport/kind-specific edit fields
  const credDiv = $('#detail-cred-fields');
  if (ws.kind === 'mcp-client') {
    if (ws.transport === 'stdio') {
      credDiv.innerHTML = `
        <label>Command</label>
        <input type="text" id="detail-cmd-command" value="${esc(ws.command || '')}">
        <label>Args (comma-separated)</label>
        <input type="text" id="detail-cmd-args" value="${esc((ws.args || []).join(', '))}">
        <label>Env (one per line: KEY=value, empty to keep current)</label>
        <textarea id="detail-cmd-env" rows="3">${Object.entries(ws.env || {}).map(([k,v]) => `${k}=${v}`).join('\n')}</textarea>
      `;
    } else if (ws.transport === 'http' || ws.transport === 'sse') {
      if (ws.oauth?.enabled) {
        credDiv.innerHTML = `
          <label>URL</label>
          <input type="text" id="detail-http-url" value="${esc(ws.url || '')}" readonly>
          ${renderOAuthPanel(ws)}
        `;
      } else {
        credDiv.innerHTML = `
          <label>URL</label>
          <input type="text" id="detail-http-url" value="${esc(ws.url || '')}">
          <label>Headers (one per line: Header: value)</label>
          <textarea id="detail-http-headers" rows="3">${Object.entries(ws.headers || {}).map(([k,v]) => `${k}: ${v}`).join('\n')}</textarea>
        `;
      }
    }
  } else if (ws.provider === 'notion') {
    credDiv.innerHTML = `<label>Integration Token</label><input type="password" id="detail-cred-token" placeholder="${esc(ws.credentials?.token || 'ntn_...')}">`;
  } else if (ws.provider === 'slack') {
    credDiv.innerHTML = `
      <label>Bot Token</label>
      <input type="password" id="detail-cred-bottoken" placeholder="${esc(ws.credentials?.botToken || 'xoxb_...')}">
      <label>Team ID</label>
      <input type="text" id="detail-cred-teamid" value="${esc(ws.credentials?.teamId || '')}">`;
  }

  $('#detail-tools-list').innerHTML = `<p style="font-size:13px;color:var(--text-secondary)">MCP tool pattern: <code>${ws.provider}_${ws.namespace}__*</code></p>`;
  $('#detail-health-info').innerHTML = `<p>Status: ${statusLabel(ws.status)}</p>`;

  // Phase 7c — per-identity Re-authorize buttons
  document.querySelectorAll('[data-reauth-identity]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const identity = btn.dataset.reauthIdentity;
      const ok = await runOAuthFlow(ws.id, { identity });
      if (ok) await refreshDetailAfterOAuth(ws.id);
    });
  });
  const addId = $('#btn-add-identity');
  if (addId) {
    addId.addEventListener('click', async () => {
      const result = await bifrostModal({
        title: '새 Identity 추가',
        fields: [{ label: 'Identity 이름 (영숫자/_/-, 1~64자)', placeholder: 'e.g. bot_ci', required: true }],
      });
      if (!result) return;
      const identity = result[0];
      if (!identity || !/^[a-zA-Z0-9_\-.]{1,64}$/.test(identity)) {
        if (identity) alert('identity 이름 형식이 맞지 않습니다.');
        return;
      }
      const ok = await runOAuthFlow(ws.id, { identity });
      if (ok) await refreshDetailAfterOAuth(ws.id);
    });
  }
  // Legacy button (kept hidden for back-compat with Phase 6 event tests)
  const reauth = $('#btn-reauthorize');
  if (reauth) {
    reauth.addEventListener('click', async () => {
      const ok = await runOAuthFlow(ws.id);
      if (ok) await refreshDetailAfterOAuth(ws.id);
    });
  }
  // Phase 10a §4.10a-5 — OAuth client actions
  const reRegBtn = $('#btn-oauth-reregister');
  if (reRegBtn) {
    reRegBtn.addEventListener('click', async () => {
      if (!confirm('Force a new DCR registration? This invalidates all existing tokens — every identity will need to re-authorize.')) return;
      const res = await api('POST', `/api/workspaces/${encodeURIComponent(ws.id)}/oauth/register`, {});
      if (res.ok) {
        alert(`New client registered (source=${res.data?.source || 'dcr'}). Please re-authorize each identity.`);
        await refreshDetailAfterOAuth(ws.id);
      } else {
        alert(`Re-register failed: ${res.error?.message || 'unknown'}`);
      }
    });
  }
  const manualBtn = $('#btn-oauth-manual-client');
  if (manualBtn) {
    manualBtn.addEventListener('click', async () => {
      const result = await bifrostModal({
        title: 'Manual OAuth Client',
        fields: [
          { label: 'Client ID', placeholder: 'pre-registered client_id from provider', required: true },
          { label: 'Client Secret (optional)', placeholder: 'leave empty for public client', required: false, type: 'password' },
          { label: 'Auth method', placeholder: 'none | client_secret_basic | client_secret_post', required: false },
        ],
      });
      if (!result) return;
      const [clientId, clientSecret, authMethod] = result;
      if (!clientId) return;
      const payload = { clientId, clientSecret: clientSecret || null, authMethod: authMethod || 'none' };
      const res = await api('PUT', `/api/workspaces/${encodeURIComponent(ws.id)}/oauth/client`, payload);
      if (res.ok) {
        alert('Manual client configured. All identities must re-authorize.');
        await refreshDetailAfterOAuth(ws.id);
      } else {
        alert(`Manual client failed: ${res.error?.message || 'unknown'}`);
      }
    });
  }
}

async function refreshDetailAfterOAuth(wsId) {
  const wsRes = await api('GET', '/api/workspaces');
  state.workspaces = wsRes.data || [];
  const updated = state.workspaces.find(w => w.id === wsId);
  if (updated) { state.currentDetail = updated; openDetail(updated.id); }
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
    if (res.ok && res.data?.ok) info.innerHTML = `<p class="success-msg">Connection successful!</p>`;
    else info.innerHTML = `<p class="error-msg">Failed: ${esc(res.data?.message || res.error?.message)}</p>`;
    const wsRes = await api('GET', '/api/workspaces');
    state.workspaces = wsRes.data || [];
    const ws = state.workspaces.find(w => w.id === state.currentDetail.id);
    if (ws) { state.currentDetail = ws; openDetail(ws.id); }
  } catch (err) {
    $('#detail-health-info').innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
});

$('#btn-detail-save').addEventListener('click', async () => {
  if (!state.currentDetail) return;
  const ws = state.currentDetail;
  const body = {
    displayName: $('#detail-displayname').value.trim(),
    alias: $('#detail-alias').value.trim(),
    enabled: $('#detail-enabled').checked,
  };

  if (ws.kind === 'mcp-client') {
    if (ws.transport === 'stdio') {
      body.command = $('#detail-cmd-command').value.trim();
      body.args = $('#detail-cmd-args').value.split(',').map(s => s.trim()).filter(Boolean);
      const envText = $('#detail-cmd-env').value;
      body.env = {};
      envText.split('\n').forEach(line => {
        const [k, ...v] = line.split('=');
        if (k?.trim() && v.length) body.env[k.trim()] = v.join('=').trim();
      });
    } else {
      body.url = $('#detail-http-url').value.trim();
      const headerText = $('#detail-http-headers').value;
      body.headers = {};
      headerText.split('\n').forEach(line => {
        const colon = line.indexOf(':');
        if (colon > 0) body.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      });
    }
  } else {
    body.credentials = {};
    if (ws.provider === 'notion') {
      const t = $('#detail-cred-token')?.value.trim();
      if (t) body.credentials.token = t;
    } else if (ws.provider === 'slack') {
      const b = $('#detail-cred-bottoken')?.value.trim();
      const t = $('#detail-cred-teamid')?.value.trim();
      if (b) body.credentials.botToken = b;
      if (t) body.credentials.teamId = t;
    }
  }

  try {
    const res = await api('PUT', `/api/workspaces/${encodeURIComponent(ws.id)}`, body);
    if (res.ok) {
      const wsRes = await api('GET', '/api/workspaces');
      state.workspaces = wsRes.data || [];
      const updated = state.workspaces.find(w => w.id === ws.id);
      if (updated) openDetail(updated.id);
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

// --- Wizard ---
let wizardState = { step: 1, template: null, customTransport: null, values: {} };

function initWizard() {
  wizardState = { step: 1, template: null, customTransport: null, values: {} };
  renderTemplates();
  showWizardStep(1);
}

function renderTemplates(filter = '') {
  const grid = $('#wiz-templates');
  const list = TEMPLATES.filter(t => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
  });
  grid.innerHTML = list.map(t => `
    <div class="template-card ${t.legacy ? 'legacy' : ''}" data-id="${t.id}">
      <div class="tpl-head">
        <span class="tpl-icon">${t.icon}</span>
        <span class="tpl-name">${esc(t.name)}</span>
      </div>
      <div class="tpl-desc">${esc(t.description)}</div>
    </div>
  `).join('');
  grid.querySelectorAll('.template-card').forEach(c => {
    c.addEventListener('click', () => selectTemplate(c.dataset.id));
  });
}

$('#wiz-search').addEventListener('input', (e) => renderTemplates(e.target.value));

function selectTemplate(id) {
  wizardState.template = TEMPLATES.find(t => t.id === id);
  wizardState.customTransport = null;
  showStep2ForTemplate();
}

function showStep2ForTemplate() {
  const t = wizardState.template;
  $('#wiz-step2-title').textContent = t.name;
  $('#wiz-step2-desc').textContent = t.description;
  $('#wiz-displayname').value = t.name;
  $('#wiz-alias').value = '';
  const fieldsDiv = $('#wiz-dynamic-fields');
  const parts = [];
  for (const f of t.fields || []) {
    const type = f.secret ? 'password' : 'text';
    parts.push(`<label>${esc(f.label)}${f.required ? ' *' : ''}</label>
      <input type="${type}" id="wiz-field-${f.name}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>`);
  }
  for (const f of t.envFields || []) {
    const type = f.secret ? 'password' : 'text';
    parts.push(`<label>${esc(f.label)}${f.required ? ' *' : ''} <small>(env: ${f.name})</small></label>
      <input type="${type}" id="wiz-envfield-${f.name}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>`);
  }
  fieldsDiv.innerHTML = parts.join('');
  showWizardStep(2);
}

$$('[data-custom]').forEach(btn => {
  btn.addEventListener('click', () => {
    wizardState.template = null;
    wizardState.customTransport = btn.dataset.custom;
    showStep2ForCustom();
  });
});

function showStep2ForCustom() {
  const t = wizardState.customTransport;
  $('#wiz-step2-title').textContent = `직접 설정 (${t})`;
  $('#wiz-step2-desc').textContent = '임의 MCP 서버 연결';
  $('#wiz-displayname').value = '';
  $('#wiz-alias').value = '';
  const fieldsDiv = $('#wiz-dynamic-fields');
  if (t === 'stdio') {
    fieldsDiv.innerHTML = `
      <label>Command *</label>
      <input type="text" id="wiz-custom-command" placeholder="npx" required>
      <label>Args (comma-separated)</label>
      <input type="text" id="wiz-custom-args" placeholder="-y, @modelcontextprotocol/server-filesystem, /path">
      <label>Env (one per line: KEY=value)</label>
      <textarea id="wiz-custom-env" rows="3"></textarea>
    `;
  } else {
    fieldsDiv.innerHTML = `
      <label>URL *</label>
      <input type="text" id="wiz-custom-url" placeholder="https://example.com/mcp" required>
      <label>Headers (one per line: Header: value)</label>
      <textarea id="wiz-custom-headers" rows="3"></textarea>
    `;
  }
  showWizardStep(2);
}

$('#wiz-back-to-1').addEventListener('click', () => showWizardStep(1));

function showWizardStep(step) {
  wizardState.step = step;
  for (let i = 1; i <= 4; i++) {
    $(`#wizard-step-${i}`).classList.toggle('hidden', i !== step);
  }
}

$('.wiz-next-2').addEventListener('click', async () => {
  const err = $('#wiz-form-error');
  err.classList.add('hidden');

  let payload;
  const displayName = $('#wiz-displayname').value.trim() || 'New Workspace';

  if (wizardState.template) {
    const t = wizardState.template;
    const values = { displayName };
    for (const f of t.fields || []) {
      values[f.name] = $(`#wiz-field-${f.name}`)?.value.trim();
      if (f.required && !values[f.name]) {
        err.textContent = `${f.label} is required`;
        err.classList.remove('hidden');
        return;
      }
    }
    for (const f of t.envFields || []) {
      values[f.name] = $(`#wiz-envfield-${f.name}`)?.value.trim();
      if (f.required && !values[f.name]) {
        err.textContent = `${f.label} is required`;
        err.classList.remove('hidden');
        return;
      }
    }
    payload = materializeTemplate(t, values);
  } else if (wizardState.customTransport === 'stdio') {
    const command = $('#wiz-custom-command').value.trim();
    if (!command) { err.textContent = 'Command is required'; err.classList.remove('hidden'); return; }
    const args = $('#wiz-custom-args').value.split(',').map(s => s.trim()).filter(Boolean);
    const envText = $('#wiz-custom-env').value;
    const env = {};
    envText.split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k?.trim() && v.length) env[k.trim()] = v.join('=').trim();
    });
    payload = { kind: 'mcp-client', transport: 'stdio', displayName, command, args, env };
  } else {
    const url = $('#wiz-custom-url').value.trim();
    if (!url) { err.textContent = 'URL is required'; err.classList.remove('hidden'); return; }
    const headerText = $('#wiz-custom-headers').value;
    const headers = {};
    headerText.split('\n').forEach(line => {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    });
    payload = { kind: 'mcp-client', transport: wizardState.customTransport, displayName, url, headers };
  }

  const alias = $('#wiz-alias').value.trim();
  if (alias) payload.alias = alias;

  showWizardStep(3);
  await runWizardTest(payload);
});

async function runWizardTest(payload) {
  for (const id of ['wiz-ts-validate', 'wiz-ts-capability', 'wiz-ts-sample']) {
    $(`#${id} .test-icon`).textContent = '...';
    $(`#${id} .test-icon`).className = 'test-icon';
  }
  $('#wiz-test-result').classList.add('hidden');
  $('.wiz-next-3').disabled = true;

  let id;
  try {
    const res = await api('POST', '/api/workspaces', payload);
    if (!res.ok) { setTestStep('wiz-ts-validate', false, res.error?.message); return; }
    id = res.data.id;
    setTestStep('wiz-ts-validate', true);
  } catch (err) {
    setTestStep('wiz-ts-validate', false, err.message);
    return;
  }

  // OAuth path: skip capability/sample until authorized
  if (payload.oauth?.enabled) {
    setTestStep('wiz-ts-capability', true, 'OAuth 필요');
    const authorized = await runOAuthFlow(id);
    if (!authorized) {
      setTestStep('wiz-ts-sample', false, 'Authorization 취소됨');
      return;
    }
    try {
      const t = await api('POST', `/api/workspaces/${encodeURIComponent(id)}/test`);
      if (t.ok && t.data?.ok) setTestStep('wiz-ts-sample', true, 'Connected');
      else setTestStep('wiz-ts-sample', false, t.data?.message);
    } catch (err) { setTestStep('wiz-ts-sample', false, err.message); }
    $('.wiz-next-3').disabled = false;
    wizardState.createdId = id;
    return;
  }

  try {
    const t = await api('POST', `/api/workspaces/${encodeURIComponent(id)}/test`);
    if (t.ok && t.data?.ok) setTestStep('wiz-ts-capability', true);
    else setTestStep('wiz-ts-capability', false, t.data?.message);
  } catch { setTestStep('wiz-ts-capability', false, 'Test failed'); }

  setTestStep('wiz-ts-sample', true, 'Discovered tools');
  $('.wiz-next-3').disabled = false;
  wizardState.createdId = id;
}

async function runOAuthFlow(wsId, { identity = 'default' } = {}) {
  try {
    let res = await api('POST', `/api/workspaces/${encodeURIComponent(wsId)}/authorize`, { identity });
    // Phase 7d: if DCR is unsupported, prompt for a manual client_id and retry.
    // Phase 11-9 §12-2: enrich the prompt with a provider-specific guide
    // + copyable redirect URI so operators don't have to dig through docs.
    if (!res.ok && res.error?.code === 'DCR_UNSUPPORTED') {
      // Codex R1 non-blocking: UX-enrichment fetches must NOT abort the
      // manual prompt on failure. If either call rejects, degrade to
      // `null` and show the plain 3-field form — better than blocking
      // the whole OAuth flow on an admin API hiccup.
      const [wsRes, redirectRes] = await Promise.all([
        api('GET', `/api/workspaces/${encodeURIComponent(wsId)}`).catch(() => null),
        api('GET', '/api/oauth/redirect-uri').catch(() => null),
      ]);
      const manual = await promptManualClientCreds({
        workspaceUrl: wsRes?.data?.url || null,
        redirectUri: redirectRes?.data?.redirectUri || null,
      });
      if (!manual) return false;
      res = await api('POST', `/api/workspaces/${encodeURIComponent(wsId)}/authorize`, { identity, manual });
    }
    if (!res.ok) {
      alert(`OAuth 초기화 실패: ${res.error?.message || 'unknown'}\n\nDCR 미지원 서버인 경우 Admin API 로 수동 client_id 를 등록하세요.`);
      return false;
    }
    const { authorizationUrl } = res.data;
    const popup = window.open(authorizationUrl, 'bifrost-oauth', 'width=560,height=760');
    if (!popup) {
      alert(`팝업이 차단되었습니다. 다음 URL 을 직접 열어주세요:\n\n${authorizationUrl}`);
      return false;
    }
    // Poll workspace state until tokens arrive or timeout (5 min)
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      if (popup.closed) {
        // grace: check once more
      }
      const wsRes = await api('GET', `/api/workspaces/${encodeURIComponent(wsId)}`);
      // Phase 7c: check byIdentity[identity] (falls back to legacy tokens for default)
      const byId = wsRes.ok ? wsRes.data?.oauth?.byIdentity?.[identity]?.tokens : null;
      const legacy = identity === 'default' ? wsRes.data?.oauth?.tokens : null;
      if ((byId?.hasAccessToken) || (legacy?.hasAccessToken)) {
        try { popup.close(); } catch {}
        return true;
      }
      if (popup.closed) return false;
    }
    try { popup.close(); } catch {}
    return false;
  } catch (err) {
    alert(`OAuth flow 오류: ${err.message}`);
    return false;
  }
}

/**
 * Phase 7d — Prompt the user for a manually-issued OAuth client when the
 * MCP server does not support Dynamic Client Registration (RFC 7591).
 *
 * Phase 11-9 §12-2 — accepts an optional context so the modal can show
 * provider-specific setup guidance (Notion / GitHub integration consoles)
 * alongside a copyable redirect URI. The static wizard copy reduces
 * round-trips between Bifrost and the provider's docs.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.workspaceUrl] — MCP server URL, used to pick the
 *   right provider guide (notion.com → Notion, github.com → GitHub).
 * @param {string} [ctx.redirectUri] — redirect URI to register in the
 *   provider console. Rendered with a copy-to-clipboard button.
 * @returns {Promise<{clientId,clientSecret,authMethod}|null>}
 */
async function promptManualClientCreds(ctx = {}) {
  const guide = guideFor(ctx.workspaceUrl);
  const bodyHtml = renderStaticClientBody({
    redirectUri: ctx.redirectUri || null,
    guide,
    esc,
  });
  const title = guide
    ? `${guide.label} OAuth Client 직접 등록`
    : 'DCR 미지원 — 수동 OAuth Client 입력';
  const result = await bifrostModal({
    title,
    bodyHtml,
    fields: [
      { label: 'Client ID (필수)', placeholder: 'client_id', required: true },
      { label: 'Client Secret (public client 는 빈값)', placeholder: '' },
      { label: 'Auth Method', placeholder: 'none / client_secret_basic / client_secret_post', value: 'none' },
    ],
    submitLabel: '등록',
  });
  if (!result || !result[0]) return null;
  const clientId = result[0].trim();
  const clientSecret = (result[1] || '').trim() || null;
  const authMethodRaw = result[2] || '';
  const authMethod = ['none', 'client_secret_basic', 'client_secret_post'].includes(authMethodRaw)
    ? authMethodRaw : (clientSecret ? 'client_secret_basic' : 'none');
  return { clientId, clientSecret, authMethod };
}

function setTestStep(id, ok, msg) {
  const icon = $(`#${id} .test-icon`);
  icon.textContent = ok ? 'OK' : 'X';
  icon.className = `test-icon ${ok ? 'pass' : 'fail'}`;
  if (msg) {
    const span = $(`#${id}`).querySelectorAll('span')[1];
    if (span && !span.textContent.includes('—')) span.textContent += ` — ${msg}`;
  }
}

$('.wiz-next-3').addEventListener('click', async () => {
  showWizardStep(4);
  const id = wizardState.createdId;
  const wsRes = await api('GET', '/api/workspaces');
  const ws = (wsRes.data || []).find(w => w.id === id);
  const summary = ws
    ? `<p><strong>Workspace:</strong> ${esc(ws.displayName)}</p>
       <p><strong>Kind:</strong> ${ws.kind}${ws.transport ? ' / ' + ws.transport : ''}</p>
       <p><strong>MCP tools:</strong> <code>${ws.provider}_${ws.namespace}__*</code></p>`
    : '<p>Saved.</p>';
  $('#wiz-summary').innerHTML = summary;
});

$('#wiz-add-another').addEventListener('click', () => initWizard());
$('#wiz-go-dashboard').addEventListener('click', async () => await enterDashboard());
$('#wiz-skip').addEventListener('click', async () => await enterDashboard());

// --- Dashboard Add button → Wizard ---
$('#btn-add-ws').addEventListener('click', () => {
  showScreen('wizard');
  initWizard();
});
$('#btn-add-ws-empty')?.addEventListener('click', () => {
  showScreen('wizard');
  initWizard();
});

// --- Test All ---
$('#btn-test-all').addEventListener('click', async () => {
  try { await api('POST', '/api/workspaces/test-all'); await loadDashboard(); }
  catch (err) { console.error('Test all failed:', err); }
});

// --- Delete confirmation ---
let pendingDeleteId = null;
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
    state.currentDetail = null;
    await enterDashboard();
  } catch (err) { console.error('Delete failed:', err); }
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
  } catch (err) { console.error('Tools load failed:', err); }
}

function renderToolsTable(tools) {
  const tbody = $('#tools-tbody');
  tbody.innerHTML = tools.map(t => {
    const ws = state.workspaces.find(w => w.id === t.workspace);
    const kind = ws?.kind === 'mcp-client' ? `mcp/${ws.transport}` : (ws?.provider || 'bifrost');
    return `<tr>
      <td>${esc(kind)}</td>
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

// --- Tokens (Phase 7b) ---
$('#btn-nav-tokens').addEventListener('click', async () => {
  showScreen('tokens');
  await loadTokensView();
});
$('#btn-back-from-tokens').addEventListener('click', async () => await enterDashboard());

async function loadTokensView() {
  try {
    const res = await api('GET', '/api/tokens');
    const tokens = res.data || [];
    const tbody = $('#tokens-tbody');
    const hasLegacy = tokens.some(t => t.source === 'env-legacy');
    $('#tokens-legacy-banner').classList.toggle('hidden', !hasLegacy);
    tbody.innerHTML = tokens.map(t => {
      const isPersisted = t.source === 'persisted';
      return `<tr>
        <td><code>${esc(t.id)}</code></td>
        <td>${esc(t.description || '')}</td>
        <td>${esc((t.allowedWorkspaces || []).join(', '))}</td>
        <td>${esc((t.allowedProfiles || []).join(', '))}</td>
        <td>${esc(t.source)}</td>
        <td>${t.hashed ? '✓ scrypt' : '<span style="color:#f59e0b">⚠ plaintext</span>'}</td>
        <td>${esc(t.createdAt || '-')}</td>
        <td>${esc(t.lastUsedAt || '-')}</td>
        <td>
          ${isPersisted ? `
            <button class="btn btn-sm btn-outline" data-rotate="${esc(t.id)}">Rotate</button>
            <button class="btn btn-sm btn-danger" data-revoke="${esc(t.id)}">Revoke</button>
          ` : '<span style="color:#64748b">환경변수</span>'}
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="9" style="text-align:center;color:#64748b;padding:20px">No tokens configured.</td></tr>';

    tbody.querySelectorAll('[data-rotate]').forEach(btn => {
      btn.addEventListener('click', () => rotateToken(btn.dataset.rotate));
    });
    tbody.querySelectorAll('[data-revoke]').forEach(btn => {
      btn.addEventListener('click', () => revokeToken(btn.dataset.revoke));
    });
  } catch (err) { console.error('Tokens load failed:', err); }
}

function showPlaintextBanner(plaintext) {
  $('#tokens-plaintext-value').textContent = plaintext;
  $('#tokens-plaintext-banner').classList.remove('hidden');
}
$('#tokens-plaintext-dismiss')?.addEventListener('click', () => {
  $('#tokens-plaintext-value').textContent = '';
  $('#tokens-plaintext-banner').classList.add('hidden');
});
$('#tokens-plaintext-copy')?.addEventListener('click', () => {
  const v = $('#tokens-plaintext-value').textContent;
  navigator.clipboard?.writeText(v).catch(() => {});
});

$('#btn-issue-token').addEventListener('click', async () => {
  const result = await bifrostModal({
    title: 'MCP 토큰 발급',
    fields: [
      { label: 'Token ID (공백은 자동 생성)', placeholder: 'tok_...' },
      { label: '설명 (선택)', placeholder: '' },
      { label: 'Allowed Workspaces (글롭, 콤마 구분)', placeholder: '*', value: '*' },
      { label: 'Allowed Profiles (글롭, 콤마 구분)', placeholder: '*', value: '*' },
    ],
    submitLabel: '발급',
  });
  if (!result) return;
  const [id, description, wsGlob, profGlob] = result;
  try {
    const body = {
      description: description || '',
      allowedWorkspaces: (wsGlob || '*').split(',').map(s => s.trim()).filter(Boolean),
      allowedProfiles: (profGlob || '*').split(',').map(s => s.trim()).filter(Boolean),
    };
    if (id?.trim()) body.id = id.trim();
    const res = await api('POST', '/api/tokens', body);
    if (res.ok) {
      showPlaintextBanner(res.data.plaintext);
      await loadTokensView();
    } else {
      alert(`발급 실패: ${res.error?.message}`);
    }
  } catch (err) { alert(`발급 실패: ${err.message}`); }
});

async function rotateToken(id) {
  if (!confirm(`토큰 '${id}' 를 rotate 하시겠습니까? 기존 plaintext 는 즉시 무효화됩니다.`)) return;
  try {
    const res = await api('POST', `/api/tokens/${encodeURIComponent(id)}/rotate`);
    if (res.ok) {
      showPlaintextBanner(res.data.plaintext);
      await loadTokensView();
    } else alert(`rotate 실패: ${res.error?.message}`);
  } catch (err) { alert(`rotate 실패: ${err.message}`); }
}

async function revokeToken(id) {
  if (!confirm(`토큰 '${id}' 를 영구 삭제하시겠습니까?`)) return;
  try {
    const res = await api('DELETE', `/api/tokens/${encodeURIComponent(id)}`);
    if (res.ok) await loadTokensView();
    else alert(`revoke 실패: ${res.error?.message}`);
  } catch (err) { alert(`revoke 실패: ${err.message}`); }
}

// --- Profiles (Phase 7a) ---
$('#btn-nav-profiles').addEventListener('click', async () => {
  showScreen('profiles');
  await loadProfilesView();
});
$('#btn-back-from-profiles').addEventListener('click', async () => await enterDashboard());

async function loadProfilesView() {
  try {
    const res = await api('GET', '/api/profiles');
    const profiles = res.data?.profiles || {};
    const preview = res.data?.preview || {};
    $('#profiles-editor').value = JSON.stringify(profiles, null, 2);
    const previewEl = $('#profiles-preview');
    previewEl.innerHTML = Object.keys(profiles).length
      ? `<h4>Preview</h4>` + Object.entries(preview).map(([name, p]) =>
          `<div style="margin:8px 0;padding:10px;background:#1e293b;border-radius:6px">
             <strong>${esc(name)}</strong> — ${p.toolCount} tools
             <div style="color:#94a3b8;font-size:12px;margin-top:4px">${esc(p.sampleTools.join(', '))}${p.toolCount > 5 ? ' …' : ''}</div>
           </div>`
        ).join('')
      : '<p style="color:#64748b">No profiles defined. Add one in the editor above.</p>';
  } catch (err) { console.error('Profiles load failed:', err); }
}

$('#btn-save-profiles').addEventListener('click', async () => {
  let parsed;
  try { parsed = JSON.parse($('#profiles-editor').value || '{}'); }
  catch (e) { alert(`JSON 파싱 실패: ${e.message}`); return; }
  try {
    const res = await api('PUT', '/api/profiles', parsed);
    if (res.ok) {
      alert('프로필이 저장되었습니다.');
      await loadProfilesView();
    } else {
      alert(`저장 실패: ${res.error?.message}`);
    }
  } catch (err) { alert(`저장 실패: ${err.message}`); }
});

// --- Usage (Phase 7g) ---
$('#btn-nav-usage').addEventListener('click', async () => {
  showScreen('usage');
  await loadUsage();
});
$('#btn-back-from-usage').addEventListener('click', async () => await enterDashboard());
$('#usage-since').addEventListener('change', loadUsage);

async function loadUsage() {
  const since = $('#usage-since').value;
  try {
    const res = await api('GET', `/api/usage?since=${since}`);
    const data = res.data || {};
    const renderList = (title, rows, keyLabel) => `
      <h4>${title}</h4>
      <table class="tools-table" style="margin-bottom:24px">
        <thead><tr><th>${keyLabel}</th><th>Count</th><th>Avg latency</th><th>Errors</th><th>Last</th></tr></thead>
        <tbody>
          ${(rows || []).map(r => `<tr>
            <td><code>${esc(r.key)}</code></td>
            <td>${r.count}</td>
            <td>${r.avgMs}ms</td>
            <td>${r.errors} (${(r.errorRate * 100).toFixed(1)}%)</td>
            <td>${esc(r.lastAt || '-')}</td>
          </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#64748b">No data.</td></tr>'}
        </tbody>
      </table>`;
    $('#usage-content').innerHTML =
      renderList('Top 10 Tools', data.topTools, 'Tool') +
      renderList('Top 5 Identities (tokens)', data.topIdentities, 'Identity') +
      renderList('Top 10 Workspaces', data.topWorkspaces, 'Workspace');
  } catch (err) { console.error('Usage load failed:', err); }
}

// --- Audit (Phase 7g) ---
$('#btn-nav-audit').addEventListener('click', async () => {
  showScreen('audit');
  await loadAudit();
});
$('#btn-back-from-audit').addEventListener('click', async () => await enterDashboard());
$('#btn-audit-refresh').addEventListener('click', loadAudit);

async function loadAudit() {
  const params = new URLSearchParams();
  const action = $('#audit-action').value.trim();
  const identity = $('#audit-identity').value.trim();
  const workspace = $('#audit-workspace').value.trim();
  if (action) params.set('action', action);
  if (identity) params.set('identity', identity);
  if (workspace) params.set('workspace', workspace);
  params.set('limit', '200');
  try {
    const res = await api('GET', `/api/audit?${params.toString()}`);
    const rows = res.data || [];
    $('#audit-tbody').innerHTML = rows.map(r => `<tr>
      <td>${esc(r.t)}</td>
      <td><code>${esc(r.action)}</code></td>
      <td>${esc(r.identity || '-')}</td>
      <td>${esc(r.workspace || '-')}</td>
      <td style="max-width:480px;word-break:break-all;font-size:12px">${esc(r.details || '')}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px">No matching audit entries.</td></tr>';
  } catch (err) { console.error('Audit load failed:', err); }
}

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
    if (target) navigator.clipboard.writeText(target.textContent).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });
});

async function loadConnectGuide() {
  try {
    const res = await api('GET', '/api/connect-info');
    const info = res.data || {};
    const baseUrl = info.tunnelUrl ? `https://${info.tunnelUrl}` : `http://localhost:${info.port}`;
    $('#connect-claudeai-url').textContent = `${baseUrl}/sse`;
    const mcpJson = {
      mcpServers: {
        bifrost: {
          url: `${baseUrl}/mcp`,
          ...(info.mcpTokenConfigured ? { headers: { Authorization: 'Bearer <BIFROST_MCP_TOKEN>' } } : {}),
        },
      },
    };
    $('#connect-mcp-json').textContent = JSON.stringify(mcpJson, null, 2);
    $('#connect-mcp-url').textContent = `${baseUrl}/mcp`;
    $('#connect-sse-url').textContent = `${baseUrl}/sse`;
    $('#connect-status-info').innerHTML = `
      <p>Port: ${info.port}</p>
      <p>Tunnel: ${info.tunnelEnabled ? 'Enabled' : 'Disabled'}</p>
      <p>MCP Token: ${info.mcpTokenConfigured ? 'Configured' : 'Not set (open mode)'}</p>
    `;
  } catch (err) { console.error('Connect info load failed:', err); }
}

// --- Init ---
(async function init() {
  if (state.token) {
    try {
      const res = await api('GET', '/api/status');
      if (res.ok) { await enterDashboard(); return; }
    } catch { /* token invalid */ }
  }
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.ok) { await enterDashboard(); return; }
  } catch { /* needs auth */ }
  showScreen('login');
})();
