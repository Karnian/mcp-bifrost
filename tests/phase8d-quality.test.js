/**
 * Phase 8d — 코드 품질 테스트
 * withLogLevel 헬퍼, readBody DRY (http-utils), getRawWorkspace public API
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. readBody from http-utils ───

describe('http-utils readBody', () => {
  it('can be imported from server/http-utils.js', async () => {
    const { readBody } = await import('../server/http-utils.js');
    assert.equal(typeof readBody, 'function');
  });

  it('is re-exported from admin/auth.js', async () => {
    const { readBody } = await import('../admin/auth.js');
    assert.equal(typeof readBody, 'function');
  });
});

// ─── 2. getRawWorkspace public API ───

describe('WorkspaceManager getRawWorkspace public API', () => {
  it('exposes getRawWorkspace as public method', async () => {
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const wm = new WorkspaceManager();
    wm.config = { workspaces: [{ id: 'test-1', provider: 'notion', displayName: 'Test' }], server: {} };
    const ws = wm.getRawWorkspace('test-1');
    assert.ok(ws);
    assert.equal(ws.id, 'test-1');
    // _getRawWorkspace should still work as alias
    const ws2 = wm._getRawWorkspace('test-1');
    assert.equal(ws2, ws);
  });

  it('returns undefined for non-existent workspace', async () => {
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const wm = new WorkspaceManager();
    wm.config = { workspaces: [], server: {} };
    assert.equal(wm.getRawWorkspace('nope'), undefined);
  });
});

// ─── 3. withLogLevel already tested in logger.test.js ───
// Just verify the export works
describe('withLogLevel export', () => {
  it('can be imported from server/logger.js', async () => {
    const { withLogLevel } = await import('../server/logger.js');
    assert.equal(typeof withLogLevel, 'function');
  });
});
