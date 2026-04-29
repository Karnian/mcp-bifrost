/**
 * Phase 12-4 — providers/slack.js OAuth mode + _headers async + capability cooldown.
 *
 * Coverage (plan §4.2 + §8.2):
 *   - authMode='oauth' calls _tokenProvider on every request
 *   - authMode='token' (legacy) backward-compat: uses credentials.botToken
 *   - _tokenProvider missing → throw at _headers time
 *   - _tokenProvider returning null/empty → SLACK_NO_TOKEN
 *   - capabilityCheck cooldown — second call within 60s returns cache
 *   - WorkspaceManager.setSlackOAuthManager wiring — provider resolves token
 *     via slackOAuth.ensureValidAccessToken
 *   - rotated tokens are picked up automatically (no provider re-create needed)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackProvider } from '../providers/slack.js';
import { WorkspaceManager } from '../server/workspace-manager.js';

function mockFetch(handler) {
  return async (url, init) => {
    const response = await handler({ url, init, body: init?.body });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: { get: (k) => response.headers?.[k] || null },
      async json() { return typeof response.body === 'string' ? JSON.parse(response.body) : response.body; },
    };
  };
}

function withFetch(fetchImpl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = prev;
  });
}

// ─── _headers / _fetch ──────────────────────────────────────────────

test('SlackProvider: token mode uses credentials.botToken (backwards compat)', async () => {
  const seen = [];
  const fetchImpl = mockFetch(async ({ init }) => {
    seen.push(init.headers.Authorization);
    return { status: 200, body: { ok: true, team_id: 'T1', team: 'X' } };
  });
  await withFetch(fetchImpl, async () => {
    const p = new SlackProvider({ id: 'w', namespace: 'w', credentials: { botToken: 'xoxb-legacy' } });
    await p.healthCheck();
  });
  assert.deepEqual(seen, ['Bearer xoxb-legacy']);
});

test('SlackProvider: oauth mode awaits _tokenProvider on every request', async () => {
  const seen = [];
  const fetchImpl = mockFetch(async ({ init }) => {
    seen.push(init.headers.Authorization);
    return { status: 200, body: { ok: true, team_id: 'T1', team: 'X' } };
  });
  let counter = 0;
  const tokenProvider = async () => {
    counter++;
    return `xoxe.xoxp-1-${counter}`;
  };
  await withFetch(fetchImpl, async () => {
    const p = new SlackProvider({
      id: 'w', namespace: 'w', authMode: 'oauth', _tokenProvider: tokenProvider,
    });
    await p.healthCheck();
    await p.healthCheck();
  });
  assert.deepEqual(seen, ['Bearer xoxe.xoxp-1-1', 'Bearer xoxe.xoxp-1-2']);
});

test('SlackProvider: oauth mode missing _tokenProvider throws', async () => {
  const p = new SlackProvider({ id: 'w', namespace: 'w', authMode: 'oauth' });
  await assert.rejects(() => p._headers(), err => /requires _tokenProvider/.test(err.message));
});

test('SlackProvider: oauth mode null token → SLACK_NO_TOKEN', async () => {
  const p = new SlackProvider({
    id: 'w', namespace: 'w', authMode: 'oauth', _tokenProvider: async () => null,
  });
  await assert.rejects(() => p._headers(), err => err.code === 'SLACK_NO_TOKEN');
});

test('SlackProvider: token mode missing botToken → SLACK_NO_TOKEN', async () => {
  const p = new SlackProvider({ id: 'w', namespace: 'w' /* no credentials */ });
  await assert.rejects(() => p._headers(), err => err.code === 'SLACK_NO_TOKEN');
});

// ─── capability cooldown ────────────────────────────────────────────

test('SlackProvider: capabilityCheck cooldown — second call within 60s returns cache', async () => {
  let calls = 0;
  const fetchImpl = mockFetch(async () => {
    calls++;
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'search:read,channels:read' },
      body: { ok: true, team_id: 'T1', team: 'X' },
    };
  });
  await withFetch(fetchImpl, async () => {
    const p = new SlackProvider({
      id: 'w', namespace: 'w', authMode: 'oauth', _tokenProvider: async () => 'xoxe.xoxp-1',
    });
    const r1 = await p.capabilityCheck();
    const r2 = await p.capabilityCheck();
    assert.equal(r1, r2);
    // r1 made 3 fetch calls (auth.test + conversations.list + search.messages)
    // r2 should make 0 (returned from cache)
    assert.equal(calls, 3);
  });
});

test('SlackProvider: capabilityCheck cooldown caches FAILURE path too (Codex R1 NIT)', async () => {
  // First auth.test fails → cached empty result. Second call within
  // cooldown must NOT retry the network — important so a missing-scope
  // workspace doesn't pummel Slack's rate budget on every status poll.
  let calls = 0;
  const fetchImpl = mockFetch(async () => {
    calls++;
    return { status: 200, body: { ok: false, error: 'invalid_auth' } };
  });
  await withFetch(fetchImpl, async () => {
    const p = new SlackProvider({
      id: 'w', namespace: 'w', authMode: 'oauth', _tokenProvider: async () => 'xoxe.xoxp-1',
    });
    const r1 = await p.capabilityCheck();
    const r2 = await p.capabilityCheck();
    assert.deepEqual(r1, { scopes: [], resources: { count: 0, samples: [] }, tools: [] });
    assert.equal(r1, r2, 'failure cache must be the same object reference');
    assert.equal(calls, 1, 'second call must hit the cache, not Slack');
  });
});

test('SlackProvider: callTool routes search/read/list through OAuth token (Codex R1 NIT — plan §8.2)', async () => {
  const seenTokens = [];
  const seenMethods = [];
  const fetchImpl = mockFetch(async ({ url, init }) => {
    seenTokens.push(init.headers.Authorization);
    seenMethods.push(url);
    if (url.endsWith('/search.messages')) {
      return { status: 200, body: { ok: true, messages: { matches: [] } } };
    }
    if (url.endsWith('/conversations.history')) {
      return { status: 200, body: { ok: true, messages: [] } };
    }
    if (url.endsWith('/conversations.list')) {
      return { status: 200, body: { ok: true, channels: [] } };
    }
    return { status: 200, body: { ok: true } };
  });
  await withFetch(fetchImpl, async () => {
    let n = 0;
    const p = new SlackProvider({
      id: 'w', namespace: 'w', authMode: 'oauth',
      _tokenProvider: async () => `xoxe.xoxp-1-T${++n}`,
    });
    await p.callTool('search_messages', { query: 'hi' });
    await p.callTool('read_channel', { channel: 'C1' });
    await p.callTool('list_channels', {});
  });
  assert.deepEqual(seenTokens, [
    'Bearer xoxe.xoxp-1-T1',
    'Bearer xoxe.xoxp-1-T2',
    'Bearer xoxe.xoxp-1-T3',
  ]);
  assert.equal(seenMethods.length, 3);
  assert.ok(seenMethods[0].endsWith('/search.messages'));
  assert.ok(seenMethods[1].endsWith('/conversations.history'));
  assert.ok(seenMethods[2].endsWith('/conversations.list'));
});

test('WorkspaceManager: OAuth provider config does NOT contain raw tokens (Codex R1 REVISE)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-4-secure-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxe.xoxp-1-RAW-IN-PROVIDER', refreshToken: 'xoxe-1-RAW-RT', tokenType: 'user' },
        status: 'active',
      },
    }],
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  wm.setSlackOAuthManager({ ensureValidAccessToken: async () => 'fresh-token' });
  await wm.load();
  try {
    const provider = wm.getProvider('slack-x');
    const dump = JSON.stringify(provider.config);
    assert.ok(!dump.includes('RAW-IN-PROVIDER'), 'provider.config must not retain access token');
    assert.ok(!dump.includes('RAW-RT'), 'provider.config must not retain refresh token');
    assert.equal(provider.config.slackOAuth, undefined, 'slackOAuth must be stripped from provider config');
    assert.equal(provider.config.credentials, undefined, 'credentials must be stripped from OAuth provider config');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager._getServerSecret: concurrent cold-boot coalesces (Codex R3 REVISE)', async () => {
  const { OAuthManager } = await import('../server/oauth-manager.js');
  const dir = await mkdtemp(join(tmpdir(), 'phase12-4-secret-race-'));
  // mock wm shape sufficient for OAuthManager constructor
  const mgr = new OAuthManager({
    getServerConfig: () => ({ port: 3100 }),
    logAudit: () => {},
    _getRawWorkspace: () => null,
  }, { stateDir: dir });
  try {
    const [a, b, c] = await Promise.all([
      mgr._getServerSecret(),
      mgr._getServerSecret(),
      mgr._getServerSecret(),
    ]);
    assert.equal(a, b, 'concurrent _getServerSecret must return same value');
    assert.equal(b, c);
    assert.ok(a && a.length >= 32);
    // Subsequent call sees cache directly
    const d = await mgr._getServerSecret();
    assert.equal(a, d);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startServer: production wiring — SlackOAuthManager attached automatically (Codex R2 REVISE)', async () => {
  // The real bootstrap path must produce a server where Slack OAuth
  // workspaces resolve tokens without manual setSlackOAuthManager.
  const { startServer } = await import('../server/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'phase12-4-bootstrap-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    server: { port: 0, host: '127.0.0.1' },
    slackApp: { clientId: '111.222', clientSecret: 'sec', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxe.xoxp-1-PROD', tokenType: 'user' },
        status: 'active',
      },
    }],
  }), 'utf-8');
  let srv;
  try {
    srv = await startServer({ port: 0, host: '127.0.0.1', configDir: dir });
    assert.ok(srv.slackOAuth, 'startServer must expose slackOAuth handle');
    assert.equal(typeof srv.slackOAuth.ensureValidAccessToken, 'function');
    // The wiring contract — provider closure resolves through the manager.
    assert.equal(srv.wm._slackOAuth, srv.slackOAuth);
    // The Slack OAuth provider's _tokenProvider closure invokes the manager.
    const provider = srv.wm.getProvider('slack-x');
    assert.equal(provider.authMode, 'oauth');
    assert.equal(typeof provider._tokenProvider, 'function');
  } finally {
    if (srv) await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SlackProvider: capabilityCheck cooldown reset by manual flush', async () => {
  let calls = 0;
  const fetchImpl = mockFetch(async () => {
    calls++;
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'search:read' },
      body: { ok: true, team_id: 'T1', team: 'X' },
    };
  });
  await withFetch(fetchImpl, async () => {
    const p = new SlackProvider({
      id: 'w', namespace: 'w', authMode: 'oauth', _tokenProvider: async () => 'xoxe.xoxp-1',
    });
    await p.capabilityCheck();
    p._lastCapabilityCheck = 0; // simulate cooldown expiry
    await p.capabilityCheck();
    // Fresh check makes 3 fetches again
    assert.equal(calls, 6);
  });
});

// ─── WorkspaceManager wiring ────────────────────────────────────────

test('WorkspaceManager + SlackOAuthManager: OAuth provider resolves rotated tokens transparently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-4-wm-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    slackApp: { clientId: '111.222', clientSecret: 'sec', tokenRotationEnabled: true },
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxe.xoxp-1-V1', tokenType: 'user' },
        status: 'active',
      },
    }],
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  let calls = [];
  // Stub Slack OAuth manager to control token returned per call
  const stubSlackOAuth = {
    ensureValidAccessToken: async (workspaceId) => {
      calls.push(workspaceId);
      return calls.length === 1 ? 'xoxe.xoxp-1-V1' : 'xoxe.xoxp-1-V2';
    },
  };
  wm.setSlackOAuthManager(stubSlackOAuth);
  await wm.load();
  try {
    const provider = wm.getProvider('slack-x');
    const seen = [];
    const fetchImpl = mockFetch(async ({ init }) => {
      seen.push(init.headers.Authorization);
      return { status: 200, body: { ok: true, team_id: 'T1', team: 'X' } };
    });
    await withFetch(fetchImpl, async () => {
      await provider.healthCheck();
      await provider.healthCheck();
    });
    assert.deepEqual(seen, ['Bearer xoxe.xoxp-1-V1', 'Bearer xoxe.xoxp-1-V2']);
    assert.deepEqual(calls, ['slack-x', 'slack-x']);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager: OAuth provider throws clear error if SlackOAuthManager not attached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-4-wm-noattach-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'slack-x', kind: 'native', provider: 'slack', authMode: 'oauth',
      namespace: 'x', alias: 'x', enabled: true,
      slackOAuth: {
        team: { id: 'T1', name: 'X' },
        tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
        status: 'active',
      },
    }],
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  // Note: setSlackOAuthManager NOT called
  try {
    const provider = wm.getProvider('slack-x');
    await assert.rejects(
      () => provider._headers(),
      err => /SlackOAuthManager is not attached/.test(err.message)
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager: token-mode Slack workspace stays on legacy path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-4-wm-token-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'slack-legacy', kind: 'native', provider: 'slack',
      namespace: 'legacy', alias: 'legacy', enabled: true,
      credentials: { botToken: 'xoxb-legacy-static' },
    }],
  }), 'utf-8');
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const provider = wm.getProvider('slack-legacy');
    assert.equal(provider.authMode, 'token');
    const headers = await provider._headers();
    assert.equal(headers.Authorization, 'Bearer xoxb-legacy-static');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});
