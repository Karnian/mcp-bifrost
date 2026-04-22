/**
 * Phase 11-10 — non-blocking cleanup batch
 *
 * Consolidates the five tail items left open after Phase 11-4 through
 * 11-9 Codex reviews:
 *   §1  OAuthMetrics saturation stats() + /api/oauth/metrics/status
 *   §2  Hostname-based provider guide matching (moved to its own module)
 *   §3  removeClient also purges legacy bare-scoped keys
 *   §4  Watcher rename re-migration — covered by existing 11-8 test 3
 *        + this suite's save-loop invariant (no new code path needed)
 *   §5  guideFor / renderStaticClientBody unit tests
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../server/oauth-manager.js';
import { OAuthMetrics } from '../server/oauth-metrics.js';
import { createAdminRoutes } from '../admin/routes.js';
import { guideFor, renderStaticClientBody, STATIC_CLIENT_GUIDES } from '../admin/public/static-client-guides.js';

// ────────────────────────────────────────────────────────────────────────
// Fixtures

function mockWm(workspaces = {}) {
  const audits = [];
  const errors = [];
  return {
    workspaces, audits, errors,
    _getRawWorkspace: (id) => workspaces[id] || null,
    getRawWorkspace: (id) => workspaces[id] || null,
    getWorkspaces: () => [],
    getOAuthClient: () => null,
    getAdminToken: () => null,
    getMcpToken: () => null,
    getServerConfig: () => ({ port: 3100 }),
    _save: async () => {},
    logAudit: (action, ws, details, identity) => audits.push({ action, ws, details, identity }),
    logError: (category, ws, msg) => errors.push({ category, ws, msg }),
    oauthAuditLog: [],
    fileSecurityWarning: false,
  };
}

async function startAdmin(oauth, metrics) {
  const routes = createAdminRoutes(
    mockWm(),
    { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
    { getSessionCount: () => 0 },
    oauth,
    null,
    metrics ? { oauthMetrics: metrics } : {},
  );
  const server = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    routes(req, res, u);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

// ────────────────────────────────────────────────────────────────────────
// §1 — OAuthMetrics saturation stats

test('stats(): reports current entries / maxEntries / saturation / evictionsTotal', () => {
  const m = new OAuthMetrics({ maxEntries: 3 });
  assert.deepEqual(m.stats(), { entries: 0, maxEntries: 3, capped: true, evictionsTotal: 0, saturation: 0 });
  m.inc('a', { workspace: 'ws-1' });
  m.inc('b', { workspace: 'ws-2' });
  const s1 = m.stats();
  assert.equal(s1.entries, 2);
  assert.equal(s1.saturation, 2 / 3);
  assert.equal(s1.evictionsTotal, 0);
});

test('stats(): evictionsTotal increments monotonically as cap is exceeded', () => {
  const m = new OAuthMetrics({ maxEntries: 2 });
  m.inc('a', { workspace: 'ws-1' });
  m.inc('b', { workspace: 'ws-2' });
  assert.equal(m.stats().evictionsTotal, 0);
  m.inc('c', { workspace: 'ws-3' }); // evicts 'a'
  assert.equal(m.stats().evictionsTotal, 1);
  m.inc('d', { workspace: 'ws-4' }); // evicts 'b'
  m.inc('e', { workspace: 'ws-5' }); // evicts 'c'
  assert.equal(m.stats().evictionsTotal, 3);
  assert.equal(m.stats().entries, 2);
});

test('stats(): maxEntries=0 → capped=false, saturation=0, no evictions', () => {
  const m = new OAuthMetrics({ maxEntries: 0 });
  for (let i = 0; i < 50; i++) m.inc('x', { workspace: `ws-${i}` });
  const s = m.stats();
  assert.equal(s.capped, false);
  assert.equal(s.maxEntries, 0);
  assert.equal(s.saturation, 0, 'saturation is 0 when cap is disabled');
  assert.equal(s.evictionsTotal, 0);
  assert.equal(s.entries, 50);
});

test('reset(): clears counters AND evictionsTotal', () => {
  const m = new OAuthMetrics({ maxEntries: 1 });
  m.inc('a', { workspace: 'x' });
  m.inc('b', { workspace: 'y' }); // evicts 'a'
  assert.equal(m.stats().evictionsTotal, 1);
  m.reset();
  assert.deepEqual(m.stats(), { entries: 0, maxEntries: 1, capped: true, evictionsTotal: 0, saturation: 0 });
});

test('GET /api/oauth/metrics/status: returns recorder stats()', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-10-'));
  try {
    const metrics = new OAuthMetrics({ maxEntries: 4 });
    metrics.inc('oauth_cache_hit_total', { workspace: 'ws-A' });
    metrics.inc('oauth_dcr_total', { workspace: 'ws-A', issuer: 'i', status: '200' });
    const oauth = new OAuthManager(mockWm(), { stateDir: dir, metrics });
    const { server, port } = await startAdmin(oauth, metrics);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/oauth/metrics/status`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.entries, 2);
      assert.equal(body.data.maxEntries, 4);
      assert.equal(body.data.capped, true);
      assert.equal(body.data.evictionsTotal, 0);
      assert.equal(body.data.saturation, 0.5);
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/oauth/metrics/status: defaults to zero-state when no recorder wired', async () => {
  const routes = createAdminRoutes(
    mockWm(),
    { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
    { getSessionCount: () => 0 },
    null, null,
  );
  const server = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    routes(req, res, u);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/oauth/metrics/status`);
    const body = await r.json();
    assert.deepEqual(body.data, { entries: 0, maxEntries: 0, capped: false, evictionsTotal: 0, saturation: 0 });
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET /api/oauth/metrics/status: broken recorder degrades, logs error, returns zero-state', async () => {
  const wm = mockWm();
  const throwingMetrics = { stats: () => { throw new Error('recorder exploded'); } };
  const routes = createAdminRoutes(
    wm,
    { getTools: async () => [], getToolCount: async () => 0, toolsVersion: 1 },
    { getSessionCount: () => 0 },
    null, null,
    { oauthMetrics: throwingMetrics },
  );
  const server = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    routes(req, res, u);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/oauth/metrics/status`);
    assert.equal(r.status, 200, 'broken recorder must not 500 the admin page');
    const body = await r.json();
    assert.equal(body.data.entries, 0);
    assert.ok(wm.errors.some(e => e.category === 'oauth.metrics' && /stats failed/.test(e.msg)));
  } finally {
    await new Promise(r => server.close(r));
  }
});

// ────────────────────────────────────────────────────────────────────────
// §2 / §5 — Hostname-based guide matching + module extraction

test('guideFor: exact hostname match returns guide', () => {
  assert.equal(guideFor('https://notion.com/mcp'), STATIC_CLIENT_GUIDES['notion.com']);
  assert.equal(guideFor('https://github.com/foo'), STATIC_CLIENT_GUIDES['github.com']);
});

test('guideFor: suffix match on subdomains returns guide', () => {
  // Real-world Notion MCP endpoint: `mcp.notion.com`
  assert.equal(guideFor('https://mcp.notion.com/mcp'), STATIC_CLIENT_GUIDES['notion.com']);
  assert.equal(guideFor('https://api.github.com/v3'), STATIC_CLIENT_GUIDES['github.com']);
});

test('guideFor: rejects attacker hosts that merely contain the provider substring', () => {
  // Before Phase 11-10, substring match picked these up as Notion/GitHub
  // guides. The hostname-based matcher now requires either exact host or
  // a true subdomain under the needle.
  assert.equal(guideFor('https://user-notion.com.attacker.tld/mcp'), null);
  assert.equal(guideFor('https://notioncom/mcp'), null);
  assert.equal(guideFor('https://github.com.evil.tld/foo'), null);
});

test('guideFor: invalid URL / empty input returns null', () => {
  assert.equal(guideFor(null), null);
  assert.equal(guideFor(''), null);
  assert.equal(guideFor(undefined), null);
  assert.equal(guideFor('not a url at all'), null);
});

test('guideFor: notion.so alias also matches', () => {
  // Some Notion OAuth callbacks land under notion.so; both keys live in
  // STATIC_CLIENT_GUIDES so either host resolves to the Notion guide.
  const g = guideFor('https://auth.notion.so/oauth');
  assert.ok(g);
  assert.equal(g.label, 'Notion');
});

test('renderStaticClientBody: embeds guide steps + copyable redirect URI', () => {
  const html = renderStaticClientBody({
    redirectUri: 'http://localhost:3100/oauth/callback',
    guide: STATIC_CLIENT_GUIDES['notion.com'],
  });
  assert.match(html, /Notion Integrations/);
  assert.match(html, /bifrost-redirect-uri/, 'emits copy-target id');
  assert.match(html, /data-copy-target="#bifrost-redirect-uri"/);
  assert.match(html, /localhost:3100\/oauth\/callback/);
});

test('renderStaticClientBody: no guide → generic heading + no steps', () => {
  const html = renderStaticClientBody({
    redirectUri: 'http://localhost:3100/oauth/callback',
    guide: null,
  });
  assert.match(html, /Dynamic Client Registration 을 지원하지 않습니다/);
  assert.ok(!/bifrost-modal-steps/.test(html), 'no steps list');
  assert.match(html, /localhost:3100\/oauth\/callback/);
});

test('renderStaticClientBody: no redirectUri → no copy row, guidance still renders', () => {
  const html = renderStaticClientBody({
    redirectUri: null,
    guide: STATIC_CLIENT_GUIDES['github.com'],
  });
  assert.match(html, /GitHub/);
  assert.ok(!/bifrost-modal-copyrow/.test(html));
});

test('renderStaticClientBody: escapes untrusted redirectUri input', () => {
  // esc is default-escape; a reflected redirect URI must not inject tags.
  const html = renderStaticClientBody({
    redirectUri: '"><script>alert(1)</script>',
    guide: null,
  });
  assert.ok(!/<script>/.test(html), 'raw <script> must not appear');
  assert.ok(/&lt;script&gt;/.test(html) || /&amp;lt;script/.test(html), 'tag is HTML-escaped');
});

// ────────────────────────────────────────────────────────────────────────
// §3 — removeClient purges legacy bare-scoped keys (overmatch fix)

test('removeClient: purges new-schema + legacy bare-scoped keys for the same workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-10-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    // Seed through the public API so the issuer cache has a new-schema
    // entry under ws::ws-mix::...
    await mgr.registerManual({ workspaceId: 'ws-mix', issuer: 'https://auth.example', clientId: 'NEW', authMethod: 'none' });
    // Hand-inject a legacy bare-scoped key with an unknown authMethod —
    // this is the exact case Codex flagged as "survives migration but
    // removeClient missed it".
    const cache = await mgr._loadIssuerCache();
    cache['ws-mix::https://auth.example::private_key_jwt'] = { clientId: 'LEG_UNKNOWN', authMethod: 'private_key_jwt' };
    await mgr._saveIssuerCache();

    const removed = await mgr.removeClient('ws-mix');
    assert.equal(removed, 2, 'both the new-schema key and the legacy bare key are purged');

    const after = await mgr._loadIssuerCache();
    assert.ok(!Object.keys(after).some(k => k.includes('ws-mix')),
      `no ws-mix key should survive; residual keys = ${JSON.stringify(Object.keys(after))}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removeClient: legacy bare-scoped key for a DIFFERENT workspace stays intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-10-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    await mgr.registerManual({ workspaceId: 'ws-one', issuer: 'https://auth.example', clientId: 'ONE', authMethod: 'none' });
    const cache = await mgr._loadIssuerCache();
    cache['ws-keep::https://auth.example::private_key_jwt'] = { clientId: 'KEEP' };
    await mgr._saveIssuerCache();

    await mgr.removeClient('ws-one');

    const after = await mgr._loadIssuerCache();
    assert.ok(after['ws-keep::https://auth.example::private_key_jwt'], 'unrelated legacy key must stay');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removeClient: does not mismatch `global::` keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase11-10-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    // Global bucket + scoped entry. removeClient('global') used to be
    // ambiguous under the old scheme; under the new prefix guards it
    // removes only the scoped entry.
    await mgr.registerManual('https://auth.example', { clientId: 'GLOBAL_CID', authMethod: 'none' });
    await mgr.registerManual({ workspaceId: 'global', issuer: 'https://auth.example', clientId: 'SCOPED_CID', authMethod: 'none' });
    const removed = await mgr.removeClient('global');
    assert.equal(removed, 1);
    const globalEntry = await mgr.getCachedClient('https://auth.example', 'none');
    assert.ok(globalEntry, 'global:: bucket preserved');
    assert.equal(globalEntry.clientId, 'GLOBAL_CID');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
