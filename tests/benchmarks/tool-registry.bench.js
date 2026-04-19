/**
 * Benchmark: ToolRegistry performance with many workspaces/tools.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('ToolRegistry performance', () => {
  it('getTools with 100 workspaces, 10 tools each completes under 500ms', async () => {
    const { ToolRegistry } = await import('../../server/tool-registry.js');

    // Mock workspace manager with 100 workspaces
    const workspaces = [];
    const providers = new Map();
    for (let i = 0; i < 100; i++) {
      const wsId = `ws-${i}`;
      workspaces.push({
        id: wsId, provider: 'notion', namespace: `ns${i}`,
        displayName: `WS ${i}`, enabled: true, status: 'healthy',
      });
      providers.set(wsId, {
        getTools: () => {
          const tools = [];
          for (let j = 0; j < 10; j++) {
            tools.push({
              name: `tool_${j}`,
              description: `Tool ${j}`,
              inputSchema: { type: 'object', properties: {} },
            });
          }
          return tools;
        },
      });
    }

    const wm = {
      getWorkspaces: () => workspaces,
      getEnabledWorkspaces: () => workspaces,
      getProvider: (id) => providers.get(id),
      config: {},
    };
    const tr = new ToolRegistry(wm);

    const start = performance.now();
    const tools = await tr.getTools();
    const elapsed = performance.now() - start;

    // 100 ws * 10 tools + 2 meta tools (bifrost__list_workspaces, bifrost__workspace_info)
    assert.ok(tools.length >= 1000, `Expected at least 1000 tools, got ${tools.length}`);
    assert.ok(elapsed < 500, `getTools took ${elapsed.toFixed(1)}ms, expected < 500ms`);
  });
});
