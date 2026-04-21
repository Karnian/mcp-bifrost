/**
 * Phase 11-7 §6 — OAuthManager cache key schema separation
 *
 * Before:  `__global__::${issuer}::${authMethod}`   (global, 2-arg)
 *          `${wsId}::${issuer}::${authMethod}`      (scoped, 3-arg)
 * After :  `global::${issuer}::${authMethod}`       (global)
 *          `ws::${wsId}::${issuer}::${authMethod}`  (scoped)
 *
 * Goals:
 *   - Structural separation between legacy and scoped keys — no workspace id
 *     can collide with the reserved global bucket even if it matches a
 *     former sentinel token.
 *   - Backwards compat — existing cache files upgrade transparently at
 *     load time via `_migrateLegacyCacheKeys`.
 *   - removeClient's prefix match is unambiguous (`ws::${wsId}::`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';

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
// _cacheKey() schema

test('_cacheKey: 2-arg returns `global::` prefix', () => {
  const mgr = new OAuthManager(mockWm());
  const key = mgr._cacheKey('https://auth.example', 'none');
  assert.equal(key, 'global::https://auth.example::none');
});

test('_cacheKey: 3-arg returns `ws::` prefix with workspaceId', () => {
  const mgr = new OAuthManager(mockWm());
  const key = mgr._cacheKey('ws-A', 'https://auth.example', 'none');
  assert.equal(key, 'ws::ws-A::https://auth.example::none');
});

test('_cacheKey: workspaceId that collides with former sentinels no longer breaks isolation', () => {
  // A user-picked id like "global" would, under the old schema, look
  // just like a 3-segment legacy scoped key starting with the word
  // `global`. With the explicit prefix, these never collide with the
  // global bucket's `global::` prefix.
  const mgr = new OAuthManager(mockWm());
  const scopedGlobal = mgr._cacheKey('global', 'https://auth.example', 'none');
  const globalBucket = mgr._cacheKey('https://auth.example', 'none');
  assert.equal(scopedGlobal, 'ws::global::https://auth.example::none');
  assert.equal(globalBucket, 'global::https://auth.example::none');
  assert.notEqual(scopedGlobal, globalBucket, 'scoped vs global never collide');
});

// ────────────────────────────────────────────────────────────────────────
// _migrateLegacyCacheKeys() unit

test('_migrateLegacyCacheKeys: __global__:: → global::', () => {
  const mgr = new OAuthManager(mockWm());
  const legacy = { '__global__::https://i/::none': { clientId: 'c' } };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(legacy);
  assert.equal(mutated, true);
  assert.deepEqual(Object.keys(migrated), ['global::https://i/::none']);
  assert.equal(migrated['global::https://i/::none'].clientId, 'c');
});

test('_migrateLegacyCacheKeys: bare-scoped 3-segment → ws:: prefix', () => {
  const mgr = new OAuthManager(mockWm());
  const legacy = { 'ws-1::https://auth.example::none': { clientId: 'cid-1' } };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(legacy);
  assert.equal(mutated, true);
  assert.deepEqual(Object.keys(migrated), ['ws::ws-1::https://auth.example::none']);
});

test('_migrateLegacyCacheKeys: already-new keys pass through untouched', () => {
  const mgr = new OAuthManager(mockWm());
  const input = {
    'global::https://i/::none': { clientId: 'g' },
    'ws::ws-1::https://i/::none': { clientId: 's' },
  };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(input);
  assert.equal(mutated, false);
  assert.deepEqual(migrated, input);
});

test('_migrateLegacyCacheKeys: unrecognized key kept as-is (no silent drop)', () => {
  const mgr = new OAuthManager(mockWm());
  const weird = { 'hand-edited-key': { clientId: 'x' } };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(weird);
  assert.equal(mutated, false);
  assert.deepEqual(migrated, weird);
});

test('_migrateLegacyCacheKeys: mixed input migrates correctly', () => {
  const mgr = new OAuthManager(mockWm());
  const mixed = {
    '__global__::https://a/::none': { clientId: 'g1' },
    'ws-1::https://b/::client_secret_basic': { clientId: 's1' },
    'global::https://c/::client_secret_post': { clientId: 'g2' },
    'ws::ws-2::https://d/::none': { clientId: 's2' },
  };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(mixed);
  assert.equal(mutated, true);
  assert.deepEqual(new Set(Object.keys(migrated)), new Set([
    'global::https://a/::none',
    'ws::ws-1::https://b/::client_secret_basic',
    'global::https://c/::client_secret_post',
    'ws::ws-2::https://d/::none',
  ]));
});

// ────────────────────────────────────────────────────────────────────────
// End-to-end: legacy cache file loads + persists upgraded schema

test('legacy cache file on disk is migrated + persisted on first load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-7-'));
  try {
    // Plant a pre-11-7 cache file with both legacy formats.
    const cachePath = join(dir, 'oauth-issuer-cache.json');
    const legacyCache = {
      '__global__::https://auth.example::none': { clientId: 'g-cid', authMethod: 'none', registeredAt: new Date().toISOString() },
      'ws-seed::https://auth.example::none': { clientId: 's-cid', authMethod: 'none', registeredAt: new Date().toISOString() },
    };
    await writeFile(cachePath, JSON.stringify(legacyCache, null, 2), 'utf-8');

    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    // Force load via a lookup
    const global = await mgr.getCachedClient('https://auth.example', 'none');
    assert.ok(global, 'legacy global entry is still reachable via 2-arg API');
    assert.equal(global.clientId, 'g-cid');
    const scoped = await mgr.getCachedClient('ws-seed', 'https://auth.example', 'none');
    assert.ok(scoped, 'legacy scoped entry is still reachable via 3-arg API');
    assert.equal(scoped.clientId, 's-cid');

    // Cache file on disk should now reflect the new schema.
    const disk = JSON.parse(await readFile(cachePath, 'utf-8'));
    assert.ok(disk['global::https://auth.example::none'], 'persisted global key');
    assert.ok(disk['ws::ws-seed::https://auth.example::none'], 'persisted scoped key');
    assert.ok(!disk['__global__::https://auth.example::none'], 'legacy sentinel removed');
    assert.ok(!disk['ws-seed::https://auth.example::none'], 'bare-scoped legacy removed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// removeClient prefix matching under the new schema

test('removeClient only purges `ws::${wsId}::` entries (no accidental match on global)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-7-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    // Seed the cache with both a global bucket entry and a scoped entry.
    await mgr.registerManual('https://auth.example', { clientId: 'GLOBAL_CID', authMethod: 'none' });
    await mgr.registerManual({ workspaceId: 'ws-1', issuer: 'https://auth.example', clientId: 'SCOPED_CID', authMethod: 'none' });

    const removed = await mgr.removeClient('ws-1');
    assert.equal(removed, 1, 'only the ws-1 scoped entry is removed');

    // Global bucket entry survives.
    const global = await mgr.getCachedClient('https://auth.example', 'none');
    assert.ok(global);
    assert.equal(global.clientId, 'GLOBAL_CID');
    const scoped = await mgr.getCachedClient('ws-1', 'https://auth.example', 'none');
    assert.equal(scoped, null, 'scoped entry gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removeClient on workspaceId that is prefix-similar to another workspace does NOT overmatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-7-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    // Two workspaces whose ids share a prefix. Under both the old
    // `${wsId}::` prefix and the new `ws::${wsId}::` prefix, the
    // embedded delimiters prevent overmatch between `ws-1` and `ws-10`
    // — the trailing `::` is always included in the prefix. This test
    // pins that behavior against future schema edits.
    // (Codex R1 correctly noted this isn't evidence of a bug the old
    // schema had; it's an invariant both schemas uphold.)
    await mgr.registerManual({ workspaceId: 'ws-1', issuer: 'https://auth.example', clientId: 'A', authMethod: 'none' });
    await mgr.registerManual({ workspaceId: 'ws-10', issuer: 'https://auth.example', clientId: 'B', authMethod: 'none' });
    const removed = await mgr.removeClient('ws-1');
    assert.equal(removed, 1);
    const otherStill = await mgr.getCachedClient('ws-10', 'https://auth.example', 'none');
    assert.ok(otherStill, 'ws-10 entry must be preserved');
    assert.equal(otherStill.clientId, 'B');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Codex R1 blocker — legacy migration must survive issuers containing `::`

test('_migrateLegacyCacheKeys: IPv6 literal issuer (contains ::) still migrates', () => {
  const mgr = new OAuthManager(mockWm());
  // RFC 3986 allows IPv6 literals in URI host component, so an issuer
  // like `https://[2001:db8::1]` is valid. The v1 split('::').length===3
  // heuristic would miss this entirely.
  const legacy = {
    'ws-1::https://[2001:db8::1]::none': { clientId: 'ipv6', authMethod: 'none' },
  };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(legacy);
  assert.equal(mutated, true);
  assert.deepEqual(Object.keys(migrated), ['ws::ws-1::https://[2001:db8::1]::none']);
  assert.equal(migrated['ws::ws-1::https://[2001:db8::1]::none'].clientId, 'ipv6');
});

test('_migrateLegacyCacheKeys: unknown authMethod with `::` in path → passes through untouched', () => {
  // Codex R2: title renamed from "still migrates" since this test
  // actually asserts pass-through (the validation guard prevents silent
  // rewrite of experimental hand-edited keys).
  const mgr = new OAuthManager(mockWm());
  const legacy = {
    'ws-2::https://auth.example/tenant::a::basic-ish': { clientId: 'weird' },
  };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(legacy);
  assert.equal(mutated, false, 'unknown authMethod → pass-through (no silent rewrite)');
  assert.deepEqual(migrated, legacy);
});

test('_migrateLegacyCacheKeys: issuer with `::` in path migrates when authMethod is known', () => {
  const mgr = new OAuthManager(mockWm());
  const legacy = {
    'ws-3::https://auth.example/tenant::x/issuer::client_secret_basic': { clientId: 'k' },
  };
  const { migrated, mutated } = mgr._migrateLegacyCacheKeys(legacy);
  assert.equal(mutated, true);
  assert.deepEqual(Object.keys(migrated), [
    'ws::ws-3::https://auth.example/tenant::x/issuer::client_secret_basic',
  ]);
});

test('_migrateLegacyCacheKeys: issuer with `::` round-trips back through _cacheKey', () => {
  const mgr = new OAuthManager(mockWm());
  // After migration, a subsequent getCachedClient call uses _cacheKey to
  // build the lookup key. Verify the parsed (wsId, issuer, authMethod)
  // triple yields exactly the migrated key.
  const issuer = 'https://[2001:db8::1]/oauth';
  const legacy = {
    [`ws-rt::${issuer}::none`]: { clientId: 'rt-cid' },
  };
  const { migrated } = mgr._migrateLegacyCacheKeys(legacy);
  const expectedKey = mgr._cacheKey('ws-rt', issuer, 'none');
  assert.ok(migrated[expectedKey], `migrated map must be reachable via _cacheKey: ${expectedKey}`);
});
