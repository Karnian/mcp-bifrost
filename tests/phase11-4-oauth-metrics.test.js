/**
 * Phase 11-4 §6-OBS.2 — OAuthMetrics recorder integration
 *
 * Covers:
 *   - OAuthMetrics unit (inc, snapshot shape, stable label keys, nullish
 *     label drop, delta validation, reset).
 *   - dcrStatusBucket helper.
 *   - OAuthManager instrumentation:
 *       oauth_cache_hit_total / oauth_cache_miss_total
 *       oauth_dcr_total { status: 200|4xx|5xx|429 }
 *       oauth_threshold_trip_total { workspace, identity }
 *       oauth_refresh_total { status: ok|fail_4xx|fail_net }
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { OAuthMetrics, dcrStatusBucket } from '../server/oauth-metrics.js';

// ────────────────────────────────────────────────────────────────────────
// Fixtures (kept local — we don't reuse phase10a makeWs so the assertions
// here stay decoupled from that test's evolution).

function mockWm(workspaces = {}) {
  return {
    workspaces,
    _getRawWorkspace: (id) => workspaces[id] || null,
    getRawWorkspace: (id) => workspaces[id] || null,
    getServerConfig: () => ({ port: 3100 }),
    _save: async () => {},
    logAudit: () => {},
    logError: () => {},
  };
}

function makeOAuthWs(id, { expired = false, refreshToken = 'RT_' + id } = {}) {
  const expiresAt = new Date(Date.now() + (expired ? -1000 : 3600_000)).toISOString();
  return {
    id,
    kind: 'mcp-client',
    transport: 'http',
    url: 'https://mcp.example/mcp',
    oauth: {
      enabled: true,
      issuer: 'https://auth.example',
      client: { clientId: 'CID', clientSecret: null, authMethod: 'none', source: 'dcr', registeredAt: new Date().toISOString() },
      metadataCache: { token_endpoint: 'https://auth.example/token', authorization_endpoint: 'https://auth.example/authorize' },
      tokens: { accessToken: 'AT_' + id, refreshToken, expiresAt, tokenType: 'Bearer' },
      byIdentity: {
        default: { tokens: { accessToken: 'AT_' + id, refreshToken, expiresAt, tokenType: 'Bearer' } },
      },
    },
  };
}

function findCounter(snapshot, name, labelMatcher) {
  return snapshot.find(c => c.name === name && Object.entries(labelMatcher).every(([k, v]) => c.labels[k] === String(v)));
}

// ────────────────────────────────────────────────────────────────────────
// OAuthMetrics unit

test('OAuthMetrics.inc: first call seeds counter with delta=1 by default', () => {
  const m = new OAuthMetrics();
  m.inc('oauth_cache_hit_total', { workspace: 'ws-1' });
  const snap = m.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].name, 'oauth_cache_hit_total');
  assert.deepEqual(snap[0].labels, { workspace: 'ws-1' });
  assert.equal(snap[0].value, 1);
});

test('OAuthMetrics.inc: repeated inc aggregates on stable key (label key order ignored)', () => {
  const m = new OAuthMetrics();
  m.inc('x', { a: 1, b: 2 });
  m.inc('x', { b: 2, a: 1 });
  m.inc('x', { a: 1, b: 2 }, 3);
  const snap = m.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].value, 5);
});

test('OAuthMetrics.inc: different labels = different counters', () => {
  const m = new OAuthMetrics();
  m.inc('oauth_dcr_total', { workspace: 'a', issuer: 'i', status: '200' });
  m.inc('oauth_dcr_total', { workspace: 'a', issuer: 'i', status: '429' });
  m.inc('oauth_dcr_total', { workspace: 'b', issuer: 'i', status: '200' });
  const snap = m.snapshot();
  assert.equal(snap.length, 3);
  assert.equal(findCounter(snap, 'oauth_dcr_total', { workspace: 'a', status: '200' }).value, 1);
  assert.equal(findCounter(snap, 'oauth_dcr_total', { workspace: 'a', status: '429' }).value, 1);
  assert.equal(findCounter(snap, 'oauth_dcr_total', { workspace: 'b', status: '200' }).value, 1);
});

test('OAuthMetrics.inc: nullish/empty labels are dropped, same bucket as no label', () => {
  const m = new OAuthMetrics();
  m.inc('x', { workspace: 'ws', identity: null });
  m.inc('x', { workspace: 'ws', identity: undefined });
  m.inc('x', { workspace: 'ws', identity: '' });
  m.inc('x', { workspace: 'ws' });
  const snap = m.snapshot();
  assert.equal(snap.length, 1, 'null/undefined/empty-string collapse to same key as missing');
  assert.equal(snap[0].value, 4);
  assert.deepEqual(snap[0].labels, { workspace: 'ws' });
});

test('OAuthMetrics.inc: invalid name / non-positive delta are no-ops', () => {
  const m = new OAuthMetrics();
  m.inc('', { a: 1 });
  m.inc(null, { a: 1 });
  m.inc('x', { a: 1 }, 0);
  m.inc('x', { a: 1 }, -5);
  m.inc('x', { a: 1 }, NaN);
  m.inc('x', { a: 1 }, Infinity);
  assert.deepEqual(m.snapshot(), []);
});

test('OAuthMetrics.snapshot: returns defensive copy — mutating result does not affect internal state', () => {
  const m = new OAuthMetrics();
  m.inc('x', { a: 1 }, 2);
  const snap = m.snapshot();
  snap[0].value = 9999;
  snap[0].labels.a = 'tampered';
  const snap2 = m.snapshot();
  assert.equal(snap2[0].value, 2);
  assert.equal(snap2[0].labels.a, '1');
});

test('OAuthMetrics.reset: clears all counters', () => {
  const m = new OAuthMetrics();
  m.inc('x', { a: 1 });
  m.inc('y', { b: 2 });
  m.reset();
  assert.deepEqual(m.snapshot(), []);
});

test('dcrStatusBucket: maps status codes into the 4-bucket set', () => {
  assert.equal(dcrStatusBucket(200), '200');
  assert.equal(dcrStatusBucket(201), '200');
  assert.equal(dcrStatusBucket(299), '200');
  assert.equal(dcrStatusBucket(400), '4xx');
  assert.equal(dcrStatusBucket(404), '4xx');
  assert.equal(dcrStatusBucket(429), '429');
  assert.equal(dcrStatusBucket(500), '5xx');
  assert.equal(dcrStatusBucket(503), '5xx');
  assert.equal(dcrStatusBucket(undefined), '5xx', 'unknown status falls through to transient bucket');
  assert.equal(dcrStatusBucket(null), '5xx');
});

// ────────────────────────────────────────────────────────────────────────
// OAuthManager → metrics wiring

test('cache miss: first getCachedClient on empty cache emits oauth_cache_miss_total', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, metrics });
    const entry = await mgr.getCachedClient('ws-1', 'https://auth.example', 'none');
    assert.equal(entry, null);
    const miss = findCounter(metrics.snapshot(), 'oauth_cache_miss_total', { workspace: 'ws-1' });
    assert.ok(miss, 'miss counter exists');
    assert.equal(miss.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cache hit: getCachedClient after registerClient emits oauth_cache_hit_total', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const fetchImpl = async () => ({
      ok: true, status: 201,
      headers: { get: () => null },
      json: async () => ({ client_id: 'CID', client_secret: null }),
      text: async () => '',
    });
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl, metrics });
    const md = { registration_endpoint: 'https://auth.example/register', token_endpoint_auth_methods_supported: ['none'] };
    await mgr.registerClient('https://auth.example', md, { workspaceId: 'ws-1', authMethod: 'none' });
    // registerClient with reuse=true already calls getCachedClient once (cache miss), then stores.
    // Now an explicit getCachedClient must be a hit.
    metrics.reset();
    const entry = await mgr.getCachedClient('ws-1', 'https://auth.example', 'none');
    assert.ok(entry, 'cached entry exists');
    const hit = findCounter(metrics.snapshot(), 'oauth_cache_hit_total', { workspace: 'ws-1' });
    assert.ok(hit, 'hit counter exists');
    assert.equal(hit.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cache TTL expiry: expired entry counts as miss (not hit)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  const origTtl = process.env.BIFROST_OAUTH_CACHE_TTL_MS;
  process.env.BIFROST_OAUTH_CACHE_TTL_MS = '1';
  try {
    const metrics = new OAuthMetrics();
    const fetchImpl = async () => ({
      ok: true, status: 201,
      headers: { get: () => null },
      json: async () => ({ client_id: 'CID_TTL', client_secret: null }),
      text: async () => '',
    });
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl, metrics });
    const md = { registration_endpoint: 'https://auth.example/register', token_endpoint_auth_methods_supported: ['none'] };
    await mgr.registerClient('https://auth.example', md, { workspaceId: 'ws-ttl', authMethod: 'none' });
    await new Promise(r => setTimeout(r, 5));
    metrics.reset();
    const entry = await mgr.getCachedClient('ws-ttl', 'https://auth.example', 'none');
    assert.equal(entry, null, 'expired cache entry returns null');
    const miss = findCounter(metrics.snapshot(), 'oauth_cache_miss_total', { workspace: 'ws-ttl' });
    assert.ok(miss, 'ttl expiry classified as miss');
    assert.equal(miss.value, 1);
    assert.equal(findCounter(metrics.snapshot(), 'oauth_cache_hit_total', { workspace: 'ws-ttl' }), undefined);
  } finally {
    if (origTtl === undefined) delete process.env.BIFROST_OAUTH_CACHE_TTL_MS;
    else process.env.BIFROST_OAUTH_CACHE_TTL_MS = origTtl;
    await rm(dir, { recursive: true, force: true });
  }
});

test('DCR success: oauth_dcr_total{status:200} inc by 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const fetchImpl = async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ client_id: 'CID' }), text: async () => '' });
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl, metrics });
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none'],
    }, { workspaceId: 'ws-1', authMethod: 'none', forceNew: true });
    const c = findCounter(metrics.snapshot(), 'oauth_dcr_total', { workspace: 'ws-1', issuer: 'https://auth.example', status: '200' });
    assert.ok(c, 'dcr success counter exists');
    assert.equal(c.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DCR 429: oauth_dcr_total{status:429} inc, no retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const fetchImpl = async () => ({
      ok: false, status: 429,
      headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '5' : null) },
      text: async () => 'rate limited', json: async () => ({}),
    });
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl, metrics });
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
    }, { workspaceId: 'ws-429', authMethod: 'none' }).catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_dcr_total', { workspace: 'ws-429', status: '429' });
    assert.ok(c, '429 counter exists');
    assert.equal(c.value, 1, '429 surfaces immediately, single inc');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DCR 4xx: oauth_dcr_total{status:4xx} inc, no retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const fetchImpl = async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad', json: async () => ({}) });
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl, metrics });
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
    }, { workspaceId: 'ws-4xx', authMethod: 'none' }).catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_dcr_total', { workspace: 'ws-4xx', status: '4xx' });
    assert.ok(c, '4xx counter exists');
    assert.equal(c.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DCR 5xx: oauth_dcr_total{status:5xx} inc per attempt (1 initial + 3 retries = 4)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const fetchImpl = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'down', json: async () => ({}) });
    // Shrink backoff via overriding _sleep on the instance so test stays fast.
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl, metrics });
    mgr._sleep = () => Promise.resolve();
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
    }, { workspaceId: 'ws-5xx', authMethod: 'none' }).catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_dcr_total', { workspace: 'ws-5xx', status: '5xx' });
    assert.ok(c, '5xx counter exists');
    assert.equal(c.value, 4, '1 initial + 3 retries');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DCR network failure: oauth_dcr_total{status:5xx} per attempt (fetch throw)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl, metrics });
    mgr._sleep = () => Promise.resolve();
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
    }, { workspaceId: 'ws-net', authMethod: 'none' }).catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_dcr_total', { workspace: 'ws-net', status: '5xx' });
    assert.ok(c, 'network-fail counter exists in 5xx bucket');
    assert.equal(c.value, 4, 'network failure retries up to 4 attempts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('threshold_trip: markAuthFailed emits oauth_threshold_trip_total{workspace,identity}', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-T');
    const mgr = new OAuthManager(mockWm({ 'ws-T': ws }), { stateDir: dir, metrics });
    await mgr.markAuthFailed('ws-T', 'bot_ci', { correlationId: 'cid-1' });
    const c = findCounter(metrics.snapshot(), 'oauth_threshold_trip_total', { workspace: 'ws-T', identity: 'bot_ci' });
    assert.ok(c, 'threshold_trip counter exists');
    assert.equal(c.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh ok: oauth_refresh_total{status:ok} inc on successful refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-R', { expired: true });
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ access_token: 'AT_NEW', refresh_token: 'RT_NEW', expires_in: 3600 }),
    });
    const mgr = new OAuthManager(mockWm({ 'ws-R': ws }), { stateDir: dir, fetchImpl, metrics });
    await mgr.forceRefresh('ws-R', 'default');
    const c = findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-R', identity: 'default', status: 'ok' });
    assert.ok(c, 'refresh ok counter exists');
    assert.equal(c.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh fail_4xx: token endpoint returns 400 → oauth_refresh_total{status:fail_4xx}', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-F4', { expired: true });
    const fetchImpl = async () => ({
      ok: false, status: 400,
      headers: { get: () => null },
      text: async () => 'invalid_grant',
    });
    const mgr = new OAuthManager(mockWm({ 'ws-F4': ws }), { stateDir: dir, fetchImpl, metrics });
    await mgr.forceRefresh('ws-F4', 'default').catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-F4', identity: 'default', status: 'fail_4xx' });
    assert.ok(c, 'fail_4xx counter exists');
    assert.equal(c.value, 1);
    assert.equal(findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-F4', status: 'fail_net' }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh fail_net: 5xx response → oauth_refresh_total{status:fail_net}', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-F5', { expired: true });
    const fetchImpl = async () => ({
      ok: false, status: 503,
      headers: { get: () => null },
      text: async () => 'upstream-down',
    });
    const mgr = new OAuthManager(mockWm({ 'ws-F5': ws }), { stateDir: dir, fetchImpl, metrics });
    await mgr.forceRefresh('ws-F5', 'default').catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-F5', identity: 'default', status: 'fail_net' });
    assert.ok(c, 'fail_net counter exists (5xx)');
    assert.equal(c.value, 1);
    assert.equal(findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-F5', status: 'fail_4xx' }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh timeout + late success: only fail_net recorded, never ok (Codex R1 blocker)', async () => {
  // Guard against the race where the background task resolves AFTER the
  // outer Promise.race rejected on timeout. Before the fix, inner task
  // emitted `status:ok` unconditionally — giving a double increment
  // (fail_net from the catch + ok from the late resolve) that violated
  // §6-OBS.2 "refresh 시도 결과별" semantics.
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-TL', { expired: true });
    const pendingFetches = [];
    const fetchImpl = () => {
      const p = new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: true, status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ access_token: 'LATE_AT', refresh_token: 'LATE_RT', expires_in: 3600 }),
        }), 80);
      });
      pendingFetches.push(p);
      return p;
    };
    const mgr = new OAuthManager(mockWm({ 'ws-TL': ws }), {
      stateDir: dir,
      fetchImpl,
      metrics,
      refreshTimeoutMs: 25,
    });
    const err = await mgr.forceRefresh('ws-TL', 'default').catch(e => e);
    assert.ok(err instanceof Error, 'timeout must throw');
    assert.match(err.message, /refresh_timeout/);
    // Give the background task enough time to actually resolve (late success)
    await Promise.all(pendingFetches);
    await new Promise(r => setTimeout(r, 20)); // drain microtasks
    const snap = metrics.snapshot();
    const ok = findCounter(snap, 'oauth_refresh_total', { workspace: 'ws-TL', identity: 'default', status: 'ok' });
    const failNet = findCounter(snap, 'oauth_refresh_total', { workspace: 'ws-TL', identity: 'default', status: 'fail_net' });
    assert.equal(ok, undefined, 'ok counter must NOT be emitted when caller observed a timeout failure');
    assert.ok(failNet, 'fail_net counter must be present');
    assert.equal(failNet.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh NO_REFRESH_TOKEN → fail_net + does NOT mark action_needed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-NRT', { expired: true, refreshToken: null });
    // Make it explicit — strip both places the refresh path consults.
    ws.oauth.tokens.refreshToken = null;
    ws.oauth.byIdentity.default.tokens.refreshToken = null;
    const mgr = new OAuthManager(mockWm({ 'ws-NRT': ws }), { stateDir: dir, metrics });
    await mgr.forceRefresh('ws-NRT', 'default').catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-NRT', identity: 'default', status: 'fail_net' });
    assert.ok(c, 'NO_REFRESH_TOKEN classified as fail_net (non-4xx terminal failure)');
    assert.equal(c.value, 1);
    // Codex R2 assertion: current OAuthManager skips oauthActionNeeded for
    // NO_REFRESH_TOKEN / TOKEN_ENDPOINT_UNKNOWN (see _runRefresh catch). Lock
    // in that contract so a future refactor has to consciously change it.
    assert.ok(!ws.oauthActionNeeded, 'NO_REFRESH_TOKEN must not auto-mark default action_needed');
    assert.ok(!ws.oauthActionNeededBy?.default, 'NO_REFRESH_TOKEN must not auto-mark per-identity action_needed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh TOKEN_ENDPOINT_UNKNOWN → fail_net + does NOT mark action_needed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-TEU', { expired: true });
    // Remove the discovered token endpoint so the refresh path raises
    // TOKEN_ENDPOINT_UNKNOWN before any HTTP is attempted.
    delete ws.oauth.metadataCache;
    delete ws.oauth.tokenEndpoint;
    const mgr = new OAuthManager(mockWm({ 'ws-TEU': ws }), { stateDir: dir, metrics });
    await mgr.forceRefresh('ws-TEU', 'default').catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-TEU', identity: 'default', status: 'fail_net' });
    assert.ok(c, 'TOKEN_ENDPOINT_UNKNOWN classified as fail_net');
    assert.equal(c.value, 1);
    // Same contract as NO_REFRESH_TOKEN — a missing token endpoint is a
    // configuration-level failure, not an authorization revocation, so
    // oauthActionNeeded should not be set implicitly by the refresh path.
    assert.ok(!ws.oauthActionNeeded);
    assert.ok(!ws.oauthActionNeededBy?.default);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh fail_net: network throw (fetch rejects) → fail_net', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-FN', { expired: true });
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    const mgr = new OAuthManager(mockWm({ 'ws-FN': ws }), { stateDir: dir, fetchImpl, metrics });
    await mgr.forceRefresh('ws-FN', 'default').catch(() => {});
    const c = findCounter(metrics.snapshot(), 'oauth_refresh_total', { workspace: 'ws-FN', identity: 'default', status: 'fail_net' });
    assert.ok(c, 'fail_net counter exists (network)');
    assert.equal(c.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no metrics injected: OAuthManager with metrics=null is a no-op on instrumentation sites', async () => {
  // Regression guard — legacy tests / callers that construct OAuthManager
  // without a recorder must continue to work.
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const ws = makeOAuthWs('ws-N');
    const mgr = new OAuthManager(mockWm({ 'ws-N': ws }), { stateDir: dir /* no metrics */ });
    await mgr.markAuthFailed('ws-N', 'default');
    // If _metric crashed, the call above would throw. Reaching here = pass.
    assert.equal(mgr.metrics, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('metrics recorder throw is swallowed by _metric (no OAuth path breakage)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const throwingMetrics = { inc: () => { throw new Error('recorder exploded'); } };
    const ws = makeOAuthWs('ws-X');
    const mgr = new OAuthManager(mockWm({ 'ws-X': ws }), { stateDir: dir, metrics: throwingMetrics });
    // markAuthFailed invokes _metric → inc → throws; _metric catches.
    const r = await mgr.markAuthFailed('ws-X', 'default');
    assert.deepEqual(r, { marked: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Admin API: GET /api/oauth/metrics

test('GET /api/oauth/metrics: returns recorder snapshot from extras.oauthMetrics', async () => {
  const { createServer } = await import('node:http');
  const { createAdminRoutes } = await import('../admin/routes.js');

  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    metrics.inc('oauth_cache_miss_total', { workspace: 'ws-A' }, 3);
    metrics.inc('oauth_dcr_total', { workspace: 'ws-A', issuer: 'https://i', status: '200' });

    const wm = {
      _getRawWorkspace: () => null,
      getWorkspaces: () => [],
      getOAuthClient: () => null,
      getAdminToken: () => null,
      getMcpToken: () => null,
      oauthAuditLog: [],
      fileSecurityWarning: false,
    };
    const oauth = new OAuthManager(wm, { stateDir: dir, metrics });

    const routes = createAdminRoutes(
      wm,
      { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
      { getSessionCount: () => 0 },
      oauth,
      null,
      { oauthMetrics: metrics },
    );
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      routes(req, res, u);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/oauth/metrics`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.data));
      const miss = body.data.find(c => c.name === 'oauth_cache_miss_total');
      assert.ok(miss, 'miss counter present in API response');
      assert.equal(miss.value, 3);
      assert.deepEqual(miss.labels, { workspace: 'ws-A' });
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/oauth/metrics: falls back to oauth.metrics when extras omitted', async () => {
  const { createServer } = await import('node:http');
  const { createAdminRoutes } = await import('../admin/routes.js');

  const dir = await mkdtemp(join(tmpdir(), 'phase11-4-'));
  try {
    const metrics = new OAuthMetrics();
    metrics.inc('oauth_threshold_trip_total', { workspace: 'ws-F', identity: 'default' });

    const wm = {
      _getRawWorkspace: () => null,
      getWorkspaces: () => [],
      getOAuthClient: () => null,
      getAdminToken: () => null,
      getMcpToken: () => null,
      oauthAuditLog: [],
      fileSecurityWarning: false,
    };
    const oauth = new OAuthManager(wm, { stateDir: dir, metrics });

    const routes = createAdminRoutes(
      wm,
      { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
      { getSessionCount: () => 0 },
      oauth,
      null,
      // extras omitted on purpose — endpoint must fall back to oauth.metrics
    );
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      routes(req, res, u);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/oauth/metrics`);
      assert.equal(r.status, 200);
      const body = await r.json();
      const trip = body.data.find(c => c.name === 'oauth_threshold_trip_total');
      assert.ok(trip, 'fallback to oauth.metrics works');
      assert.equal(trip.value, 1);
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/oauth/metrics: returns [] when no recorder is wired anywhere', async () => {
  const { createServer } = await import('node:http');
  const { createAdminRoutes } = await import('../admin/routes.js');

  const wm = {
    _getRawWorkspace: () => null,
    getWorkspaces: () => [],
    getOAuthClient: () => null,
    getAdminToken: () => null,
    getMcpToken: () => null,
    oauthAuditLog: [],
    fileSecurityWarning: false,
  };

  const routes = createAdminRoutes(
    wm,
    { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
    { getSessionCount: () => 0 },
    null, // no oauth manager at all
    null,
  );
  const server = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    routes(req, res, u);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/oauth/metrics`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.data, []);
  } finally {
    await new Promise(r => server.close(r));
  }
});
