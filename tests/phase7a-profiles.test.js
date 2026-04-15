/**
 * Phase 7a — Profile endpoint tests.
 * Validates:
 *  - glob matching edge cases beyond the 7b coverage
 *  - ToolRegistry.getTools({ profile }) filtering combinations
 *  - McpHandler treats unknown profile as error (via assertAllowed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPattern } from '../server/mcp-token-manager.js';
import { ToolRegistry } from '../server/tool-registry.js';
import { McpHandler } from '../server/mcp-handler.js';

function fakeProvider(tools) {
  return {
    getTools() { return tools; },
    async callTool(name) { return { content: [{ type: 'text', text: `ok ${name}` }] }; },
    async healthCheck() { return { ok: true }; },
    async refreshTools() { return tools; },
  };
}

function fakeWm({ workspaces, profiles } = {}) {
  const cfg = {
    workspaces: workspaces || [],
    server: { port: 3100, profiles: profiles || {} },
  };
  return {
    config: cfg,
    _save: async () => {},
    logAudit: () => {},
    logError: () => {},
    getWorkspaces: () => cfg.workspaces.map(w => ({ ...w, status: 'healthy' })),
    getWorkspace: id => cfg.workspaces.find(w => w.id === id) || null,
    getEnabledWorkspaces: () => cfg.workspaces.filter(w => w.enabled !== false),
    getProvider: id => cfg.workspaces.find(w => w.id === id)?._provider || null,
    getCapability: () => null,
  };
}

test('matchPattern handles escape chars in value (dots, parens)', () => {
  // pattern should treat the `.` as a literal dot, and not be a regex meta
  assert.equal(matchPattern('notion.foo', 'notion.foo'), true);
  assert.equal(matchPattern('notion.foo', 'notionXfoo'), false);
  assert.equal(matchPattern('*.search', 'foo.search'), true);
  assert.equal(matchPattern('*.search', 'foosearch'), false);
});

test('matchPattern: empty pattern always false, empty value requires wildcard', () => {
  assert.equal(matchPattern('', 'anything'), false);
  assert.equal(matchPattern('*', ''), true);
  assert.equal(matchPattern('foo', ''), false);
});

test('ToolRegistry profile.toolsInclude matches either original or namespaced name', async () => {
  const providerA = fakeProvider([
    { name: 'search_pages', description: '', inputSchema: {} },
    { name: 'create_page', description: '', inputSchema: {} },
  ]);
  const wm = fakeWm({
    workspaces: [{ id: 'notion-a', kind: 'mcp-client', provider: 'notion', namespace: 'a', displayName: 'A', enabled: true, _provider: providerA }],
  });
  const tr = new ToolRegistry(wm);
  // toolsInclude matches the bare "search_pages" even though the final name is namespaced
  const t1 = await tr.getTools({ profile: { toolsInclude: ['search_pages'] } });
  const wsOnly1 = t1.filter(t => t._workspace);
  assert.equal(wsOnly1.length, 1);
  assert.equal(wsOnly1[0]._originalName, 'search_pages');

  // Glob against the namespaced form
  const t2 = await tr.getTools({ profile: { toolsInclude: ['notion_a__*'] } });
  const wsOnly2 = t2.filter(t => t._workspace);
  assert.equal(wsOnly2.length, 2);
});

test('profile.workspacesInclude glob combined with identity allowedWorkspaces (intersection)', async () => {
  const wm = fakeWm({
    workspaces: [
      { id: 'notion-a', kind: 'mcp-client', provider: 'notion', namespace: 'a', displayName: 'A', enabled: true, _provider: fakeProvider([{ name: 't1' }]) },
      { id: 'notion-b', kind: 'mcp-client', provider: 'notion', namespace: 'b', displayName: 'B', enabled: true, _provider: fakeProvider([{ name: 't2' }]) },
      { id: 'slack-c', kind: 'mcp-client', provider: 'slack', namespace: 'c', displayName: 'C', enabled: true, _provider: fakeProvider([{ name: 't3' }]) },
    ],
  });
  const tr = new ToolRegistry(wm);
  const identity = { id: 'x', allowedWorkspaces: ['notion-*', 'slack-*'], allowedProfiles: ['*'] };
  const profile = { workspacesInclude: ['notion-a'] }; // intersection → only notion-a
  const tools = await tr.getTools({ identity, profile });
  const wsIds = new Set(tools.filter(t => t._workspace).map(t => t._workspace));
  assert.deepEqual([...wsIds], ['notion-a']);
});

test('Unknown profile → tools/call returns unauthorized-style error', async () => {
  const provider = fakeProvider([{ name: 'hello', description: '', inputSchema: {} }]);
  const wm = fakeWm({
    workspaces: [{ id: 'n-a', kind: 'mcp-client', provider: 'notion', namespace: 'a', displayName: 'A', enabled: true, _provider: provider }],
  });
  const tr = new ToolRegistry(wm);
  const mcp = new McpHandler(wm, tr);
  // Warm registry so resolve() finds the tool
  await tr.getTools();
  const res = await mcp.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'notion_a__hello', arguments: {} },
  }, { profile: 'does-not-exist' });
  assert.equal(res.result.isError, true);
  // Unknown profile emits -32602 but handle() wraps it into tool-error
  assert.equal(res.result._meta.bifrost.category, 'unauthorized');
});

test('Empty tools/list result when profile excludes everything', async () => {
  const wm = fakeWm({
    workspaces: [
      { id: 'n-a', kind: 'mcp-client', provider: 'notion', namespace: 'a', displayName: 'A', enabled: true, _provider: fakeProvider([{ name: 'search', description: '', inputSchema: {} }]) },
    ],
    profiles: { empty: { toolsInclude: ['no_such_tool'] } },
  });
  const tr = new ToolRegistry(wm);
  const mcp = new McpHandler(wm, tr);
  const res = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { profile: 'empty' });
  const wsTools = res.result.tools.filter(t => !t.name.startsWith('bifrost__'));
  assert.equal(wsTools.length, 0);
});
