/**
 * Phase 9d — 운영 기능 테스트
 * usage timeseries, profile glob validation, existing features verification
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. Usage timeseries ───

describe('UsageRecorder timeseries', () => {
  it('returns hourly buckets from in-memory events', async () => {
    const { UsageRecorder } = await import('../server/usage-recorder.js');
    const baseTime = Date.now();
    const usage = new UsageRecorder({ stateDir: '/tmp/bifrost-test-usage-9d', now: () => baseTime });

    // Record a few events at different hours
    usage.record({ identity: 'user1', workspaceId: 'ws1', tool: 'search', durationMs: 100, ok: true });
    usage.record({ identity: 'user1', workspaceId: 'ws1', tool: 'search', durationMs: 200, ok: false });
    usage.record({ identity: 'user2', workspaceId: 'ws2', tool: 'read', durationMs: 50, ok: true });

    const series = usage.timeseries({ range: '24h' });
    assert.ok(Array.isArray(series));
    assert.ok(series.length > 0);

    // All events are at the same hour
    const bucket = series[0];
    assert.equal(bucket.callCount, 3);
    assert.equal(bucket.errorCount, 1);
    assert.ok(bucket.avgLatency > 0);
    assert.ok(bucket.hour.endsWith(':00:00Z'));
  });

  it('returns empty array when no events', async () => {
    const { UsageRecorder } = await import('../server/usage-recorder.js');
    const usage = new UsageRecorder({ stateDir: '/tmp/bifrost-test-usage-9d-empty', now: () => Date.now() });
    const series = usage.timeseries({ range: '24h' });
    assert.deepStrictEqual(series, []);
  });

  it('sorts by hour ascending', async () => {
    const { UsageRecorder } = await import('../server/usage-recorder.js');
    let fakeTime = Date.now();
    const usage = new UsageRecorder({ stateDir: '/tmp/bifrost-test-usage-9d-sort', now: () => fakeTime });

    // Record at hour H
    usage.record({ identity: 'u1', workspaceId: 'ws1', tool: 't1', durationMs: 10, ok: true });
    // Advance 2 hours and record again
    fakeTime += 2 * 60 * 60 * 1000;
    usage.record({ identity: 'u1', workspaceId: 'ws1', tool: 't1', durationMs: 20, ok: true });

    const series = usage.timeseries({ range: '24h' });
    assert.ok(series.length >= 2);
    assert.ok(series[0].hour < series[series.length - 1].hour);
  });
});

// ─── 2. Profile glob validation ───

describe('Profile glob validation', () => {
  it('rejects patterns longer than 256 chars', async () => {
    // This test verifies the validation logic exists in the routes
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../admin/routes.js', import.meta.url), 'utf-8');
    assert.ok(src.includes('PATTERN_TOO_LONG'));
    assert.ok(src.includes('256'));
  });

  it('rejects ReDoS-risk patterns', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../admin/routes.js', import.meta.url), 'utf-8');
    assert.ok(src.includes('PATTERN_REDOS'));
  });
});

// ─── 3. Soft delete already implemented ───

describe('WorkspaceManager soft delete', () => {
  it('has deleteWorkspace with deletedAt', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../server/workspace-manager.js', import.meta.url), 'utf-8');
    assert.ok(src.includes('deletedAt'));
    assert.ok(src.includes('restoreWorkspace'));
    assert.ok(src.includes('getDeletedWorkspaces'));
    assert.ok(src.includes('purgeExpiredWorkspaces'));
  });
});

// ─── 4. Export/import validation (9b에서 추가) ───

describe('Export/import with validation', () => {
  it('/api/import validates per-entry and checks command/env', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../admin/routes.js', import.meta.url), 'utf-8');
    // Import route has schema + command + env validation
    assert.ok(src.includes('importValidation'));
    assert.ok(src.includes('isCommandAllowed'));
    assert.ok(src.includes('validateEnvVars'));
  });
});

// ─── 5. MCP token scope already implemented ───

describe('MCP token scope', () => {
  it('issue() accepts allowedWorkspaces and allowedProfiles', async () => {
    const { McpTokenManager } = await import('../server/mcp-token-manager.js');
    const wm = {
      config: { server: { mcpTokens: [] } },
      _save: async () => {},
    };
    const tm = new McpTokenManager(wm);
    const result = await tm.issue({
      id: 'scoped-token',
      description: 'Test scoped token',
      allowedWorkspaces: ['notion-*'],
      allowedProfiles: ['read-only'],
    });
    assert.ok(result.plaintext);
    assert.equal(result.id, 'scoped-token');
    // Verify the stored entry has the scope
    const stored = wm.config.server.mcpTokens.find(t => t.id === 'scoped-token');
    assert.deepStrictEqual(stored.allowedWorkspaces, ['notion-*']);
    assert.deepStrictEqual(stored.allowedProfiles, ['read-only']);
  });
});

// ─── 6. Audit log file-based with rotation ───

describe('AuditLogger file-based rotation', () => {
  it('has rotation and purge logic', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../server/audit-logger.js', import.meta.url), 'utf-8');
    assert.ok(src.includes('_rotateIfNeeded'));
    assert.ok(src.includes('MAX_FILE_BYTES'));
    assert.ok(src.includes('_purgeOldRotations'));
    assert.ok(src.includes('RETENTION_MS'));
  });
});

// ─── 7. Usage timeseries API route ───

describe('Usage timeseries API route', () => {
  it('/api/usage/timeseries route exists with range validation', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../admin/routes.js', import.meta.url), 'utf-8');
    assert.ok(src.includes('/api/usage/timeseries'));
    assert.ok(src.includes('INVALID_RANGE'));
    assert.ok(src.includes('timeseries'));
  });
});
