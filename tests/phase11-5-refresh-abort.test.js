/**
 * Phase 11-5 §8 — Refresh timeout + AbortController
 *
 * Phase 11-4 closed the metrics-level double-count on refresh timeout +
 * late success (Codex R1). What remained was state/audit convergence
 * (Codex R2 non-blocker): a timed-out refresh whose background HTTP
 * later resolved would still
 *   - overwrite ws.oauth.byIdentity[identity].tokens
 *   - emit an `oauth.refresh_success` audit that contradicts the earlier
 *     `oauth.refresh_fail`
 *   - in rare races, revive a client/identity that had already been
 *     quiesced by markAuthFailed / rotateClientUnderMutex.
 *
 * `_runRefresh` now drives an AbortController. On timeout we call
 * controller.abort() BEFORE rejecting; the _tokenRequest helper forwards
 * the signal into fetch so standards-compliant fetch implementations
 * cancel the socket immediately. A post-fetch abort guard covers stubs
 * that ignore `signal`: even if they resolve late, we check
 * controller.signal.aborted and throw REFRESH_ABORTED before mutating
 * state or emitting success audit.
 *
 * Covers:
 *   1. Standards fetch (honors signal) → background fetch rejects with
 *      AbortError; tokens untouched; no refresh_success audit.
 *   2. Stub fetch (ignores signal, late resolves) → post-fetch guard
 *      throws REFRESH_ABORTED; tokens untouched; no refresh_success
 *      audit; metrics stay single (fail_net only, no ok).
 *   3. _tokenRequest signal passthrough — fetchInit.signal is actually
 *      populated so real-world AbortSignal semantics reach fetch.
 *   4. Backwards compat — _tokenRequest without a signal still works
 *      (authorize-code path doesn't pass one).
 *   5. Legacy phase6c-refresh test pattern still passes: timeout throws
 *      refresh_timeout, mutex cleared, oauth.refresh_fail audit emitted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { OAuthMetrics } from '../server/oauth-metrics.js';

// ────────────────────────────────────────────────────────────────────────
// Fixtures

function mockWm(workspaces = {}) {
  const audits = [];
  return {
    workspaces,
    audits,
    _getRawWorkspace: (id) => workspaces[id] || null,
    getRawWorkspace: (id) => workspaces[id] || null,
    getServerConfig: () => ({ port: 3100 }),
    _save: async () => {},
    logAudit: (action, ws, details, identity) => audits.push({ action, ws, details, identity }),
    logError: () => {},
  };
}

function makeOAuthWs(id, { expired = true, refreshToken = 'RT_' + id, accessToken = 'AT_' + id } = {}) {
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
      tokens: { accessToken, refreshToken, expiresAt, tokenType: 'Bearer' },
      byIdentity: { default: { tokens: { accessToken, refreshToken, expiresAt, tokenType: 'Bearer' } } },
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Scenario 1 — standards fetch honors AbortSignal

test('refresh timeout aborts in-flight fetch when fetch honors signal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-5-'));
  try {
    const ws = makeOAuthWs('ws-HONOR');
    const wm = mockWm({ 'ws-HONOR': ws });
    const originalAccess = ws.oauth.byIdentity.default.tokens.accessToken;
    const originalRefresh = ws.oauth.byIdentity.default.tokens.refreshToken;

    // Codex R1 non-blocking: use an explicit promise that resolves from the
    // abort handler so the test observes the cancellation deterministically
    // (AbortController dispatches `abort` synchronously; no need to wait for
    // `setImmediate` / microtask flushes).
    let resolveAbortSeen;
    const abortSeen = new Promise(r => { resolveAbortSeen = r; });

    const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
      if (init?.signal) {
        const signal = init.signal;
        const onAbort = () => {
          resolveAbortSeen();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // Otherwise resolve slowly (would never race-win here)
      setTimeout(() => resolve({
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'LATE_AT', expires_in: 3600 }),
      }), 200);
    });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl, refreshTimeoutMs: 25 });
    const err = await mgr.forceRefresh('ws-HONOR', 'default').catch(e => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /refresh_timeout/);
    // Abort event is dispatched synchronously from the timeout handler; this
    // await resolves once the fetch stub actually observed it.
    await abortSeen;
    // State untouched
    assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, originalAccess);
    assert.equal(ws.oauth.byIdentity.default.tokens.refreshToken, originalRefresh);
    // Audit: refresh_fail yes, refresh_success no
    assert.ok(wm.audits.some(a => a.action === 'oauth.refresh_fail'));
    assert.ok(!wm.audits.some(a => a.action === 'oauth.refresh_success'), 'no refresh_success after abort');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 2 — stub fetch ignores signal; post-fetch guard kicks in

test('refresh timeout + late-resolving stub (ignores signal): guard discards response, no refresh_success, no ok metric', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-5-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-STUB');
    const wm = mockWm({ 'ws-STUB': ws });
    const originalAccess = ws.oauth.byIdentity.default.tokens.accessToken;

    const pendingFetches = [];
    const fetchImpl = () => {
      // Stub ignores init.signal entirely, just resolves 80ms later.
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
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl, metrics, refreshTimeoutMs: 25 });
    const err = await mgr.forceRefresh('ws-STUB', 'default').catch(e => e);
    assert.match(err.message, /refresh_timeout/);
    // Drain pending fetch + task microtasks so the post-fetch guard runs
    await Promise.all(pendingFetches);
    await new Promise(r => setTimeout(r, 20));
    // State MUST still be the pre-timeout value — the background task's
    // attempt to _storeTokens was intercepted by controller.signal.aborted.
    assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, originalAccess,
      'post-fetch abort guard must prevent late token persistence');
    assert.notEqual(ws.oauth.byIdentity.default.tokens.refreshToken, 'LATE_RT',
      'refresh token must not be rotated by the aborted background task');
    // No refresh_success audit
    assert.ok(!wm.audits.some(a => a.action === 'oauth.refresh_success'));
    // Metrics: only fail_net, never ok
    const snap = metrics.snapshot();
    const ok = snap.find(c => c.name === 'oauth_refresh_total' && c.labels.status === 'ok');
    const failNet = snap.find(c => c.name === 'oauth_refresh_total' && c.labels.status === 'fail_net');
    assert.equal(ok, undefined, 'ok counter must remain absent after guarded abort');
    assert.ok(failNet);
    assert.equal(failNet.value, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 3 — _tokenRequest signal passthrough

test('_tokenRequest forwards AbortSignal into fetch init', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-5-'));
  try {
    let receivedInit;
    const fetchImpl = async (_url, init) => {
      receivedInit = init;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'AT_X', expires_in: 3600 }),
      };
    };
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl });
    const controller = new AbortController();
    const entry = { tokenEndpoint: 'https://auth.example/token', clientId: 'C', clientSecret: null, authMethod: 'none', resource: null };
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', 'RT');
    await mgr._tokenRequest(entry, params, 'refresh', { signal: controller.signal });
    assert.ok(receivedInit, 'fetch was called');
    assert.equal(receivedInit.signal, controller.signal, 'signal must reach fetch init verbatim');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 4 — backwards compat (authorize code path)

test('_tokenRequest without a signal still works (authorize-code path unchanged)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-5-'));
  try {
    let initSeen;
    const fetchImpl = async (_url, init) => {
      initSeen = init;
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'AT_Y', expires_in: 3600 }),
      };
    };
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl });
    const entry = { tokenEndpoint: 'https://auth.example/token', clientId: 'C', clientSecret: null, authMethod: 'none', resource: null };
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', 'AC');
    const tokens = await mgr._tokenRequest(entry, params, 'authorize');
    assert.equal(tokens.access_token, 'AT_Y');
    // Callers that don't opt in must not leak a signal into fetchInit
    assert.equal(initSeen.signal, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 5 — metrics `ok` emission still fires on the happy path

test('happy-path refresh still records ok (Phase 11-4 contract preserved)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-5-'));
  try {
    const metrics = new OAuthMetrics();
    const ws = makeOAuthWs('ws-OK');
    const wm = mockWm({ 'ws-OK': ws });
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ access_token: 'AT_NEW', refresh_token: 'RT_NEW', expires_in: 3600 }),
    });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl, metrics });
    const result = await mgr.forceRefresh('ws-OK', 'default');
    assert.equal(result.accessToken, 'AT_NEW');
    const snap = metrics.snapshot();
    const ok = snap.find(c => c.name === 'oauth_refresh_total' && c.labels.status === 'ok');
    assert.ok(ok, 'ok counter must still fire on the happy path');
    assert.equal(ok.value, 1);
    // And refresh_success audit fires
    assert.ok(wm.audits.some(a => a.action === 'oauth.refresh_success'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 6b — rare race (c): timeout → markAuthFailed → late fetch resolve
//
// Without the abort guard, a background refresh that resolves after
// `markAuthFailed` already quiesced the identity would call _storeTokens
// and flip oauthActionNeededBy[identity] back to false, reviving a
// revoked authorization. Codex R1 explicitly recommended locking this in.

test('quiesced state revive: timeout → markAuthFailed → late fetch must NOT restore accessToken or clear action_needed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-5-'));
  try {
    const ws = makeOAuthWs('ws-QUIESCE');
    const wm = mockWm({ 'ws-QUIESCE': ws });

    const pendingFetches = [];
    const fetchImpl = () => {
      // Stub ignores signal + resolves long after timeout → exercises the
      // post-fetch guard path, which is the one that matters for this race.
      const p = new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: true, status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ access_token: 'REVIVED_AT', refresh_token: 'REVIVED_RT', expires_in: 3600 }),
        }), 80);
      });
      pendingFetches.push(p);
      return p;
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl, refreshTimeoutMs: 25 });

    // 1) Fire refresh that will time out
    const refreshPromise = mgr.forceRefresh('ws-QUIESCE', 'default').catch(e => e);
    const err = await refreshPromise;
    assert.match(err.message, /refresh_timeout/);

    // 2) Admin / threshold logic now quiesces the identity. Per Phase 10a,
    //    markAuthFailed flips ws.oauthActionNeededBy[identity] = true and
    //    nulls the accessToken in byIdentity.
    await mgr.markAuthFailed('ws-QUIESCE', 'default', { correlationId: 'test-race' });
    assert.equal(ws.oauthActionNeededBy.default, true, 'quiesced by markAuthFailed');
    assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, null, 'accessToken nulled by markAuthFailed');

    // 3) Late fetch resolves. Background task enters post-fetch guard and
    //    throws REFRESH_ABORTED — it MUST NOT touch tokens or reset
    //    oauthActionNeededBy.
    await Promise.all(pendingFetches);
    await new Promise(r => setTimeout(r, 20));

    // Revive-resistance assertions
    assert.equal(ws.oauthActionNeededBy.default, true, 'action_needed must stay set');
    assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, null, 'accessToken must stay nulled');
    assert.notEqual(ws.oauth.byIdentity.default.tokens.refreshToken, 'REVIVED_RT',
      'refresh token must not be rotated by the late response');
    // And no contradictory refresh_success audit was emitted during the
    // whole sequence (refresh_fail from timeout + threshold_trip from
    // markAuthFailed are allowed; refresh_success is not).
    assert.ok(!wm.audits.some(a => a.action === 'oauth.refresh_success'),
      'no refresh_success audit on revive attempt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 6 — phase6c compat: mutex cleared + refresh_fail audit on timeout

test('phase6c compat: refresh_timeout still throws, identity mutex cleared, oauth.refresh_fail audit still emitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-5-'));
  try {
    const ws = makeOAuthWs('ws-COMPAT');
    const wm = mockWm({ 'ws-COMPAT': ws });
    const pendingFetches = [];
    const fetchImpl = (_url, init) => {
      const p = new Promise((resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const err = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        }
        setTimeout(() => resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"access_token":"late"}' }), 80);
      });
      pendingFetches.push(p.catch(() => {}));
      return p;
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl, refreshTimeoutMs: 25 });
    const err = await mgr.forceRefresh('ws-COMPAT').catch(e => e);
    assert.match(err.message, /refresh_timeout/);
    // Per phase10a §6.4: _refreshMutex was renamed to _identityMutex
    assert.equal(mgr._identityMutex.size, 0, 'identity mutex must be cleared after timeout');
    assert.ok(wm.audits.some(a => a.action === 'oauth.refresh_fail'));
    // Drain so no timer leaks into the runner
    await Promise.all(pendingFetches);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
