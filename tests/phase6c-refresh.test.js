import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { McpClientProvider } from '../providers/mcp-client.js';

function mockWm(workspaces = {}) {
  const audits = [];
  const errors = [];
  const map = new Map(Object.entries(workspaces));
  return {
    audits, errors,
    logAudit: (action, ws, details) => audits.push({ action, ws, details }),
    logError: (category, ws, message) => errors.push({ category, ws, message }),
    _getRawWorkspace: (id) => map.get(id) || null,
    _save: async () => {},
    getServerConfig: () => ({ port: 3100 }),
    _setWs: (id, ws) => map.set(id, ws),
  };
}

function makeWsWithTokens({ accessToken = 'AT', refreshToken = 'RT', expiresAt = null } = {}) {
  return {
    id: 'ws-1',
    oauth: {
      enabled: true,
      issuer: 'https://auth.example',
      clientId: 'cid',
      clientSecret: null,
      authMethod: 'none',
      resource: 'https://mcp.example/mcp',
      metadataCache: { token_endpoint: 'https://auth.example/token' },
      tokens: { accessToken, refreshToken, expiresAt, tokenType: 'Bearer' },
    },
  };
}

test('getValidAccessToken returns cached token when not expired', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const ws = makeWsWithTokens({ accessToken: 'FRESH', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const mgr = new OAuthManager(mockWm({ 'ws-1': ws }), { stateDir: dir, fetchImpl: async () => { throw new Error('should not fetch'); } });
    assert.equal(await mgr.getValidAccessToken('ws-1'), 'FRESH');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getValidAccessToken triggers refresh when within leeway window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const ws = makeWsWithTokens({ accessToken: 'OLD', refreshToken: 'RT_OLD', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const wm = mockWm({ 'ws-1': ws });
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls++;
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'RT_OLD');
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'NEW', refresh_token: 'RT_NEW', expires_in: 3600, token_type: 'Bearer' }) };
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    assert.equal(await mgr.getValidAccessToken('ws-1'), 'NEW');
    assert.equal(ws.oauth.tokens.refreshToken, 'RT_NEW', 'rotation should apply');
    assert.equal(calls, 1);
    assert.ok(wm.audits.some(a => a.action === 'oauth.refresh_success'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh without rotation preserves existing refresh_token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const ws = makeWsWithTokens({ refreshToken: 'RT_KEEP', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const mgr = new OAuthManager(mockWm({ 'ws-1': ws }), {
      stateDir: dir,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'NEW', expires_in: 3600, token_type: 'Bearer' }) }),
    });
    await mgr.forceRefresh('ws-1');
    assert.equal(ws.oauth.tokens.refreshToken, 'RT_KEEP');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent refresh calls serialize via FIFO chain (phase10a §6.4)', async () => {
  // Phase 10a Round 8: mutex semantics flipped from coalescing to FIFO chain
  // so that markAuthFailed ↔ refresh are mutually exclusive. Concurrent
  // refreshes are now serialized (not coalesced) — each call executes the
  // fetch, but they run one after another without racing.
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const ws = makeWsWithTokens({ refreshToken: 'RT', expiresAt: new Date(Date.now() - 1000).toISOString() });
    let calls = 0;
    let maxConcurrent = 0;
    let inFlight = 0;
    const fetchImpl = async () => {
      calls++;
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise(r => setTimeout(r, 30));
      inFlight--;
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'NEW', expires_in: 3600, token_type: 'Bearer' }) };
    };
    const mgr = new OAuthManager(mockWm({ 'ws-1': ws }), { stateDir: dir, fetchImpl });
    const [a, b, c] = await Promise.all([mgr.forceRefresh('ws-1'), mgr.forceRefresh('ws-1'), mgr.forceRefresh('ws-1')]);
    assert.equal(maxConcurrent, 1, 'FIFO chain must serialize — no concurrent token requests');
    assert.equal(calls, 3, 'FIFO chain executes each call sequentially (coalescing removed in Phase 10a)');
    assert.equal(a.accessToken, 'NEW');
    assert.equal(b.accessToken, 'NEW');
    assert.equal(c.accessToken, 'NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh_fail marks workspace action_needed and logs audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const ws = makeWsWithTokens({ refreshToken: 'RT', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const wm = mockWm({ 'ws-1': ws });
    const mgr = new OAuthManager(wm, {
      stateDir: dir,
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }),
    });
    await assert.rejects(() => mgr.forceRefresh('ws-1'));
    assert.equal(ws.oauthActionNeeded, true);
    assert.ok(wm.audits.some(a => a.action === 'oauth.refresh_fail'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('McpClientProvider injects Authorization header from tokenProvider', async () => {
  let captured;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = init.headers;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }),
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }),
    };
  };
  try {
    const provider = new McpClientProvider(
      { id: 'ws-1', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', headers: {} },
      { tokenProvider: async () => 'TOKEN.123' },
    );
    await provider._rpcHttp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(captured['Authorization'], 'Bearer TOKEN.123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('McpClientProvider retries once on 401 via onUnauthorized', async () => {
  let attempt = 0;
  let refreshCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    attempt++;
    if (attempt === 1) {
      return { ok: false, status: 401, headers: { get: () => 'application/json' }, text: async () => 'unauthorized' };
    }
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: init.body.includes('"id":1') ? 1 : 2, result: { ok: true } }),
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    };
  };
  try {
    const provider = new McpClientProvider(
      { id: 'ws-1', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', headers: {} },
      {
        tokenProvider: async () => 'T',
        onUnauthorized: async () => { refreshCalls++; },
      },
    );
    const res = await provider._rpcHttp('tools/list', {});
    assert.deepEqual(res, { ok: true });
    assert.equal(refreshCalls, 1);
    assert.equal(attempt, 2, 'one retry after refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refresh mutex timeout releases lock and propagates error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const ws = makeWsWithTokens({ refreshToken: 'RT', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const wm = mockWm({ 'ws-1': ws });
    const pendingFetches = [];
    const mgr = new OAuthManager(wm, {
      stateDir: dir,
      refreshTimeoutMs: 30,
      fetchImpl: () => {
        const p = new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, text: async () => '{"access_token":"late"}' }), 80);
        });
        pendingFetches.push(p);
        return p;
      },
    });
    const err = await mgr.forceRefresh('ws-1').catch(e => e);
    assert.equal(err.message, 'refresh_timeout');
    // Phase 10a §6.4: _refreshMutex renamed to _identityMutex (shared with markAuthFailed)
    assert.equal(mgr._identityMutex.size, 0, 'identity mutex must be cleared after timeout');
    assert.ok(wm.audits.some(a => a.action === 'oauth.refresh_fail'));
    // Drain pending fetches so the test doesn't leak timers into the runner
    await Promise.all(pendingFetches);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('McpClientProvider does not loop if 401 persists after refresh', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return { ok: false, status: 401, headers: { get: () => 'application/json' }, text: async () => 'unauthorized' }; };
  try {
    const provider = new McpClientProvider(
      { id: 'ws-1', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', headers: {} },
      { tokenProvider: async () => 'T', onUnauthorized: async () => {} },
    );
    await assert.rejects(() => provider._rpcHttp('tools/list', {}));
    assert.equal(attempts, 2, 'should stop at 1 retry');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
