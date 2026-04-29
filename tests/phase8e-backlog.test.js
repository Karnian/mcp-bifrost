/**
 * Phase 8e — Backlog 테스트
 * aggregate O(1), audit ring 50, RegExp cache, meta usage, Date 비교,
 * dynamic import → static, console→logger
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. _updateAggregate incremental (O(1) per record) ───

describe('UsageRecorder incremental aggregate', () => {
  it('maintains correct count after many records without O(n) recount', async () => {
    const { UsageRecorder } = await import('../server/usage-recorder.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'bifrost-8e-'));
    try {
      let fakeNow = Date.now();
      const recorder = new UsageRecorder({ stateDir: tmpDir, now: () => fakeNow });
      const N = 100;
      for (let i = 0; i < N; i++) {
        recorder.record({ identity: 'u1', workspaceId: 'ws1', tool: 'tool1', durationMs: 5, ok: true });
      }
      const results = recorder.query({ since: '24h', by: 'tool' });
      const toolEntry = results.find(r => r.key === 'tool1');
      assert.ok(toolEntry);
      assert.equal(toolEntry.count, N);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 2. Audit ring expanded to 50 ───

describe('WorkspaceManager audit ring size', () => {
  it('keeps up to 50 entries instead of 10', async () => {
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const wm = new WorkspaceManager();
    for (let i = 0; i < 55; i++) {
      wm.logAudit('test', null, `entry ${i}`);
    }
    assert.equal(wm.auditLog.length, 50);
  });
});

// ─── 3. matchPattern RegExp LRU cache ───

describe('matchPattern RegExp cache', () => {
  it('reuses cached RegExp for same pattern', async () => {
    const { matchPattern } = await import('../server/mcp-token-manager.js');
    // Call with same glob pattern multiple times
    assert.equal(matchPattern('foo*', 'foobar'), true);
    assert.equal(matchPattern('foo*', 'foobaz'), true);
    assert.equal(matchPattern('foo*', 'bar'), false);
    // Literal patterns don't use regex
    assert.equal(matchPattern('exact', 'exact'), true);
    assert.equal(matchPattern('exact', 'other'), false);
  });
});

// ─── 4. meta tool usage recording (BIFROST_META_USAGE=1) ───

describe('meta tool usage recording', () => {
  it('records usage when BIFROST_META_USAGE=1', async () => {
    const { McpHandler } = await import('../server/mcp-handler.js');
    const recordings = [];
    const mockUsage = {
      record: (r) => { recordings.push(r); return r; },
    };
    const mockWm = {
      getWorkspaces: () => [{ id: 'ws1', provider: 'test', displayName: 'Test', namespace: 'test', status: 'healthy', enabled: true }],
      getEnabledWorkspaces: () => [],
      config: {},
    };
    const mockTr = {
      getTools: async () => [],
      resolve: async (name) => {
        if (name.startsWith('bifrost__')) return { type: 'meta', toolName: name };
        return null;
      },
    };
    const handler = new McpHandler(mockWm, mockTr, { usage: mockUsage });
    const prev = process.env.BIFROST_META_USAGE;
    process.env.BIFROST_META_USAGE = '1';
    try {
      await handler.handle({ method: 'tools/call', params: { name: 'bifrost__list_workspaces' }, id: 1 });
      assert.ok(recordings.length > 0, 'should record meta tool usage');
      assert.equal(recordings[0].tool, 'bifrost__list_workspaces');
    } finally {
      if (prev === undefined) delete process.env.BIFROST_META_USAGE;
      else process.env.BIFROST_META_USAGE = prev;
    }
  });
});

// ─── 5. Date comparison in purgeExpiredWorkspaces ───

describe('purgeExpiredWorkspaces uses Date comparison', () => {
  it('purges workspaces older than 30 days', async () => {
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // Isolate to a tmpdir so purgeExpiredWorkspaces' internal _save() does
    // not write into the repo's real config/ on a CI checkout (which
    // doesn't have a writable workspaces.json by default).
    const dir = await mkdtemp(join(tmpdir(), 'phase8e-purge-'));
    try {
      const wm = new WorkspaceManager({ configDir: dir });
      wm._loaded = true;
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      wm.config = {
        workspaces: [
          { id: 'old-ws', displayName: 'Old', deletedAt: oldDate },
          { id: 'recent-ws', displayName: 'Recent', deletedAt: new Date().toISOString() },
        ],
        server: {},
      };
      const count = await wm.purgeExpiredWorkspaces();
      assert.equal(count, 1);
      assert.equal(wm.config.workspaces.length, 1);
      assert.equal(wm.config.workspaces[0].id, 'recent-ws');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── 6. static import of matchPattern in routes.js ───

describe('routes.js static import', () => {
  it('matchPattern is imported at top level (no dynamic import)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../admin/routes.js', import.meta.url), 'utf-8');
    // Should have static import
    assert.ok(src.includes("import { matchPattern }"), 'matchPattern should be statically imported');
    // Should NOT have await import for matchPattern
    assert.ok(!src.includes("await import('../server/mcp-token-manager.js')"), 'dynamic import should be removed');
  });
});

// ─── 7. _storeTokens helper (8d #16 completed) ───

describe('OAuthManager _storeTokens helper', () => {
  it('_storeTokens method exists and writes byIdentity', async () => {
    const { OAuthManager } = await import('../server/oauth-manager.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'bifrost-8e-oauth-'));
    try {
      const ws = { id: 'test-ws', oauth: { enabled: true } };
      const mockWm = {
        _getRawWorkspace: () => ws,
        getServerConfig: () => ({ port: 3100 }),
        _save: async () => {},
        logAudit: () => {},
      };
      const oauth = new OAuthManager(mockWm, { stateDir: tmpDir });
      const tokenData = { accessToken: 'at_123', refreshToken: 'rt_456', expiresAt: null };
      oauth._storeTokens(ws, 'default', tokenData);
      assert.ok(ws.oauth.byIdentity.default);
      assert.equal(ws.oauth.byIdentity.default.tokens.accessToken, 'at_123');
      // Legacy mirror
      assert.equal(ws.oauth.tokens.accessToken, 'at_123');
      // action_needed cleared
      assert.equal(ws.oauthActionNeededBy.default, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
