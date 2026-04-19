/**
 * Phase 9f — 테스트 인프라 테스트
 * coverage script, benchmark framework, test structure
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. package.json has test scripts ───

describe('Test infrastructure', () => {
  it('package.json has test:coverage script', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
    assert.ok(pkg.scripts['test:coverage']);
    assert.ok(pkg.scripts['test:coverage'].includes('--experimental-test-coverage'));
  });

  it('package.json has test:bench script', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
    assert.ok(pkg.scripts['test:bench']);
    assert.ok(pkg.scripts['test:bench'].includes('benchmarks'));
  });

  it('benchmarks directory exists with at least one file', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(new URL('../tests/benchmarks/', import.meta.url));
    assert.ok(files.length > 0);
    assert.ok(files.some(f => f.endsWith('.bench.js')));
  });
});

// ─── 2. Benchmark runs ───

describe('Benchmark smoke test', () => {
  it('tool-registry benchmark completes successfully', async () => {
    // Import and run inline — just verify it doesn't crash
    const { ToolRegistry } = await import('../server/tool-registry.js');
    const wsData = [{ id: 'ws1', provider: 'notion', namespace: 'test', displayName: 'T', enabled: true, status: 'healthy' }];
    const wm = {
      getWorkspaces: () => wsData,
      getEnabledWorkspaces: () => wsData,
      getProvider: () => ({
        getTools: () => [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      }),
      config: {},
    };
    const tr = new ToolRegistry(wm);
    const tools = await tr.getTools();
    assert.ok(tools.length > 0);
  });
});
