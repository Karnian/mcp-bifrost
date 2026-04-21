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
    // Phase 10a: getOAuthClient public API
    getOAuthClient: (id) => {
      const ws = workspaces.find(w => w.id === id);
      if (!ws?.oauth) return null;
      if (ws.oauth.client) {
        const c = ws.oauth.client;
        return { clientId: c.clientId, clientSecret: c.clientSecret ? '***' : null, authMethod: c.authMethod, source: c.source, registeredAt: c.registeredAt };
      }
      if (ws.oauth.clientId) return { clientId: ws.oauth.clientId, clientSecret: ws.oauth.clientSecret ? '***' : null, authMethod: ws.oauth.authMethod, source: 'legacy-flat', registeredAt: null };
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
      // Tokens must be invalidated + action_needed flipped
      assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, null);
      assert.equal(ws.oauth.tokens.accessToken, null);
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
      assert.equal(ws.oauth.clientId, 'MY_CID', 'flat mirror (§3.4) written');
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
