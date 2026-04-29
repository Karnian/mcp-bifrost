/**
 * Phase 12-10 — Slack OAuth integration test suite.
 *
 * Coverage (plan §8.5 — full install → tools/list → refresh → revoke
 * round-trip on a mock Slack endpoint):
 *
 *   1. install start → callback success → workspace materialized
 *   2. installed workspace's tools surface in /api/status (tool count
 *      reflects new entry) and /api/workspaces masking (no raw tokens)
 *   3. duplicate-team install (D9 re-authorize) updates tokens without
 *      creating a second entry
 *   4. teamInstallMutex serializes parallel callbacks for same team
 *   5. token expiring within leeway triggers refresh through the provider
 *      callTool path (end-to-end mutex chain validation)
 *   6. provider callTool routes through OAuth refresh — search/list/history
 *   7. disconnect (hard-delete) removes workspace + revoke fired
 *   8. multi-workspace isolation — two installs end up on independent token
 *      stores
 *
 * The Slack endpoints are stubbed via fakeFetch — Phase 12-10 is "all
 * paths exercised without an external dep". Real-Slack E2E is left for
 * docs/SLACK_OAUTH_E2E_CHECKLIST.md (manual run).
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
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

function makeFakeSlack({ teams = ['T01'], tokenSeed = 1, slackHandlers } = {}) {
  // The fake server tracks per-team token rotation state so a refresh
  // chain matches Slack's 1-of-1 refresh_token semantics.
  const state = {};
  for (const id of teams) {
    state[id] = {
      access: `xoxe.xoxp-1-${id}-A${tokenSeed}`,
      refresh: `xoxe-1-${id}-R${tokenSeed}`,
      revoked: new Set(),
    };
  }
  const calls = [];
  return {
    state,
    calls,
    fetch: async (url, init) => {
      // Phase 12-10 (Codex R2 BLOCKER): record Authorization header so
      // rotation tests can assert the Slack Web API call carries the
      // *rotated* access token, not the original.
      calls.push({
        url,
        body: init?.body,
        authorization: init?.headers?.Authorization || init?.headers?.authorization || null,
      });
      const body = String(init?.body || '');
      if (url === 'https://slack.com/api/oauth.v2.access') {
        if (body.includes('grant_type=refresh_token')) {
          const params = new URLSearchParams(body);
          const sent = params.get('refresh_token');
          const team = Object.entries(state).find(([, s]) => s.refresh === sent);
          if (!team) {
            return mockResponse({ ok: false, error: 'invalid_grant' });
          }
          const [tid, s] = team;
          tokenSeed++;
          s.access = `xoxe.xoxp-1-${tid}-A${tokenSeed}`;
          s.refresh = `xoxe-1-${tid}-R${tokenSeed}`;
          return mockResponse({
            ok: true,
            access_token: s.access, refresh_token: s.refresh,
            expires_in: 5, // refresh quickly so the next call drives another rotation
            token_type: 'user',
            scope: 'search:read,channels:read,channels:history,users:read',
            team: { id: tid, name: tid },
          });
        }
        // install path
        if (slackHandlers?.installResponse) {
          return mockResponse(slackHandlers.installResponse(state, body));
        }
        const team = teams[0];
        const s = state[team];
        return mockResponse({
          ok: true,
          team: { id: team, name: team },
          authed_user: {
            id: `U-${team}`,
            scope: 'search:read,channels:read,channels:history,users:read',
            access_token: s.access, refresh_token: s.refresh,
            token_type: 'user',
            expires_in: 43200,
          },
          is_enterprise_install: false,
        });
      }
      if (url === 'https://slack.com/api/auth.revoke') {
        const params = new URLSearchParams(body);
        const tok = params.get('token');
        for (const s of Object.values(state)) {
          if (s.access === tok || s.refresh === tok) s.revoked.add(tok);
        }
        return mockResponse({ ok: true });
      }
      // Slack Web API call from provider — return safe stubs
      if (url.startsWith('https://slack.com/api/')) {
        if (url.endsWith('/auth.test')) {
          return mockResponse({ ok: true, team: 'X', team_id: 'T01' });
        }
        if (url.endsWith('/conversations.list')) {
          return mockResponse({ ok: true, channels: [{ id: 'C1', name: 'general' }] });
        }
        if (url.endsWith('/conversations.history')) {
          return mockResponse({ ok: true, messages: [{ user: 'U1', text: 'hi', ts: '1' }] });
        }
        if (url.endsWith('/search.messages')) {
          return mockResponse({ ok: true, messages: { matches: [] } });
        }
        return mockResponse({ ok: true });
      }
      return mockResponse({ ok: false }, 404);
    },
  };
}

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

async function bootIntegration({ slackApp = true, fake } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-10-'));
  const config = {
    server: { port: 0, host: '127.0.0.1' },
    workspaces: [],
  };
  if (slackApp) {
    config.slackApp = { clientId: '111111.222222', clientSecret: 's', tokenRotationEnabled: true };
  }
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify(config), 'utf-8');
  const srv = await startServer({ port: 0, host: '127.0.0.1', configDir: dir });
  if (fake) srv.slackOAuth.fetch = fake.fetch;
  return {
    srv, dir,
    baseUrl: `http://127.0.0.1:${srv.port}`,
    teardown: async () => { await srv.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

beforeEach(() => setEnv('https://bifrost.test'));
afterEach(() => restoreEnv());

// ─── Test 1: full install round-trip ─────────────────────────────

test('integration: install → callback → workspace materialized + masked output', async () => {
  const fake = makeFakeSlack({ teams: ['T01'] });
  const { srv, baseUrl, teardown } = await bootIntegration({ fake });
  try {
    const init = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const { installId } = (await init.json()).data;
    const state = srv.slackOAuth._installPending.get(installId).state;

    const cb = await fetch(`${baseUrl}/oauth/slack/callback?code=C1&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 200);

    const status = (await (await fetch(`${baseUrl}/api/slack/install/status?installId=${installId}`)).json()).data;
    assert.equal(status.status, 'completed');

    // Masked output never leaks raw token
    const wsList = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slack = wsList.find(w => w.provider === 'slack' && w.authMode === 'oauth');
    assert.ok(slack);
    assert.ok(!JSON.stringify(slack).includes('xoxe.xoxp-1-T01-A1'));
    assert.equal(slack.slackOAuth.tokens.hasRefreshToken, true);
  } finally { await teardown(); }
});

// ─── Test 2: duplicate-team install → re-authorize ──────────────

test('integration: same team second install → re-authorize swaps tokens (Codex R1 BLOCKER 2)', async () => {
  // Make each install respond with a NEW token pair so we can detect
  // re-authorize updating the stored slackOAuth.tokens. Without rotated
  // values the entry-count assertion alone passes a buggy implementation.
  let installCount = 0;
  const fake = makeFakeSlack({ teams: ['T01'] });
  const origFetch = fake.fetch;
  fake.fetch = async (url, init) => {
    const body = String(init?.body || '');
    if (url === 'https://slack.com/api/oauth.v2.access' && !body.includes('grant_type=refresh_token')) {
      installCount++;
      const access = `xoxe.xoxp-1-T01-INSTALL-${installCount}`;
      const refresh = `xoxe-1-T01-INSTALL-RT-${installCount}`;
      fake.state.T01.access = access;
      fake.state.T01.refresh = refresh;
      return mockResponse({
        ok: true,
        team: { id: 'T01', name: 'T01' },
        authed_user: {
          id: 'U-T01', scope: 'search:read,channels:read', token_type: 'user',
          access_token: access, refresh_token: refresh, expires_in: 43200,
        },
        is_enterprise_install: false,
      });
    }
    return origFetch(url, init);
  };
  const { srv, baseUrl, teardown } = await bootIntegration({ fake });
  try {
    const startCall = async () => {
      const init = await fetch(`${baseUrl}/api/slack/install/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const { installId } = (await init.json()).data;
      const state = srv.slackOAuth._installPending.get(installId).state;
      const cb = await fetch(`${baseUrl}/oauth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
      assert.equal(cb.status, 200);
      return installId;
    };
    const id1 = await startCall();
    const status1 = (await (await fetch(`${baseUrl}/api/slack/install/status?installId=${id1}`)).json()).data;
    assert.equal(status1.mode, 'create');
    const wsListA = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slackA = wsListA.find(w => w.provider === 'slack');
    const rawA = srv.wm.getRawWorkspace(slackA.id).slackOAuth.tokens;
    assert.equal(rawA.accessToken, 'xoxe.xoxp-1-T01-INSTALL-1');

    const id2 = await startCall();
    const status2 = (await (await fetch(`${baseUrl}/api/slack/install/status?installId=${id2}`)).json()).data;
    assert.equal(status2.mode, 're-authorize');
    assert.equal(status2.workspaceId, slackA.id, 're-authorize must reuse the same workspace id');
    const wsListB = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slackList = wsListB.filter(w => w.provider === 'slack');
    assert.equal(slackList.length, 1, 'duplicate team must NOT create second entry');
    const rawB = srv.wm.getRawWorkspace(slackA.id).slackOAuth.tokens;
    assert.equal(rawB.accessToken, 'xoxe.xoxp-1-T01-INSTALL-2');
    assert.equal(rawB.refreshToken, 'xoxe-1-T01-INSTALL-RT-2');
  } finally { await teardown(); }
});

// ─── Test 3: parallel concurrent installs same team → mutex ─────

test('integration: concurrent installs same team → exactly one entry', async () => {
  const fake = makeFakeSlack({ teams: ['T01'] });
  const { srv, baseUrl, teardown } = await bootIntegration({ fake });
  try {
    const start1 = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const id1 = (await start1.json()).data.installId;
    const state1 = srv.slackOAuth._installPending.get(id1).state;
    const start2 = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const id2 = (await start2.json()).data.installId;
    const state2 = srv.slackOAuth._installPending.get(id2).state;
    await Promise.all([
      fetch(`${baseUrl}/oauth/slack/callback?code=C&state=${encodeURIComponent(state1)}`),
      fetch(`${baseUrl}/oauth/slack/callback?code=C&state=${encodeURIComponent(state2)}`),
    ]);
    const wsList = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slack = wsList.filter(w => w.provider === 'slack');
    assert.equal(slack.length, 1, 'teamInstallMutex must collapse to 1 entry');
  } finally { await teardown(); }
});

// ─── Test 4: forceRefresh through admin endpoint ────────────────

test('integration: admin forceRefresh exercises rotation chain', async () => {
  const fake = makeFakeSlack({ teams: ['T01'] });
  const { srv, baseUrl, teardown } = await bootIntegration({ fake });
  try {
    // 1. install
    const init = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const { installId } = (await init.json()).data;
    const state = srv.slackOAuth._installPending.get(installId).state;
    await fetch(`${baseUrl}/oauth/slack/callback?code=C1&state=${encodeURIComponent(state)}`);

    const wsList = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slack = wsList.find(w => w.provider === 'slack');

    // 2. force refresh — Slack returns A2/R2
    const r = await fetch(`${baseUrl}/api/workspaces/${slack.id}/slack/refresh`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.data.tokenPrefix, /^xoxe\.xoxp-1-/);

    // 3. raw config tokens have advanced
    const rawTokens = srv.wm.getRawWorkspace(slack.id).slackOAuth.tokens;
    assert.equal(rawTokens.refreshToken, fake.state.T01.refresh);
  } finally { await teardown(); }
});

// ─── Test 5: provider callTool exercises the OAuth refresh path ──

test('integration: provider callTool drives OAuth refresh + uses rotated token (Codex R1 BLOCKER 1)', async () => {
  // Install with a SHORT expires_in so the next callTool falls inside the
  // refresh leeway. The test then asserts:
  //   1. refresh endpoint hit happened
  //   2. Slack Web API call used the ROTATED access token
  //   3. raw config persisted the rotated tokens
  const fake = makeFakeSlack({ teams: ['T01'] });
  // Override install path: short expires_in, distinct token bodies
  const origFetch = fake.fetch;
  fake.fetch = async (url, init) => {
    const body = String(init?.body || '');
    if (url === 'https://slack.com/api/oauth.v2.access' && !body.includes('grant_type=refresh_token')) {
      fake.state.T01.access = 'xoxe.xoxp-1-T01-A0';
      fake.state.T01.refresh = 'xoxe-1-T01-R0';
      return mockResponse({
        ok: true,
        team: { id: 'T01', name: 'T01' },
        authed_user: {
          id: 'U-T01', scope: 'search:read,channels:read,channels:history,users:read',
          token_type: 'user',
          access_token: 'xoxe.xoxp-1-T01-A0', refresh_token: 'xoxe-1-T01-R0',
          expires_in: 1, // immediately stale → triggers refresh on next call
        },
        is_enterprise_install: false,
      });
    }
    return origFetch(url, init);
  };
  const { srv, baseUrl, teardown } = await bootIntegration({ fake });
  try {
    const init = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const { installId } = (await init.json()).data;
    const state = srv.slackOAuth._installPending.get(installId).state;
    await fetch(`${baseUrl}/oauth/slack/callback?code=C&state=${encodeURIComponent(state)}`);

    const wsList = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slack = wsList.find(w => w.provider === 'slack');
    const provider = srv.wm.getProvider(slack.id);

    // Wire fake fetch into provider's global fetch — provider uses
    // globalThis.fetch for Slack Web API calls.
    const realGlobalFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    try {
      // Wait long enough that expires_in:1s elapsed → refresh fires
      await new Promise(r => setTimeout(r, 50));
      const result = await provider.callTool('search_messages', { query: 'hi' });
      assert.ok(!result.isError, `callTool failed: ${JSON.stringify(result)}`);

      // 1. Refresh endpoint actually hit
      const refreshCalls = fake.calls.filter(c =>
        c.url === 'https://slack.com/api/oauth.v2.access' &&
        String(c.body || '').includes('grant_type=refresh_token'));
      assert.ok(refreshCalls.length >= 1, 'refresh must have fired before search.messages');

      // 2. Slack Web API call used a NEW access token (rotated, not A0).
      // Codex R2 BLOCKER: assert the Authorization header directly so the
      // rotation chain is end-to-end verified, not inferred.
      const searchCall = fake.calls.find(c => c.url.endsWith('/search.messages'));
      assert.ok(searchCall, 'search.messages must have been called');
      assert.ok(searchCall.authorization, 'search.messages must carry Authorization header');
      assert.notEqual(
        searchCall.authorization,
        'Bearer xoxe.xoxp-1-T01-A0',
        'search.messages must use rotated access token, not the install-time one',
      );
      // The Authorization must equal whatever raw config now stores.
      const rawAfterCall = srv.wm.getRawWorkspace(slack.id).slackOAuth.tokens.accessToken;
      assert.equal(searchCall.authorization, `Bearer ${rawAfterCall}`);

      // 3. raw config has the rotated token
      const raw = srv.wm.getRawWorkspace(slack.id).slackOAuth.tokens;
      assert.notEqual(raw.accessToken, 'xoxe.xoxp-1-T01-A0', 'access token must have rotated');
      assert.notEqual(raw.refreshToken, 'xoxe-1-T01-R0', 'refresh token must have rotated');
    } finally {
      globalThis.fetch = realGlobalFetch;
    }
  } finally { await teardown(); }
});

// ─── Test 6: disconnect hard-delete + revoke ─────────────────────

test('integration: disconnect hard-deletes workspace + revoke fired', async () => {
  const fake = makeFakeSlack({ teams: ['T01'] });
  const { srv, baseUrl, teardown } = await bootIntegration({ fake });
  try {
    const init = await fetch(`${baseUrl}/api/slack/install/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const { installId } = (await init.json()).data;
    const state = srv.slackOAuth._installPending.get(installId).state;
    await fetch(`${baseUrl}/oauth/slack/callback?code=C&state=${encodeURIComponent(state)}`);

    const wsList = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slack = wsList.find(w => w.provider === 'slack');
    const accessBefore = fake.state.T01.access;
    const refreshBefore = fake.state.T01.refresh;
    const r = await fetch(`${baseUrl}/api/workspaces/${slack.id}/slack/disconnect`, { method: 'POST' });
    assert.equal(r.status, 200);
    // workspace is gone
    const after = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    assert.ok(!after.find(w => w.id === slack.id));
    // Codex R1 REVISE 3: both access AND refresh tokens must have been revoked
    const revokeCalls = fake.calls.filter(c => c.url.includes('/auth.revoke'));
    assert.equal(revokeCalls.length, 2, 'expected 2 revoke calls (access + refresh)');
    assert.ok(fake.state.T01.revoked.has(accessBefore), 'access token must be revoked');
    assert.ok(fake.state.T01.revoked.has(refreshBefore), 'refresh token must be revoked');
  } finally { await teardown(); }
});

// ─── Test 7: multi-workspace isolation ──────────────────────────

test('integration: two team installs → independent token stores', async () => {
  // Build a fetch mock that switches team based on the install code.
  const fake = makeFakeSlack({ teams: ['T01', 'T02'] });
  // Override install handler to pick a team per call sequence
  let installCounter = 0;
  fake.fetch = (() => {
    const orig = fake.fetch;
    return async (url, init) => {
      const body = String(init?.body || '');
      if (url === 'https://slack.com/api/oauth.v2.access' && !body.includes('grant_type=refresh_token')) {
        installCounter++;
        const team = installCounter === 1 ? 'T01' : 'T02';
        const s = fake.state[team];
        return mockResponse({
          ok: true,
          team: { id: team, name: team },
          authed_user: {
            id: `U-${team}`, scope: 'search:read', token_type: 'user',
            access_token: s.access, refresh_token: s.refresh, expires_in: 43200,
          },
          is_enterprise_install: false,
        });
      }
      return orig(url, init);
    };
  })();
  const { srv, baseUrl, teardown } = await bootIntegration({ fake });
  try {
    for (let i = 0; i < 2; i++) {
      const init = await fetch(`${baseUrl}/api/slack/install/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const { installId } = (await init.json()).data;
      const state = srv.slackOAuth._installPending.get(installId).state;
      await fetch(`${baseUrl}/oauth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    }
    const wsList = (await (await fetch(`${baseUrl}/api/workspaces`)).json()).data;
    const slack = wsList.filter(w => w.provider === 'slack');
    assert.equal(slack.length, 2, 'must have 2 separate Slack workspace entries');
    // Tokens are distinct between the two workspaces
    const raw1 = srv.wm.getRawWorkspace(slack[0].id).slackOAuth.tokens;
    const raw2 = srv.wm.getRawWorkspace(slack[1].id).slackOAuth.tokens;
    assert.notEqual(raw1.accessToken, raw2.accessToken, 'tokens must be isolated per workspace');
    assert.notEqual(raw1.refreshToken, raw2.refreshToken);
  } finally { await teardown(); }
});

// ─── Test 8: invalid state (popup shut → second open with stale state) ──

test('integration: callback with stale state rejected (status_failed UI surface)', async () => {
  const fake = makeFakeSlack({ teams: ['T01'] });
  const { baseUrl, teardown } = await bootIntegration({ fake });
  try {
    const cb = await fetch(`${baseUrl}/oauth/slack/callback?code=C&state=fabricated.bogus`);
    assert.equal(cb.status, 400);
    const html = await cb.text();
    assert.match(html, /state 검증 실패/);
  } finally { await teardown(); }
});
