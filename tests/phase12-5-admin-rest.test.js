/**
 * Phase 12-5 — Admin REST endpoints for Slack OAuth.
 *
 * Coverage (plan §4.3):
 *   - GET    /api/slack/app                   — masked app + publicOrigin diag
 *   - POST   /api/slack/app                   — credential register/update
 *   - DELETE /api/slack/app                   — refuse w/ dependents, force OK
 *   - POST   /api/slack/install/start         — install flow init
 *   - GET    /api/slack/install/status        — pending/completed/failed polling
 *   - GET    /api/slack/manifest.yaml         — admin-protected manifest download
 *   - POST   /api/workspaces/:id/slack/refresh
 *   - POST   /api/workspaces/:id/slack/disconnect
 *   - GET    /oauth/slack/callback             — postMessage HTML + status update
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startServer } from '../server/index.js';
import { PUBLIC_ORIGIN_ENV_VAR } from '../server/public-origin.js';

const ENV_BACKUP = {};
function setEnv(k, v) {
  if (!(k in ENV_BACKUP)) ENV_BACKUP[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(ENV_BACKUP)) delete ENV_BACKUP[k];
}

async function bootServer(initialConfig = {}, slackOAuthFetch = null) {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-5-admin-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    server: { port: 0, host: '127.0.0.1' },
    workspaces: [],
    ...initialConfig,
  }), 'utf-8');
  const srv = await startServer({ port: 0, host: '127.0.0.1', configDir: dir });
  // Wire test-controlled fetch into SlackOAuthManager so we can simulate
  // Slack token endpoints without hitting the network.
  if (slackOAuthFetch) srv.slackOAuth.fetch = slackOAuthFetch;
  const teardown = async () => {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  };
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  return { srv, baseUrl, teardown, dir };
}

beforeEach(() => setEnv(PUBLIC_ORIGIN_ENV_VAR, 'https://bifrost.test'));
afterEach(() => restoreEnv());

// ─── /api/slack/app ──────────────────────────────────────────────────

test('GET /api/slack/app — empty config', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/slack/app`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.hasSecret, false);
    assert.equal(body.data.sources.clientSecret, 'none');
    assert.equal(body.data.publicOrigin.valid, true);
    assert.equal(body.data.redirectUri, 'https://bifrost.test/oauth/slack/callback');
  } finally { await teardown(); }
});

test('POST /api/slack/app — register valid credentials', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/slack/app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: '111111.222222', clientSecret: 'abcdef' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.clientId, '111111.222222');
    assert.equal(body.data.hasSecret, true);
  } finally { await teardown(); }
});

test('POST /api/slack/app — malformed clientId rejected', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/slack/app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'not-slack', clientSecret: 'abc' }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  } finally { await teardown(); }
});

test('DELETE /api/slack/app — refuses if dependent OAuth workspace exists', async () => {
  const { baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
        status: 'active',
      },
    }],
  });
  try {
    let r = await fetch(`${baseUrl}/api/slack/app`, { method: 'DELETE' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error.code, 'SLACK_APP_HAS_DEPENDENTS');
    assert.equal(body.error.dependentCount, 1);
    // Force overrides
    r = await fetch(`${baseUrl}/api/slack/app?force=true`, { method: 'DELETE' });
    assert.equal(r.status, 200);
  } finally { await teardown(); }
});

// ─── /api/slack/install/* ────────────────────────────────────────────

test('POST /api/slack/install/start — initializes flow + status pending', async () => {
  const { baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
  });
  try {
    const r = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.match(body.data.installId, /^inst_/);
    assert.match(body.data.authorizationUrl, /^https:\/\/slack\.com\/oauth\/v2\/authorize/);
    assert.match(body.data.authorizationUrl, /redirect_uri=https%3A%2F%2Fbifrost\.test%2Foauth%2Fslack%2Fcallback/);
    // Status polling reflects pending
    const sr = await fetch(`${baseUrl}/api/slack/install/status?installId=${body.data.installId}`);
    assert.equal(sr.status, 200);
    const status = (await sr.json()).data;
    assert.equal(status.status, 'pending');
  } finally { await teardown(); }
});

test('POST /api/slack/install/start — 412 when SLACK_APP_NOT_CONFIGURED', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 412);
    const body = await r.json();
    assert.equal(body.error.code, 'SLACK_APP_NOT_CONFIGURED');
  } finally { await teardown(); }
});

test('POST /api/slack/install/start — 412 when BIFROST_PUBLIC_URL missing', async () => {
  setEnv(PUBLIC_ORIGIN_ENV_VAR, undefined);
  const { baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
  });
  try {
    const r = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 412);
    const body = await r.json();
    assert.equal(body.error.code, 'PUBLIC_ORIGIN_MISSING');
  } finally { await teardown(); }
});

test('GET /api/slack/install/status — unknown installId returns "unknown"', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/slack/install/status?installId=inst_nope`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.data.status, 'unknown');
  } finally { await teardown(); }
});

// ─── /api/slack/manifest.yaml ────────────────────────────────────────

test('GET /api/slack/manifest.yaml — stamps redirect_url with canonical origin', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/slack/manifest.yaml`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/yaml/);
    const yaml = await r.text();
    assert.match(yaml, /pkce_enabled: false/);
    assert.match(yaml, /https:\/\/bifrost\.test\/oauth\/slack\/callback/);
    assert.match(yaml, /token_rotation_enabled: true/);
  } finally { await teardown(); }
});

test('GET /api/slack/manifest.yaml — 412 if BIFROST_PUBLIC_URL missing', async () => {
  setEnv(PUBLIC_ORIGIN_ENV_VAR, undefined);
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/slack/manifest.yaml`);
    assert.equal(r.status, 412);
  } finally { await teardown(); }
});

// ─── /oauth/slack/callback ───────────────────────────────────────────

function fakeSlackFetch({ tokenResponse, revokeResponse }) {
  return async (url, init) => {
    let body;
    if (url === 'https://slack.com/api/oauth.v2.access') {
      body = typeof tokenResponse === 'function' ? tokenResponse(init) : tokenResponse;
    } else if (url === 'https://slack.com/api/auth.revoke') {
      body = revokeResponse || { ok: true };
    } else {
      body = { ok: false, error: 'unexpected_url' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() { return JSON.stringify(body); },
      async json() { return body; },
    };
  };
}

test('GET /oauth/slack/callback — success flips status to completed + creates workspace', async () => {
  const { srv, baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
  }, fakeSlackFetch({
    tokenResponse: {
      ok: true,
      team: { id: 'T01', name: 'ACME' },
      authed_user: {
        id: 'U01', scope: 'search:read,channels:read',
        access_token: 'xoxe.xoxp-1-RT', refresh_token: 'xoxe-1-RT',
        expires_in: 43200, token_type: 'user',
      },
      is_enterprise_install: false,
    },
  }));
  try {
    // Start install to get a state
    const init = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const { installId } = (await init.json()).data;
    // Fetch state from internal manager (injected via _signState)
    const pending = srv.slackOAuth._installPending.get(installId);
    const state = pending.state;

    const cb = await fetch(`${baseUrl}/oauth/slack/callback?code=C1&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 200);
    const html = await cb.text();
    assert.match(html, /Slack 연결 완료/);
    assert.match(html, /bifrost-slack-install/);

    const status = (await (await fetch(`${baseUrl}/api/slack/install/status?installId=${installId}`)).json()).data;
    assert.equal(status.status, 'completed');
    assert.ok(status.workspaceId);
    const wsList = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slack = wsList.find(w => w.provider === 'slack' && w.authMode === 'oauth');
    assert.ok(slack, 'workspace must exist');
    // Masked output — never expose raw token
    assert.ok(!JSON.stringify(slack).includes('xoxe.xoxp-1-RT-FULL'));
  } finally { await teardown(); }
});

test('GET /oauth/slack/callback — slack ?error=access_denied surfaces friendly message + status=failed (Codex R1 BLOCKER 1)', async () => {
  const { srv, baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
  }, fakeSlackFetch({ tokenResponse: { ok: true } }));
  try {
    const init = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const { installId } = (await init.json()).data;
    const state = srv.slackOAuth._installPending.get(installId).state;
    const cb = await fetch(`${baseUrl}/oauth/slack/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 400);
    const html = await cb.text();
    assert.match(html, /거부/);
    // Polling status MUST be 'failed' so UI converges
    const status = (await (await fetch(`${baseUrl}/api/slack/install/status?installId=${installId}`)).json()).data;
    assert.equal(status.status, 'failed');
    assert.equal(status.error, 'access_denied');
  } finally { await teardown(); }
});

test('GET /api/slack/install/status — never exposes "in_progress" (Codex R1 BLOCKER 2)', async () => {
  const { srv, baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
  });
  try {
    const init = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const { installId } = (await init.json()).data;
    // Force 'in_progress' marker
    srv.slackOAuth._markPending(installId, { status: 'in_progress' });
    const sr = await fetch(`${baseUrl}/api/slack/install/status?installId=${installId}`);
    const status = (await sr.json()).data;
    // Externally visible state must collapse to 'pending'
    assert.equal(status.status, 'pending');
  } finally { await teardown(); }
});

test('POST /api/workspaces/:id/slack/refresh — exercises rotation endpoint via forceRefresh (Codex R1 BLOCKER 3)', async () => {
  let refreshHits = 0;
  const fetchImpl = async (url, init) => {
    if (url === 'https://slack.com/api/oauth.v2.access' && String(init.body).includes('grant_type=refresh_token')) {
      refreshHits++;
      const body = {
        ok: true,
        access_token: `xoxe.xoxp-1-FORCE-${refreshHits}`,
        refresh_token: `xoxe-1-FORCE-RT-${refreshHits}`,
        expires_in: 43200, token_type: 'user', scope: 'search:read',
        team: { id: 'T1', name: 'X' },
      };
      return {
        ok: true, status: 200, headers: { get: () => null },
        async text() { return JSON.stringify(body); },
        async json() { return body; },
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, async text() { return '{}'; }, async json() { return {}; } };
  };
  const { baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-fr', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'fr', alias: 'fr', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-OLD',
          refreshToken: 'xoxe-1-OLD',
          // Long-lived — no automatic refresh would fire
          expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
          tokenType: 'user',
        },
        status: 'active',
      },
    }],
  }, fetchImpl);
  try {
    const r = await fetch(`${baseUrl}/api/workspaces/slack-fr/slack/refresh`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(refreshHits, 1, 'force refresh must hit Slack rotation endpoint');
    const body = await r.json();
    // Response masks the token to 12 chars; just verify shape, not full body.
    assert.match(body.data.tokenPrefix, /^xoxe\.xoxp-1-/);
  } finally { await teardown(); }
});

test('POST /api/slack/install/start — 412 also for PUBLIC_ORIGIN_HAS_PATH / INVALID (Codex R1 BLOCKER 4)', async () => {
  setEnv(PUBLIC_ORIGIN_ENV_VAR, 'https://bifrost.test/admin');
  const { baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
  });
  try {
    const r = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(r.status, 412);
    const body = await r.json();
    assert.equal(body.error.code, 'PUBLIC_ORIGIN_HAS_PATH');
  } finally { await teardown(); }
});

test('GET /oauth/slack/callback — invalid state rejected (status_failed broadcast)', async () => {
  const { baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
  });
  try {
    const cb = await fetch(`${baseUrl}/oauth/slack/callback?code=C1&state=bogus`);
    assert.equal(cb.status, 400);
    const html = await cb.text();
    assert.match(html, /state 검증 실패/);
  } finally { await teardown(); }
});

// ─── /api/workspaces/:id/slack/refresh ──────────────────────────────

test('POST /api/workspaces/:id/slack/refresh — admin manual refresh', async () => {
  const { srv, baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-FRESH-VALID',
          refreshToken: 'xoxe-1-OLD',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          tokenType: 'user',
        },
        status: 'active',
      },
    }],
  }, fakeSlackFetch({
    tokenResponse: {
      ok: true,
      access_token: 'xoxe.xoxp-1-NEW-FROM-ADMIN',
      refresh_token: 'xoxe-1-NEW-RT',
      expires_in: 43200, token_type: 'user', scope: 'search:read',
      team: { id: 'T1', name: 'X' },
    },
  }));
  try {
    const r = await fetch(`${baseUrl}/api/workspaces/slack-x/slack/refresh`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.match(body.data.tokenPrefix, /^xoxe\.xoxp-1-/);
  } finally { await teardown(); }
});

test('POST /api/workspaces/:id/slack/refresh — 404 unknown workspace', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/api/workspaces/nope/slack/refresh`, { method: 'POST' });
    assert.equal(r.status, 404);
  } finally { await teardown(); }
});

// ─── /api/workspaces/:id/slack/disconnect ───────────────────────────

test('POST /api/workspaces/:id/slack/disconnect — hard-deletes by default', async () => {
  const { srv, baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxe.xoxp-1', refreshToken: 'xoxe-1', tokenType: 'user' },
        status: 'active',
      },
    }],
  }, fakeSlackFetch({ tokenResponse: { ok: true } }));
  try {
    const r = await fetch(`${baseUrl}/api/workspaces/slack-x/slack/disconnect`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.keepEntry, false);
    // Workspace gone
    const list = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    assert.ok(!list.find(w => w.id === 'slack-x'));
  } finally { await teardown(); }
});

test('POST /api/workspaces/:id/slack/disconnect?keepEntry=true — strips slackOAuth only', async () => {
  const { baseUrl, teardown } = await bootServer({
    slackApp: { clientId: '111.222', clientSecret: 's', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-y', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'y', alias: 'y', enabled: true,
      slackOAuth: {
        team: { id: 'T2', name: 'Y' },
        tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
        status: 'active',
      },
    }],
  }, fakeSlackFetch({ tokenResponse: { ok: true } }));
  try {
    const r = await fetch(`${baseUrl}/api/workspaces/slack-y/slack/disconnect?keepEntry=true`, { method: 'POST' });
    assert.equal(r.status, 200);
    const list = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const ws = list.find(w => w.id === 'slack-y');
    assert.ok(ws, 'entry kept');
    assert.equal(ws.slackOAuth, undefined);
  } finally { await teardown(); }
});
