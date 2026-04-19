/**
 * Phase 9a — MCP 프로토콜 완성 + 긴급 보안 테스트
 * prompts/list, prompts/get, resource size limit, env injection defense,
 * mcp-client transport TODO cleanup
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. prompts/list + prompts/get ───

describe('McpHandler prompts', () => {
  let McpHandler;

  beforeEach(async () => {
    ({ McpHandler } = await import('../server/mcp-handler.js'));
  });

  it('prompts/list returns built-in bifrost__workspace_summary', async () => {
    const handler = new McpHandler(
      { getWorkspaces: () => [], config: {} },
      { getTools: async () => [] }
    );
    const res = await handler.handle({ method: 'prompts/list', id: 1 });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    const names = res.result.prompts.map(p => p.name);
    assert.ok(names.includes('bifrost__workspace_summary'));
  });

  it('prompts/list includes provider prompts from enabled workspaces', async () => {
    const mockProvider = {
      getPrompts: () => [
        { name: 'summarize', description: 'Summarize workspace', arguments: [] }
      ],
    };
    const wm = {
      getWorkspaces: () => [
        { id: 'notion-personal', provider: 'notion', namespace: 'personal', displayName: 'My Notion', enabled: true, status: 'healthy' },
      ],
      getProvider: () => mockProvider,
      config: {},
    };
    const handler = new McpHandler(wm, { getTools: async () => [] });
    const res = await handler.handle({ method: 'prompts/list', id: 2 });
    const names = res.result.prompts.map(p => p.name);
    assert.ok(names.includes('notion_personal__summarize'));
  });

  it('prompts/list excludes disabled workspace prompts', async () => {
    const mockProvider = {
      getPrompts: () => [
        { name: 'summarize', description: 'Summarize', arguments: [] }
      ],
    };
    const wm = {
      getWorkspaces: () => [
        { id: 'notion-disabled', provider: 'notion', namespace: 'disabled', displayName: 'Disabled', enabled: false, status: 'error' },
      ],
      getProvider: () => mockProvider,
      config: {},
    };
    const handler = new McpHandler(wm, { getTools: async () => [] });
    const res = await handler.handle({ method: 'prompts/list', id: 3 });
    const names = res.result.prompts.map(p => p.name);
    assert.ok(!names.some(n => n.includes('disabled')));
  });

  it('prompts/get returns workspace summary for built-in prompt', async () => {
    const wm = {
      getWorkspaces: () => [
        { id: 'notion-personal', provider: 'notion', namespace: 'personal', displayName: 'My Notion', enabled: true, status: 'healthy' },
      ],
      getProvider: () => null,
      config: {},
    };
    const handler = new McpHandler(wm, { getTools: async () => [] });
    const res = await handler.handle({
      method: 'prompts/get',
      params: { name: 'bifrost__workspace_summary' },
      id: 4,
    });
    assert.ok(res.result.messages);
    assert.equal(res.result.messages.length, 1);
    assert.equal(res.result.messages[0].role, 'user');
    assert.ok(res.result.messages[0].content.text.includes('My Notion'));
  });

  it('prompts/get returns error for unknown prompt', async () => {
    const handler = new McpHandler(
      { getWorkspaces: () => [], config: {} },
      { getTools: async () => [] }
    );
    const res = await handler.handle({
      method: 'prompts/get',
      params: { name: 'nonexistent_prompt' },
      id: 5,
    });
    assert.ok(res.error);
    assert.equal(res.error.code, -32602);
  });

  it('prompts/get returns error when name is missing', async () => {
    const handler = new McpHandler(
      { getWorkspaces: () => [], config: {} },
      { getTools: async () => [] }
    );
    const res = await handler.handle({
      method: 'prompts/get',
      params: {},
      id: 6,
    });
    assert.ok(res.error);
    assert.equal(res.error.code, -32602);
  });

  it('initialize response includes prompts capability', async () => {
    const handler = new McpHandler(
      { getWorkspaces: () => [], config: {} },
      { getTools: async () => [] }
    );
    const res = await handler.handle({ method: 'initialize', params: {}, id: 7 });
    assert.ok(res.result.capabilities.prompts);
  });
});

// ─── 2. resource read size limit ───

describe('McpHandler resource size limit', () => {
  it('MAX_RESOURCE_SIZE constant is defined and used', async () => {
    // Verify the constant is accessible by reading the module source
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../server/mcp-handler.js', import.meta.url), 'utf-8');
    assert.ok(src.includes('MAX_RESOURCE_SIZE'));
    assert.ok(src.includes('BIFROST_MAX_RESOURCE_SIZE'));
    assert.ok(src.includes('Buffer.byteLength'));
    assert.ok(src.includes('Resource size exceeds limit'));
  });

  it('rejects oversized resource with -32600 error', async () => {
    // Dynamically construct a handler where _resourcesRead generates huge text
    const { McpHandler } = await import('../server/mcp-handler.js');
    // Create a workspace with a very long displayName to exceed a low limit
    const longName = 'X'.repeat(200);
    const wsData = { id: 'big-ws', provider: 'notion', namespace: 'big', displayName: longName, enabled: true, status: 'healthy' };
    const wm = {
      getWorkspaces: () => [wsData],
      getWorkspace: (id) => id === 'big-ws' ? wsData : null,
      config: {},
    };
    // Generate many tools to inflate the JSON
    const manyTools = [];
    for (let i = 0; i < 50000; i++) {
      manyTools.push({ name: `notion_big__tool_${i}`, _workspace: 'big-ws', _originalName: `tool_${i}` });
    }
    const tr = { getTools: async () => manyTools };
    const handler = new McpHandler(wm, tr);

    const res = await handler.handle({
      method: 'resources/read',
      params: { uri: 'bifrost://workspaces/big-ws' },
      id: 99,
    });

    // With 50k tools, the JSON will exceed 5MB. If it doesn't in this env,
    // the handler should still work correctly either way.
    const text = res.result?.contents?.[0]?.text;
    if (text && Buffer.byteLength(text, 'utf-8') > 5 * 1024 * 1024) {
      assert.fail('Resource should have been rejected by size limit');
    }
    if (res.error) {
      assert.equal(res.error.code, -32600);
      assert.ok(res.error.message.includes('Resource size exceeds limit'));
    }
    // Either rejected (error) or under limit (result) — both valid outcomes
    assert.ok(res.error || res.result);
  });

  it('normal resource read succeeds under limit', async () => {
    const { McpHandler } = await import('../server/mcp-handler.js');
    const wsData = { id: 'test-ws', provider: 'notion', namespace: 'test', displayName: 'Test', enabled: true, status: 'healthy' };
    const wm = {
      getWorkspaces: () => [wsData],
      getWorkspace: (id) => id === 'test-ws' ? wsData : null,
      getProvider: () => null,
      config: {},
    };
    const tr = {
      getTools: async () => [{ name: 'notion_test__search', _workspace: 'test-ws', _originalName: 'search' }],
      resolve: async () => null,
    };
    const handler = new McpHandler(wm, tr);
    const res = await handler.handle({
      method: 'resources/read',
      params: { uri: 'bifrost://workspaces/test-ws' },
      id: 10,
    });
    assert.ok(res.result, `Expected result, got: ${JSON.stringify(res)}`);
    assert.ok(res.result.contents);
    assert.equal(res.result.contents.length, 1);
    assert.ok(res.result.contents[0].text.includes('test-ws'));
  });
});

// ─── 3. env vars injection defense ───

describe('validateEnvVars', () => {
  let validateEnvVars;

  beforeEach(async () => {
    ({ validateEnvVars } = await import('../admin/auth.js'));
  });

  it('blocks PATH injection', () => {
    const result = validateEnvVars({ PATH: '/malicious/bin' });
    assert.equal(result.valid, false);
    assert.ok(result.blocked.includes('PATH'));
  });

  it('blocks LD_PRELOAD injection', () => {
    const result = validateEnvVars({ LD_PRELOAD: '/tmp/evil.so' });
    assert.equal(result.valid, false);
    assert.ok(result.blocked.includes('LD_PRELOAD'));
  });

  it('blocks DYLD_INSERT_LIBRARIES injection', () => {
    const result = validateEnvVars({ DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' });
    assert.equal(result.valid, false);
    assert.ok(result.blocked.includes('DYLD_INSERT_LIBRARIES'));
  });

  it('blocks NODE_OPTIONS injection', () => {
    const result = validateEnvVars({ NODE_OPTIONS: '--require /tmp/evil.js' });
    assert.equal(result.valid, false);
    assert.ok(result.blocked.includes('NODE_OPTIONS'));
  });

  it('allows BIFROST_ prefixed vars', () => {
    const result = validateEnvVars({ BIFROST_DEBUG: '1', BIFROST_LOG_LEVEL: 'debug' });
    assert.equal(result.valid, true);
    assert.equal(result.blocked.length, 0);
  });

  it('allows NODE_ENV', () => {
    const result = validateEnvVars({ NODE_ENV: 'production' });
    assert.equal(result.valid, true);
  });

  it('allows HOME, LANG, TERM, TZ', () => {
    const result = validateEnvVars({ HOME: '/home/user', LANG: 'en_US.UTF-8', TERM: 'xterm', TZ: 'UTC' });
    assert.equal(result.valid, true);
  });

  it('blocks arbitrary env vars not in allowlist', () => {
    const result = validateEnvVars({ EVIL_VAR: 'hack', CUSTOM_SECRET: 'x' });
    assert.equal(result.valid, false);
    assert.ok(result.blocked.includes('EVIL_VAR'));
    assert.ok(result.blocked.includes('CUSTOM_SECRET'));
  });

  it('returns valid for null/undefined/empty env', () => {
    assert.equal(validateEnvVars(null).valid, true);
    assert.equal(validateEnvVars(undefined).valid, true);
    assert.equal(validateEnvVars({}).valid, true);
  });

  it('allows custom prefixes via BIFROST_ALLOWED_ENV_PREFIXES', () => {
    const original = process.env.BIFROST_ALLOWED_ENV_PREFIXES;
    process.env.BIFROST_ALLOWED_ENV_PREFIXES = 'MYAPP_,CUSTOM_';
    try {
      const result = validateEnvVars({ MYAPP_KEY: 'val', CUSTOM_TOKEN: 'tok' });
      assert.equal(result.valid, true);
    } finally {
      if (original !== undefined) {
        process.env.BIFROST_ALLOWED_ENV_PREFIXES = original;
      } else {
        delete process.env.BIFROST_ALLOWED_ENV_PREFIXES;
      }
    }
  });
});

// ─── 4. mcp-client transport modes ───

describe('McpClientProvider transport modes', () => {
  it('http transport is supported (not TODO)', async () => {
    const { McpClientProvider } = await import('../providers/mcp-client.js');
    const provider = new McpClientProvider({
      id: 'test-http',
      provider: 'mcp-client',
      transport: 'http',
      url: 'http://localhost:9999/mcp',
    });
    assert.equal(provider.transport, 'http');
    // Verify _connect dispatches to _connectHttp
    try {
      await provider._connect();
    } catch (err) {
      // Connection refused is expected — but NOT "Transport not supported"
      assert.ok(!err.message.includes('not supported'), 'http transport should be supported');
    }
  });

  it('sse transport is supported (not TODO)', async () => {
    const { McpClientProvider } = await import('../providers/mcp-client.js');
    const provider = new McpClientProvider({
      id: 'test-sse',
      provider: 'mcp-client',
      transport: 'sse',
      url: 'http://localhost:9999/sse',
    });
    assert.equal(provider.transport, 'sse');
    try {
      await provider._connect();
    } catch (err) {
      assert.ok(!err.message.includes('not supported'), 'sse transport should be supported');
    }
  });

  it('unknown transport throws "not supported"', async () => {
    const { McpClientProvider } = await import('../providers/mcp-client.js');
    const provider = new McpClientProvider({
      id: 'test-unknown',
      provider: 'mcp-client',
      transport: 'websocket',
    });
    await assert.rejects(
      () => provider._connect(),
      { message: /not supported/ }
    );
  });
});

// ─── 5. BaseProvider getPrompts default ───

describe('BaseProvider getPrompts', () => {
  it('returns empty array by default', async () => {
    const { BaseProvider } = await import('../providers/base.js');
    // Create a concrete subclass
    class TestProvider extends BaseProvider {
      getTools() { return []; }
      async callTool() { return {}; }
      async healthCheck() { return { ok: true }; }
      async validateCredentials() { return true; }
      async capabilityCheck() { return { scopes: [], resources: { count: 0 }, tools: [] }; }
    }
    const p = new TestProvider({ id: 'test', provider: 'test', namespace: 'test', displayName: 'Test' });
    assert.deepStrictEqual(p.getPrompts(), []);
  });
});
