import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('SlackProvider', () => {
  let SlackProvider;

  before(async () => {
    ({ SlackProvider } = await import('../providers/slack.js'));
  });

  it('should instantiate with config', () => {
    const provider = new SlackProvider({
      id: 'slack-test',
      provider: 'slack',
      namespace: 'test',
      displayName: 'Test Slack',
      credentials: { botToken: 'xoxb-test', teamId: 'T001' },
    });
    assert.equal(provider.botToken, 'xoxb-test');
    assert.equal(provider.teamId, 'T001');
  });

  it('should return 3 tools', () => {
    const provider = new SlackProvider({
      id: 'slack-test',
      provider: 'slack',
      namespace: 'test',
      displayName: 'Test',
      credentials: { botToken: 'xoxb-test' },
    });
    const tools = provider.getTools();
    assert.equal(tools.length, 3);
    const names = tools.map(t => t.name);
    assert.ok(names.includes('search_messages'));
    assert.ok(names.includes('read_channel'));
    assert.ok(names.includes('list_channels'));
  });

  it('should return error for unknown tool', async () => {
    const provider = new SlackProvider({
      id: 'slack-test',
      provider: 'slack',
      namespace: 'test',
      displayName: 'Test',
      credentials: { botToken: 'xoxb-test' },
    });
    const result = await provider.callTool('nonexistent');
    assert.equal(result.isError, true);
  });
});

describe('Slack tools via ToolRegistry', () => {
  let WorkspaceManager, ToolRegistry;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
    ({ ToolRegistry } = await import('../server/tool-registry.js'));
  });

  it('should generate namespaced Slack tool names', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({
      provider: 'slack',
      displayName: 'Work Slack',
      credentials: { botToken: 'xoxb-test', teamId: 'T001' },
    });
    const tr = new ToolRegistry(wm);
    const tools = tr.getTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('slack_work-slack__search_messages'));
    assert.ok(names.includes('slack_work-slack__read_channel'));
    assert.ok(names.includes('slack_work-slack__list_channels'));
  });
});

describe('Diagnostics', () => {
  let WorkspaceManager;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
  });

  it('should track error log', () => {
    const wm = new WorkspaceManager();
    wm.logError('credential', 'notion-test', 'Token expired');
    assert.equal(wm.errorLog.length, 1);
    assert.equal(wm.errorLog[0].category, 'credential');
  });

  it('should cap error log at 50', () => {
    const wm = new WorkspaceManager();
    for (let i = 0; i < 60; i++) {
      wm.logError('test', 'ws', `Error ${i}`);
    }
    assert.equal(wm.errorLog.length, 50);
  });

  it('should track audit log', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Audit', credentials: { token: 'x' } });
    assert.equal(wm.auditLog.length, 1);
    assert.equal(wm.auditLog[0].action, 'add');
  });

  it('should return diagnostics summary', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({ provider: 'notion', displayName: 'Diag', credentials: { token: 'x' } });
    const diag = wm.getDiagnostics();
    assert.ok(diag.workspaces.length > 0);
    assert.ok(Array.isArray(diag.errorLog));
    assert.ok(Array.isArray(diag.auditLog));
  });
});
