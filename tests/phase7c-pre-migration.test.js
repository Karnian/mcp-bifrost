/**
 * Phase 7c-pre — migration shim tests.
 *
 * Scope: byIdentity schema introduction without breaking Phase 6 callers.
 *   - legacy ws.oauth.tokens is read by OAuthManager._tokensFor
 *   - migrating workspace config mirrors tokens into byIdentity.default
 *   - tokenProvider(identity?) signature accepts both 0-arg and 1-arg calls
 *   - per-identity action_needed map (oauthActionNeededBy)
 *   - default mutex key = "${wsId}::default" (parallel for 2 identities)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { WorkspaceManager } from '../server/workspace-manager.js';
import { MockOAuthServer } from './fixtures/mock-oauth-server.js';

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

test('_tokensFor(default) reads legacy ws.oauth.tokens when byIdentity is absent', async () => {
  const ws = {
    id: 'w1',
    oauth: { enabled: true, tokens: { accessToken: 'legacy_at', refreshToken: 'legacy_rt' } },
  };
  const wm = makeWm([ws]);
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7cpre-'));
  try {
    const oauth = new OAuthManager(wm, { stateDir });
    assert.equal(oauth._tokensFor(ws, 'default').accessToken, 'legacy_at');
    // getValidAccessToken with no identity arg → default
    assert.equal(await oauth.getValidAccessToken('w1'), 'legacy_at');
    // explicit 'default'
    assert.equal(await oauth.getValidAccessToken('w1', 'default'), 'legacy_at');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('_tokensFor(non-default) returns null for a legacy-only config', async () => {
  const ws = { id: 'w1', oauth: { enabled: true, tokens: { accessToken: 'at', refreshToken: 'rt' } } };
  const wm = makeWm([ws]);
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7cpre2-'));
  try {
    const oauth = new OAuthManager(wm, { stateDir });
    assert.equal(oauth._tokensFor(ws, 'bot_ci'), null);
    await assert.rejects(() => oauth.getValidAccessToken('w1', 'bot_ci'), /workspace_not_authorized/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('WorkspaceManager._migrateLegacy mirrors ws.oauth.tokens into byIdentity.default', async () => {
  const wm = new WorkspaceManager();
  wm.config = {
    workspaces: [
      { id: 'w1', kind: 'mcp-client', oauth: { enabled: true, tokens: { accessToken: 'a1', refreshToken: 'r1' } } },
      { id: 'w2', kind: 'mcp-client', oauth: { enabled: true } }, // no tokens yet
      { id: 'w3', kind: 'mcp-client' }, // no oauth at all
    ],
    server: { port: 3100 },
  };
  wm._migrateLegacy();
  assert.deepEqual(wm.config.workspaces[0].oauth.byIdentity.default.tokens, { accessToken: 'a1', refreshToken: 'r1' });
  // Legacy tokens field remains for back-compat readers
  assert.equal(wm.config.workspaces[0].oauth.tokens.accessToken, 'a1');
  // No tokens → no byIdentity
  assert.equal(wm.config.workspaces[1].oauth.byIdentity, undefined);
  // No oauth → no change
  assert.equal(wm.config.workspaces[2].oauth, undefined);
});

test('tokenProvider signature accepts 0-arg (legacy) and 1-arg (identity) calls', async () => {
  const ws = {
    id: 'w1',
    oauth: {
      enabled: true,
      // Both identities present
      byIdentity: {
        default: { tokens: { accessToken: 'default_at', refreshToken: 'rt1' } },
        bot_ci: { tokens: { accessToken: 'ci_at', refreshToken: 'rt2' } },
      },
      tokens: { accessToken: 'default_at', refreshToken: 'rt1' },
    },
  };
  const wm = makeWm([ws]);
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7cpre3-'));
  try {
    const oauth = new OAuthManager(wm, { stateDir });
    // Simulate provider's tokenProvider(identity?) pattern
    const tp = async (identity) => oauth.getValidAccessToken('w1', identity || 'default').catch(() => null);
    assert.equal(await tp(), 'default_at');
    assert.equal(await tp('default'), 'default_at');
    assert.equal(await tp('bot_ci'), 'ci_at');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('per-identity oauthActionNeededBy is independent; _computeStatus flags any true', () => {
  const wm = new WorkspaceManager();
  wm.config = { workspaces: [
    { id: 'w1', enabled: true, oauthActionNeededBy: { default: false, bot_ci: true } },
    { id: 'w2', enabled: true, oauthActionNeededBy: { default: false } },
    { id: 'w3', enabled: true, oauthActionNeeded: true }, // legacy bool still works
  ], server: { port: 3100 } };
  assert.equal(wm._computeStatus(wm.config.workspaces[0], null), 'action_needed');
  assert.equal(wm._computeStatus(wm.config.workspaces[1], null), 'unknown');
  assert.equal(wm._computeStatus(wm.config.workspaces[2], null), 'action_needed');
});

test('2 identities refresh in parallel — per-identity mutex is independent', async () => {
  const mock = new MockOAuthServer();
  const base = await mock.start();
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7cpre-mutex-'));
  try {
    const ws = {
      id: 'w1',
      oauth: {
        enabled: true,
        issuer: base,
        clientId: 'cid',
        clientSecret: null,
        authMethod: 'none',
        metadataCache: { token_endpoint: `${base}/token` },
        byIdentity: {
          default: { tokens: { accessToken: 'old_a', refreshToken: 'should_fail_rt', expiresAt: new Date(Date.now() - 10_000).toISOString(), tokenType: 'Bearer' } },
        },
        tokens: { accessToken: 'old_a', refreshToken: 'should_fail_rt', expiresAt: new Date(Date.now() - 10_000).toISOString(), tokenType: 'Bearer' },
      },
    };
    // Seed the mock with both refresh tokens
    mock.refreshTokens.set('default_rt', { clientId: 'cid' });
    mock.refreshTokens.set('bot_rt', { clientId: 'cid' });
    ws.oauth.byIdentity.default.tokens.refreshToken = 'default_rt';
    ws.oauth.tokens.refreshToken = 'default_rt';
    ws.oauth.byIdentity.bot_ci = { tokens: { accessToken: 'old_b', refreshToken: 'bot_rt', expiresAt: new Date(Date.now() - 10_000).toISOString(), tokenType: 'Bearer' } };

    const wm = makeWm([ws]);
    const oauth = new OAuthManager(wm, { stateDir, redirectPort: 3100 });

    const [a, b] = await Promise.all([
      oauth.getValidAccessToken('w1', 'default'),
      oauth.getValidAccessToken('w1', 'bot_ci'),
    ]);
    assert.ok(a.startsWith('AT.'));
    assert.ok(b.startsWith('AT.'));
    assert.notEqual(a, b);
    // Both updated in byIdentity
    assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, a);
    assert.equal(ws.oauth.byIdentity.bot_ci.tokens.accessToken, b);
    // Legacy mirror reflects default only
    assert.equal(ws.oauth.tokens.accessToken, a);
  } finally {
    await mock.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('McpClientProvider._buildHeaders passes identity to tokenProvider', async () => {
  const { McpClientProvider } = await import('../providers/mcp-client.js');
  const received = [];
  const tokenProvider = async (identity) => { received.push(identity); return `tok_${identity}`; };
  const prov = new McpClientProvider(
    { id: 'w1', transport: 'http', url: 'http://example/mcp', headers: {} },
    { tokenProvider, identity: 'default' }
  );
  const h1 = await prov._buildHeaders(); // default via provider-level
  const h2 = await prov._buildHeaders('bot_ci'); // explicit override
  assert.equal(h1['Authorization'], 'Bearer tok_default');
  assert.equal(h2['Authorization'], 'Bearer tok_bot_ci');
  assert.deepEqual(received, ['default', 'bot_ci']);
});

test('non-default identity authorization does not inherit default refresh_token', async () => {
  const ws = {
    id: 'w1',
    oauth: {
      enabled: true, issuer: 'https://x', clientId: 'c', authMethod: 'none',
      tokens: { accessToken: 'default_at', refreshToken: 'default_rt' },
      byIdentity: { default: { tokens: { accessToken: 'default_at', refreshToken: 'default_rt' } } },
    },
  };
  const wm = makeWm([ws]);
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-7cpre-iso-'));
  try {
    const oauth = new OAuthManager(wm, { stateDir });
    // Simulate completeAuthorization for a new identity 'bot_ci' returning a
    // token payload WITHOUT refresh_token. The stored bot_ci refreshToken
    // must NOT inherit 'default_rt'.
    oauth._persistTokens('w1', {
      issuer: 'https://x', clientId: 'c', clientSecret: null, authMethod: 'none',
      tokens: { access_token: 'bot_at', token_type: 'Bearer' }, // no refresh_token
      identity: 'bot_ci',
    });
    const botTokens = ws.oauth.byIdentity.bot_ci.tokens;
    assert.equal(botTokens.accessToken, 'bot_at');
    assert.equal(botTokens.refreshToken, null, 'bot_ci must NOT inherit default_rt');
    // Default identity untouched
    assert.equal(ws.oauth.byIdentity.default.tokens.refreshToken, 'default_rt');
    assert.equal(ws.oauth.tokens.refreshToken, 'default_rt');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('WorkspaceManager masking hides access/refresh tokens inside byIdentity[*]', () => {
  const wm = new WorkspaceManager();
  // Phase 11 §3 — use nested ws.oauth.client; flat mirror is removed.
  wm.config = {
    workspaces: [
      {
        id: 'w1', kind: 'mcp-client', provider: 'notion', namespace: 'n', displayName: 'X',
        enabled: true,
        oauth: {
          enabled: true,
          client: {
            clientId: 'abcd1234efgh5678',
            clientSecret: 'super_secret_xyz',
            authMethod: 'client_secret_basic',
            source: 'manual',
            registeredAt: new Date().toISOString(),
          },
          tokens: { accessToken: 'default_access_xyz_ENDD', refreshToken: 'default_refresh_xyz', tokenType: 'Bearer' },
          byIdentity: {
            default: { tokens: { accessToken: 'default_access_xyz_ENDD', refreshToken: 'default_refresh_xyz', tokenType: 'Bearer' } },
            bot_ci: { tokens: { accessToken: 'botci_access_abc_ENDB', refreshToken: 'botci_refresh_abc', tokenType: 'Bearer' } },
          },
        },
      },
    ],
    server: { port: 3100 },
  };
  wm._loaded = true;
  const list = wm.getWorkspaces({ masked: true });
  const oauth = list[0].oauth;
  // Phase 11 §3 — nested client.clientSecret redacted (flat mirror removed)
  assert.equal(oauth.client.clientSecret, '***');
  // Flat fields must NOT exist post-Phase-11
  assert.equal(oauth.clientSecret, undefined, 'Phase 11 §3: flat clientSecret must not exist in masked view');
  // Legacy tokens object is the masked shape
  assert.equal(oauth.tokens.accessTokenPrefix?.startsWith('defa'), true);
  assert.equal(oauth.tokens.accessToken, undefined);
  assert.equal(oauth.tokens.refreshToken, undefined);
  // byIdentity masking — both entries
  for (const [ident, entry] of Object.entries(oauth.byIdentity)) {
    assert.equal(entry.tokens.accessToken, undefined, `byIdentity[${ident}] leaked accessToken`);
    assert.equal(entry.tokens.refreshToken, undefined, `byIdentity[${ident}] leaked refreshToken`);
    assert.ok(entry.tokens.accessTokenPrefix);
    assert.equal(entry.tokens.hasRefreshToken, true);
  }
  // Non-default identity prefix must be different from default's (sanity)
  assert.notEqual(oauth.byIdentity.default.tokens.accessTokenPrefix, oauth.byIdentity.bot_ci.tokens.accessTokenPrefix);
});

test('non-default identity refresh does NOT clear legacy oauthActionNeeded for default', () => {
  const ws = {
    id: 'w1', enabled: true,
    oauthActionNeeded: true, // default identity was previously flagged
    oauthActionNeededBy: { default: true, bot_ci: true },
  };
  // Simulate successful bot_ci refresh → only bot_ci flag cleared
  ws.oauthActionNeededBy.bot_ci = false;
  // default still flagged
  const wm = new WorkspaceManager();
  wm.config = { workspaces: [ws], server: { port: 3100 } };
  assert.equal(wm._computeStatus(ws, null), 'action_needed');
});

test('§Phase11-3: WorkspaceManager._migrateLegacy promotes flat→nested AND scrubs the flat keys', () => {
  // Phase 11 §3 — flat-field mirror removal. When a legacy config arrives
  // with ws.oauth.{clientId,clientSecret,authMethod} (pre-Phase-10a or
  // pre-Phase-11), startup migration must promote them into
  // ws.oauth.client AND delete the flat keys — so the in-memory config
  // and the subsequent on-disk save carry nested-only schema.
  const wm = new WorkspaceManager();
  wm.config = {
    server: { port: 3100 },
    workspaces: [
      {
        id: 'flat-ws', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
        oauth: {
          enabled: true,
          issuer: 'https://mcp.example',
          clientId: 'FLAT_CID',
          clientSecret: 'FLAT_SECRET',
          authMethod: 'client_secret_basic',
          byIdentity: { default: { tokens: { accessToken: 'AT' } } },
        },
      },
    ],
  };
  wm._migrateLegacy();
  const ws = wm.config.workspaces[0];
  // Nested populated
  assert.ok(ws.oauth.client, 'nested client must be populated');
  assert.equal(ws.oauth.client.clientId, 'FLAT_CID');
  assert.equal(ws.oauth.client.clientSecret, 'FLAT_SECRET');
  assert.equal(ws.oauth.client.authMethod, 'client_secret_basic');
  assert.equal(ws.oauth.client.source, 'legacy-flat');
  // Flat keys scrubbed
  assert.equal(ws.oauth.clientId, undefined, 'Phase 11 §3: flat clientId must be scrubbed from in-memory config');
  assert.equal(ws.oauth.clientSecret, undefined, 'Phase 11 §3: flat clientSecret must be scrubbed');
  assert.equal(ws.oauth.authMethod, undefined, 'Phase 11 §3: flat authMethod must be scrubbed');
});

test('§Phase11-3: WorkspaceManager._migrateLegacy on config that already has nested+flat scrubs flat (drift safety)', () => {
  // If a previous process wrote both nested AND flat (e.g. a node running
  // pre-Phase-11 code on disk that already had nested), startup on the new
  // binary must scrub the flat side to converge to single-source.
  const wm = new WorkspaceManager();
  wm.config = {
    server: { port: 3100 },
    workspaces: [
      {
        id: 'mixed-ws', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
        oauth: {
          enabled: true,
          issuer: 'https://mcp.example',
          client: { clientId: 'NESTED_CID', clientSecret: null, authMethod: 'none', source: 'dcr', registeredAt: '2026-01-01' },
          clientId: 'NESTED_CID',  // matching flat mirror
          clientSecret: null,
          authMethod: 'none',
          byIdentity: { default: { tokens: { accessToken: 'AT' } } },
        },
      },
    ],
  };
  wm._migrateLegacy();
  const ws = wm.config.workspaces[0];
  assert.equal(ws.oauth.client.clientId, 'NESTED_CID', 'nested client preserved');
  // Flat keys scrubbed (even though they matched nested)
  assert.equal(ws.oauth.clientId, undefined);
  assert.equal(ws.oauth.clientSecret, undefined);
  assert.equal(ws.oauth.authMethod, undefined);
});

test('§Phase11-3 (Codex R1 follow-up): _migrateLegacy scrubs flat keys when ws.oauth.client is null', () => {
  // Codex Phase 11-3 R1 identified an edge case: when Phase 10a's old
  // disambiguation logic ran, it set `ws.oauth.client = null` but left the
  // flat clientId/clientSecret = null in place. Previous Phase 11 code gated
  // the scrub on `if (ws.oauth.client)` — that branch was skipped when
  // client was null, leaving dead flat=null keys on disk forever.
  //
  // The fix ungated the scrub so it runs whenever ws.oauth exists and the
  // flat keys are present (regardless of truthiness).
  const wm = new WorkspaceManager();
  wm.config = {
    server: { port: 3100 },
    workspaces: [
      {
        id: 'disambiguated-ws', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
        oauth: {
          enabled: true,
          issuer: 'https://mcp.example',
          client: null,
          clientId: null,       // legacy disambiguation output
          clientSecret: null,
          authMethod: null,
          byIdentity: { default: { tokens: null } },
        },
      },
    ],
  };
  const mutated = wm._migrateLegacy();
  assert.ok(mutated, '_migrateLegacy must return true when flat keys are scrubbed');
  const ws = wm.config.workspaces[0];
  assert.equal(ws.oauth.client, null, 'client stays null (no flat to promote)');
  // Flat keys scrubbed (even though they were null)
  assert.equal('clientId' in ws.oauth, false, 'Phase 11 §3: flat clientId key must be scrubbed (was null)');
  assert.equal('clientSecret' in ws.oauth, false, 'Phase 11 §3: flat clientSecret key must be scrubbed (was null)');
  assert.equal('authMethod' in ws.oauth, false, 'Phase 11 §3: flat authMethod key must be scrubbed (was null)');
});

test('§Phase11-3: _migrateLegacy returns false when no mutation occurs (already-migrated config)', () => {
  // Sanity: _migrateLegacy must not force-save an already-clean config.
  const wm = new WorkspaceManager();
  wm.config = {
    server: { port: 3100 },
    workspaces: [
      {
        id: 'clean-ws', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
        oauth: {
          enabled: true,
          issuer: 'https://mcp.example',
          client: { clientId: 'CID', authMethod: 'none', source: 'dcr', registeredAt: '2026-01-01' },
          byIdentity: { default: { tokens: { accessToken: 'AT' } } },
        },
      },
    ],
  };
  const mutated = wm._migrateLegacy();
  assert.equal(mutated, false, 'already-migrated config must not trigger mutation flag');
});
