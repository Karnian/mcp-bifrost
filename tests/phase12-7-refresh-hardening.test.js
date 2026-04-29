/**
 * Phase 12-7 — Refresh hardening + token rotation crash recovery + Slack
 * error mapping coverage.
 *
 * The atomic-save / forceRefresh / mutex / state-failure paths landed in
 * 12-3 and 12-5; this phase consolidates the remaining race + recovery +
 * UX-error-mapping tests so the rotation surface is complete:
 *
 *   - rotation under concurrent forceRefresh (mutex re-read fences)
 *   - HTTP 5xx / network error → no token mutation
 *   - markActionNeeded preserves accessToken
 *   - re-authorize after action_needed flips status back to active
 *     (mirrors 12-5 callback duplicate-team detection)
 *   - invalid_client (R7 clientSecret rotation) → action_needed,
 *     accessToken preserved
 *   - SLACK_ERROR_MAP friendly UX coverage with Korean strings asserted
 *     per documented code (Codex 12-7 R1 BLOCKER fix)
 *   - workspace mutex prevents disconnect from racing in-flight refresh
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackOAuthManager, describeSlackError } from '../server/slack-oauth-manager.js';
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

function mockFetch(handler) {
  return async (url, init) => {
    const r = await handler({ url, init });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => r.headers?.[k] || null },
      async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body); },
      async json() { return typeof r.body === 'string' ? JSON.parse(r.body) : r.body; },
    };
  };
}

async function makeSlackOAuth(initial = {}, fetchImpl = null) {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-7-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    slackApp: { clientId: '111111.222222', clientSecret: 's', tokenRotationEnabled: true },
    workspaces: [],
    ...initial,
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  const mgr = new SlackOAuthManager(wm, { fetchImpl: fetchImpl || mockFetch(async () => ({ status: 200, body: { ok: true } })) });
  wm.setSlackOAuthManager(mgr);
  return { wm, mgr, dir };
}

const STD_WS = {
  id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
  namespace: 'x', alias: 'x', enabled: true,
  slackOAuth: {
    team: { id: 'T1', name: 'X' },
    tokens: {
      accessToken: 'xoxe.xoxp-1-OLD',
      refreshToken: 'xoxe-1-OLD-RT',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: 'user',
    },
    status: 'active',
  },
};

// ─── Concurrent forceRefresh + ensureValidAccessToken ──────────────

test('forceRefresh concurrent: 2nd refresh uses ROTATED refresh_token (mutex re-read)', async () => {
  // Codex 12-7 R1 REVISE 2: a no-mutex implementation could let both
  // forceRefresh calls fire with the SAME old refresh_token. The mock
  // explicitly rejects reuse with invalid_grant — the only way the 2nd
  // call succeeds is if the mutex serialized them and the inner
  // _runRefresh re-read the rotated refresh_token from disk.
  const refreshTokensSeen = [];
  let counter = 0;
  const fetchImpl = mockFetch(async ({ url, init }) => {
    if (url === 'https://slack.com/api/oauth.v2.access' && String(init.body).includes('grant_type=refresh_token')) {
      const params = new URLSearchParams(String(init.body));
      const sent = params.get('refresh_token');
      refreshTokensSeen.push(sent);
      // Reject reuse — non-mutex implementations would hit this on the
      // second concurrent call.
      const expected = counter === 0 ? 'xoxe-1-OLD-RT' : `xoxe-1-NEW-${counter}`;
      if (sent !== expected) {
        return { status: 200, body: { ok: false, error: 'invalid_grant' } };
      }
      counter++;
      return { status: 200, body: {
        ok: true, access_token: `xoxe.xoxp-1-NEW-${counter}`, refresh_token: `xoxe-1-NEW-${counter}`,
        expires_in: 43200, token_type: 'user', scope: 'search:read', team: { id: 'T1', name: 'X' },
      } };
    }
    return { status: 200, body: { ok: true } };
  });
  const { wm, mgr, dir } = await makeSlackOAuth({ workspaces: [STD_WS] }, fetchImpl);
  try {
    const [a, b] = await Promise.all([
      mgr.forceRefresh('slack-x'),
      mgr.forceRefresh('slack-x'),
    ]);
    // Both succeed because the mutex forced the 2nd to read the rotated token.
    assert.deepEqual(refreshTokensSeen, ['xoxe-1-OLD-RT', 'xoxe-1-NEW-1']);
    assert.equal(a, 'xoxe.xoxp-1-NEW-1');
    assert.equal(b, 'xoxe.xoxp-1-NEW-2');
    const final = wm.getRawWorkspace('slack-x').slackOAuth.tokens;
    assert.equal(final.accessToken, 'xoxe.xoxp-1-NEW-2');
    assert.equal(final.refreshToken, 'xoxe-1-NEW-2');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── HTTP 5xx / network failure ────────────────────────────────────

test('refresh: HTTP 5xx leaves tokens untouched + no action_needed', async () => {
  const fetchImpl = mockFetch(async () => ({ status: 503, body: 'service unavailable' }));
  const { wm, mgr, dir } = await makeSlackOAuth({ workspaces: [STD_WS] }, fetchImpl);
  try {
    await assert.rejects(
      () => mgr.forceRefresh('slack-x'),
      err => err.code === 'SLACK_HTTP_ERROR' && err.status === 503
    );
    const after = wm.getRawWorkspace('slack-x');
    // 5xx is transient — leave tokens alone, do NOT flip action_needed
    assert.equal(after.slackOAuth.status, 'active');
    assert.equal(after.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-OLD');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh: network error leaves tokens untouched', async () => {
  const fetchImpl = async () => { throw new Error('econnreset'); };
  const { wm, mgr, dir } = await makeSlackOAuth({ workspaces: [STD_WS] }, fetchImpl);
  try {
    await assert.rejects(() => mgr.forceRefresh('slack-x'));
    const after = wm.getRawWorkspace('slack-x');
    assert.equal(after.slackOAuth.status, 'active');
    assert.equal(after.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-OLD');
    assert.equal(after.slackOAuth.tokens.refreshToken, 'xoxe-1-OLD-RT');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── invalid_grant → action_needed → re-authorize recovery ────────

test('refresh: invalid_grant → action_needed → re-authorize completes recovery', async () => {
  let phase = 'invalid';
  const fetchImpl = mockFetch(async ({ url, init }) => {
    if (url === 'https://slack.com/api/oauth.v2.access') {
      const body = String(init.body);
      if (phase === 'invalid' && body.includes('grant_type=refresh_token')) {
        return { status: 200, body: { ok: false, error: 'invalid_grant' } };
      }
      if (body.includes('code=NEW_AUTH_CODE')) {
        return { status: 200, body: {
          ok: true, team: { id: 'T1', name: 'X' },
          authed_user: {
            id: 'U1', scope: 'search:read', token_type: 'user',
            access_token: 'xoxe.xoxp-1-RE-AUTHED', refresh_token: 'xoxe-1-NEW-RT', expires_in: 43200,
          },
          is_enterprise_install: false,
        } };
      }
    }
    return { status: 200, body: { ok: true } };
  });
  const { wm, mgr, dir } = await makeSlackOAuth({ workspaces: [STD_WS] }, fetchImpl);
  try {
    await assert.rejects(
      () => mgr.forceRefresh('slack-x'),
      err => err.slackError === 'invalid_grant'
    );
    let after = wm.getRawWorkspace('slack-x');
    assert.equal(after.slackOAuth.status, 'action_needed');

    // Re-authorize via completeInstall (same team.id triggers re-authorize mode)
    phase = 'reauth';
    const start = await mgr.initializeInstall({});
    const state = start.installId && (await mgr._signState({
      typ: 'slack-oauth', aud: '/oauth/slack/callback',
      installId: start.installId, iat: Date.now(), exp: Date.now() + 600_000,
    }));
    const result = await mgr.completeInstall({ code: 'NEW_AUTH_CODE', state });
    assert.equal(result.mode, 're-authorize');

    after = wm.getRawWorkspace('slack-x');
    assert.equal(after.slackOAuth.status, 'active');
    assert.equal(after.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-RE-AUTHED');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── markActionNeeded preserves accessToken ────────────────────────

test('markActionNeeded: keeps accessToken intact (sets status only)', async () => {
  const { wm, mgr, dir } = await makeSlackOAuth({ workspaces: [STD_WS] });
  try {
    await mgr.markActionNeeded('slack-x', 'test_reason');
    const after = wm.getRawWorkspace('slack-x');
    assert.equal(after.slackOAuth.status, 'action_needed');
    assert.equal(after.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-OLD',
      'accessToken must NOT be nulled — still useful until re-auth');
    assert.equal(after.slackOAuth.actionNeededReason, 'test_reason');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── disconnect-during-refresh mutex ───────────────────────────────

test('disconnect blocks until in-flight refresh completes (mutex)', async () => {
  let releaseRefresh;
  const refreshGate = new Promise(r => { releaseRefresh = r; });
  let refreshDone = false;
  let revoked = false;
  const fetchImpl = mockFetch(async ({ url, init }) => {
    if (url === 'https://slack.com/api/oauth.v2.access' && String(init.body).includes('grant_type=refresh_token')) {
      await refreshGate;
      refreshDone = true;
      return { status: 200, body: {
        ok: true, access_token: 'xoxe.xoxp-1-NEW', refresh_token: 'xoxe-1-NEW-RT',
        expires_in: 43200, token_type: 'user', team: { id: 'T1', name: 'X' },
      } };
    }
    if (url === 'https://slack.com/api/auth.revoke') {
      // Revoke must NOT fire before refresh completes
      assert.ok(refreshDone, 'mutex violated — revoke fired before refresh');
      revoked = true;
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { ok: true } };
  });
  const { wm, mgr, dir } = await makeSlackOAuth({ workspaces: [STD_WS] }, fetchImpl);
  try {
    const refreshPromise = mgr.forceRefresh('slack-x');
    // Yield once so refresh acquires mutex
    await new Promise(r => setImmediate(r));
    const disconnectPromise = mgr.revoke('slack-x', { mode: 'hard-delete' });
    // Release the refresh
    releaseRefresh();
    await refreshPromise;
    await disconnectPromise;
    assert.ok(revoked, 'revoke must have fired after refresh completed');
    // Workspace removed
    assert.equal(wm.getRawWorkspace('slack-x'), undefined);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Slack error mapping ───────────────────────────────────────────

test('describeSlackError: full coverage of documented codes (plan §4.5) — strict per-code Korean text (Codex R1 BLOCKER)', () => {
  // Codex 12-7 R1 BLOCKER: assert specific Korean text for each code so
  // a regression that drops an entry from SLACK_ERROR_MAP and falls
  // through to the generic prefix is caught. Each expectedFragment is
  // the load-bearing concept, not the full sentence.
  const cases = [
    ['bad_redirect_uri', /Redirect URLs/],
    ['invalid_team_for_non_distributed_app', /Public Distribution/],
    ['unapproved_scope', /scope 승인/],
    ['org_login_required', /Enterprise Grid/],
    ['invalid_client', /client_id .* client_secret/],
    ['invalid_client_id', /client_id 가 일치/],
    ['invalid_grant', /refresh_token .* (만료|1회용)/],
    ['access_denied', /거부/],
  ];
  for (const [code, fragment] of cases) {
    const msg = describeSlackError(code);
    assert.match(msg, fragment, `friendly message for ${code} must include "${fragment}"`);
    // Must NOT match the unknown-code fallback shape.
    assert.ok(!/^Slack OAuth error: /.test(msg), `${code} should not fall through to generic prefix`);
  }
});

test('refresh: invalid_client (R7 — clientSecret rotation) → action_needed + accessToken preserved', async () => {
  // Plan §10 R7: when an operator regenerates Slack App clientSecret,
  // pre-existing refresh calls must surface invalid_client → action_needed.
  // The previously-cached accessToken stays in place so masked endpoints
  // / passive readers don't see a null value (re-authorization is the
  // recovery path, but until then the token is still useful where it's
  // already cached upstream).
  const fetchImpl = mockFetch(async ({ url, init }) => {
    if (url === 'https://slack.com/api/oauth.v2.access' && String(init.body).includes('grant_type=refresh_token')) {
      return { status: 200, body: { ok: false, error: 'invalid_client' } };
    }
    return { status: 200, body: { ok: true } };
  });
  const { wm, mgr, dir } = await makeSlackOAuth({ workspaces: [STD_WS] }, fetchImpl);
  try {
    await assert.rejects(
      () => mgr.forceRefresh('slack-x'),
      err => err.slackError === 'invalid_client'
    );
    const after = wm.getRawWorkspace('slack-x');
    assert.equal(after.slackOAuth.status, 'action_needed');
    assert.equal(after.slackOAuth.actionNeededReason, 'invalid_client');
    // accessToken preserved — refresh path nulls *neither* token; only
    // re-authorize replaces them.
    assert.equal(after.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-OLD');
    assert.equal(after.slackOAuth.tokens.refreshToken, 'xoxe-1-OLD-RT');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('describeSlackError: unknown code falls through with raw label', () => {
  const msg = describeSlackError('made_up_error');
  assert.match(msg, /made_up_error/);
});

test('describeSlackError: no code returns fallbackMessage', () => {
  assert.equal(describeSlackError(null, 'fb'), 'fb');
  assert.match(describeSlackError(null), /no code/);
});
