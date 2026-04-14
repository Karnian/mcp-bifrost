import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(__dirname, 'fixtures', 'mock-mcp-server.js');

describe('McpClientProvider (stdio)', () => {
  let McpClientProvider;
  const providers = [];

  before(async () => {
    ({ McpClientProvider } = await import('../providers/mcp-client.js'));
  });

  after(async () => {
    for (const p of providers) {
      try { await p.shutdown(); } catch {}
    }
  });

  function newProvider(config = {}) {
    const p = new McpClientProvider({
      id: 'test-mcp',
      kind: 'mcp-client',
      provider: 'stdio',
      namespace: 'test',
      displayName: 'Test',
      transport: 'stdio',
      command: process.execPath,
      args: [MOCK_SERVER],
      ...config,
    });
    providers.push(p);
    return p;
  }

  it('should connect and list tools', async () => {
    const p = newProvider();
    const tools = await p.refreshTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('echo'));
    assert.ok(names.includes('add'));
    await p.shutdown();
  });

  it('should call a tool and get response', async () => {
    const p = newProvider();
    await p.refreshTools();
    const res = await p.callTool('echo', { message: 'hello' });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text, 'hello');
    await p.shutdown();
  });

  it('should call add tool', async () => {
    const p = newProvider();
    await p.refreshTools();
    const res = await p.callTool('add', { a: 2, b: 3 });
    assert.equal(res.content[0].text, '5');
    await p.shutdown();
  });

  it('should pass through isError from upstream', async () => {
    const p = newProvider();
    await p.refreshTools();
    const res = await p.callTool('fail_once');
    assert.equal(res.isError, true);
    await p.shutdown();
  });

  it('should healthCheck successfully', async () => {
    const p = newProvider();
    const result = await p.healthCheck();
    assert.equal(result.ok, true);
    await p.shutdown();
  });

  it('should fail healthCheck on bad command', async () => {
    const p = newProvider({ command: '/nonexistent/cmd' });
    const result = await p.healthCheck();
    assert.equal(result.ok, false);
  });

  it('should capabilityCheck with tool list', async () => {
    const p = newProvider();
    const cap = await p.capabilityCheck();
    assert.ok(cap.tools.length > 0);
    assert.ok(cap.tools.every(t => t.usable === 'usable'));
    await p.shutdown();
  });
});

describe('Legacy migration', () => {
  let WorkspaceManager;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
  });

  it('should migrate legacy entries to kind=native', () => {
    const wm = new WorkspaceManager();
    wm.config.workspaces = [
      { id: 'notion-a', provider: 'notion', namespace: 'a', alias: 'a', displayName: 'A', credentials: { token: 'x' }, enabled: true },
    ];
    wm._migrateLegacy();
    assert.equal(wm.config.workspaces[0].kind, 'native');
  });

  it('should not overwrite existing kind', () => {
    const wm = new WorkspaceManager();
    wm.config.workspaces = [
      { id: 'fs', kind: 'mcp-client', provider: 'stdio', namespace: 'fs', alias: 'fs', displayName: 'FS', enabled: true },
    ];
    wm._migrateLegacy();
    assert.equal(wm.config.workspaces[0].kind, 'mcp-client');
  });
});

describe('WorkspaceManager with mcp-client kind', () => {
  let WorkspaceManager;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
  });

  it('should add mcp-client stdio workspace', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({
      kind: 'mcp-client',
      transport: 'stdio',
      displayName: 'File System',
      command: 'echo',
      args: ['hello'],
      env: { FOO: 'bar' },
    });
    assert.equal(ws.kind, 'mcp-client');
    assert.equal(ws.transport, 'stdio');
    assert.equal(ws.command, 'echo');
    assert.deepEqual(ws.args, ['hello']);
    await wm.deleteWorkspace(ws.id, { hard: true });
  });

  it('should mask env values in API response', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({
      kind: 'mcp-client',
      transport: 'stdio',
      displayName: 'Secrets Test',
      command: 'echo',
      env: { API_KEY: 'sk_secret_abcdefghijkl' },
    });
    const masked = wm.getWorkspace(ws.id);
    assert.ok(masked.env.API_KEY.includes('***'));
    assert.ok(!masked.env.API_KEY.includes('secret'));
    await wm.deleteWorkspace(ws.id, { hard: true });
  });

  it('should add mcp-client http workspace', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({
      kind: 'mcp-client',
      transport: 'http',
      displayName: 'Remote MCP',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc123xyz' },
    });
    assert.equal(ws.transport, 'http');
    assert.equal(ws.url, 'https://example.com/mcp');
    // Headers should be masked in getWorkspace response
    const masked = wm.getWorkspace(ws.id);
    assert.ok(masked.headers.Authorization.includes('***'));
    await wm.deleteWorkspace(ws.id, { hard: true });
  });
});

describe('ToolRegistry reverse lookup', () => {
  let WorkspaceManager, ToolRegistry;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
    ({ ToolRegistry } = await import('../server/tool-registry.js'));
  });

  it('should handle tool names with underscores', async () => {
    const wm = new WorkspaceManager();
    await wm.addWorkspace({
      kind: 'mcp-client',
      transport: 'stdio',
      displayName: 'WS',
      command: 'true',
    });
    const [ws] = wm.config.workspaces;
    // Inject a fake provider with underscore-rich tool names
    wm.providers.set(ws.id, {
      getTools: () => [
        { name: 'some__weird__tool', description: 'test' },
        { name: 'normal_tool', description: 'test' },
      ],
    });
    const tr = new ToolRegistry(wm);
    const tools = tr.getTools();
    const weirdTool = tools.find(t => t._originalName === 'some__weird__tool');
    assert.ok(weirdTool, 'weird tool should be registered');

    // Resolve via reverse map (not string parsing)
    const resolved = tr.resolve(weirdTool.name);
    assert.equal(resolved.toolName, 'some__weird__tool');
    assert.equal(resolved.workspaceId, ws.id);
  });
});
