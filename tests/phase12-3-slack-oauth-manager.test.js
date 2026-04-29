/**
 * Phase 12-3 — SlackOAuthManager unit tests.
 *
 * Coverage (plan §4.1 + §6 + §8.1):
 *   - state HMAC sign/verify (typ/aud/iat/exp + tampering)
 *   - state TTL expiry
 *   - parseTokenResponse:
 *       - success (nested authed_user)
 *       - is_enterprise_install: true → reject
 *       - missing authed_user.access_token → reject
 *       - token_type !== 'user' → reject
 *       - rotation half-state (expires_in w/o refresh) → reject
 *       - non-rotating active (no expires_in / no refresh) → accept
 *   - completeInstall:
 *       - HTTP 200 + ok:false → mapped Slack error
 *       - duplicate team install → re-authorize mode
 *       - teamInstallMutex serializes concurrent installs (single entry)
 *       - state_invalid blocks entry
 *       - errorParam (?error=) short-circuits with friendly mapping
 *       - save failure → revoke fresh tokens
 *   - ensureValidAccessToken:
 *       - non-rotating long-lived → returns immediately
 *       - rotating but not near expiry → returns immediately
 *       - near expiry → triggers refresh
 *   - refresh mutex — concurrent calls coalesce to single token endpoint hit
 *   - refresh save failure → action_needed, error propagates
 *   - markActionNeeded
 *   - revoke (best-effort)
 *   - aliasForTeam
 *   - SLACK_OAUTH_CALLBACK_PATH BIFROST_PUBLIC_URL gate
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackOAuthManager, aliasForTeam, describeSlackError } from '../server/slack-oauth-manager.js';
import { WorkspaceManager } from '../server/workspace-manager.js';
import { PUBLIC_ORIGIN_ENV_VAR } from '../server/public-origin.js';

const ENV_BACKUP = {};
function setEnv(value) {
  ENV_BACKUP[PUBLIC_ORIGIN_ENV_VAR] = process.env[PUBLIC_ORIGIN_ENV_VAR];
  if (value === undefined) delete process.env[PUBLIC_ORIGIN_ENV_VAR];
  else process.env[PUBLIC_ORIGIN_ENV_VAR] = value;
}
function restoreEnv() {
  for (const k of Object.keys(ENV_BACKUP)) {
    if (ENV_BACKUP[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_BACKUP[k];
  }
  for (const k of Object.keys(ENV_BACKUP)) delete ENV_BACKUP[k];
}

beforeEach(() => setEnv('https://bifrost.test'));
afterEach(() => restoreEnv());

async function makeWm(initial = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-3-wm-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    slackApp: {
      clientId: '111111.222222',
      clientSecret: 'topsecret',
      tokenRotationEnabled: true,
    },
    workspaces: [],
    ...initial,
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  return { wm, dir };
}

function fakeFetch(handler) {
  return async (url, init) => {
    const body = init?.body || '';
    const result = await handler({ url, init, body, params: new URLSearchParams(typeof body === 'string' ? body : '') });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: { get: () => null },
      async text() { return typeof result.body === 'string' ? result.body : JSON.stringify(result.body); },
      async json() { return typeof result.body === 'string' ? JSON.parse(result.body) : result.body; },
    };
  };
}

// ─── State HMAC ──────────────────────────────────────────────────────

test('state: sign + verify roundtrip succeeds', async () => {
  const mgr = new SlackOAuthManager({});
  const now = Date.now();
  const state = await mgr._signState({
    typ: 'slack-oauth',
    aud: '/oauth/slack/callback',
    installId: 'inst_x',
    iat: now,
    exp: now + 600_000,
  });
  const verified = await mgr._verifyState(state);
  assert.equal(verified.installId, 'inst_x');
});

test('state: tampered signature rejected', async () => {
  const mgr = new SlackOAuthManager({});
  const state = await mgr._signState({
    typ: 'slack-oauth', aud: '/oauth/slack/callback',
    installId: 'inst_x', iat: Date.now(), exp: Date.now() + 600_000,
  });
  const tampered = state.slice(0, -1) + (state.slice(-1) === 'a' ? 'b' : 'a');
  assert.equal(await mgr._verifyState(tampered), null);
});

test('state: wrong typ rejected', async () => {
  const mgr = new SlackOAuthManager({});
  const state = await mgr._signState({
    typ: 'other', aud: '/oauth/slack/callback',
    installId: 'inst_x', iat: Date.now(), exp: Date.now() + 600_000,
  });
  assert.equal(await mgr._verifyState(state), null);
});

test('state: wrong aud rejected', async () => {
  const mgr = new SlackOAuthManager({});
  const state = await mgr._signState({
    typ: 'slack-oauth', aud: '/wrong',
    installId: 'inst_x', iat: Date.now(), exp: Date.now() + 600_000,
  });
  assert.equal(await mgr._verifyState(state), null);
});

test('state: expired exp rejected', async () => {
  const mgr = new SlackOAuthManager({});
  const past = Date.now() - 10_000;
  const state = await mgr._signState({
    typ: 'slack-oauth', aud: '/oauth/slack/callback',
    installId: 'inst_x', iat: past - 1000, exp: past,
  });
  assert.equal(await mgr._verifyState(state), null);
});

test('state: future iat rejected (clock-skew tolerance ≤ 1s)', async () => {
  const mgr = new SlackOAuthManager({});
  const future = Date.now() + 30_000;
  const state = await mgr._signState({
    typ: 'slack-oauth', aud: '/oauth/slack/callback',
    installId: 'inst_x', iat: future, exp: future + 600_000,
  });
  assert.equal(await mgr._verifyState(state), null);
});

// ─── parseTokenResponse ──────────────────────────────────────────────

function validResponse(over = {}) {
  return {
    ok: true,
    team: { id: 'T01', name: 'ACME' },
    authed_user: {
      id: 'U01',
      scope: 'search:read,channels:read',
      access_token: 'xoxe.xoxp-1-VALID',
      refresh_token: 'xoxe-1-VALID-RT',
      token_type: 'user',
      expires_in: 43200,
    },
    is_enterprise_install: false,
    ...over,
  };
}

test('parseTokenResponse: success → ISO expiresAt + scope split', () => {
  const mgr = new SlackOAuthManager({});
  const parsed = mgr.parseTokenResponse(validResponse());
  assert.equal(parsed.team.id, 'T01');
  assert.equal(parsed.tokens.accessToken, 'xoxe.xoxp-1-VALID');
  assert.equal(parsed.tokens.refreshToken, 'xoxe-1-VALID-RT');
  assert.equal(parsed.tokens.tokenType, 'user');
  assert.match(parsed.tokens.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(parsed.authedUser.scopesGranted, ['search:read', 'channels:read']);
});

test('parseTokenResponse: is_enterprise_install=true → reject', () => {
  const mgr = new SlackOAuthManager({});
  assert.throws(
    () => mgr.parseTokenResponse(validResponse({ is_enterprise_install: true })),
    err => err.code === 'SLACK_ENTERPRISE_INSTALL_REJECTED'
  );
});

test('parseTokenResponse: missing authed_user.access_token → reject (Phase 12 invariant)', () => {
  const mgr = new SlackOAuthManager({});
  const r = validResponse();
  delete r.authed_user.access_token;
  assert.throws(() => mgr.parseTokenResponse(r), err => err.code === 'SLACK_NO_USER_TOKEN');
});

test('parseTokenResponse: token_type=bot → reject', () => {
  const mgr = new SlackOAuthManager({});
  const r = validResponse();
  r.authed_user.token_type = 'bot';
  assert.throws(() => mgr.parseTokenResponse(r), err => err.code === 'SLACK_BAD_TOKEN_TYPE');
});

test('parseTokenResponse: expires_in without refresh_token → half-state reject', () => {
  const mgr = new SlackOAuthManager({});
  const r = validResponse();
  delete r.authed_user.refresh_token;
  assert.throws(() => mgr.parseTokenResponse(r), err => err.code === 'SLACK_ROTATION_HALF_STATE');
});

test('parseTokenResponse: refresh_token without expires_in → half-state reject (Codex R1 BLOCKER)', () => {
  const mgr = new SlackOAuthManager({});
  const r = validResponse();
  delete r.authed_user.expires_in;
  assert.throws(() => mgr.parseTokenResponse(r), err => err.code === 'SLACK_ROTATION_HALF_STATE');
});

test('parseTokenResponse: token_type missing → reject (Codex R1 REVISE — invariant tighten)', () => {
  const mgr = new SlackOAuthManager({});
  const r = validResponse();
  delete r.authed_user.token_type;
  assert.throws(() => mgr.parseTokenResponse(r), err => err.code === 'SLACK_BAD_TOKEN_TYPE');
});

test('parseTokenResponse: non-rotating active (no expires_in, no refresh) → accept', () => {
  const mgr = new SlackOAuthManager({});
  const r = validResponse();
  delete r.authed_user.refresh_token;
  delete r.authed_user.expires_in;
  const parsed = mgr.parseTokenResponse(r);
  assert.equal(parsed.tokens.accessToken, 'xoxe.xoxp-1-VALID');
  assert.equal(parsed.tokens.refreshToken, undefined);
  assert.equal(parsed.tokens.expiresAt, undefined);
});

test('parseTokenResponse: missing team.id → reject', () => {
  const mgr = new SlackOAuthManager({});
  const r = validResponse();
  delete r.team;
  assert.throws(() => mgr.parseTokenResponse(r), err => err.code === 'SLACK_NO_TEAM');
});

// ─── parseRefreshResponse (Codex R1 BLOCKER — separate parser) ──────

test('parseRefreshResponse: success — top-level access/refresh/expires_in', () => {
  const mgr = new SlackOAuthManager({});
  const parsed = mgr.parseRefreshResponse({
    ok: true,
    access_token: 'xoxe.xoxp-1-NEW',
    refresh_token: 'xoxe-1-NEW-RT',
    expires_in: 43200,
    token_type: 'user',
    scope: 'search:read,channels:read',
    team: { id: 'T01', name: 'ACME' },
  });
  assert.equal(parsed.tokens.accessToken, 'xoxe.xoxp-1-NEW');
  assert.equal(parsed.tokens.refreshToken, 'xoxe-1-NEW-RT');
  assert.equal(parsed.tokens.tokenType, 'user');
  assert.match(parsed.tokens.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('parseRefreshResponse: missing top-level access_token → reject', () => {
  const mgr = new SlackOAuthManager({});
  assert.throws(
    () => mgr.parseRefreshResponse({ ok: true, token_type: 'user' }),
    err => err.code === 'SLACK_NO_ACCESS_TOKEN'
  );
});

test('parseRefreshResponse: token_type !== user rejected', () => {
  const mgr = new SlackOAuthManager({});
  assert.throws(
    () => mgr.parseRefreshResponse({ ok: true, access_token: 'x', token_type: 'bot' }),
    err => err.code === 'SLACK_BAD_TOKEN_TYPE'
  );
});

test('parseRefreshResponse: half-state both directions', () => {
  const mgr = new SlackOAuthManager({});
  assert.throws(
    () => mgr.parseRefreshResponse({ ok: true, access_token: 'x', token_type: 'user', expires_in: 100 }),
    err => err.code === 'SLACK_ROTATION_HALF_STATE'
  );
  assert.throws(
    () => mgr.parseRefreshResponse({ ok: true, access_token: 'x', token_type: 'user', refresh_token: 'r' }),
    err => err.code === 'SLACK_ROTATION_HALF_STATE'
  );
});

test('parseRefreshResponse: is_enterprise_install=true → reject', () => {
  const mgr = new SlackOAuthManager({});
  assert.throws(
    () => mgr.parseRefreshResponse({
      ok: true,
      access_token: 'x',
      refresh_token: 'r',
      expires_in: 100,
      token_type: 'user',
      is_enterprise_install: true,
    }),
    err => err.code === 'SLACK_ENTERPRISE_INSTALL_REJECTED'
  );
});

// ─── State validation (Codex R1 REVISE) ─────────────────────────────

test('state: extra dots (3+ segments) rejected', async () => {
  const mgr = new SlackOAuthManager({});
  assert.equal(await mgr._verifyState('a.b.c'), null);
  assert.equal(await mgr._verifyState('only-one'), null);
});

test('state: missing installId rejected', async () => {
  const mgr = new SlackOAuthManager({});
  // Sign manually without installId
  const state = await mgr._signState({
    typ: 'slack-oauth', aud: '/oauth/slack/callback',
    iat: Date.now(), exp: Date.now() + 600_000,
  });
  assert.equal(await mgr._verifyState(state), null);
});

test('state: TTL bound (exp - iat > 10min + tolerance) rejected', async () => {
  const mgr = new SlackOAuthManager({});
  const now = Date.now();
  // Forged state with 30-min TTL
  const state = await mgr._signState({
    typ: 'slack-oauth', aud: '/oauth/slack/callback',
    installId: 'inst_x',
    iat: now, exp: now + 30 * 60 * 1000,
  });
  assert.equal(await mgr._verifyState(state), null);
});

// ─── completeInstall ─────────────────────────────────────────────────

async function makeManager({ installResponse, refreshResponse }) {
  const { wm, dir } = await makeWm();
  const calls = [];
  const fetchImpl = fakeFetch(async ({ url, params }) => {
    calls.push({ url, body: params.toString() });
    if (url === 'https://slack.com/api/oauth.v2.access') {
      const grant = params.get('grant_type');
      if (grant === 'refresh_token' && refreshResponse) {
        const r = typeof refreshResponse === 'function' ? refreshResponse(params) : refreshResponse;
        return { status: 200, body: r };
      }
      const r = typeof installResponse === 'function' ? installResponse(params) : installResponse;
      return { status: 200, body: r };
    }
    if (url === 'https://slack.com/api/auth.revoke') {
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: 'unknown' } };
  });
  const mgr = new SlackOAuthManager(wm, { fetchImpl });
  return { wm, mgr, dir, calls };
}

test('completeInstall: state_invalid before mutex (no entry created)', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: { ok: false, error: 'invalid_code' } });
  try {
    await assert.rejects(
      () => mgr.completeInstall({ code: 'C1', state: 'tampered.state' }),
      err => err.code === 'STATE_INVALID'
    );
    assert.equal(wm.config.workspaces.length, 0);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeInstall: errorParam (with valid state) flips status to failed (Codex 12-5 R1 BLOCKER 1)', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    const start = await mgr.initializeInstall({});
    const st = await makeStateFor(mgr, start.installId);
    await assert.rejects(
      () => mgr.completeInstall({ errorParam: 'access_denied', state: st }),
      err => err.code === 'SLACK_AUTHORIZE_ERROR' && err.slackError === 'access_denied'
    );
    // Polling status now reflects the failure.
    const status = mgr.getInstallStatus(start.installId);
    assert.equal(status.status, 'failed');
    assert.equal(status.error, 'access_denied');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeInstall: errorParam with bad state rejects as STATE_INVALID (precedence)', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    await assert.rejects(
      () => mgr.completeInstall({ errorParam: 'access_denied', state: 'bogus.state' }),
      err => err.code === 'STATE_INVALID'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateFor(mgr, installId) {
  return mgr._signState({
    typ: 'slack-oauth',
    aud: '/oauth/slack/callback',
    installId,
    iat: Date.now(),
    exp: Date.now() + 600_000,
  });
}

test('completeInstall: HTTP 200 + ok:false maps Slack error', async () => {
  const { wm, mgr, dir } = await makeManager({
    installResponse: { ok: false, error: 'bad_redirect_uri' },
  });
  try {
    const start = await mgr.initializeInstall({});
    const st = await makeStateFor(mgr, start.installId);
    await assert.rejects(
      () => mgr.completeInstall({ code: 'C1', state: st }),
      err => err.code === 'SLACK_OAUTH_ERROR' && err.slackError === 'bad_redirect_uri'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeInstall: success creates workspace + masks audit + status=completed', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    const start = await mgr.initializeInstall({});
    const st = await makeStateFor(mgr, start.installId);
    const result = await mgr.completeInstall({ code: 'C1', state: st });
    assert.equal(result.mode, 'create');
    assert.equal(result.team.id, 'T01');
    const status = mgr.getInstallStatus(start.installId);
    assert.equal(status.status, 'completed');
    assert.equal(status.workspaceId, result.workspaceId);
    const ws = wm.getRawWorkspace(result.workspaceId);
    assert.equal(ws.authMode, 'oauth');
    assert.equal(ws.slackOAuth.team.id, 'T01');
    assert.equal(ws.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-VALID');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeInstall: duplicate team → re-authorize mode (single entry)', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    const s1 = await mgr.initializeInstall({});
    const st1 = await makeStateFor(mgr, s1.installId);
    const r1 = await mgr.completeInstall({ code: 'C1', state: st1 });
    assert.equal(r1.mode, 'create');

    const s2 = await mgr.initializeInstall({});
    const st2 = await makeStateFor(mgr, s2.installId);
    const r2 = await mgr.completeInstall({ code: 'C2', state: st2 });
    assert.equal(r2.mode, 're-authorize');
    assert.equal(r2.workspaceId, r1.workspaceId);
    assert.equal(wm.config.workspaces.length, 1);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeInstall: same-team concurrent installs serialized (single entry)', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    const s1 = await mgr.initializeInstall({});
    const s2 = await mgr.initializeInstall({});
    const st1 = await makeStateFor(mgr, s1.installId);
    const st2 = await makeStateFor(mgr, s2.installId);
    const [r1, r2] = await Promise.all([
      mgr.completeInstall({ code: 'C1', state: st1 }),
      mgr.completeInstall({ code: 'C2', state: st2 }),
    ]);
    // Exactly one create + one re-authorize, single workspace entry.
    const modes = new Set([r1.mode, r2.mode]);
    assert.deepEqual([...modes].sort(), ['create', 're-authorize']);
    assert.equal(r1.workspaceId, r2.workspaceId);
    assert.equal(wm.config.workspaces.length, 1);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeInstall: parse failure (is_enterprise_install) revokes fresh access token', async () => {
  const { wm, mgr, dir, calls } = await makeManager({
    installResponse: validResponse({ is_enterprise_install: true }),
  });
  try {
    const start = await mgr.initializeInstall({});
    const st = await makeStateFor(mgr, start.installId);
    await assert.rejects(
      () => mgr.completeInstall({ code: 'C1', state: st }),
      err => err.code === 'SLACK_ENTERPRISE_INSTALL_REJECTED'
    );
    // Ensure auth.revoke was attempted as best-effort cleanup.
    assert.ok(calls.some(c => c.url === 'https://slack.com/api/auth.revoke'),
      'expected best-effort revoke after parse rejection');
    assert.equal(wm.config.workspaces.length, 0);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeInstall: BIFROST_PUBLIC_URL missing surfaces friendly error', async () => {
  setEnv(undefined);
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    await assert.rejects(
      () => mgr.initializeInstall({}),
      err => err.code === 'PUBLIC_ORIGIN_MISSING'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('initializeInstall: SLACK_APP_NOT_CONFIGURED if credential absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-3-noapp-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const mgr = new SlackOAuthManager(wm, { fetchImpl: fakeFetch(async () => ({ status: 200, body: { ok: true } })) });
    await assert.rejects(
      () => mgr.initializeInstall({}),
      err => err.code === 'SLACK_APP_NOT_CONFIGURED'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── ensureValidAccessToken ──────────────────────────────────────────

test('ensureValidAccessToken: rejects unknown workspace', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    await assert.rejects(
      () => mgr.ensureValidAccessToken('does-not-exist'),
      err => err.code === 'WORKSPACE_NOT_FOUND'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureValidAccessToken: non-rotating active (no expiresAt, no refreshToken) returns immediately', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxp-long-lived', tokenType: 'user' },
        status: 'active',
      },
    });
    const ws = wm.config.workspaces[0];
    const tok = await mgr.ensureValidAccessToken(ws.id);
    assert.equal(tok, 'xoxp-long-lived');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureValidAccessToken: rotating not near expiry returns immediately', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-FRESH',
          refreshToken: 'xoxe-1-RT',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          tokenType: 'user',
        },
        status: 'active',
      },
    });
    const ws = wm.config.workspaces[0];
    const tok = await mgr.ensureValidAccessToken(ws.id);
    assert.equal(tok, 'xoxe.xoxp-1-FRESH');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureValidAccessToken: near expiry triggers refresh + persists rotated tokens', async () => {
  const { wm, mgr, dir, calls } = await makeManager({
    installResponse: validResponse(),
    refreshResponse: () => ({
      ok: true,
      access_token: 'xoxe.xoxp-1-NEW',
      refresh_token: 'xoxe-1-NEW-RT',
      expires_in: 43200,
      token_type: 'user',
      scope: 'search:read',
      team: { id: 'T1', name: 'X' },
    }),
  });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-OLD',
          refreshToken: 'xoxe-1-OLD-RT',
          expiresAt: new Date(Date.now() + 5_000).toISOString(), // < leeway
          tokenType: 'user',
        },
        status: 'active',
      },
    });
    const ws = wm.config.workspaces[0];
    const tok = await mgr.ensureValidAccessToken(ws.id);
    assert.equal(tok, 'xoxe.xoxp-1-NEW');
    const refreshed = wm.getRawWorkspace(ws.id);
    assert.equal(refreshed.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-NEW');
    assert.equal(refreshed.slackOAuth.tokens.refreshToken, 'xoxe-1-NEW-RT');
    // exactly one refresh request observed
    const refreshCalls = calls.filter(c => c.url === 'https://slack.com/api/oauth.v2.access' && c.body.includes('grant_type=refresh_token'));
    assert.equal(refreshCalls.length, 1);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh mutex: concurrent ensureValidAccessToken coalesces single token endpoint hit', async () => {
  let refreshHits = 0;
  const { wm, mgr, dir, calls } = await makeManager({
    installResponse: validResponse(),
    refreshResponse: () => {
      refreshHits++;
      return {
        ok: true,
        access_token: `xoxe.xoxp-1-NEW-${refreshHits}`,
        refresh_token: `xoxe-1-NEW-RT-${refreshHits}`,
        expires_in: 43200,
        token_type: 'user',
        scope: 'search:read',
        team: { id: 'T1', name: 'X' },
      };
    },
  });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-OLD',
          refreshToken: 'xoxe-1-OLD-RT',
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
          tokenType: 'user',
        },
        status: 'active',
      },
    });
    const ws = wm.config.workspaces[0];
    const [a, b, c] = await Promise.all([
      mgr.ensureValidAccessToken(ws.id),
      mgr.ensureValidAccessToken(ws.id),
      mgr.ensureValidAccessToken(ws.id),
    ]);
    // First fires real refresh; subsequent calls observe rotated token.
    assert.equal(refreshHits, 1, 'expected single refresh under mutex');
    assert.equal(a, 'xoxe.xoxp-1-NEW-1');
    assert.equal(b, 'xoxe.xoxp-1-NEW-1');
    assert.equal(c, 'xoxe.xoxp-1-NEW-1');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh: invalid_grant maps to action_needed + propagates SLACK_OAUTH_ERROR', async () => {
  const { wm, mgr, dir } = await makeManager({
    installResponse: validResponse(),
    refreshResponse: { ok: false, error: 'invalid_grant' },
  });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-OLD',
          refreshToken: 'xoxe-1-OLD-RT',
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
          tokenType: 'user',
        },
        status: 'active',
      },
    });
    const ws = wm.config.workspaces[0];
    await assert.rejects(
      () => mgr.ensureValidAccessToken(ws.id),
      err => err.slackError === 'invalid_grant'
    );
    const after = wm.getRawWorkspace(ws.id);
    assert.equal(after.slackOAuth.status, 'action_needed');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh: uses TOP-LEVEL refresh response shape (Codex R1 BLOCKER fix)', async () => {
  // Slack token rotation refresh response is top-level access/refresh/
  // expires_in — no authed_user wrapper. Verifies parseRefreshResponse
  // is wired up.
  const { wm, mgr, dir } = await makeManager({
    installResponse: validResponse(),
    refreshResponse: () => ({
      ok: true,
      access_token: 'xoxe.xoxp-1-ROTATED',
      refresh_token: 'xoxe-1-ROTATED-RT',
      expires_in: 43200,
      token_type: 'user',
      scope: 'search:read,channels:read',
      team: { id: 'T1', name: 'X' },
    }),
  });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-OLD',
          refreshToken: 'xoxe-1-OLD-RT',
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
          tokenType: 'user',
        },
        status: 'active',
      },
    });
    const ws = wm.config.workspaces[0];
    const tok = await mgr.ensureValidAccessToken(ws.id);
    assert.equal(tok, 'xoxe.xoxp-1-ROTATED');
    const after = wm.getRawWorkspace(ws.id);
    assert.equal(after.slackOAuth.tokens.refreshToken, 'xoxe-1-ROTATED-RT');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateSlackOAuthAtomic: disk write failure leaves this.config UNCHANGED (Codex R2 atomic)', async () => {
  // Verifies the strict clone-then-swap contract: this.config must not
  // observe the new tokens at any point during a failed save.
  const dir = await mkdtemp(join(tmpdir(), 'phase12-3-cts-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    slackApp: { clientId: '111.222', clientSecret: 'sec', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'OLD', tokenType: 'user' },
        status: 'active',
      },
    }],
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    // Make _saveSnapshot throw
    const realSnap = wm._saveSnapshot.bind(wm);
    wm._saveSnapshot = async () => { throw new Error('snapshot disk fail'); };
    await assert.rejects(
      () => wm.updateSlackOAuthAtomic('slack-x', (cur) => ({
        ...cur, tokens: { accessToken: 'NEW-FAILED', tokenType: 'user' },
      })),
      err => /snapshot disk fail/.test(err.message)
    );
    // this.config must still expose OLD
    const ws = wm.getRawWorkspace('slack-x');
    assert.equal(ws.slackOAuth.tokens.accessToken, 'OLD');
    // Restore + retry succeeds
    wm._saveSnapshot = realSnap;
    await wm.updateSlackOAuthAtomic('slack-x', (cur) => ({
      ...cur, tokens: { accessToken: 'NEW-OK', tokenType: 'user' },
    }));
    assert.equal(wm.getRawWorkspace('slack-x').slackOAuth.tokens.accessToken, 'NEW-OK');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateSlackOAuthAtomic: concurrent updateWorkspace mutations preserved (Codex R3 in-place commit)', async () => {
  // Whole-config swap would lose a concurrent displayName change.
  // In-place commit ensures other fields are not clobbered.
  const dir = await mkdtemp(join(tmpdir(), 'phase12-3-concurrent-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    slackApp: { clientId: '111.222', clientSecret: 'sec', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', displayName: 'OldName',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'OLD-T', tokenType: 'user' },
        status: 'active',
      },
    }],
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    let releaseSnapshot;
    const blockingSnapshot = new Promise((res) => { releaseSnapshot = res; });
    const realSnap = wm._saveSnapshot.bind(wm);
    wm._saveSnapshot = async (snap) => {
      await blockingSnapshot;
      return realSnap(snap);
    };
    const atomicPromise = wm.updateSlackOAuthAtomic('slack-x', (cur) => ({
      ...cur, tokens: { accessToken: 'NEW-T', tokenType: 'user' },
    }));
    await new Promise(r => setImmediate(r));
    // Concurrent: another caller mutates displayName (e.g. updateWorkspace
    // called from admin). With whole-config swap, this would be lost.
    await wm.updateWorkspace('slack-x', { displayName: 'NewName' });
    releaseSnapshot();
    await atomicPromise;
    const ws = wm.getRawWorkspace('slack-x');
    assert.equal(ws.displayName, 'NewName', 'concurrent displayName must survive atomic commit');
    assert.equal(ws.slackOAuth.tokens.accessToken, 'NEW-T', 'atomic still committed slackOAuth');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateSlackOAuthAtomic: this.config NOT mutated during in-flight save (Codex R2 atomic)', async () => {
  // The snapshot path must keep this.config visible as OLD while the
  // disk write is pending. We assert that synchronous reads after
  // calling updateSlackOAuthAtomic but before awaiting it still see OLD.
  const dir = await mkdtemp(join(tmpdir(), 'phase12-3-inflight-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    slackApp: { clientId: '111.222', clientSecret: 'sec', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'OLD', tokenType: 'user' },
        status: 'active',
      },
    }],
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    let releaseSnapshot;
    const blockingSnapshot = new Promise((res) => { releaseSnapshot = res; });
    const realSnap = wm._saveSnapshot.bind(wm);
    wm._saveSnapshot = async (snap) => {
      await blockingSnapshot;
      return realSnap(snap);
    };
    const promise = wm.updateSlackOAuthAtomic('slack-x', (cur) => ({
      ...cur, tokens: { accessToken: 'NEW-IN-FLIGHT', tokenType: 'user' },
    }));
    // Yield once — let the snapshot build + saveSnapshot fire.
    await new Promise(r => setImmediate(r));
    // CONCURRENT READ: must still see OLD
    assert.equal(
      wm.getRawWorkspace('slack-x').slackOAuth.tokens.accessToken, 'OLD',
      'reader must see OLD until disk write resolves'
    );
    releaseSnapshot();
    await promise;
    assert.equal(
      wm.getRawWorkspace('slack-x').slackOAuth.tokens.accessToken, 'NEW-IN-FLIGHT',
      'after save resolves, swap publishes new token'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh: durable save failure leaves PREVIOUS token in-memory (Codex R1 atomic save)', async () => {
  const { wm, mgr, dir } = await makeManager({
    installResponse: validResponse(),
    refreshResponse: () => ({
      ok: true,
      access_token: 'xoxe.xoxp-1-NEW',
      refresh_token: 'xoxe-1-NEW-RT',
      expires_in: 43200,
      token_type: 'user',
      scope: 'search:read',
      team: { id: 'T1', name: 'X' },
    }),
  });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-OLD',
          refreshToken: 'xoxe-1-OLD-RT',
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
          tokenType: 'user',
        },
        status: 'active',
      },
    });
    const ws = wm.config.workspaces[0];
    // Inject a snapshot save failure — _runRefresh uses
    // updateSlackOAuthAtomic → _saveSnapshot. The follow-up _save() from
    // _markActionNeededInLock is on a different code path so action_needed
    // still gets persisted.
    const realSnap = wm._saveSnapshot.bind(wm);
    let firstCall = true;
    wm._saveSnapshot = async (snap) => {
      if (firstCall) { firstCall = false; throw new Error('disk full'); }
      return realSnap(snap);
    };
    await assert.rejects(
      () => mgr.ensureValidAccessToken(ws.id),
      err => /disk full/.test(err.message)
    );
    const after = wm.getRawWorkspace(ws.id);
    // Atomic clone-then-swap: in-memory token must remain the OLD value,
    // not the new one we couldn't persist.
    assert.equal(after.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-OLD',
      'clone-then-swap must roll back in-memory tokens on save failure');
    assert.equal(after.slackOAuth.tokens.refreshToken, 'xoxe-1-OLD-RT',
      'clone-then-swap must roll back refresh_token too');
    assert.equal(after.slackOAuth.status, 'action_needed');
    assert.equal(after.slackOAuth.actionNeededReason, 'save_failed');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── markActionNeeded / revoke / aliasForTeam / describeSlackError ──

test('markActionNeeded: idempotent — second call reports already', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
        status: 'active',
      },
    });
    const id = wm.config.workspaces[0].id;
    const r1 = await mgr.markActionNeeded(id, 'test_reason');
    assert.equal(r1.marked, true);
    const r2 = await mgr.markActionNeeded(id, 'test_reason');
    assert.ok(r2.alreadyActionNeeded);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('revoke: best-effort even when Slack returns error', async () => {
  const { wm, dir } = await makeWm();
  try {
    await wm.addWorkspace({
      kind: 'native', provider: 'slack', authMode: 'oauth',
      displayName: 'X', alias: 'x',
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: {
          accessToken: 'xoxe.xoxp-1-A',
          refreshToken: 'xoxe-1-R',
          tokenType: 'user',
        },
        status: 'active',
      },
    });
    const id = wm.config.workspaces[0].id;
    const fetchImpl = fakeFetch(async ({ url }) => {
      if (url === 'https://slack.com/api/auth.revoke') {
        return { status: 200, body: { ok: false, error: 'invalid_auth' } };
      }
      return { status: 200, body: { ok: true } };
    });
    const mgr = new SlackOAuthManager(wm, { fetchImpl });
    const r = await mgr.revoke(id);
    assert.equal(r.revoked, true);
    assert.equal(r.accessRevoked, false);
    assert.equal(r.refreshRevoked, false);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('aliasForTeam: lowercase + hyphenate + fallback', () => {
  assert.equal(aliasForTeam('ACME Workspace!'), 'acme-workspace');
  assert.equal(aliasForTeam('---'), 'slack');
  assert.equal(aliasForTeam(''), 'slack');
  assert.equal(aliasForTeam(undefined), 'slack');
});

test('describeSlackError: known + unknown codes', () => {
  assert.match(describeSlackError('bad_redirect_uri'), /Redirect URLs/);
  assert.match(describeSlackError('access_denied'), /거부/);
  assert.match(describeSlackError('mystery_code'), /mystery_code/);
});

// ─── purgeStaleInstalls ──────────────────────────────────────────────

test('purgeStaleInstalls: removes only expired pending entries', async () => {
  const { wm, mgr, dir } = await makeManager({ installResponse: validResponse() });
  try {
    const start = await mgr.initializeInstall({});
    // Force the entry to expire
    const entry = mgr._installPending.get(start.installId);
    entry.expiresAt = Date.now() - 1000;
    const removed = mgr.purgeStaleInstalls();
    assert.equal(removed, 1);
    assert.equal(mgr.getInstallStatus(start.installId).status, 'unknown');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});
