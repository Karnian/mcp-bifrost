import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Soft Delete', () => {
  let WorkspaceManager;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
  });

  it('should soft delete a workspace', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Soft Del', credentials: { token: 'x' } });
    await wm.deleteWorkspace(ws.id);
    // Should not appear in normal listing
    assert.equal(wm.getWorkspaces().length, 0);
    // Should appear in deleted listing
    assert.equal(wm.getDeletedWorkspaces().length, 1);
    assert.equal(wm.getDeletedWorkspaces()[0].id, ws.id);
  });

  it('should restore a soft-deleted workspace', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Restore Me', credentials: { token: 'x' } });
    await wm.deleteWorkspace(ws.id);
    assert.equal(wm.getWorkspaces().length, 0);
    await wm.restoreWorkspace(ws.id);
    assert.equal(wm.getWorkspaces().length, 1);
    assert.equal(wm.getDeletedWorkspaces().length, 0);
  });

  it('should hard delete a workspace', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Hard Del', credentials: { token: 'x' } });
    await wm.deleteWorkspace(ws.id, { hard: true });
    assert.equal(wm.getWorkspaces().length, 0);
    assert.equal(wm.getDeletedWorkspaces().length, 0);
  });

  it('should not show soft-deleted in enabled workspaces', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Enabled Test', credentials: { token: 'x' } });
    await wm.deleteWorkspace(ws.id);
    assert.equal(wm.getEnabledWorkspaces().length, 0);
  });
});

describe('Profile-based MCP filtering', () => {
  let WorkspaceManager, ToolRegistry, McpHandler;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
    ({ ToolRegistry } = await import('../server/tool-registry.js'));
    ({ McpHandler } = await import('../server/mcp-handler.js'));
  });

  it('should return all tools without profile', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Profile Test', credentials: { token: 'x' } });
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.ok(result.result.tools.length > 0);
  });

  it('should filter with read-only profile', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'ReadOnly Test', credentials: { token: 'x' } });
    const tr = new ToolRegistry(wm);
    const handler = new McpHandler(wm, tr);
    const result = await handler.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { profile: 'read-only' }
    );
    // All Notion tools are read-only, so all should be included
    const wsTools = result.result.tools.filter(t => t.name.includes('notion_'));
    assert.ok(wsTools.length > 0);
  });
});

describe('Audit log tracks operations', () => {
  let WorkspaceManager;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
  });

  it('should log add, update, delete, restore', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Audit Full', credentials: { token: 'x' } });
    await wm.updateWorkspace(ws.id, { displayName: 'Updated' });
    await wm.deleteWorkspace(ws.id);
    await wm.restoreWorkspace(ws.id);
    assert.equal(wm.auditLog.length, 4);
    const actions = wm.auditLog.map(l => l.action);
    assert.ok(actions.includes('add'));
    assert.ok(actions.includes('update'));
    assert.ok(actions.includes('delete'));
    assert.ok(actions.includes('restore'));
  });
});
