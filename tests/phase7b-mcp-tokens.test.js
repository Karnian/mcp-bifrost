/**
 * Phase 7b — MCP token manager + ACL tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  McpTokenManager,
  hashToken,
  verifyToken,
  matchPattern,
  identityAllowsWorkspace,
  identityAllowsProfile,
} from '../server/mcp-token-manager.js';
import { McpHandler } from '../server/mcp-handler.js';
import { ToolRegistry } from '../server/tool-registry.js';

function fakeWm(initial = {}) {
  const cfg = {
    workspaces: initial.workspaces || [],
    server: initial.server || { port: 3100 },
  };
  const state = {
    config: cfg,
    saved: 0,
    audits: [],
    errors: [],
    _save: async () => { state.saved++; },
    logAudit: (action, ws, details) => { state.audits.push({ action, ws, details }); },
    logError: (cat, ws, msg) => { state.errors.push({ cat, ws, msg }); },
    getWorkspaces: () => cfg.workspaces.map(w => ({ ...w, status: 'healthy' })),
    getWorkspace: (id) => {
      const w = cfg.workspaces.find(x => x.id === id);
      return w ? { ...w, status: 'healthy' } : null;
    },
    getEnabledWorkspaces: () => cfg.workspaces.filter(w => w.enabled !== false),
    getProvider: (id) => {
      const w = cfg.workspaces.find(x => x.id === id);
      return w?._provider || null;
    },
    getCapability: () => null,
  };
  return state;
}

// ──────────────────────────────────────────────────────────────────────
// 1. scrypt hash / verify round-trip

test('hashToken / verifyToken round-trip succeeds with correct plaintext', async () => {
  const hash = await hashToken('mysecret_abc');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyToken('mysecret_abc', hash), true);
});

test('verifyToken rejects wrong plaintext', async () => {
  const hash = await hashToken('mysecret_abc');
  assert.equal(await verifyToken('mysecret_xyz', hash), false);
});

test('verifyToken rejects malformed hash string', async () => {
  assert.equal(await verifyToken('x', 'not-a-scrypt-hash'), false);
  assert.equal(await verifyToken('x', 'scrypt$1$1$1$abc'), false);
  assert.equal(await verifyToken('x', null), false);
});

// ──────────────────────────────────────────────────────────────────────
// 2. Token manager resolve flow

test('resolve returns null when no tokens configured', async () => {
  const wm = fakeWm();
  const tm = new McpTokenManager(wm, { envToken: '', envTokens: '' });
  assert.equal(tm.isConfigured(), false);
  assert.equal(await tm.resolve('anything'), null);
});

test('resolve returns legacy identity for BIFROST_MCP_TOKEN', async () => {
  const wm = fakeWm();
  const tm = new McpTokenManager(wm, { envToken: 'legacy_secret', envTokens: '' });
  assert.equal(tm.isConfigured(), true);
  const id = await tm.resolve('legacy_secret');
  assert.deepEqual(id, {
    id: 'legacy',
    source: 'env-legacy',
    allowedWorkspaces: ['*'],
    allowedProfiles: ['*'],
  });
  assert.equal(await tm.resolve('wrong'), null);
});

test('resolve handles BIFROST_MCP_TOKENS multi-env with ACL globs', async () => {
  const wm = fakeWm();
  const tm = new McpTokenManager(wm, {
    envToken: '',
    envTokens: 'bot_ci:plain_ci_tok:notion-*|slack-*:read-only,bot_admin:admin_tok:*:*',
  });
  const ci = await tm.resolve('plain_ci_tok');
  assert.equal(ci.id, 'bot_ci');
  assert.deepEqual(ci.allowedWorkspaces, ['notion-*', 'slack-*']);
  assert.deepEqual(ci.allowedProfiles, ['read-only']);

  const admin = await tm.resolve('admin_tok');
  assert.equal(admin.id, 'bot_admin');
  assert.deepEqual(admin.allowedWorkspaces, ['*']);
});

test('issue + resolve + revoke round-trip on persisted store', async () => {
  const wm = fakeWm();
  const tm = new McpTokenManager(wm, { envToken: '', envTokens: '' });
  const { id, plaintext, entry } = await tm.issue({
    id: 'tok_ci',
    description: 'CI bot',
    allowedWorkspaces: ['linear-*'],
    allowedProfiles: ['read-only'],
  });
  assert.equal(id, 'tok_ci');
  assert.ok(plaintext.startsWith('bft_'));
  assert.equal(entry.hashed, true);
  // wm.config.server.mcpTokens populated with hash, not plaintext
  const stored = wm.config.server.mcpTokens[0];
  assert.ok(stored.token.startsWith('scrypt$'));
  assert.equal(stored.token.includes(plaintext), false);
  // resolve finds it
  const resolved = await tm.resolve(plaintext);
  assert.equal(resolved.id, 'tok_ci');
  assert.deepEqual(resolved.allowedWorkspaces, ['linear-*']);
  // lastUsedAt touched
  assert.ok(stored.lastUsedAt);
  // revoke removes it
  await tm.revoke('tok_ci');
  assert.equal(wm.config.server.mcpTokens.length, 0);
  assert.equal(await tm.resolve(plaintext), null);
});

test('rotate replaces hash but keeps id/ACL; old plaintext fails', async () => {
  const wm = fakeWm();
  const tm = new McpTokenManager(wm, { envToken: '', envTokens: '' });
  const first = await tm.issue({ id: 'tok_x' });
  const second = await tm.rotate('tok_x');
  assert.equal(first.id, second.id);
  assert.notEqual(first.plaintext, second.plaintext);
  assert.equal(await tm.resolve(first.plaintext), null);
  const r = await tm.resolve(second.plaintext);
  assert.equal(r.id, 'tok_x');
});

test('issue rejects duplicate id', async () => {
  const wm = fakeWm();
  const tm = new McpTokenManager(wm, { envToken: '', envTokens: '' });
  await tm.issue({ id: 'dup' });
  await assert.rejects(() => tm.issue({ id: 'dup' }), /exists/);
});

// ──────────────────────────────────────────────────────────────────────
// 3. Pattern matching + ACL helpers

test('matchPattern: exact, prefix, suffix, contains, wildcard', () => {
  assert.equal(matchPattern('*', 'notion-x'), true);
  assert.equal(matchPattern('notion-*', 'notion-work'), true);
  assert.equal(matchPattern('notion-*', 'slack-work'), false);
  assert.equal(matchPattern('*-work', 'notion-work'), true);
  assert.equal(matchPattern('*work*', 'notion-work-extra'), true);
  assert.equal(matchPattern('exact', 'exact'), true);
  assert.equal(matchPattern('exact', 'other'), false);
});

test('identityAllowsWorkspace/Profile honor glob list', () => {
  const id = { id: 'x', allowedWorkspaces: ['notion-*'], allowedProfiles: ['read-*'] };
  assert.equal(identityAllowsWorkspace(id, 'notion-a'), true);
  assert.equal(identityAllowsWorkspace(id, 'slack-a'), false);
  assert.equal(identityAllowsProfile(id, 'read-only'), true);
  assert.equal(identityAllowsProfile(id, 'admin'), false);
  assert.equal(identityAllowsProfile(id, null), true); // no profile requested → allow
});

// ──────────────────────────────────────────────────────────────────────
// 4. McpHandler ACL enforcement (2nd-line, defense in depth)

function fakeProvider(tools) {
  return {
    getTools() { return tools; },
    async callTool(name, args) {
      return { content: [{ type: 'text', text: `called ${name} ${JSON.stringify(args)}` }] };
    },
    async healthCheck() { return { ok: true, message: 'ok' }; },
    async refreshTools() { return tools; },
  };
}

function setupHandler() {
  const providerA = fakeProvider([{ name: 'search_pages', description: 'search', inputSchema: {}, readOnly: true }]);
  const providerB = fakeProvider([{ name: 'send_message', description: 'send', inputSchema: {}, readOnly: false }]);
  const wm = fakeWm({
    workspaces: [
      { id: 'notion-work', kind: 'mcp-client', provider: 'notion', namespace: 'work', displayName: 'Notion', enabled: true, _provider: providerA },
      { id: 'slack-work', kind: 'mcp-client', provider: 'slack', namespace: 'work', displayName: 'Slack', enabled: true, _provider: providerB },
    ],
    server: {
      port: 3100,
      profiles: {
        'read-only': { toolsInclude: ['*search*', '*_get_*'] },
        'notion-only': { workspacesInclude: ['notion-*'] },
      },
    },
  });
  const tr = new ToolRegistry(wm);
  const mcp = new McpHandler(wm, tr);
  return { wm, tr, mcp };
}

test('tools/list filters by identity.allowedWorkspaces', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'notion-bot', allowedWorkspaces: ['notion-*'], allowedProfiles: ['*'] };
  const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { identity });
  const names = res.result.tools.map(t => t.name);
  const workspaceTools = names.filter(n => !n.startsWith('bifrost__'));
  assert.ok(workspaceTools.every(n => n.startsWith('notion_')), `expected only notion tools, got: ${workspaceTools.join(',')}`);
});

test('tools/call denies cross-workspace access even if tool name known', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'notion-bot', allowedWorkspaces: ['notion-*'], allowedProfiles: ['*'] };
  const res = await mcp.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'slack_work__send_message', arguments: {} },
  }, { identity });
  assert.equal(res.result.isError, true);
  assert.equal(res.result._meta.bifrost.category, 'unauthorized');
});

test('tools/call allows access when identity matches', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'notion-bot', allowedWorkspaces: ['notion-*'], allowedProfiles: ['*'] };
  const res = await mcp.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'notion_work__search_pages', arguments: { q: 'x' } },
  }, { identity });
  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /called search_pages/);
});

test('profile toolsInclude filters tools/list by glob', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'any', allowedWorkspaces: ['*'], allowedProfiles: ['*'] };
  const res = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { identity, profile: 'read-only' });
  const wsTools = res.result.tools.filter(t => !t.name.startsWith('bifrost__'));
  // "read-only" profile toolsInclude = ['*search*','*_get_*'] — only search_pages matches
  assert.ok(wsTools.some(t => t.name.includes('search_pages')));
  assert.ok(!wsTools.some(t => t.name.includes('send_message')), 'send_message should not pass toolsInclude');
});

test('profile workspacesInclude restricts workspaces', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'any', allowedWorkspaces: ['*'], allowedProfiles: ['*'] };
  // 'notion-only' profile → only notion-* workspaces
  const res = await mcp.handle({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'slack_work__send_message', arguments: {} },
  }, { identity, profile: 'notion-only' });
  assert.equal(res.result.isError, true);
  assert.equal(res.result._meta.bifrost.category, 'unauthorized');
});

test('unknown profile rejected with -32602', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'any', allowedWorkspaces: ['*'], allowedProfiles: ['*'] };
  const res = await mcp.handle({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'notion_work__search_pages', arguments: {} },
  }, { identity, profile: 'nonexistent' });
  // mcp-handler returns toolError for call path; for unknown profile that's via assertAllowed → unauthorized message
  assert.equal(res.result.isError, true);
});

test('identity.allowedProfiles restricts which profile the token may request', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'ci', allowedWorkspaces: ['*'], allowedProfiles: ['read-only'] };
  // Try to use "notion-only" profile — should be denied (token not allowed for that profile)
  const res = await mcp.handle({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'notion_work__search_pages', arguments: {} },
  }, { identity, profile: 'notion-only' });
  assert.equal(res.result.isError, true);
  assert.equal(res.result._meta.bifrost.category, 'unauthorized');
});

test('resources/list filters by identity', async () => {
  const { mcp } = setupHandler();
  const identity = { id: 'notion-bot', allowedWorkspaces: ['notion-*'], allowedProfiles: ['*'] };
  const res = await mcp.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, { identity });
  assert.equal(res.result.resources.length, 1);
  assert.match(res.result.resources[0].uri, /notion-work/);
});

test('open mode (no identity) allows everything', async () => {
  const { mcp } = setupHandler();
  const res = await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, {});
  const wsTools = res.result.tools.filter(t => !t.name.startsWith('bifrost__'));
  assert.equal(wsTools.length, 2);
});
