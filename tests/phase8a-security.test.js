/**
 * Phase 8a — 긴급 보안 패치 테스트
 * path traversal, body limit, XSS escape, slowloris timeout, callTool throw
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../server/html-escape.js';

// ─── 1. HTML escape (XSS prevention) ───

describe('escapeHtml', () => {
  it('escapes all 5 dangerous characters', () => {
    const input = '<script>alert("xss")&\'</script>';
    const escaped = escapeHtml(input);
    assert.ok(!escaped.includes('<'));
    assert.ok(!escaped.includes('>'));
    assert.ok(escaped.includes('&lt;'));
    assert.ok(escaped.includes('&gt;'));
    assert.ok(escaped.includes('&quot;'));
    assert.ok(escaped.includes('&#39;'));
    assert.ok(escaped.includes('&amp;'));
  });

  it('returns empty string for non-string input', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(123), '');
  });

  it('passes through safe strings unchanged', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
  });
});

// ─── 2. callTool throw for transient errors ───

describe('McpClientProvider callTool throw behavior', () => {
  it('throws on HTTP error (enables mcp-handler retry)', async () => {
    const { McpClientProvider } = await import('../providers/mcp-client.js');
    const provider = new McpClientProvider({
      id: 'test-throw',
      kind: 'mcp-client',
      transport: 'http',
      url: 'http://localhost:19999',
      namespace: 'test',
      provider: 'mcp',
    });
    provider._initialized = true;
    provider._rpc = mock.fn(async () => {
      const err = new Error('HTTP 500: Internal Server Error');
      err.status = 500;
      throw err;
    });

    await assert.rejects(() => provider.callTool('some_tool', {}), (err) => {
      assert.equal(err.status, 500);
      return true;
    });
  });

  it('throws on 429 with retryAfter preserved', async () => {
    const { McpClientProvider } = await import('../providers/mcp-client.js');
    const provider = new McpClientProvider({
      id: 'test-429',
      kind: 'mcp-client',
      transport: 'http',
      url: 'http://localhost:19999',
      namespace: 'test',
      provider: 'mcp',
    });
    provider._initialized = true;
    provider._rpc = mock.fn(async () => {
      const err = new Error('HTTP 429');
      err.status = 429;
      err.retryAfter = 5;
      throw err;
    });

    await assert.rejects(() => provider.callTool('some_tool', {}), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 5);
      return true;
    });
  });

  it('throws on connection errors (ECONNREFUSED)', async () => {
    const { McpClientProvider } = await import('../providers/mcp-client.js');
    const provider = new McpClientProvider({
      id: 'test-conn',
      kind: 'mcp-client',
      transport: 'http',
      url: 'http://localhost:19999',
      namespace: 'test',
      provider: 'mcp',
    });
    provider._initialized = true;
    provider._rpc = mock.fn(async () => {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    });

    await assert.rejects(() => provider.callTool('some_tool', {}), (err) => {
      assert.equal(err.code, 'ECONNREFUSED');
      return true;
    });
  });

  it('returns business errors (isError) without throwing', async () => {
    const { McpClientProvider } = await import('../providers/mcp-client.js');
    const provider = new McpClientProvider({
      id: 'test-biz',
      kind: 'mcp-client',
      transport: 'http',
      url: 'http://localhost:19999',
      namespace: 'test',
      provider: 'mcp',
    });
    provider._initialized = true;
    provider._rpc = mock.fn(async () => ({
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    }));

    const result = await provider.callTool('some_tool', {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Something went wrong');
  });
});

// ─── 3. Path traversal defense ───

describe('serveStatic path traversal defense', () => {
  it('blocks ../../ path traversal attempts', async () => {
    const { createAdminRoutes } = await import('../admin/routes.js');
    const mockWm = {
      getAdminToken: () => null,
      getWorkspaces: () => [],
      getEnabledWorkspaces: () => [],
      config: { server: { port: 3100 } },
      getServerConfig: () => ({ port: 3100 }),
    };
    const mockTr = { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 };
    const handler = createAdminRoutes(mockWm, mockTr, null, null, null, {});

    let statusCode, responseBody;
    const res = {
      writeHead: (code, headers) => { statusCode = code; },
      end: (body) => { responseBody = body; },
    };
    const url = new URL('http://localhost:3100/admin/../../config/workspaces.json');
    const req = { method: 'GET', url: url.pathname, headers: {}, socket: { remoteAddress: '127.0.0.1' } };

    await handler(req, res, url);
    // Should get 403 or SPA fallback (not workspaces.json content)
    if (statusCode === 403) {
      assert.equal(statusCode, 403);
    } else {
      // SPA fallback — verify it's NOT the workspaces.json content
      const text = responseBody?.toString?.() || '';
      assert.ok(!text.includes('"workspaces"') || text.includes('<!'), 'Should not serve raw workspaces.json');
    }
  });
});
