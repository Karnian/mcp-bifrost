/**
 * Phase 10a — OAuth Client Isolation (§9 assertions)
 *
 * Covers the 32 success-criteria assertions from
 * docs/OAUTH_CLIENT_ISOLATION_PLAN.md §9. All assertions use the plan's
 * declared public API:
 *   - WorkspaceManager.getWorkspace(id)        (masked by default)
 *   - WorkspaceManager.getOAuthClient(id)      (§4.10a-4 new)
 *   - OAuthManager.forceRefresh(wsId, identity) (public wrapper)
 *   - OAuthManager.markAuthFailed(wsId, identity)
 *   - OAuthManager.registerClient({ workspaceId }) (§4.10a-1)
 *   - OAuthManager.removeClient(wsId)          (§4.10a-1)
 *   - McpClientProvider.getStreamStatus()      (§4.10a-4 new)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager, maskClientId } from '../server/oauth-manager.js';
import { McpClientProvider } from '../providers/mcp-client.js';
import { AuditLogger } from '../server/audit-logger.js';

// ────────────────────────────────────────────────────────────────────────
// Test fixtures

function mockWm(workspaces = {}) {
  const audits = [];
  const errors = [];
  const wm = {
    audits, errors,
    workspaces,
    _getRawWorkspace: (id) => workspaces[id] || null,
    getRawWorkspace: (id) => workspaces[id] || null,
    getServerConfig: () => ({ port: 3100 }),
    _save: async () => {},
    logAudit: (action, ws, details, identity) => audits.push({ action, ws, details, identity }),
    logError: (category, ws, message) => errors.push({ category, ws, message }),
  };
  return wm;
}

function makeWs(id, { clientId = 'CLIENT_' + id, refreshToken = 'RT_' + id, accessToken = 'AT_' + id } = {}) {
  return {
    id,
    kind: 'mcp-client',
    transport: 'http',
    url: 'https://mcp.example/mcp',
    oauth: {
      enabled: true,
      issuer: 'https://auth.example',
      client: {
        clientId,
        clientSecret: null,
        authMethod: 'none',
        source: 'dcr',
        registeredAt: new Date().toISOString(),
      },
      // legacy flat mirror (§3.4)
      clientId,
      clientSecret: null,
      authMethod: 'none',
      metadataCache: {
        token_endpoint: 'https://auth.example/token',
        authorization_endpoint: 'https://auth.example/authorize',
        registration_endpoint: 'https://auth.example/register',
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        tokenType: 'Bearer',
      },
      byIdentity: {
        default: {
          tokens: {
            accessToken,
            refreshToken,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tokenType: 'Bearer',
          },
        },
      },
    },
  };
}

function dcrStubFetch({ onRegister, onToken }) {
  let registerCalls = 0;
  let tokenCalls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/register')) {
      registerCalls++;
      return onRegister(init, registerCalls);
    }
    if (u.endsWith('/token')) {
      tokenCalls++;
      return onToken(init, tokenCalls);
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}), headers: { get: () => null } };
  };
  fetchImpl.getRegisterCalls = () => registerCalls;
  fetchImpl.getTokenCalls = () => tokenCalls;
  return fetchImpl;
}

// ────────────────────────────────────────────────────────────────────────
// §4.10a-1 — Workspace-scoped DCR cache

test('§4.10a-1: same issuer, two workspaces → different cache keys (no cross-talk)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const wsA = makeWs('ws-A');
    const wsB = makeWs('ws-B');
    const wm = mockWm({ 'ws-A': wsA, 'ws-B': wsB });
    let counter = 0;
    const fetchImpl = async () => ({
      ok: true, status: 201,
      headers: { get: () => null },
      json: async () => ({ client_id: `GENERATED_${++counter}`, client_secret: null }),
      text: async () => '',
    });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    const md = {
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none'],
    };
    const regA = await mgr.registerClient('https://auth.example', md, { workspaceId: 'ws-A', authMethod: 'none' });
    const regB = await mgr.registerClient('https://auth.example', md, { workspaceId: 'ws-B', authMethod: 'none' });
    assert.notEqual(regA.clientId, regB.clientId, 'each workspace must get a distinct clientId');
    // Cache should have both entries under scoped keys
    const rawCache = JSON.parse(await readFile(join(dir, 'oauth-issuer-cache.json'), 'utf-8'));
    const keyA = 'ws-A::https://auth.example::none';
    const keyB = 'ws-B::https://auth.example::none';
    assert.ok(rawCache[keyA], `cache must have key ${keyA}`);
    assert.ok(rawCache[keyB], `cache must have key ${keyB}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-1: removeClient purges all entries for a workspace + emits audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const wm = mockWm();
    const fetchImpl = async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ client_id: 'CID', client_secret: null }), text: async () => '' });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none'],
    }, { workspaceId: 'ws-purge', authMethod: 'none' });
    // Sanity: cache populated
    assert.ok((await mgr.getCachedClient('ws-purge', 'https://auth.example', 'none')), 'cache seeded');
    const removed = await mgr.removeClient('ws-purge');
    assert.equal(removed, 1);
    assert.equal(await mgr.getCachedClient('ws-purge', 'https://auth.example', 'none'), null, 'cache purged');
    assert.ok(wm.audits.some(a => a.action === 'oauth.cache_purge' && a.ws === 'ws-purge'), 'audit emitted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §4.10a-3 — DCR error classification

test('§4.10a-3: DCR 429 → throws DCR_RATE_LIMITED with retryAfterMs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return {
        ok: false, status: 429,
        headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '42' : null) },
        text: async () => 'rate limited',
        json: async () => ({}),
      };
    };
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl });
    const err = await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
    }, { workspaceId: 'ws-1', authMethod: 'none' }).catch(e => e);
    assert.equal(err.code, 'DCR_RATE_LIMITED');
    assert.equal(err.status, 429);
    assert.equal(typeof err.retryAfterMs, 'number');
    assert.equal(err.retryAfterMs, 42_000);
    assert.equal(calls, 1, '429 surfaces immediately without retry');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-3: DCR 4xx → DCR_REJECTED, no retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad request', json: async () => ({}) };
    };
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl });
    const err = await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
    }, { workspaceId: 'ws-1', authMethod: 'none' }).catch(e => e);
    assert.equal(err.code, 'DCR_REJECTED');
    assert.equal(err.status, 400);
    assert.equal(calls, 1, '4xx must not retry');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-3: DCR 5xx → DCR_TRANSIENT, 1 initial + 3 retries = 4 calls + backoff sequence', async () => {
  // Plan §4.10a-3: "3 retries with exponential backoff" = 4 total attempts,
  // with sleeps of 1s / 2s / 4s between retries (cap 5s). Codex Round 1 REVISE
  // flagged the previous 3-attempt implementation as mismatched with plan.
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'service unavailable', json: async () => ({}) };
    };
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl });
    // Record backoff invocations while keeping sleep itself instant for test speed.
    const sleepCalls = [];
    const originalBackoff = mgr._dcrBackoffMs.bind(mgr);
    mgr._sleep = async () => {};
    mgr._dcrBackoffMs = (n) => { const v = originalBackoff(n); sleepCalls.push({ attempt: n, ms: v }); return v; };
    const err = await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
    }, { workspaceId: 'ws-1', authMethod: 'none' }).catch(e => e);
    assert.equal(err.code, 'DCR_TRANSIENT');
    assert.equal(calls, 4, '5xx must issue 1 initial + 3 retries = 4 total fetch calls');
    assert.equal(sleepCalls.length, 3, 'backoff sleeps exactly 3 times');
    assert.deepEqual(sleepCalls.map(s => s.ms), [1000, 2000, 4000], 'exponential backoff 1s / 2s / 4s');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §4.10a-4 — 401 fail-fast + markAuthFailed + concurrency

test('§4.10a-4: markAuthFailed nulls default tokens + sets action_needed + emits threshold_trip audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const ws = makeWs('ws-1');
    const wm = mockWm({ 'ws-1': ws });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl: async () => ({ ok: false, status: 500 }) });
    await mgr.markAuthFailed('ws-1', 'default', { correlationId: 'cid-123' });
    assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, null);
    assert.equal(ws.oauth.tokens.accessToken, null, 'default mirrors legacy ws.oauth.tokens');
    assert.equal(ws.oauthActionNeededBy.default, true);
    assert.equal(ws.oauthActionNeeded, true, 'default identity must set root flag');
    const trip = wm.audits.find(a => a.action === 'oauth.threshold_trip' && a.ws === 'ws-1');
    assert.ok(trip, 'threshold_trip audit must be emitted');
    const details = JSON.parse(trip.details);
    assert.equal(typeof details.threshold, 'number');
    assert.equal(details.correlationId, 'cid-123');
    assert.equal(trip.identity, 'default');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-4: markAuthFailed for bot_ci leaves default tokens + legacy mirror untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const ws = makeWs('ws-1');
    ws.oauth.byIdentity.bot_ci = {
      tokens: { accessToken: 'AT_BOT', refreshToken: 'RT_BOT', expiresAt: new Date(Date.now() + 3600_000).toISOString(), tokenType: 'Bearer' },
    };
    const wm = mockWm({ 'ws-1': ws });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl: async () => ({ ok: false, status: 500 }) });
    await mgr.markAuthFailed('ws-1', 'bot_ci');
    // bot_ci nulled
    assert.equal(ws.oauth.byIdentity.bot_ci.tokens.accessToken, null);
    assert.equal(ws.oauthActionNeededBy.bot_ci, true);
    // default unaffected
    assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, 'AT_ws-1');
    assert.equal(ws.oauth.tokens.accessToken, 'AT_ws-1', 'legacy default mirror MUST NOT be touched by non-default identity');
    assert.notEqual(ws.oauthActionNeeded, true, 'root flag is default-only');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-4: refresh early-return after markAuthFailed (skipped + fetch POST 0)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const ws = makeWs('ws-1');
    // make token expired so forceRefresh wants to run
    ws.oauth.byIdentity.default.tokens.expiresAt = new Date(Date.now() - 1000).toISOString();
    ws.oauth.tokens.expiresAt = ws.oauth.byIdentity.default.tokens.expiresAt;
    const wm = mockWm({ 'ws-1': ws });
    let tokenCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/token')) tokenCalls++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'NEVER' }), headers: { get: () => null } };
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    await mgr.markAuthFailed('ws-1', 'default');
    const result = await mgr.forceRefresh('ws-1', 'default');
    assert.deepEqual(result, { skipped: true, reason: 'action_needed' });
    assert.equal(tokenCalls, 0, 'refresh must not hit token endpoint');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-4: concurrency — Promise.all([markAuthFailed, forceRefresh]) → action_needed sticks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const ws = makeWs('ws-1');
    ws.oauth.byIdentity.default.tokens.expiresAt = new Date(Date.now() - 1000).toISOString();
    ws.oauth.tokens.expiresAt = ws.oauth.byIdentity.default.tokens.expiresAt;
    const wm = mockWm({ 'ws-1': ws });
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'WOULD_REFRESH', expires_in: 3600 }), headers: { get: () => null } });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    // Fire both concurrently — any interleaving must end with action_needed=true
    const [r1, r2] = await Promise.allSettled([
      mgr.markAuthFailed('ws-1', 'default'),
      mgr.forceRefresh('ws-1', 'default'),
    ]);
    // Final state: action_needed always ends up true (either markAuthFailed won,
    // OR refresh ran first then markAuthFailed nulled the token right after).
    assert.equal(ws.oauthActionNeededBy.default, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §4.10a-2 — Static client priority + DCR fallback

test('§4.10a-2: cached static client reused — no DCR call on second registerClient', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const wm = mockWm();
    let registerCalls = 0;
    const fetchImpl = async () => {
      registerCalls++;
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ client_id: 'CID_NEW', client_secret: null }), text: async () => '' };
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    // First: manual register (simulates static pre-registered client)
    await mgr.registerManual({ workspaceId: 'ws-1', issuer: 'https://auth.example', clientId: 'CID_STATIC', authMethod: 'none' });
    // Second: registerClient with reuse=true → must hit cache, NOT DCR
    const md = {
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none'],
    };
    const r = await mgr.registerClient('https://auth.example', md, { workspaceId: 'ws-1', authMethod: 'none', reuse: true });
    assert.equal(r.clientId, 'CID_STATIC', 'must return cached manual client');
    assert.equal(r.cached, true);
    assert.equal(registerCalls, 0, 'DCR endpoint must not be called when cache hits');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-2: restart → OAuthManager fresh instance, ws.oauth.client reused, DCR 0 calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const ws = makeWs('ws-1');
    // Simulate restart — ws already has oauth.client persisted; but fresh OAuthManager
    // has empty _clientCache. Our flow: admin/routes.js reads ws.oauth.client.clientId,
    // skips registerClient call entirely → DCR 0 hits.
    // Here we verify by reading the admin path logic: if ws.oauth.client.clientId exists,
    // no registerClient is called (admin/routes.js line ~225: `if (!clientId || forceRegister)`).
    // So from OAuthManager POV, we just verify that when the nested block has clientId,
    // refresh flow reads it correctly.
    const wm = mockWm({ 'ws-1': ws });
    let tokenCalls = 0;
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/token')) {
        tokenCalls++;
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 3600, token_type: 'Bearer' }),
          headers: { get: () => null },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    // Force expiration + refresh
    ws.oauth.byIdentity.default.tokens.expiresAt = new Date(Date.now() - 1000).toISOString();
    ws.oauth.tokens.expiresAt = ws.oauth.byIdentity.default.tokens.expiresAt;
    const result = await mgr.forceRefresh('ws-1', 'default');
    assert.equal(result.accessToken, 'NEW_AT');
    assert.equal(tokenCalls, 1, 'only token refresh, no DCR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §4.10a-4 — getStreamStatus() public API

test('§4.10a-4: McpClientProvider.getStreamStatus() — stdio returns not_applicable', async () => {
  const provider = new McpClientProvider({ id: 'ws-stdio', kind: 'mcp-client', transport: 'stdio', command: 'echo' });
  assert.equal(provider.getStreamStatus(), 'not_applicable');
});

test('§4.10a-4: McpClientProvider.getStreamStatus() — http defaults to idle before stream starts', async () => {
  const provider = new McpClientProvider({ id: 'ws-http', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp' });
  assert.equal(provider.getStreamStatus(), 'idle');
});

test('§4.10a-4: getStreamStatus() transitions to stopped:auth_failed after N consecutive 401', async () => {
  const ws = { id: 'ws-1', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', headers: {} };
  // Spy fetch returns 401 forever
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    return {
      ok: false, status: 401,
      headers: { get: () => null },
      text: async () => 'unauthorized',
      json: async () => ({}),
      body: null,
    };
  };
  let markCalls = 0;
  try {
    const provider = new McpClientProvider(ws, {
      tokenProvider: async () => 'TOKEN',
      onUnauthorized: async () => { /* refresh always "succeeds" but next 401 repeats */ },
      onAuthFailed: async () => { markCalls++; },
      authFailThreshold: 3,
    });
    // Invoke _rpcHttp 3 times — each returns 401 and counts up.
    for (let i = 0; i < 3; i++) {
      try { await provider._rpcHttp('tools/list', {}); } catch { /* will throw once threshold hits */ }
    }
    assert.equal(provider.getStreamStatus(), 'stopped:auth_failed');
    assert.equal(markCalls, 1, 'onAuthFailed must be called exactly once on threshold trip');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('§4.10a-4: successful request resets 401 counter', async () => {
  const ws = { id: 'ws-1', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', headers: {} };
  let attempt = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    attempt++;
    // 1st call → 401. Refresh handler runs, then the retry path calls fetch again.
    // That 2nd call returns 200. Counter should reset to 0.
    if (attempt === 1) return { ok: false, status: 401, headers: { get: () => null }, text: async () => '' };
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: init.body.includes('"id":1') ? 1 : 2, result: { ok: true } }),
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    };
  };
  let markCalls = 0;
  try {
    const provider = new McpClientProvider(ws, {
      tokenProvider: async () => 'TOKEN',
      onUnauthorized: async () => { /* refresh */ },
      onAuthFailed: async () => { markCalls++; },
      authFailThreshold: 3,
    });
    await provider._rpcHttp('tools/list', {});
    assert.equal(provider._consecutive401Count.get('default'), 0, 'counter reset on 2xx');
    assert.equal(markCalls, 0, 'no threshold trip');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ────────────────────────────────────────────────────────────────────────
// §6-OBS.1 — Audit masking

test('§6-OBS.1: registerClient success → audit clientIdMasked format + no raw clientId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const wm = mockWm();
    const fetchImpl = async () => ({
      ok: true, status: 201,
      headers: { get: () => null },
      json: async () => ({ client_id: 'GN6tDPJbB40wd_ei', client_secret: null }), // Notion-like id with _
      text: async () => '',
    });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none'],
    }, { workspaceId: 'ws-1', authMethod: 'none' });
    const audit = wm.audits.find(a => a.action === 'oauth.client_registered');
    assert.ok(audit, 'oauth.client_registered must be emitted');
    const details = JSON.parse(audit.details);
    assert.equal(typeof details.clientIdMasked, 'string');
    // Format ^[a-zA-Z0-9_-]{4}\*{3}[a-zA-Z0-9_-]{4}$
    assert.match(details.clientIdMasked, /^[a-zA-Z0-9_-]{4}\*{3}[a-zA-Z0-9_-]{4}$/);
    assert.equal(details.clientIdMasked, 'GN6t***d_ei');
    assert.equal(details.clientId, undefined, 'raw clientId must NOT appear in audit');
    assert.equal(details.source, 'dcr');
    assert.equal(details.authMethod, 'none');
    assert.equal(details.issuer, 'https://auth.example');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§6-OBS.1: maskClientId format is stable', () => {
  assert.equal(maskClientId('GN6tDPJbB40wd_ei'), 'GN6t***d_ei');
  assert.equal(maskClientId(null), null);
  assert.equal(maskClientId('short'), '***');
  assert.equal(maskClientId('abcdefgh'), '***'); // len 8 → too short
  assert.equal(maskClientId('abcdefghi'), 'abcd***fghi');
});

// ────────────────────────────────────────────────────────────────────────
// §9 — Isolation (two Notion-like workspaces share issuer, different tokens)

test('§9 isolation: two workspaces with same issuer → different accessTokenPrefix after refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    // Load a real WorkspaceManager so the masked prefix API works end-to-end.
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const wm = new WorkspaceManager();
    wm.config = {
      workspaces: [
        makeWs('http-notion-A', { clientId: 'CID_A', refreshToken: 'RT_A', accessToken: 'AT_A_OLD' }),
        makeWs('http-notion-B', { clientId: 'CID_B', refreshToken: 'RT_B', accessToken: 'AT_B_OLD' }),
      ],
      server: { port: 3100 },
    };
    wm._loaded = false; // avoid any disk writes during the test
    // Force expiry on both
    for (const ws of wm.config.workspaces) {
      ws.oauth.byIdentity.default.tokens.expiresAt = new Date(Date.now() - 1000).toISOString();
      ws.oauth.tokens.expiresAt = ws.oauth.byIdentity.default.tokens.expiresAt;
    }
    // Each workspace gets its own new access token (distinct per-request via refresh_token)
    const fetchImpl = async (url, init) => {
      const body = init.body?.toString() || '';
      // Infer which workspace by the refresh_token sent
      if (body.includes('RT_A')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT_A_NEW_TOKEN_1234567890', refresh_token: 'RT_A_NEW', expires_in: 3600 }), headers: { get: () => null } };
      }
      if (body.includes('RT_B')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT_B_NEW_TOKEN_ABCDEFGHIJ', refresh_token: 'RT_B_NEW', expires_in: 3600 }), headers: { get: () => null } };
      }
      throw new Error('unexpected refresh body: ' + body);
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    wm.setOAuthManager(mgr);
    await mgr.forceRefresh('http-notion-A', 'default');
    await mgr.forceRefresh('http-notion-B', 'default');
    const a = wm.getWorkspace('http-notion-A');
    const b = wm.getWorkspace('http-notion-B');
    assert.notEqual(
      a.oauth.byIdentity.default.tokens.accessTokenPrefix,
      b.oauth.byIdentity.default.tokens.accessTokenPrefix,
      'refreshed access tokens must be distinct between workspaces',
    );
    // sanity: raw comparison
    const aRaw = wm.getWorkspace('http-notion-A', { masked: false });
    const bRaw = wm.getWorkspace('http-notion-B', { masked: false });
    assert.notEqual(aRaw.oauth.byIdentity.default.tokens.accessToken, bRaw.oauth.byIdentity.default.tokens.accessToken);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §9 — Cache purge (hard delete primary) + soft-delete retention

test('§9 cache purge: hard delete → getOAuthClient(null) + re-register hits DCR (calls === 1)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const wm = new WorkspaceManager();
    wm.config = {
      workspaces: [
        { id: 'ws-A', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', oauth: { enabled: true, issuer: 'https://auth.example', client: { clientId: 'OLD_CLIENT', authMethod: 'none', source: 'dcr', registeredAt: new Date().toISOString() }, clientId: 'OLD_CLIENT', authMethod: 'none' } },
      ],
      server: { port: 3100 },
    };
    wm._loaded = true; // allow save (we override _save)
    wm._save = async () => {}; // disable actual disk writes

    let registerCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/register')) {
        registerCalls++;
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ client_id: `NEW_CLIENT_${registerCalls}`, client_secret: null }), text: async () => '' };
      }
      return { ok: false, status: 404, headers: { get: () => null } };
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    wm.setOAuthManager(mgr);
    // Seed cache for ws-A
    await mgr._storeCachedClient('ws-A', 'https://auth.example', 'none', { clientId: 'OLD_CLIENT', authMethod: 'none', source: 'dcr' });

    // Hard delete
    await wm.deleteWorkspace('ws-A', { hard: true });
    assert.equal(wm.getOAuthClient('ws-A'), null, 'getOAuthClient must be null post hard-delete');

    // Re-create same id + register → must hit DCR (cache purged)
    wm.config.workspaces.push({ id: 'ws-A', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', oauth: { enabled: true, issuer: 'https://auth.example' } });
    const reg = await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none'],
    }, { workspaceId: 'ws-A', authMethod: 'none' });
    assert.equal(registerCalls, 1, 'DCR must be called exactly once after cache purge');
    assert.notEqual(reg.clientId, 'OLD_CLIENT', 'new DCR must issue a new clientId');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§9 soft delete retention: softDelete keeps cache; purgeExpiredWorkspaces removes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const wm = new WorkspaceManager();
    wm.config = {
      workspaces: [
        { id: 'ws-A', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', oauth: { enabled: true, issuer: 'https://auth.example', client: { clientId: 'CID_A', authMethod: 'none', source: 'dcr', registeredAt: new Date().toISOString() } } },
      ],
      server: { port: 3100 },
    };
    wm._loaded = true;
    wm._save = async () => {};
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl: async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ client_id: 'NEW' }), text: async () => '' }) });
    wm.setOAuthManager(mgr);
    await mgr._storeCachedClient('ws-A', 'https://auth.example', 'none', { clientId: 'CID_A', authMethod: 'none', source: 'dcr' });

    // Soft delete → cache retained (Option Y)
    await wm.deleteWorkspace('ws-A', { hard: false });
    assert.ok(await mgr.getCachedClient('ws-A', 'https://auth.example', 'none'), 'cache retained during soft delete');
    // getOAuthClient still returns the persisted client (deletedAt doesn't nuke the data)
    assert.ok(wm.getOAuthClient('ws-A'), 'getOAuthClient still returns client during soft-delete window');

    // Simulate 31 days elapsed via explicit `now` arg
    const future = Date.now() + 31 * 24 * 60 * 60 * 1000;
    const purged = await wm.purgeExpiredWorkspaces({ now: future });
    assert.equal(purged, 1, 'one workspace purged');
    assert.equal(await mgr.getCachedClient('ws-A', 'https://auth.example', 'none'), null, 'cache purged after expire');
    assert.equal(wm.getOAuthClient('ws-A'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §6-OBS Observability — correlationId + threshold details encoding

test('§6-OBS: oauth.threshold_trip details encoding includes correlationId, threshold, consecutiveCount', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const ws = makeWs('ws-1');
    const wm = mockWm({ 'ws-1': ws });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl: async () => ({ ok: false, status: 500 }) });
    await mgr.markAuthFailed('ws-1', 'default', { correlationId: 'abcd-1234', consecutiveCount: 3 });
    const trip = wm.audits.find(a => a.action === 'oauth.threshold_trip');
    const details = JSON.parse(trip.details);
    assert.equal(typeof details.threshold, 'number');
    assert.equal(details.consecutiveCount, 3);
    assert.equal(typeof details.correlationId, 'string');
    assert.equal(details.correlationId, 'abcd-1234');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §9 — Masked API (hasAccessToken after markAuthFailed)

test('§9 masked API: after markAuthFailed, hasAccessToken is false via getWorkspace()', async () => {
  const { WorkspaceManager } = await import('../server/workspace-manager.js');
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-'));
  try {
    const wm = new WorkspaceManager();
    wm.config = { workspaces: [makeWs('ws-1')], server: { port: 3100 } };
    wm._loaded = true;
    wm._save = async () => {};
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl: async () => ({ ok: false, status: 500 }) });
    wm.setOAuthManager(mgr);
    await mgr.markAuthFailed('ws-1', 'default');
    const got = wm.getWorkspace('ws-1');
    assert.equal(got.oauth.byIdentity.default.tokens.hasAccessToken, false, 'masked API reflects nulled token');
    assert.equal(got.oauth.tokens.hasAccessToken, false, 'legacy mirror also reflects nulled token');
    assert.equal(got.oauthActionNeededBy.default, true);
    assert.equal(got.oauthActionNeeded, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// §4.10a-1 getOAuthClient() — masked secret

test('§4.10a-1: workspace id "__global__" is reserved (Codex R1)', async () => {
  const { WorkspaceManager } = await import('../server/workspace-manager.js');
  const wm = new WorkspaceManager();
  wm._loaded = false;
  wm._save = async () => {};
  await assert.rejects(
    () => wm.addWorkspace({ id: '__global__', kind: 'native', provider: 'notion', displayName: 'x', alias: 'x' }),
    /__global__/,
  );
  await assert.rejects(
    () => wm.addWorkspace({ kind: 'native', provider: 'notion', displayName: 'x', alias: '__global__' }),
    /__global__/,
  );
});

test('§4.10a-4: getOAuthClient returns masked clientSecret (never raw)', async () => {
  const { WorkspaceManager } = await import('../server/workspace-manager.js');
  const wm = new WorkspaceManager();
  wm.config = {
    workspaces: [
      { id: 'ws-1', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp', oauth: {
        enabled: true,
        issuer: 'https://auth.example',
        client: { clientId: 'PUB_CID', clientSecret: 'SUPER_SECRET_VALUE', authMethod: 'client_secret_basic', source: 'manual', registeredAt: new Date().toISOString() },
      } },
    ],
    server: { port: 3100 },
  };
  const client = wm.getOAuthClient('ws-1');
  assert.equal(client.clientId, 'PUB_CID');
  assert.equal(client.clientSecret, '***', 'clientSecret must always be masked');
  assert.equal(client.authMethod, 'client_secret_basic');
  assert.equal(client.source, 'manual');
  assert.equal(wm.getOAuthClient('does-not-exist'), null);
});
