/**
 * Phase 11-9 §12-2 — Admin Wizard: static-client UX
 *
 * Scope:
 *   - Backend: `GET /api/oauth/redirect-uri` returns the exact URI that
 *     operators should register in Notion / GitHub / generic OAuth
 *     consoles when Dynamic Client Registration is unavailable.
 *
 * Frontend changes (bifrostModal bodyHtml / promptManualClientCreds /
 * provider guide map / CSS) are exercised manually in a browser; this
 * test suite locks the server contract the UI depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { createAdminRoutes } from '../admin/routes.js';

function makeWm() {
  return {
    _getRawWorkspace: () => null,
    getWorkspaces: () => [],
    getOAuthClient: () => null,
    getAdminToken: () => null,
    getMcpToken: () => null,
    oauthAuditLog: [],
    fileSecurityWarning: false,
  };
}

async function startAdmin(oauth) {
  const routes = createAdminRoutes(
    makeWm(),
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

test('GET /api/oauth/redirect-uri returns the OAuthManager redirect URI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-9-'));
  try {
    const oauth = new OAuthManager(makeWm(), { stateDir: dir, redirectPort: 3100 });
    const { server, port } = await startAdmin(oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/oauth/redirect-uri`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.redirectUri, 'http://localhost:3100/oauth/callback');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/oauth/redirect-uri returns redirectUri: null when oauth is not configured', async () => {
  const routes = createAdminRoutes(
    makeWm(),
    { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
    { getSessionCount: () => 0 },
    null, // no OAuthManager
    null,
  );
  const server = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    routes(req, res, u);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/oauth/redirect-uri`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.redirectUri, null);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET /api/oauth/redirect-uri respects a custom redirect port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-9-'));
  try {
    const oauth = new OAuthManager(makeWm(), { stateDir: dir, redirectPort: 4200 });
    const { server, port } = await startAdmin(oauth);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/oauth/redirect-uri`);
      const body = await r.json();
      assert.equal(body.data.redirectUri, 'http://localhost:4200/oauth/callback');
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
