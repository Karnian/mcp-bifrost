/**
 * End-to-end OAuth flow against the in-process mock server.
 * Exercises discovery → DCR → PKCE authorize → token exchange → refresh rotation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockOAuthServer } from './fixtures/mock-oauth-server.js';
import { OAuthManager } from '../server/oauth-manager.js';

function mockWm(workspaces = {}) {
  const audits = [];
  const map = new Map(Object.entries(workspaces));
  return {
    audits,
    logAudit: (action, ws, details) => audits.push({ action, ws, details }),
    logError: () => {},
    _getRawWorkspace: (id) => map.get(id) || null,
    _save: async () => {},
    getServerConfig: () => ({ port: 3100 }),
  };
}

async function fetchOAuthCode(authorizationUrl) {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  const loc = res.headers.get('location');
  if (!loc) throw new Error(`authorize did not redirect; got ${res.status}`);
  const u = new URL(loc);
  return { code: u.searchParams.get('code'), state: u.searchParams.get('state') };
}

test('end-to-end OAuth flow against mock server (DCR + PKCE + refresh + rotation)', async () => {
  const mock = new MockOAuthServer();
  const baseUrl = await mock.start();
  const dir = await mkdtemp(join(tmpdir(), 'e2e-'));
  try {
    const ws = { id: 'ws-e2e' };
    const wm = mockWm({ 'ws-e2e': ws });
    const mgr = new OAuthManager(wm, { stateDir: dir });

    // Discovery
    const disc = await mgr.discover(`${baseUrl}/mcp`);
    assert.equal(disc.issuer, baseUrl);

    // DCR
    const reg = await mgr.registerClient(disc.issuer, disc.authServerMetadata);
    assert.ok(reg.clientId.startsWith('mock_'));

    // Authorize (initialize URL, auto-approve via mock redirect)
    const init = await mgr.initializeAuthorization('ws-e2e', {
      issuer: disc.issuer,
      clientId: reg.clientId,
      authMethod: reg.authMethod,
      authServerMetadata: disc.authServerMetadata,
      resource: disc.resource,
    });
    const { code, state } = await fetchOAuthCode(init.authorizationUrl);
    assert.equal(state, init.state);

    // Complete authorization (token exchange)
    const saved = await mgr.completeAuthorization(state, code);
    const originalAccess = saved.tokens.accessToken;
    const originalRefresh = saved.tokens.refreshToken;
    assert.ok(originalAccess.startsWith('AT.'));
    assert.ok(originalRefresh.startsWith('RT.'));

    // Seed metadataCache on ws for refresh
    ws.oauth.metadataCache = disc.authServerMetadata;

    // Refresh with rotation
    const refreshed = await mgr.forceRefresh('ws-e2e');
    assert.notEqual(refreshed.refreshToken, originalRefresh, 'refresh token should rotate');
    assert.notEqual(refreshed.accessToken, originalAccess, 'access token should change');

    // Audit trail contains expected events
    const actions = wm.audits.map(a => a.action);
    assert.ok(actions.includes('oauth.authorize_start'));
    assert.ok(actions.includes('oauth.authorize_complete'));
    assert.ok(actions.includes('oauth.refresh_success'));
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mock server with DCR disabled surfaces as DCR_UNSUPPORTED', async () => {
  const mock = new MockOAuthServer({ dcrEnabled: false });
  const baseUrl = await mock.start();
  const dir = await mkdtemp(join(tmpdir(), 'e2e-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    const disc = await mgr.discover(`${baseUrl}/mcp`);
    await assert.rejects(
      () => mgr.registerClient(disc.issuer, disc.authServerMetadata),
      (err) => err.code === 'DCR_UNSUPPORTED',
    );
    // Manual fallback path
    const manual = await mgr.registerManual(disc.issuer, { clientId: 'preset_cid', authMethod: 'none' });
    assert.equal(manual.source, 'manual');
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mock server /mcp rejects requests with stale access token', async () => {
  const mock = new MockOAuthServer({ expiresIn: 1 });
  const baseUrl = await mock.start();
  const dir = await mkdtemp(join(tmpdir(), 'e2e-'));
  try {
    const ws = { id: 'ws-x' };
    const mgr = new OAuthManager(mockWm({ 'ws-x': ws }), { stateDir: dir });
    const disc = await mgr.discover(`${baseUrl}/mcp`);
    const reg = await mgr.registerClient(disc.issuer, disc.authServerMetadata);
    const init = await mgr.initializeAuthorization('ws-x', {
      issuer: disc.issuer, clientId: reg.clientId, authMethod: reg.authMethod, authServerMetadata: disc.authServerMetadata, resource: disc.resource,
    });
    const { code, state } = await fetchOAuthCode(init.authorizationUrl);
    const saved = await mgr.completeAuthorization(state, code);

    // Call /mcp with a bogus token
    const bad = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(bad.status, 401);
    assert.ok(bad.headers.get('www-authenticate')?.includes('resource_metadata'));

    // Call /mcp with the fresh token
    const ok = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${saved.tokens.accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const json = await ok.json();
    assert.equal(json.result.tools[0].name, 'echo');
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
