/**
 * Phase 7g — Usage + audit file logging tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageRecorder } from '../server/usage-recorder.js';
import { AuditLogger } from '../server/audit-logger.js';

test('UsageRecorder.record queues + flush appends JSONL to disk with chmod 0600 (POSIX)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-7g-usage-'));
  try {
    const usage = new UsageRecorder({ stateDir: dir });
    usage.record({ identity: 'u1', workspaceId: 'w1', tool: 'notion_x__search', durationMs: 42, ok: true });
    usage.record({ identity: 'u1', workspaceId: 'w1', tool: 'notion_x__search', durationMs: 60, ok: false });
    await usage.flush();
    const raw = await readFile(join(dir, 'usage.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    assert.equal(e1.identity, 'u1');
    assert.equal(e1.tool, 'notion_x__search');
    assert.equal(e1.ok, true);
    assert.equal(JSON.parse(lines[1]).ok, false);
    if (process.platform !== 'win32') {
      const st = await stat(join(dir, 'usage.jsonl'));
      assert.equal((st.mode & 0o777), 0o600, 'usage.jsonl should be chmod 0600');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('UsageRecorder rolling aggregate: 24h vs 7d windows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-7g-agg-'));
  try {
    let fakeNow = Date.parse('2026-04-15T00:00:00Z');
    const usage = new UsageRecorder({ stateDir: dir, now: () => fakeNow });
    // 1 event now
    usage.record({ identity: 'u1', workspaceId: 'w1', tool: 'search', durationMs: 100, ok: true, t: new Date(fakeNow).toISOString() });
    // 1 event 36 hours ago (outside 24h, inside 7d)
    usage.record({ identity: 'u1', workspaceId: 'w1', tool: 'search', durationMs: 100, ok: true, t: new Date(fakeNow - 36 * 3600 * 1000).toISOString() });
    // 1 event 10 days ago (outside both)
    usage.record({ identity: 'u1', workspaceId: 'w1', tool: 'search', durationMs: 100, ok: true, t: new Date(fakeNow - 10 * 24 * 3600 * 1000).toISOString() });
    const q24 = usage.query({ since: '24h', by: 'tool' });
    assert.equal(q24.find(r => r.key === 'search').count, 1);
    const q7 = usage.query({ since: '7d', by: 'tool' });
    assert.equal(q7.find(r => r.key === 'search').count, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('UsageRecorder rotates when file exceeds 10MB; retention purges old rotations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-7g-rotate-'));
  try {
    // Pre-seed a usage.jsonl at 11MB to force rotation on next flush
    const big = Buffer.alloc(11 * 1024 * 1024, 'x').toString('ascii');
    await writeFile(join(dir, 'usage.jsonl'), big);
    // Also pre-seed an older rotation (mtime 40 days ago) that should be purged
    const oldRotated = join(dir, 'usage-20260301.jsonl');
    await writeFile(oldRotated, 'stale');
    const old = Date.now() - 40 * 24 * 3600 * 1000;
    const { utimes } = await import('node:fs/promises');
    await utimes(oldRotated, new Date(old), new Date(old));

    const usage = new UsageRecorder({ stateDir: dir });
    usage.record({ identity: 'u1', workspaceId: 'w1', tool: 't', durationMs: 1, ok: true });
    await usage.flush();
    // Rotated file exists (usage-YYYYMMDD.jsonl — today)
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(dir)).sort();
    const rotatedToday = files.find(n => n.startsWith('usage-') && n.endsWith('.jsonl') && !n.includes('20260301'));
    assert.ok(rotatedToday, `expected a today-rotated file: ${files.join(',')}`);
    // Old rotation purged
    assert.ok(!files.includes('usage-20260301.jsonl'), '40-day-old rotation should be purged');
    // New usage.jsonl contains the fresh event
    const fresh = await readFile(join(dir, 'usage.jsonl'), 'utf-8');
    const firstLine = fresh.split('\n')[0];
    const ev = JSON.parse(firstLine);
    assert.equal(ev.tool, 't');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('UsageRecorder concurrent record + flush does not lose events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-7g-concur-'));
  try {
    const usage = new UsageRecorder({ stateDir: dir });
    // Kick off many records in parallel with intermixed flushes
    const N = 50;
    for (let i = 0; i < N; i++) {
      usage.record({ identity: `u${i % 3}`, workspaceId: 'w', tool: 't', durationMs: i, ok: i % 5 !== 0 });
      if (i % 7 === 0) usage.flush().catch(() => {});
    }
    await usage.flush();
    const raw = await readFile(join(dir, 'usage.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, N, `expected ${N} events, got ${lines.length}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('AuditLogger tail filters newest-first by action prefix + identity + workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-7g-audit-'));
  try {
    const audit = new AuditLogger({ stateDir: dir });
    audit.record({ action: 'oauth.authorize_start', identity: 'admin', workspace: 'w1', details: 'x' });
    audit.record({ action: 'oauth.refresh_success', identity: 'admin', workspace: 'w1', details: 'y' });
    audit.record({ action: 'workspace.add', identity: 'admin', workspace: 'w2', details: 'z' });
    audit.record({ action: 'oauth.refresh_fail', identity: 'bot', workspace: 'w1', details: 'w' });
    await audit.flush();

    // No filter → 4 events newest first
    const all = await audit.tail();
    assert.equal(all.length, 4);
    assert.equal(all[0].action, 'oauth.refresh_fail');

    // Prefix filter
    const oauthOnly = await audit.tail({ actionPrefix: 'oauth.' });
    assert.equal(oauthOnly.length, 3);

    // Identity + workspace combo
    const adminW1 = await audit.tail({ identity: 'admin', workspace: 'w1' });
    assert.equal(adminW1.length, 2);
    assert.ok(adminW1.every(e => e.identity === 'admin' && e.workspace === 'w1'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('AuditLogger sanitizes token material in details before writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-7g-audit-sanitize-'));
  try {
    const audit = new AuditLogger({ stateDir: dir });
    audit.record({
      action: 'oauth.debug',
      identity: 'u',
      workspace: 'w',
      details: 'access_token=SHOULD_BE_SCRUBBED_abcd1234 refresh_token=ALSO_SCRUBBED',
    });
    await audit.flush();
    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf-8');
    assert.ok(!raw.includes('SHOULD_BE_SCRUBBED_abcd1234'), 'access_token leaked');
    assert.ok(!raw.includes('ALSO_SCRUBBED'), 'refresh_token leaked');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('WorkspaceManager.logAudit forwards identity to audit.jsonl via mirror', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-7g-identity-audit-'));
  try {
    const audit = new AuditLogger({ stateDir: dir });
    const { WorkspaceManager } = await import('../server/workspace-manager.js');
    const wm = new WorkspaceManager();
    wm.setAuditLogger(audit);
    // Legacy 3-arg call still works (identity=null)
    wm.logAudit('workspace.add', 'w1', 'details');
    // New 4-arg call carries identity
    wm.logAudit('oauth.authorize_start', 'w1', '{"issuer":"x"}', 'bot_ci');
    wm.logAudit('oauth.refresh_success', 'w1', 'ok', 'default');
    await audit.flush();
    const rows = await audit.tail({ limit: 10 });
    const byAction = Object.fromEntries(rows.map(r => [r.action, r]));
    assert.equal(byAction['workspace.add'].identity, null);
    assert.equal(byAction['oauth.authorize_start'].identity, 'bot_ci');
    assert.equal(byAction['oauth.refresh_success'].identity, 'default');
    // tail filter by identity works
    const botOnly = await audit.tail({ identity: 'bot_ci' });
    assert.equal(botOnly.length, 1);
    assert.equal(botOnly[0].action, 'oauth.authorize_start');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('McpHandler calls UsageRecorder on tools/call success and failure', async () => {
  const { McpHandler } = await import('../server/mcp-handler.js');
  const { ToolRegistry } = await import('../server/tool-registry.js');

  const recorded = [];
  const usage = { record: (e) => recorded.push(e) };

  const providerOk = {
    getTools: () => [{ name: 'search', description: '', inputSchema: {} }],
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
    async refreshTools() { return this.getTools(); },
  };
  const providerFail = {
    getTools: () => [{ name: 'send', description: '', inputSchema: {} }],
    async callTool() { const e = new Error('upstream 500'); e.status = 502; throw e; },
    async refreshTools() { return this.getTools(); },
  };

  const wm = {
    config: { workspaces: [], server: { port: 3100 } },
    getWorkspaces: () => [
      { id: 'n-a', kind: 'mcp-client', provider: 'notion', namespace: 'a', displayName: 'A', enabled: true },
      { id: 's-b', kind: 'mcp-client', provider: 'slack', namespace: 'b', displayName: 'B', enabled: true },
    ],
    getEnabledWorkspaces() { return this.getWorkspaces(); },
    getWorkspace(id) { return this.getWorkspaces().find(w => w.id === id) || null; },
    getProvider(id) { return id === 'n-a' ? providerOk : id === 's-b' ? providerFail : null; },
    getCapability: () => null,
    logError: () => {},
    logAudit: () => {},
  };
  const tr = new ToolRegistry(wm);
  const mcp = new McpHandler(wm, tr, { usage });

  // Successful call
  const r1 = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notion_a__search', arguments: {} } }, { identity: { id: 'u1', allowedWorkspaces: ['*'] } });
  assert.ok(!r1.result.isError, `success expected, got ${JSON.stringify(r1)}`);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].identity, 'u1');
  assert.equal(recorded[0].ok, true);

  // Failing call (non-retriable: 5xx is retriable in current categorizer; use 401 to make non-retriable)
  const providerFail401 = {
    getTools: () => [{ name: 'auth', description: '', inputSchema: {} }],
    async callTool() { const e = new Error('nope'); e.status = 401; throw e; },
    async refreshTools() { return this.getTools(); },
  };
  wm.getProvider = (id) => id === 'n-a' ? providerOk : providerFail401;
  wm.getWorkspaces = () => [
    { id: 'n-a', kind: 'mcp-client', provider: 'notion', namespace: 'a', displayName: 'A', enabled: true },
    { id: 'x-c', kind: 'mcp-client', provider: 'notion', namespace: 'c', displayName: 'C', enabled: true },
  ];
  wm.getEnabledWorkspaces = () => wm.getWorkspaces();
  wm.getWorkspace = (id) => wm.getWorkspaces().find(w => w.id === id);
  tr._reverseMap = new Map(); // reset registry
  const r2 = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'notion_c__auth', arguments: {} } }, { identity: { id: 'u1', allowedWorkspaces: ['*'] } });
  assert.equal(r2.result.isError, true);
  // Usage recorded the failure
  const failEv = recorded.find(e => e.tool === 'notion_c__auth');
  assert.ok(failEv);
  assert.equal(failEv.ok, false);
});
