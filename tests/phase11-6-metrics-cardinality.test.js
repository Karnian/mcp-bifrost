/**
 * Phase 11-6 §9 — OAuthMetrics cardinality cap + workspace prune hook
 *
 * Phase 11-4 (Codex R2 non-blocking) flagged that the in-memory counter
 * Map grows monotonically: entries for deleted workspaces / churning
 * identity-issuer tuples never age out. This phase adds
 *   - a soft cap (default 10_000) that evicts oldest insertion-order
 *     entries when exceeded, and
 *   - `pruneWorkspace(wsId)` called from OAuthManager.removeClient()
 *     so hard-delete + TTL-expire paths drop stale metrics.
 *
 * The soft cap is intentionally insertion-order eviction (not LRU): a
 * true LRU would require touching entry order on every inc, which
 * dominates the simple hot-path. Insertion-order is good enough because
 * pathological growth comes from label churn, not counter hotness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { OAuthMetrics } from '../server/oauth-metrics.js';

function mockWm(workspaces = {}) {
  const audits = [];
  return {
    workspaces, audits,
    _getRawWorkspace: (id) => workspaces[id] || null,
    getRawWorkspace: (id) => workspaces[id] || null,
    getServerConfig: () => ({ port: 3100 }),
    _save: async () => {},
    logAudit: (action, ws, details, identity) => audits.push({ action, ws, details, identity }),
    logError: () => {},
  };
}

// ────────────────────────────────────────────────────────────────────────
// pruneWorkspace unit

test('pruneWorkspace: drops every counter whose workspace label matches, leaves others', () => {
  const m = new OAuthMetrics();
  m.inc('oauth_cache_miss_total', { workspace: 'ws-A' });
  m.inc('oauth_refresh_total', { workspace: 'ws-A', identity: 'default', status: 'ok' });
  m.inc('oauth_dcr_total', { workspace: 'ws-A', issuer: 'i', status: '200' });
  m.inc('oauth_cache_miss_total', { workspace: 'ws-B' });
  m.inc('oauth_threshold_trip_total', { workspace: 'ws-C', identity: 'bot' });

  const removed = m.pruneWorkspace('ws-A');
  assert.equal(removed, 3, 'three ws-A counters must be removed');
  const remaining = m.snapshot();
  assert.equal(remaining.length, 2);
  const workspaces = new Set(remaining.map(c => c.labels.workspace));
  assert.deepEqual(workspaces, new Set(['ws-B', 'ws-C']));
});

test('pruneWorkspace: no-op when workspace id has no entries (or falsy)', () => {
  const m = new OAuthMetrics();
  m.inc('x', { workspace: 'ws-keep' });
  assert.equal(m.pruneWorkspace('ws-nonexistent'), 0);
  assert.equal(m.pruneWorkspace(null), 0);
  assert.equal(m.pruneWorkspace(undefined), 0);
  assert.equal(m.pruneWorkspace(''), 0);
  assert.equal(m.snapshot().length, 1, 'unrelated entries untouched');
});

test('pruneWorkspace: entries without workspace label are preserved', () => {
  const m = new OAuthMetrics();
  m.inc('x', {}); // no workspace label at all
  m.inc('y', { workspace: 'ws-gone' });
  m.pruneWorkspace('ws-gone');
  const snap = m.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].name, 'x');
});

// ────────────────────────────────────────────────────────────────────────
// size() observation

test('size: reflects current entry count and drops after prune', () => {
  const m = new OAuthMetrics();
  assert.equal(m.size(), 0);
  m.inc('a', { workspace: 'ws-1' });
  m.inc('b', { workspace: 'ws-1' });
  m.inc('c', { workspace: 'ws-2' });
  assert.equal(m.size(), 3);
  m.pruneWorkspace('ws-1');
  assert.equal(m.size(), 1);
});

// ────────────────────────────────────────────────────────────────────────
// Soft cap — insertion-order eviction

test('soft cap: exceeding maxEntries evicts oldest-insertion entries first', () => {
  const m = new OAuthMetrics({ maxEntries: 3 });
  m.inc('a', { workspace: 'ws-1' }); // insertion 0 (oldest)
  m.inc('b', { workspace: 'ws-2' });
  m.inc('c', { workspace: 'ws-3' });
  assert.equal(m.size(), 3);
  m.inc('d', { workspace: 'ws-4' }); // triggers eviction of 'a'
  assert.equal(m.size(), 3);
  const names = m.snapshot().map(c => c.name);
  assert.ok(!names.includes('a'), 'oldest entry evicted');
  assert.deepEqual(names, ['b', 'c', 'd']);
});

test('soft cap: incrementing existing counter does NOT trigger eviction', () => {
  const m = new OAuthMetrics({ maxEntries: 2 });
  m.inc('a', { workspace: 'ws-1' });
  m.inc('b', { workspace: 'ws-2' });
  assert.equal(m.size(), 2);
  // Re-increment existing — size unchanged, no eviction.
  m.inc('a', { workspace: 'ws-1' }, 5);
  m.inc('b', { workspace: 'ws-2' });
  assert.equal(m.size(), 2);
  const a = m.snapshot().find(c => c.name === 'a');
  assert.equal(a.value, 6);
});

test('soft cap: maxEntries=0 disables cap (useful for tests)', () => {
  const m = new OAuthMetrics({ maxEntries: 0 });
  for (let i = 0; i < 100; i++) m.inc('x', { workspace: `ws-${i}` });
  assert.equal(m.size(), 100);
});

test('soft cap: default maxEntries is applied when omitted', () => {
  const m = new OAuthMetrics();
  // Can't easily assert 10_000 without burning cycles — verify the cap
  // exists by construction: we feed past a large threshold and check size
  // stays bounded within a reasonable time.
  const start = Date.now();
  for (let i = 0; i < 10_005; i++) m.inc('x', { workspace: `ws-${i}` });
  assert.equal(m.size(), 10_000, 'default cap is 10_000');
  assert.ok(Date.now() - start < 2000, 'fits within 2s budget');
});

// ────────────────────────────────────────────────────────────────────────
// Integration — OAuthManager.removeClient() invokes pruneWorkspace

test('OAuthManager.removeClient prunes metrics for the deleted workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-6-'));
  try {
    const metrics = new OAuthMetrics();
    // Pre-populate metrics as if ws-GONE had been active
    metrics.inc('oauth_cache_miss_total', { workspace: 'ws-GONE' });
    metrics.inc('oauth_refresh_total', { workspace: 'ws-GONE', identity: 'default', status: 'ok' });
    metrics.inc('oauth_cache_hit_total', { workspace: 'ws-KEEP' });

    const mgr = new OAuthManager(mockWm(), { stateDir: dir, metrics });
    // Seed the issuer cache with one entry so removeClient returns >0 and
    // audits the cache_purge. The prune path must run regardless.
    const fetchImpl = async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({ client_id: 'C' }), text: async () => '' });
    mgr.fetch = fetchImpl;
    await mgr.registerClient('https://auth.example', {
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none'],
    }, { workspaceId: 'ws-GONE', authMethod: 'none' });

    const removed = await mgr.removeClient('ws-GONE');
    assert.ok(removed >= 1, 'at least one cache entry removed');
    const snap = metrics.snapshot();
    const gone = snap.filter(c => c.labels.workspace === 'ws-GONE');
    assert.equal(gone.length, 0, 'all ws-GONE metrics pruned');
    const keep = snap.filter(c => c.labels.workspace === 'ws-KEEP');
    assert.equal(keep.length, 1, 'unrelated workspace metrics preserved');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.removeClient on a workspace with no cache entry still prunes metrics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-6-'));
  try {
    const metrics = new OAuthMetrics();
    metrics.inc('oauth_refresh_total', { workspace: 'ws-ORPHAN', identity: 'default', status: 'fail_net' });
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, metrics });
    const removed = await mgr.removeClient('ws-ORPHAN');
    assert.equal(removed, 0, 'no cache entries to purge');
    assert.equal(metrics.size(), 0, 'but metrics were still pruned (runs outside the removed>0 gate)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.removeClient with metrics=null is a no-op (no crash)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-6-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir /* no metrics */ });
    // If removeClient crashes when metrics is null, this rejects.
    const removed = await mgr.removeClient('ws-noop');
    assert.equal(removed, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.removeClient swallows pruneWorkspace throws (broken recorder)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-6-'));
  try {
    const throwingMetrics = {
      inc: () => {},
      pruneWorkspace: () => { throw new Error('recorder exploded'); },
    };
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, metrics: throwingMetrics });
    const removed = await mgr.removeClient('ws-any');
    assert.equal(removed, 0, 'returns normally even when recorder throws');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
