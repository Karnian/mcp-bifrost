/**
 * Phase 10a §4.10a-5 — Admin API endpoints for OAuth client management.
 *   POST /api/workspaces/:id/oauth/register — re-register (DCR forceNew or manual)
 *   PUT  /api/workspaces/:id/oauth/client   — set static/manual client
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { OAuthManager } from '../server/oauth-manager.js';
import { MockOAuthServer } from './fixtures/mock-oauth-server.js';
import { createAdminRoutes } from '../admin/routes.js';

function makeWm(workspaces) {
  const providerRecreateLog = [];
  const wm = {
    config: { workspaces, server: { port: 3100 }, tunnel: {} },
    _getRawWorkspace: id => workspaces.find(w => w.id === id) || null,
    getRawWorkspace: id => workspaces.find(w => w.id === id) || null,
    getWorkspaces: () => workspaces,
    getWorkspace: (id, { masked = true } = {}) => {
      const ws = workspaces.find(w => w.id === id);
      if (!ws) return null;
      return { ...ws };
    },
    getServerConfig: () => ({ port: 3100 }),
    getAdminToken: () => null,
    getMcpToken: () => null,
    _save: async () => {},
    logAudit: () => {},
    logError: () => {},
    setOAuthManager() {},
    getDiagnostics: () => ({ workspaces, errorLog: [], auditLog: [], oauthAuditLog: [] }),
    // Phase 11 §3: getOAuthClient is nested-only (flat-fallback removed from
    // production WorkspaceManager; test stub mirrors that behavior).
    getOAuthClient: (id) => {
      const ws = workspaces.find(w => w.id === id);
      if (!ws?.oauth) return null;
      if (ws.oauth.client) {
        const c = ws.oauth.client;
        return { clientId: c.clientId, clientSecret: c.clientSecret ? '***' : null, authMethod: c.authMethod, source: c.source, registeredAt: c.registeredAt };
      }
      return null;
    },
    // Phase 10a Codex R2 blocker 1 — provider recreate on rotation
    _createProvider: (ws) => { providerRecreateLog.push(ws.id); },
    getProvider: () => null,
    providerRecreateLog,
  };
  return wm;
}

async function startAdminServer(wm, oauth) {
  const routes = createAdminRoutes(
    wm,
    { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
    { getSessionCount: () => 0 },
    oauth,
    null,
  );
  const server = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    routes(req, res, u);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('§4.10a-5: POST /oauth/register (DCR forceNew) issues new client + invalidates tokens', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: {
        enabled: true,
        issuer: base,
        client: { clientId: 'OLD_CLIENT', authMethod: 'none', source: 'dcr', registeredAt: '2020-01-01' },
        clientId: 'OLD_CLIENT',
        authMethod: 'none',
        metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
        byIdentity: {
          default: { tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT', expiresAt: null, tokenType: 'Bearer' } },
        },
        tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT', expiresAt: null, tokenType: 'Bearer' },
      },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.notEqual(body.data.clientId, 'OLD_CLIENT', 'new DCR issues new client_id');
      assert.equal(body.data.source, 'dcr');
      // Tokens must be invalidated — both access AND refresh (Codex R5 blocker)
      assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, null);
      assert.equal(ws.oauth.byIdentity.default.tokens.refreshToken, null, 'refreshToken MUST be nulled too (Codex R5)');
      assert.equal(ws.oauth.tokens.accessToken, null);
      assert.equal(ws.oauth.tokens.refreshToken, null);
      assert.equal(ws.oauthActionNeededBy.default, true);
      assert.equal(ws.oauthActionNeeded, true);
      // Codex R2 blocker 1: provider must be recreated so new client takes effect
      assert.ok(wm.providerRecreateLog.includes('w1'), 'provider must be recreated after client rotation');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-5: POST /oauth/register with manual → source=manual + tokens nulled', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: {
        enabled: true,
        issuer: base,
        metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
        byIdentity: { default: { tokens: { accessToken: 'OLD', refreshToken: 'OLDRT' } } },
        tokens: { accessToken: 'OLD', refreshToken: 'OLDRT' },
      },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: { clientId: 'MY_STATIC', clientSecret: 'ssh', authMethod: 'client_secret_basic' } }),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.data.clientId, 'MY_STATIC');
      assert.equal(body.data.source, 'manual');
      assert.equal(body.data.clientSecret, '***', 'clientSecret must be masked in response');
      assert.equal(body.data.authMethod, 'client_secret_basic');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-5: PUT /oauth/client sets static client + returns 400 on invalid clientId', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: {
        enabled: true,
        issuer: base,
        metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
      },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      // Missing clientId → 400
      const r0 = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/oauth/client`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(r0.status, 400);
      const j0 = await r0.json();
      assert.equal(j0.error.code, 'INVALID_CLIENT_ID');

      // Bad authMethod → 400
      const rBad = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/oauth/client`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'CID', authMethod: 'private_key_jwt' }),
      });
      assert.equal(rBad.status, 400);
      assert.equal((await rBad.json()).error.code, 'UNSUPPORTED_AUTH_METHOD');

      // Valid → 200
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/oauth/client`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'MY_CID', clientSecret: 'sec', authMethod: 'client_secret_basic' }),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.data.clientId, 'MY_CID');
      assert.equal(body.data.source, 'manual');
      assert.equal(body.data.clientSecret, '***');
      assert.equal(ws.oauth.client.clientId, 'MY_CID');
      // Phase 11 §3 — flat mirror removed. Assert it's NOT written.
      assert.equal(ws.oauth.clientId, undefined, 'Phase 11 §3: flat mirror must NOT be written');
      assert.equal(ws.oauth.clientSecret, undefined, 'Phase 11 §3: flat clientSecret must NOT be written');
      assert.equal(ws.oauth.authMethod, undefined, 'Phase 11 §3: flat authMethod must NOT be written');
      assert.equal(ws.oauth.client.source, 'manual');
      // Codex R2 blocker 1
      assert.ok(wm.providerRecreateLog.includes('w1'), 'provider must be recreated');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-5 (Codex R2 cleanup): POST /oauth/register manual also whitelists authMethod', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: {
        enabled: true,
        issuer: base,
        metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
      },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: { clientId: 'CID', authMethod: 'private_key_jwt' } }),
      });
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.equal(body.error.code, 'UNSUPPORTED_AUTH_METHOD');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-2 (Codex R3): /authorize rejects unsupported authMethod on manual path', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: false });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: null,
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: { clientId: 'CID', authMethod: 'private_key_jwt' } }),
      });
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.equal(body.error.code, 'UNSUPPORTED_AUTH_METHOD');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-2 (Codex R3): /authorize purges pending auth states when rotating client via forceRegister', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: { enabled: true, issuer: base, client: { clientId: 'OLD', authMethod: 'none', source: 'dcr' }, clientId: 'OLD', authMethod: 'none', metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` } },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    // Seed pending state for w1 as if a previous /authorize had begun
    const pending = await oauth._loadPending();
    pending['state-old'] = { workspaceId: 'w1', identity: 'default', issuer: base, clientId: 'OLD', clientSecret: null, authMethod: 'none', verifier: 'v', tokenEndpoint: `${base}/token`, resource: null, expiresAt: Date.now() + 60_000 };
    await oauth._savePending();
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRegister: true }),
      });
      assert.equal(r.status, 200);
      const after = await oauth._loadPending();
      assert.equal(after['state-old'], undefined, 'old pending entry must be purged on client rotation');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-2 (Codex R4 blocker): /authorize rotation invalidates existing tokens', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: {
        enabled: true,
        issuer: base,
        client: { clientId: 'OLD_CID', authMethod: 'none', source: 'dcr', registeredAt: '2026-01-01' },
        clientId: 'OLD_CID', authMethod: 'none',
        metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
        byIdentity: { default: { tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT', expiresAt: null, tokenType: 'Bearer' } } },
        tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT', expiresAt: null, tokenType: 'Bearer' },
      },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRegister: true }),
      });
      assert.equal(r.status, 200);
      // Codex R4: both accessToken AND refreshToken must be nulled so a refresh
      // doesn't combine old refresh_token with new client credentials.
      assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, null);
      assert.equal(ws.oauth.byIdentity.default.tokens.refreshToken, null);
      assert.equal(ws.oauth.tokens.accessToken, null);
      assert.equal(ws.oauth.tokens.refreshToken, null);
      assert.equal(ws.oauthActionNeededBy.default, true);
      assert.equal(ws.oauthActionNeeded, true);
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-2 (Codex R4 blocker): /authorize manual.clientId is honored even when client already exists', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: {
        enabled: true,
        issuer: base,
        client: { clientId: 'EXISTING', authMethod: 'none', source: 'dcr', registeredAt: '2026-01-01' },
        clientId: 'EXISTING', authMethod: 'none',
        metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
        byIdentity: { default: { tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT' } } },
        tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT' },
      },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      // Send /authorize with manual.clientId — contract requires it is honored
      // even though a client already exists. Previously dropped silently.
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: { clientId: 'OPERATOR_CID', clientSecret: 's', authMethod: 'client_secret_basic' } }),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.data.clientId, 'OPERATOR_CID', '/authorize must honor manual override even with an existing client');
      assert.equal(body.data.authMethod, 'client_secret_basic');
      assert.equal(ws.oauth.client.clientId, 'OPERATOR_CID');
      assert.equal(ws.oauth.client.source, 'manual');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Phase 11 §2 — _rotateClientAndInvalidate consolidation coverage
//
// These tests verify that all three rotation paths (POST /oauth/register,
// PUT /oauth/client, POST /oauth/authorize with rotation) produce the
// EXACT SAME post-rotation state — a guarantee of the consolidated helper.

async function doRotateRegisterDcr(ws, wm, oauth, port) {
  return fetch(`http://127.0.0.1:${port}/api/workspaces/${ws.id}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}
async function doRotatePutClient(ws, wm, oauth, port) {
  return fetch(`http://127.0.0.1:${port}/api/workspaces/${ws.id}/oauth/client`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'NEW_PUT_CLIENT', clientSecret: 'SECRET', authMethod: 'client_secret_basic' }),
  });
}
async function doRotateAuthorizeForceRegister(ws, wm, oauth, port) {
  return fetch(`http://127.0.0.1:${port}/api/workspaces/${ws.id}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceRegister: true }),
  });
}

test('§Phase11-2: all three rotation paths invalidate tokens + action_needed (consistency via consolidated helper)', async () => {
  // Proves all three paths — POST /oauth/register (DCR), PUT /oauth/client
  // (manual), POST /oauth/authorize (forceRegister) — produce identical
  // invalidation state after rotation. This is the behavioral contract
  // the _rotateClientAndInvalidate helper enforces.
  for (const [label, doRotate] of [
    ['register-dcr', doRotateRegisterDcr],
    ['put-client', doRotatePutClient],
    ['authorize-force', doRotateAuthorizeForceRegister],
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), `phase11-helper-${label}-`));
    const mock = new MockOAuthServer({ dcrEnabled: true });
    const base = await mock.start();
    try {
      const ws = {
        id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
        displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
        oauth: {
          enabled: true,
          issuer: base,
          client: { clientId: 'OLD_CLIENT', authMethod: 'none', source: 'dcr', registeredAt: '2020-01-01' },
          clientId: 'OLD_CLIENT',
          authMethod: 'none',
          metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
          byIdentity: {
            default:  { tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT', expiresAt: null, tokenType: 'Bearer' } },
            bot_ci:   { tokens: { accessToken: 'OLD_AT2', refreshToken: 'OLD_RT2', expiresAt: null, tokenType: 'Bearer' } },
          },
          tokens: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT', expiresAt: null, tokenType: 'Bearer' },
        },
      };
      const wm = makeWm([ws]);
      const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
      const { server, port } = await startAdminServer(wm, oauth);
      try {
        const r = await doRotate(ws, wm, oauth, port);
        assert.equal(r.status, 200, `${label}: rotation must succeed`);
        // Post-rotation invariants (identical across all three paths).
        assert.notEqual(ws.oauth.client.clientId, 'OLD_CLIENT', `${label}: client must have rotated`);
        for (const ident of ['default', 'bot_ci']) {
          assert.equal(ws.oauth.byIdentity[ident].tokens.accessToken, null, `${label}: ${ident} accessToken must be nulled`);
          assert.equal(ws.oauth.byIdentity[ident].tokens.refreshToken, null, `${label}: ${ident} refreshToken must be nulled`);
          assert.equal(ws.oauthActionNeededBy[ident], true, `${label}: ${ident} must be flagged action_needed`);
        }
        assert.equal(ws.oauth.tokens.accessToken, null, `${label}: legacy tokens.accessToken must be nulled`);
        assert.equal(ws.oauth.tokens.refreshToken, null, `${label}: legacy tokens.refreshToken must be nulled`);
        assert.equal(ws.oauthActionNeeded, true, `${label}: legacy oauthActionNeeded must be true`);
        // Phase 11 §3 — flat mirror removed; assert NOT present.
        assert.equal(ws.oauth.clientId, undefined, `${label}: Phase 11 §3: flat clientId mirror must NOT exist`);
        assert.equal(ws.oauth.clientSecret, undefined, `${label}: Phase 11 §3: flat clientSecret mirror must NOT exist`);
        assert.equal(ws.oauth.authMethod, undefined, `${label}: Phase 11 §3: flat authMethod mirror must NOT exist`);
      } finally {
        await new Promise(r => server.close(r));
      }
    } finally {
      await mock.stop();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('§Phase11-2: POST /oauth/register and PUT /oauth/client BOTH recreate provider (consistent via helper)', async () => {
  // POST /register and PUT /client must recreate the provider so the new
  // client is effective immediately. /authorize does NOT recreate (it
  // expects the browser to follow up via /callback). This test proves the
  // helper's `recreateProvider` option is correctly wired per route.
  for (const [label, doRotate, expectRecreate] of [
    ['register-dcr', doRotateRegisterDcr, true],
    ['put-client', doRotatePutClient, true],
    ['authorize-force', doRotateAuthorizeForceRegister, false],
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), `phase11-recreate-${label}-`));
    const mock = new MockOAuthServer({ dcrEnabled: true });
    const base = await mock.start();
    try {
      const ws = {
        id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
        displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
        oauth: {
          enabled: true, issuer: base,
          client: { clientId: 'OLD', authMethod: 'none', source: 'dcr', registeredAt: '2020-01-01' },
          clientId: 'OLD', authMethod: 'none',
          metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
          byIdentity: { default: { tokens: { accessToken: 'AT', refreshToken: 'RT' } } },
          tokens: { accessToken: 'AT', refreshToken: 'RT' },
        },
      };
      const wm = makeWm([ws]);
      const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
      const { server, port } = await startAdminServer(wm, oauth);
      try {
        const r = await doRotate(ws, wm, oauth, port);
        assert.equal(r.status, 200, `${label}: rotation must succeed`);
        const recreated = wm.providerRecreateLog.includes('w1');
        assert.equal(recreated, expectRecreate,
          `${label}: provider recreate expected=${expectRecreate}, got=${recreated}`);
      } finally {
        await new Promise(r => server.close(r));
      }
    } finally {
      await mock.stop();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('§Phase11-2 (Codex R1 regression): same-client manual rotation purges pending states (stale callback can\'t resurrect)', async () => {
  // Codex Phase 11 R1 found that if the helper purged pending states
  // OUTSIDE the workspace mutex, a stale completeAuthorization callback
  // could race with the purge when the "rotated" client tuple equals the
  // pre-rotation tuple (e.g. operator re-enters the same manual clientId).
  // In that case completeAuthorization's client-field discriminator sees
  // matching fields and accepts the stale pending entry → token persist
  // against the wrong state.
  //
  // The fix: purge pending INSIDE the workspace-locked critical section,
  // so completeAuthorization (which FIFO-chains behind on the same
  // _workspaceMutex) always sees an already-purged pending.
  //
  // This test drives exactly that scenario: existing pending state + PUT
  // /oauth/client with the SAME clientId, then verifies the pending entry
  // is gone.
  const stateDir = await mkdtemp(join(tmpdir(), 'phase11-r1-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
      oauth: {
        enabled: true, issuer: base,
        client: { clientId: 'SAME_CLIENT', authMethod: 'none', source: 'manual', registeredAt: '2020-01-01' },
        clientId: 'SAME_CLIENT', authMethod: 'none',
        metadataCache: { registration_endpoint: `${base}/register`, token_endpoint: `${base}/token`, authorization_endpoint: `${base}/authorize` },
        byIdentity: { default: { tokens: { accessToken: 'AT', refreshToken: 'RT' } } },
        tokens: { accessToken: 'AT', refreshToken: 'RT' },
      },
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });

    // Seed a pending auth state for this workspace (simulates a browser
    // that started /authorize but never hit /callback yet).
    const init = await oauth.initializeAuthorization('w1', {
      issuer: base,
      clientId: 'SAME_CLIENT',
      clientSecret: null,
      authMethod: 'none',
      identity: 'default',
      authServerMetadata: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` },
    });
    // Sanity: pending exists.
    const pendingBefore = await oauth._loadPending();
    assert.ok(pendingBefore[init.state], 'pending must exist before rotation');

    const { server, port } = await startAdminServer(wm, oauth);
    try {
      // PUT /oauth/client with the SAME clientId (operator re-enters same
      // value). isRotation=true from the route's perspective, but the
      // client-field discriminator in completeAuthorization cannot
      // distinguish this from the prior client.
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/oauth/client`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'SAME_CLIENT', clientSecret: null, authMethod: 'none' }),
      });
      assert.equal(r.status, 200, 'same-client PUT must succeed');

      // Critical assertion: the stale pending entry must be GONE.
      const pendingAfter = await oauth._loadPending();
      assert.equal(pendingAfter[init.state], undefined,
        'pending auth state must be purged after client rotation (stale callback cannot resurrect)');

      // And a stale completeAuthorization attempt must fail.
      await assert.rejects(
        () => oauth.completeAuthorization(init.state, 'some-code'),
        /state_not_found_or_already_used|STATE_NOT_FOUND/,
        'stale completeAuthorization must be rejected after rotation',
      );
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('§4.10a-1b: /api/oauth/discover response does NOT include cachedClient field', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'phase10a-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: true });
  const base = await mock.start();
  try {
    const wm = makeWm([]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await startAdminServer(wm, oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/oauth/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${base}/mcp` }),
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.data.issuer, base);
      assert.equal(body.data.dcrSupported, true);
      assert.equal(body.data.cachedClient, undefined, '§4.10a-1b: cachedClient field must be removed from discover response');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
