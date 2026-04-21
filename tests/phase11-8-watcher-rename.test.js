/**
 * Phase 11-8 §7 — Watcher now reloads on atomic-replace (rename) writes
 *
 * Phase 11-3 (Codex R2 low) flagged that `_startFileWatcher` only handled
 * `eventType === 'change'`. Atomic saves from editors (VSCode, vim, sed,
 * even Bifrost's own `_save()`) publish `rename` because the on-disk
 * inode flips (temp file → rename over path). These writes silently
 * bypassed hot-reload.
 *
 * After Phase 11-8:
 *   - The watcher treats `rename` the same as `change`.
 *   - If the file is transiently absent during the rename, a 50ms grace
 *     tolerates the gap before concluding the file is gone.
 *   - After a `rename` the old inode watcher is stale, so we close it
 *     and rebind to the new inode on the next tick (setImmediate).
 *
 * This test suite relies on the new `configDir` DI option on
 * WorkspaceManager so we can exercise the watcher against a tmpdir
 * without touching the repo's real config/workspaces.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from '../server/workspace-manager.js';

async function waitForCondition(pred, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function makeConfig(workspaces = []) {
  return {
    workspaces,
    server: { port: 3100 },
    tunnel: { enabled: false, fixedDomain: '' },
  };
}

// ────────────────────────────────────────────────────────────────────────

test('atomic rename: external writer (tmp + rename) triggers hot-reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-8-'));
  const configPath = join(dir, 'workspaces.json');
  try {
    // Plant an initial config so `load()` doesn't try to save-default.
    await writeFile(configPath, JSON.stringify(makeConfig([
      { id: 'native-one', kind: 'native', provider: 'notion', displayName: 'One', alias: 'one', namespace: 'one', enabled: true, credentials: {} },
    ]), null, 2), 'utf-8');

    const wm = new WorkspaceManager({ configDir: dir });
    await wm.load();
    assert.equal(wm.getWorkspaces().length, 1);
    assert.equal(wm.getWorkspaces()[0].id, 'native-one');

    let changeObserved = 0;
    wm.onWorkspaceChange(() => { changeObserved++; });

    // Simulate an atomic-save from an external tool: write to tmp, then
    // rename over the config. Without the rename branch, this is missed.
    const tmpPath = join(dir, 'external.tmp');
    await writeFile(tmpPath, JSON.stringify(makeConfig([
      { id: 'native-one', kind: 'native', provider: 'notion', displayName: 'One', alias: 'one', namespace: 'one', enabled: true, credentials: {} },
      { id: 'native-two', kind: 'native', provider: 'slack', displayName: 'Two', alias: 'two', namespace: 'two', enabled: true, credentials: {} },
    ]), null, 2), 'utf-8');
    await rename(tmpPath, configPath);

    const reloaded = await waitForCondition(() => wm.getWorkspaces().length === 2);
    assert.ok(reloaded, `watcher must observe rename and hot-reload (workspaces: ${wm.getWorkspaces().length}, changes: ${changeObserved})`);
    assert.equal(wm.getWorkspaces().map(w => w.id).sort().join(','), 'native-one,native-two');
    assert.ok(changeObserved >= 1, 'onWorkspaceChange callback must fire');

    // Follow-up: after the rename, the inode changed. A subsequent
    // atomic write must STILL be observed — proves the watcher rebinding
    // logic (setImmediate-scheduled _startFileWatcher) ran.
    const tmpPath2 = join(dir, 'external2.tmp');
    await writeFile(tmpPath2, JSON.stringify(makeConfig([])), 'utf-8');
    await rename(tmpPath2, configPath);

    const empty = await waitForCondition(() => wm.getWorkspaces().length === 0);
    assert.ok(empty, 'second rename after rebind must still hot-reload');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('in-place write: change event still hot-reloads without rebinding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-8-'));
  const configPath = join(dir, 'workspaces.json');
  try {
    await writeFile(configPath, JSON.stringify(makeConfig([])), 'utf-8');
    const wm = new WorkspaceManager({ configDir: dir });
    await wm.load();
    // In-place write (not atomic) keeps the inode the same and publishes
    // `change`. Must still be observed.
    await writeFile(configPath, JSON.stringify(makeConfig([
      { id: 'native-x', kind: 'native', provider: 'notion', displayName: 'X', alias: 'x', namespace: 'x', enabled: true, credentials: {} },
    ]), null, 2), 'utf-8');
    const reloaded = await waitForCondition(() => wm.getWorkspaces().length === 1);
    assert.ok(reloaded, 'in-place change still triggers hot-reload');
    assert.equal(wm.getWorkspaces()[0].id, 'native-x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('self _save does NOT loop the hot-reload (self-save guard)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-8-'));
  const configPath = join(dir, 'workspaces.json');
  try {
    await writeFile(configPath, JSON.stringify(makeConfig([])), 'utf-8');
    const wm = new WorkspaceManager({ configDir: dir });
    await wm.load();
    let changeCount = 0;
    wm.onWorkspaceChange(() => { changeCount++; });

    // Add a workspace via the internal API — this calls _save() which uses
    // atomic rename. The self-save guard must suppress the hot-reload
    // cycle even though our _save emits a `rename` event now.
    const before = changeCount;
    await wm.addWorkspace({ kind: 'native', provider: 'notion', displayName: 'Self' });
    // Let the watcher observe the self-save rename + decide to skip it.
    await new Promise(r => setTimeout(r, 150));
    // Exactly one change from addWorkspace._notifyChange, not two (the
    // re-entrant hot-reload would have incremented a second time).
    const delta = changeCount - before;
    assert.equal(delta, 1, `expected exactly one change (addWorkspace direct notify); got ${delta}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex R1 blocker: mutated hot-reload ＋ second external rename stays observed', async () => {
  // Repro: external atomic write plants a flat-field (pre-Phase-11-3)
  // legacy config → hot-reload triggers _migrateLegacy() mutated=true
  // → background _save() fires another atomic rename. Without the
  // save-before-rebind sequencing, the rebound watcher would arm on
  // the old inode, the save's rename would skip because _saving=true,
  // and the watcher goes stale. A subsequent external rename is then
  // silently missed.
  const dir = await mkdtemp(join(tmpdir(), 'phase11-8-'));
  const configPath = join(dir, 'workspaces.json');
  try {
    await writeFile(configPath, JSON.stringify(makeConfig([])), 'utf-8');
    const wm = new WorkspaceManager({ configDir: dir });
    await wm.load();

    // 1) External atomic write with a FLAT-FIELD legacy oauth entry.
    //    _migrateLegacy() promotes flat → nested + scrubs, returning
    //    mutated=true → hot-reload pipeline schedules _save() which
    //    itself is an atomic rename.
    const legacyWs = {
      id: 'http-legacy',
      kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
      displayName: 'Legacy', alias: 'legacy', namespace: 'legacy', enabled: true,
      oauth: {
        enabled: true,
        issuer: 'https://auth.example',
        // Flat fields — pre-Phase-11-3 shape. Migration moves them
        // under ws.oauth.client + scrubs the flat keys.
        clientId: 'LEGACY_CID',
        clientSecret: null,
        authMethod: 'none',
      },
    };
    const tmpPath1 = join(dir, 'external1.tmp');
    await writeFile(tmpPath1, JSON.stringify(makeConfig([legacyWs]), null, 2), 'utf-8');
    await rename(tmpPath1, configPath);

    // Wait for migration + background _save to flush.
    const promoted = await waitForCondition(() => {
      const ws = wm.getRawWorkspace?.('http-legacy') || wm._getRawWorkspace?.('http-legacy');
      return ws?.oauth?.client?.clientId === 'LEGACY_CID';
    });
    assert.ok(promoted, 'flat field must have been migrated into ws.oauth.client');
    // Give _save's own atomic rename time to finalise.
    await new Promise(r => setTimeout(r, 120));

    // 2) Second external atomic rename AFTER the migration save. If the
    //    rebind raced the save, this event is missed and the test fails
    //    on timeout.
    const tmpPath2 = join(dir, 'external2.tmp');
    await writeFile(tmpPath2, JSON.stringify(makeConfig([
      // Different workspace id so we can assert state change.
      { id: 'native-fresh', kind: 'native', provider: 'notion', displayName: 'Fresh', alias: 'fresh', namespace: 'fresh', enabled: true, credentials: {} },
    ]), null, 2), 'utf-8');
    await rename(tmpPath2, configPath);

    const observed = await waitForCondition(() =>
      wm.getWorkspaces().length === 1 && wm.getWorkspaces()[0].id === 'native-fresh'
    );
    assert.ok(observed, 'second external rename after mutated hot-reload must still be hot-reloaded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-existent file at startup: watcher stays idle (no crash)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-8-'));
  try {
    // Don't plant a config — WorkspaceManager.load() will write a default
    // and then start the watcher. Verify no crash + watcher works.
    const wm = new WorkspaceManager({ configDir: dir });
    await wm.load();
    assert.equal(wm.getWorkspaces().length, 0);
    // Trigger a change to prove the watcher still runs on the
    // auto-created config.
    const configPath = join(dir, 'workspaces.json');
    await writeFile(configPath, JSON.stringify(makeConfig([
      { id: 'native-late', kind: 'native', provider: 'notion', displayName: 'Late', alias: 'late', namespace: 'late', enabled: true, credentials: {} },
    ]), null, 2), 'utf-8');
    const ok = await waitForCondition(() => wm.getWorkspaces().length === 1);
    assert.ok(ok);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
