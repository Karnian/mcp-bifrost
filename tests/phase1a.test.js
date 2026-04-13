import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// --- Unit tests for WorkspaceManager, ToolRegistry, McpHandler ---

describe('WorkspaceManager', () => {
  let WorkspaceManager;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
  });

  it('should create with empty defaults', () => {
    const wm = new WorkspaceManager();
    assert.deepStrictEqual(wm.getWorkspaces(), []);
  });

  it('should add a workspace with auto-generated namespace', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({
      provider: 'notion',
      displayName: 'My Notion',
      credentials: { token: 'ntn_test_token_1234' },
    });
    assert.equal(ws.provider, 'notion');
    assert.equal(ws.namespace, 'my-notion');
    assert.equal(ws.alias, 'my-notion');
    assert.equal(ws.displayName, 'My Notion');
    assert.equal(ws.enabled, true);
  });

  it('should prevent namespace change on update', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({
      provider: 'notion',
      displayName: 'Test',
      credentials: { token: 'ntn_test' },
    });
    await assert.rejects(
      () => wm.updateWorkspace(ws.id, { namespace: 'changed' }),
      /immutable/
    );
  });

  it('should mask credentials', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({
      provider: 'notion',
      displayName: 'Masked Test',
      credentials: { token: 'ntn_abcdefgh1234' },
    });
    const list = wm.getWorkspaces({ masked: true });
    assert.ok(list[0].credentials.token.includes('***'));
    assert.ok(list[0].credentials.token.endsWith('1234'));
  });

  it('should deduplicate aliases', async () => {
    const wm = new WorkspaceManager();
    const ws1 = await wm.addWorkspace({ provider: 'notion', displayName: 'Test', credentials: { token: 'a' } });
    const ws2 = await wm.addWorkspace({ provider: 'notion', displayName: 'Test', credentials: { token: 'b' } });
    assert.notEqual(ws1.alias, ws2.alias);
  });

  it('should delete workspace', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Del', credentials: { token: 'x' } });
    await wm.deleteWorkspace(ws.id);
    assert.equal(wm.getWorkspaces().length, 0);
  });

  it('should compute status correctly — disabled', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Status', credentials: { token: 'x' }, enabled: false });
    const result = wm.getWorkspace(ws.id);
    assert.equal(result.status, 'disabled');
  });

  it('should return unknown status for unchecked workspaces', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Unchecked', credentials: { token: 'x' } });
    const result = wm.getWorkspace(ws.id);
    assert.equal(result.status, 'unknown');
  });
});

describe('ToolRegistry', () => {
  let WorkspaceManager, ToolRegistry;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
    ({ ToolRegistry } = await import('../server/tool-registry.js'));
  });

  it('should generate namespaced tool names', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({
      provider: 'notion',
      displayName: 'Personal',
      credentials: { token: 'ntn_test' },
    });
    const tr = new ToolRegistry(wm);
    const tools = tr.getTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('notion_personal__search_pages'));
    assert.ok(names.includes('notion_personal__read_page'));
    assert.ok(names.includes('notion_personal__list_databases'));
    // Meta tools
    assert.ok(names.includes('bifrost__list_workspaces'));
    assert.ok(names.includes('bifrost__workspace_info'));
  });

  it('should resolve namespaced tools', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Personal', credentials: { token: 'x' } });
    const tr = new ToolRegistry(wm);
    const resolved = tr.resolve('notion_personal__search_pages');
    assert.equal(resolved.type, 'workspace');
    assert.equal(resolved.toolName, 'search_pages');
    assert.equal(resolved.provider, 'notion');
    assert.equal(resolved.namespace, 'personal');
  });

  it('should resolve meta tools', () => {
    const wm = new WorkspaceManager();
    const tr = new ToolRegistry(wm);
    const resolved = tr.resolve('bifrost__list_workspaces');
    assert.equal(resolved.type, 'meta');
  });

  it('should return null for unknown tools', () => {
    const wm = new WorkspaceManager();
    const tr = new ToolRegistry(wm);
    assert.equal(tr.resolve('unknown__tool'), null);
  });

  it('should enrich tool descriptions with displayName', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'My Notion', credentials: { token: 'x' } });
    const tr = new ToolRegistry(wm);
    const tools = tr.getTools();
    const searchTool = tools.find(t => t.name === 'notion_my-notion__search_pages');
    assert.ok(searchTool.description.includes('[My Notion]'));
    assert.ok(searchTool.description.includes('Notion 워크스페이스'));
    assert.ok(searchTool.description.includes('읽기 전용'));
  });

  it('should not include tools from disabled workspaces', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Disabled', credentials: { token: 'x' }, enabled: false });
    const tr = new ToolRegistry(wm);
    const tools = tr.getTools();
    const wsTools = tools.filter(t => t._workspace !== null);
    assert.equal(wsTools.length, 0);
  });

  it('should exclude unavailable tools from capabilityCheck', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({
      provider: 'notion',
      displayName: 'CapTest',
      credentials: { token: 'x' },
    });
    // Simulate capabilityCheck result with an unavailable tool
    wm.capabilityCache.set(ws.id, {
      tools: [
        { name: 'search_pages', usable: 'usable' },
        { name: 'read_page', usable: 'unavailable' },
        { name: 'list_databases', usable: 'limited' },
      ],
    });
    const tr = new ToolRegistry(wm);
    const tools = tr.getTools().filter(t => t._workspace === ws.id);
    const names = tools.map(t => t._originalName);
    assert.ok(names.includes('search_pages'));
    assert.ok(!names.includes('read_page')); // unavailable → excluded
    assert.ok(names.includes('list_databases')); // limited → included
  });

  it('should apply toolFilter include mode', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({
      provider: 'notion',
      displayName: 'Filtered',
      credentials: { token: 'x' },
      toolFilter: { mode: 'include', enabled: ['search_pages'] },
    });
    const tr = new ToolRegistry(wm);
    const tools = tr.getTools().filter(t => t._workspace !== null);
    assert.equal(tools.length, 1);
    assert.ok(tools[0].name.includes('search_pages'));
  });
});

describe('McpHandler', () => {
  let WorkspaceManager, ToolRegistry, McpHandler;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
    ({ ToolRegistry } = await import('../server/tool-registry.js'));
    ({ McpHandler } = await import('../server/mcp-handler.js'));
  });

  it('should handle initialize', async () => {
    const wm = new WorkspaceManager();
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(result.result.protocolVersion, '2025-03-26');
    assert.equal(result.result.serverInfo.name, 'mcp-bifrost');
  });

  it('should handle tools/list', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Test', credentials: { token: 'x' } });
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.ok(result.result.tools.length > 0);
  });

  it('should return error for unknown tool call', async () => {
    const wm = new WorkspaceManager();
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'nonexistent__tool', arguments: {} },
    });
    assert.equal(result.result.isError, true);
  });

  it('should handle bifrost__list_workspaces meta tool', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Meta Test', credentials: { token: 'x' } });
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'bifrost__list_workspaces', arguments: {} },
    });
    const workspaces = JSON.parse(result.result.content[0].text);
    assert.ok(workspaces.length > 0);
    assert.equal(workspaces[0].displayName, 'Meta Test');
  });

  it('should handle resources/list', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Res Test', credentials: { token: 'x' } });
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} });
    assert.ok(result.result.resources.length > 0);
    assert.ok(result.result.resources[0].uri.startsWith('bifrost://'));
  });

  it('should handle unknown method', async () => {
    const wm = new WorkspaceManager();
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({ jsonrpc: '2.0', id: 6, method: 'unknown/method', params: {} });
    assert.ok(result.error);
    assert.equal(result.error.code, -32601);
  });

  it('should handle ping', async () => {
    const wm = new WorkspaceManager();
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} });
    assert.deepStrictEqual(result.result, {});
  });
});
