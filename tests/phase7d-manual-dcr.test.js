/**
 * Phase 7d — Manual OAuth client_id flow when DCR is unsupported.
 *
 * The admin/routes.js /authorize endpoint already accepts a `manual` field;
 * here we verify the OAuthManager path end-to-end against a mock server with
 * DCR disabled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { OAuthManager } from '../server/oauth-manager.js';
import { MockOAuthServer } from './fixtures/mock-oauth-server.js';
import { createAdminRoutes } from '../admin/routes.js';

function makeWm(workspaces) {
  return {
    config: { workspaces, server: { port: 3100 } },
    _getRawWorkspace: id => workspaces.find(w => w.id === id) || null,
    getServerConfig: () => ({ port: 3100 }),
    _save: async () => {},
    logAudit: () => {},
    logError: () => {},
  };
}

test('Manual client_id flow completes authorization when DCR is disabled', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-phase7d-'));
  await mkdir(stateDir, { recursive: true });
  const mock = new MockOAuthServer({ dcrEnabled: false });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1',
      kind: 'mcp-client',
      transport: 'http',
      url: `${base}/mcp`,
      oauth: null,
    };
    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });

    // 1. Discovery works — resource metadata + auth server metadata.
    const disc = await oauth.discover(ws.url);
    assert.equal(disc.issuer, base);

    // 2. registerClient throws DCR_UNSUPPORTED.
    await assert.rejects(
      () => oauth.registerClient(disc.issuer, disc.authServerMetadata),
      (err) => err.code === 'DCR_UNSUPPORTED'
    );

    // 3. registerManual accepts user-supplied client and caches it.
    const manual = await oauth.registerManual(disc.issuer, {
      clientId: 'user_provided_client',
      clientSecret: 'shh',
      authMethod: 'client_secret_basic',
    });
    assert.equal(manual.clientId, 'user_provided_client');
    assert.equal(manual.source, 'manual');
    const cached = await oauth.getCachedClient(disc.issuer, 'client_secret_basic');
    assert.equal(cached.clientId, 'user_provided_client');

    // 4. initializeAuthorization + simulate mock approval + completeAuthorization
    // Phase 11 §3 — nested ws.oauth.client only.
    ws.oauth = {
      enabled: true,
      issuer: disc.issuer,
      client: {
        clientId: manual.clientId,
        clientSecret: manual.clientSecret,
        authMethod: manual.authMethod,
        source: 'manual',
        registeredAt: new Date().toISOString(),
      },
      metadataCache: disc.authServerMetadata,
    };
    const init = await oauth.initializeAuthorization(ws.id, {
      issuer: disc.issuer,
      clientId: manual.clientId,
      clientSecret: manual.clientSecret,
      authMethod: manual.authMethod,
      authServerMetadata: disc.authServerMetadata,
      resource: disc.resource,
    });
    // Drive the mock /authorize to get a code — follow redirect manually.
    const authRes = await fetch(init.authorizationUrl, { redirect: 'manual' });
    assert.equal(authRes.status, 302);
    const redirLoc = authRes.headers.get('location');
    const code = new URL(redirLoc).searchParams.get('code');
    const state = new URL(redirLoc).searchParams.get('state');
    assert.ok(code && state);

    const result = await oauth.completeAuthorization(state, code);
    assert.ok(result.tokens.accessToken);
    assert.ok(result.tokens.refreshToken);
    // Phase 11 §3 — nested client only.
    assert.equal(result.client.clientId, 'user_provided_client');
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('admin /authorize without manual → DCR_UNSUPPORTED; with manual → 200 authorizationUrl', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-phase7d-admin-'));
  const mock = new MockOAuthServer({ dcrEnabled: false });
  const base = await mock.start();
  try {
    const ws = {
      id: 'w1',
      kind: 'mcp-client',
      transport: 'http',
      url: `${base}/mcp`,
      oauth: null,
      displayName: 'X', namespace: 'x', provider: 'notion', enabled: true,
    };
    const wm = makeWm([ws]);
    // Minimum surface used by admin routes in the /authorize path:
    wm.getAdminToken = () => null;
    wm.getServerConfig = () => ({ port: 3100 });
    wm.getWorkspaces = () => [ws];
    wm.getWorkspace = () => ws;
    wm.addWorkspace = async () => ws;
    wm.config.tunnel = {};
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });
    const routes = createAdminRoutes(wm, { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 }, { getSessionCount: () => 0 }, oauth, null);

    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      routes(req, res, u);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      // 1. Without manual body → server returns 422 DCR_UNSUPPORTED (admin-routes error mapping)
      const r1 = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(r1.status, 422);
      const j1 = await r1.json();
      assert.equal(j1.error.code, 'DCR_UNSUPPORTED');

      // 2. With manual body → 200 + authorizationUrl
      const r2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/w1/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: { clientId: 'user_cid', clientSecret: 'sec', authMethod: 'client_secret_basic' } }),
      });
      assert.equal(r2.status, 200);
      const j2 = await r2.json();
      assert.ok(j2.data.authorizationUrl.includes('client_id=user_cid'));
      assert.equal(j2.data.clientId, 'user_cid');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('registerManual persists entry in issuer cache under "manual" source', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-phase7d-cache-'));
  try {
    const wm = makeWm([]);
    const oauth = new OAuthManager(wm, { stateDir });
    await oauth.registerManual('https://example.test', { clientId: 'cid', clientSecret: null, authMethod: 'none' });
    const cachePath = join(stateDir, 'oauth-issuer-cache.json');
    const raw = JSON.parse(await readFile(cachePath, 'utf-8'));
    // Phase 10a §4.10a-1: legacy 2-arg form falls into the reserved global bucket.
    // Production callers pass workspaceId, landing in `ws::${wsId}::${issuer}::${authMethod}`.
    // Phase 11-7 §6: global bucket is now keyed with `global::` prefix instead
    // of the legacy `__global__::` sentinel so the schema is structurally
    // distinguishable from scoped keys.
    const key = 'global::https://example.test::none';
    assert.ok(raw[key], `cache should have key ${key}`);
    assert.equal(raw[key].clientId, 'cid');
    assert.equal(raw[key].source, 'manual');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
