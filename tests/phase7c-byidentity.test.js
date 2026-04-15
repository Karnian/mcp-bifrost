/**
 * Phase 7c — byIdentity OAuth isolation (full authorize + use flow).
 *
 * End-to-end against the mock OAuth server with two distinct identities
 * against the same workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { MockOAuthServer } from './fixtures/mock-oauth-server.js';
import { createAdminRoutes } from '../admin/routes.js';

function makeWm(ws) {
  return {
    config: { workspaces: [ws], server: { port: 3100 }, tunnel: {} },
    _getRawWorkspace: id => (id === ws.id ? ws : null),
    getServerConfig: () => ({ port: 3100 }),
    _save: async () => {},
    logAudit: () => {},
    logError: () => {},
    getAdminToken: () => null,
    getWorkspaces: () => [ws],
    getWorkspace: () => ws,
    fileSecurityWarning: false,
    oauthAuditLog: [],
  };
}

async function bootRoutes(wm, oauth) {
  const routes = createAdminRoutes(wm, { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 }, { getSessionCount: () => 0 }, oauth, null);
  const server = createServer((req, res) => routes(req, res, new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function driveOAuth(authorizationUrl) {
  const r = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location'));
  return { code: u.searchParams.get('code'), state: u.searchParams.get('state') };
}

test('Two identities against the same workspace: independent tokens + isolated refresh', async () => {
  const mock = new MockOAuthServer();
  const base = await mock.start();
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7c-'));
  try {
    const ws = {
      id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`, oauth: null,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
    };
    const wm = makeWm(ws);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const { server, port } = await bootRoutes(wm, oauth);
    try {
      const authorize = async (identity, body = {}) => {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity, ...body }),
        });
        return r.json();
      };

      // 1. default identity authorize
      const r1 = await authorize('default');
      assert.ok(r1.data?.authorizationUrl, `authorize default failed: ${JSON.stringify(r1)}`);
      assert.equal(r1.data.identity, 'default');
      const { code: c1, state: s1 } = await driveOAuth(r1.data.authorizationUrl);
      await oauth.completeAuthorization(s1, c1);

      // 2. bot_ci identity authorize (same ws, different identity)
      const r2 = await authorize('bot_ci');
      assert.ok(r2.data?.authorizationUrl);
      assert.equal(r2.data.identity, 'bot_ci');
      const { code: c2, state: s2 } = await driveOAuth(r2.data.authorizationUrl);
      await oauth.completeAuthorization(s2, c2);

      // 3. Tokens stored separately under byIdentity
      const defTok = ws.oauth.byIdentity.default.tokens;
      const botTok = ws.oauth.byIdentity.bot_ci.tokens;
      assert.ok(defTok.accessToken && defTok.accessToken.startsWith('AT.'));
      assert.ok(botTok.accessToken && botTok.accessToken.startsWith('AT.'));
      assert.notEqual(defTok.accessToken, botTok.accessToken);
      assert.notEqual(defTok.refreshToken, botTok.refreshToken);
      // Legacy mirror reflects default only
      assert.equal(ws.oauth.tokens.accessToken, defTok.accessToken);

      // 4. getValidAccessToken routes by identity
      assert.equal(await oauth.getValidAccessToken('w1', 'default'), defTok.accessToken);
      assert.equal(await oauth.getValidAccessToken('w1', 'bot_ci'), botTok.accessToken);
      // Default (no arg)
      assert.equal(await oauth.getValidAccessToken('w1'), defTok.accessToken);

      // 5. Force refresh bot_ci only → default token untouched
      const defBefore = defTok.accessToken;
      await oauth.forceRefresh('w1', 'bot_ci');
      assert.notEqual(ws.oauth.byIdentity.bot_ci.tokens.accessToken, botTok.accessToken);
      assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, defBefore);

      // 6. Per-identity action_needed: force bot_ci refresh with a bogus refreshToken → flag set only for bot_ci
      ws.oauth.byIdentity.bot_ci.tokens.refreshToken = 'bogus';
      await assert.rejects(() => oauth.forceRefresh('w1', 'bot_ci'));
      assert.equal(ws.oauthActionNeededBy.bot_ci, true);
      assert.ok(!ws.oauthActionNeededBy.default);
      // Legacy bool unaffected since default still OK
      assert.ok(!ws.oauthActionNeeded);
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('admin /authorize rejects invalid identity slugs', async () => {
  const mock = new MockOAuthServer();
  const base = await mock.start();
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7c-slug-'));
  try {
    const ws = { id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`, oauth: null };
    const wm = makeWm(ws);
    const oauth = new OAuthManager(wm, { stateDir });
    const { server, port } = await bootRoutes(wm, oauth);
    try {
      for (const bad of ['has space', 'has/slash', '../escape', '']) {
        // '' is explicitly-present-but-empty → must be rejected (not coerced to 'default')
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: bad }),
        });
        assert.equal(r.status, 400, `expected 400 for bad identity "${bad}"`);
        const j = await r.json();
        assert.equal(j.error.code, 'INVALID_IDENTITY');
      }
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Invalid identity is rejected BEFORE any side-effecting discovery/register', async () => {
  const mock = new MockOAuthServer();
  const base = await mock.start();
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7c-sideeffect-'));
  try {
    const ws = { id: 'w1', kind: 'mcp-client', transport: 'http', url: `${base}/mcp`, oauth: null };
    const wm = makeWm(ws);
    const oauth = new OAuthManager(wm, { stateDir });
    const { server, port } = await bootRoutes(wm, oauth);
    try {
      // Count mock requests before the call
      const before = mock.requests.length;
      const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: 'has space' }),
      });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.error.code, 'INVALID_IDENTITY');
      // No discovery/register happened
      assert.equal(mock.requests.length, before, 'no HTTP side-effects on invalid identity');
      // ws.oauth must remain untouched (no discovered metadata or clientId saved)
      assert.equal(ws.oauth, null);
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Per-identity warm-up is skipped when default tokens absent (false-positive guard)', async () => {
  const { WorkspaceManager } = await import('../server/workspace-manager.js');
  const wm = new WorkspaceManager();
  wm.config = {
    workspaces: [
      { id: 'w1', kind: 'mcp-client', transport: 'http', url: 'https://example/mcp',
        provider: 'notion', namespace: 'x', displayName: 'X', enabled: true,
        oauth: { enabled: true } }, // no tokens yet
    ],
    server: { port: 3100 },
  };
  wm._loaded = true;
  // Stub the OAuthManager to track calls
  let refreshCalled = 0;
  wm.setOAuthManager({
    getValidAccessToken: async () => { refreshCalled++; return null; },
    forceRefresh: async () => {},
  });
  // Initialize providers — warm-up should NOT fire tokenProvider (no tokens)
  await wm._initProviders();
  // Give the process tick for any microtask
  await new Promise(r => setImmediate(r));
  const ws = wm.config.workspaces[0];
  assert.equal(ws.oauthActionNeeded, undefined, 'should not be flagged action_needed on cold start');
});
