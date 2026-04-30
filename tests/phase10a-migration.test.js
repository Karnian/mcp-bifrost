/**
 * Phase 10a §4.10a-6 — migrate-oauth-clients.mjs tests.
 * Covers §9 "마이그레이션 3 경로":
 *   --dry-run: no file changes, stdout report
 *   --apply:   .pre-10a.bak created (0o600), config rewritten, shared clients disambiguated
 *   --restore: diff original === restored === 0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'migrate-oauth-clients.mjs');

// 2026-05-01 손상 사고 후속 — protectRealConfig() 패턴 제거.
// 이전 구현은 실제 config/workspaces.json 을 save → fixture 쓰기 → restore
// 의 패턴이었는데, finally 가 정상 실행되어도 한 번 사고 (process kill 등)
// 로 fixture 가 잔존하면, 다음 실행에서 protectRealConfig 가 fixture 를
// "원본" 으로 capture 해 영영 복구되지 않는 sticky bug 였음.
// 모든 테스트는 이제 mkdtemp + --config=<tmp> 으로 완전 sandbox.

async function runScript(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

async function withTempConfig(fixture, fn) {
  // 2026-05-01 사고 후속: --config=<path> override 로 완전 sandbox.
  // backup 도 sibling tmp 에 생성됨 (backupPathFor 가 sibling 으로 결정).
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-'));
  const cfgPath = join(dir, 'workspaces.json');
  await writeFile(cfgPath, JSON.stringify(fixture, null, 2), 'utf-8');
  try { return await fn(cfgPath, dir); } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// (protectRealConfig 제거 — 2026-05-01 데이터 손상 사고 후속)

function fixtureSharedClient() {
  return {
    server: { port: 3100 },
    workspaces: [
      {
        id: 'http-notion-A', kind: 'mcp-client', transport: 'http', url: 'https://mcp.notion.com/mcp',
        oauth: {
          enabled: true, issuer: 'https://mcp.notion.com',
          clientId: 'SHARED_CID', authMethod: 'none',
          byIdentity: { default: { tokens: { accessToken: 'AT_A', refreshToken: 'RT_A' } } },
          tokens: { accessToken: 'AT_A', refreshToken: 'RT_A' },
        },
      },
      {
        id: 'http-notion-B', kind: 'mcp-client', transport: 'http', url: 'https://mcp.notion.com/mcp',
        oauth: {
          enabled: true, issuer: 'https://mcp.notion.com',
          clientId: 'SHARED_CID', authMethod: 'none',
          byIdentity: { default: { tokens: { accessToken: 'AT_B', refreshToken: 'RT_B' } } },
          tokens: { accessToken: 'AT_B', refreshToken: 'RT_B' },
        },
      },
    ],
  };
}

test('§4.10a-6: --dry-run reports shared clients + flat-to-nested without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-dry-'));
  try {
    const cfgPath = join(dir, 'workspaces.json');
    await writeFile(cfgPath, JSON.stringify(fixtureSharedClient(), null, 2), 'utf-8');
    const before = await readFile(cfgPath, 'utf-8');
    const r = await runScript([`--config=${cfgPath}`, '--dry-run']);
    assert.equal(r.code, 0, `exit code 0; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.action, 'dry-run');
    assert.ok(out.report.flatToNested.length === 2);
    assert.equal(out.report.sharedClients.length, 1);
    assert.equal(out.report.sharedClients[0].groupKey, 'https://mcp.notion.com::SHARED_CID');
    assert.deepEqual(out.report.sharedClients[0].workspaces.sort(), ['http-notion-A', 'http-notion-B']);
    // No file change
    const after = await readFile(cfgPath, 'utf-8');
    assert.equal(after, before, 'dry-run must not modify file');
    // No backup created
    const bakPath = `${cfgPath}.pre-10a.bak`;
    const bakExists = await stat(bakPath).then(() => true).catch(() => false);
    assert.equal(bakExists, false, 'dry-run must not create backup');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-6 (Codex R8): --apply purges pending auth states for disambiguated workspaces', async () => {
  // 2026-05-01 사고 후속: --pending=<path> 옵션 도입으로 pending state 도 완전
  // sandbox. 이전엔 .ao/state/oauth-pending.json 을 save → fixture write → restore
  // 했어서 동일한 sticky 위험 (process kill 시 fixture 잔존).
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-pending-'));
  try {
    const cfgPath = join(dir, 'workspaces.json');
    const pendingPath = join(dir, 'oauth-pending.json');
    await writeFile(cfgPath, JSON.stringify(fixtureSharedClient(), null, 2), 'utf-8');
    const seedPending = {
      'state-stale-B': { workspaceId: 'http-notion-B', identity: 'default', issuer: 'https://mcp.notion.com', clientId: 'SHARED_CID', authMethod: 'none', verifier: 'v', tokenEndpoint: 'x', resource: null, expiresAt: Date.now() + 60_000 },
      'state-keep-A': { workspaceId: 'http-notion-A', identity: 'default', issuer: 'https://mcp.notion.com', clientId: 'SHARED_CID', authMethod: 'none', verifier: 'v', tokenEndpoint: 'x', resource: null, expiresAt: Date.now() + 60_000 },
    };
    await writeFile(pendingPath, JSON.stringify(seedPending, null, 2), 'utf-8');
    const r = await runScript([`--config=${cfgPath}`, `--pending=${pendingPath}`, '--apply']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pendingPurged, 1, 'must purge the disambiguated workspace pending entry only');
    const afterPending = JSON.parse(await readFile(pendingPath, 'utf-8'));
    assert.equal(afterPending['state-stale-B'], undefined, 'pending for disambiguated workspace must be purged');
    assert.ok(afterPending['state-keep-A'], 'pending for retained workspace must be preserved');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-6: --apply creates .pre-10a.bak (0o600) + disambiguates shared + migrates flat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-apply-'));
  try {
    const cfgPath = join(dir, 'workspaces.json');
    const bakPath = `${cfgPath}.pre-10a.bak`;
    await writeFile(cfgPath, JSON.stringify(fixtureSharedClient(), null, 2), 'utf-8');
    const r = await runScript([`--config=${cfgPath}`, '--apply']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.action, 'apply');
    // Backup sits next to the config (sibling) + 0o600 on POSIX
    const bakStat = await stat(bakPath);
    assert.ok(bakStat);
    if (process.platform !== 'win32') {
      assert.equal(bakStat.mode & 0o777, 0o600, 'backup must be chmod 0o600');
    }
    const migrated = JSON.parse(await readFile(cfgPath, 'utf-8'));
    const [wsA, wsB] = migrated.workspaces;
    assert.ok(wsA.oauth.client);
    assert.equal(wsA.oauth.client.clientId, 'SHARED_CID');
    assert.equal(wsA.oauth.client.source, 'legacy-flat');
    assert.equal(wsB.oauth.client, null);
    assert.equal(wsB.oauth.clientId, undefined, 'Phase 11 §3: flat clientId must be scrubbed from config');
    assert.equal(wsB.oauth.clientSecret, undefined, 'Phase 11 §3: flat clientSecret must be scrubbed from config');
    assert.equal(wsB.oauthActionNeeded, true);
    assert.equal(wsB.oauthActionNeededBy.default, true);
    assert.equal(wsB.oauth.byIdentity.default.tokens.accessToken, null);
    assert.equal(out.report.disambiguated.length, 1);
    assert.equal(out.report.disambiguated[0].id, 'http-notion-B');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-6: --restore replaces config with backup byte-for-byte', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-restore-'));
  try {
    const cfgPath = join(dir, 'workspaces.json');
    const fixture = fixtureSharedClient();
    const originalJson = JSON.stringify(fixture, null, 2);
    await writeFile(cfgPath, originalJson, 'utf-8');
    const apply = await runScript([`--config=${cfgPath}`, '--apply']);
    assert.equal(apply.code, 0);
    const modified = await readFile(cfgPath, 'utf-8');
    assert.notEqual(modified, originalJson, 'apply must modify file');
    const restore = await runScript([`--config=${cfgPath}`, '--restore']);
    assert.equal(restore.code, 0);
    const restored = await readFile(cfgPath, 'utf-8');
    assert.equal(restored, originalJson, 'restore must replicate original byte-for-byte');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-6 (Codex R2 cleanup): --config=path uses a sibling backup, not repo-global', async () => {
  // Sandboxed — operates entirely in a temp dir.
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-'));
  try {
    const cfgPath = join(dir, 'my-config.json');
    await writeFile(cfgPath, JSON.stringify(fixtureSharedClient(), null, 2), 'utf-8');
    const r = await runScript([`--config=${cfgPath}`, '--apply']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    // Backup must sit next to the custom config, NOT at repo-global path.
    const expectedBak = `${cfgPath}.pre-10a.bak`;
    assert.equal(out.backup, expectedBak);
    const bakStat = await stat(expectedBak);
    assert.ok(bakStat);
    // Repo-global backup must NOT be created (sticky-corruption regression
    // — see file header). Compute the path locally rather than referencing
    // a top-level REPO_BACKUP_PATH constant we deleted.
    const repoBakPath = join(__dirname, '..', 'config', 'workspaces.json.pre-10a.bak');
    const repoBakExists = await stat(repoBakPath).then(() => true).catch(() => false);
    assert.equal(repoBakExists, false, 'must not create repo-global backup when --config is overridden');
    // --restore should also work with the same override
    const rr = await runScript([`--config=${cfgPath}`, '--restore']);
    assert.equal(rr.code, 0);
    const restored = await readFile(cfgPath, 'utf-8');
    assert.equal(restored, JSON.stringify(fixtureSharedClient(), null, 2));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§4.10a-6: no-op workspace (already migrated or non-OAuth) is safely handled', async () => {
  // Sandbox via temp --config (consistent with the rest of the file).
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-'));
  try {
    const cfgPath = join(dir, 'my-config.json');
    const fixture = {
      server: { port: 3100 },
      workspaces: [
        {
          id: 'ws-native', kind: 'native', provider: 'notion', credentials: { token: 'x' }, oauth: null,
        },
        {
          id: 'ws-migrated', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
          oauth: {
            enabled: true, issuer: 'https://mcp.example',
            client: { clientId: 'NEW', authMethod: 'none', source: 'dcr', registeredAt: '2026-01-01' },
            byIdentity: { default: { tokens: { accessToken: 'AT' } } },
          },
        },
      ],
    };
    await writeFile(cfgPath, JSON.stringify(fixture, null, 2), 'utf-8');
    const r = await runScript([`--config=${cfgPath}`, '--apply']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.report.disambiguated.length, 0, 'no disambiguation needed');
    assert.equal(out.report.flatToNested.length, 0, 'no flat-to-nested needed');
    assert.equal(out.report.alreadyMigrated.length, 1);
    assert.equal(out.report.nonOAuth.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§Phase11-3: --apply scrubs flat OAuth fields from config (nested-only after migration)', async () => {
  // Phase 11 §3 — the flat-field mirror was preserved for 1 release by
  // Phase 10a §3.4. Phase 11 removes it. The migration script must now
  // delete ws.oauth.{clientId,clientSecret,authMethod} after promoting
  // them into ws.oauth.client, so the on-disk config never carries the
  // legacy mirror.
  const dir = await mkdtemp(join(tmpdir(), 'phase11-flat-scrub-'));
  try {
    const cfgPath = join(dir, 'my-config.json');
    const fixture = {
      server: { port: 3100 },
      workspaces: [
        {
          id: 'ws-flat-only', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
          oauth: {
            enabled: true, issuer: 'https://mcp.example',
            clientId: 'FLAT_CLIENT',
            clientSecret: 'FLAT_SECRET',
            authMethod: 'client_secret_basic',
            byIdentity: { default: { tokens: { accessToken: 'AT' } } },
          },
        },
      ],
    };
    await writeFile(cfgPath, JSON.stringify(fixture, null, 2), 'utf-8');
    const r = await runScript([`--config=${cfgPath}`, '--apply']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    // flatScrubbed report surfaces the mutation (Codex Phase 11-3 R1 follow-up)
    assert.ok(Array.isArray(out.report.flatScrubbed), 'report must include flatScrubbed array');
    assert.equal(out.report.flatScrubbed.length, 1, 'one workspace must be reported as scrubbed');
    assert.equal(out.report.flatScrubbed[0].id, 'ws-flat-only');
    const migrated = JSON.parse(await readFile(cfgPath, 'utf-8'));
    const ws = migrated.workspaces[0];
    // Nested is populated
    assert.ok(ws.oauth.client);
    assert.equal(ws.oauth.client.clientId, 'FLAT_CLIENT');
    assert.equal(ws.oauth.client.clientSecret, 'FLAT_SECRET');
    assert.equal(ws.oauth.client.authMethod, 'client_secret_basic');
    assert.equal(ws.oauth.client.source, 'legacy-flat');
    // Flat keys are SCRUBBED (Phase 11 §3)
    assert.equal(ws.oauth.clientId, undefined, 'Phase 11 §3: flat clientId must be removed from config');
    assert.equal(ws.oauth.clientSecret, undefined, 'Phase 11 §3: flat clientSecret must be removed from config');
    assert.equal(ws.oauth.authMethod, undefined, 'Phase 11 §3: flat authMethod must be removed from config');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('§Phase11-3 (Codex R1 follow-up): --apply scrubs flat null keys left by pre-Phase-11 disambiguation', async () => {
  // Codex Phase 11-3 R1 Medium finding: configs produced by Phase 10a's
  // disambiguation branch set ws.oauth.client=null AND left flat keys as
  // null. Previous Phase 11 scrub logic gated on `if (ws.oauth.client)` so
  // the null-flat keys persisted on disk forever. This test drives exactly
  // that shape through --apply and asserts the flat keys are scrubbed
  // despite client===null.
  const dir = await mkdtemp(join(tmpdir(), 'phase11-null-scrub-'));
  try {
    const cfgPath = join(dir, 'my-config.json');
    const fixture = {
      server: { port: 3100 },
      workspaces: [
        {
          id: 'disambiguated-ws', kind: 'mcp-client', transport: 'http', url: 'https://mcp.example/mcp',
          oauth: {
            enabled: true, issuer: 'https://mcp.example',
            client: null,                  // pre-Phase-11 disambiguation output
            clientId: null,                // flat=null left behind
            clientSecret: null,
            authMethod: null,
            byIdentity: { default: { tokens: null } },
          },
          oauthActionNeeded: true,
          oauthActionNeededBy: { default: true },
        },
      ],
    };
    await writeFile(cfgPath, JSON.stringify(fixture, null, 2), 'utf-8');
    const r = await runScript([`--config=${cfgPath}`, '--apply']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.report.flatScrubbed.length, 1, 'null-only flat keys must also be scrubbed');
    const migrated = JSON.parse(await readFile(cfgPath, 'utf-8'));
    const ws = migrated.workspaces[0];
    // client stays null (no flat to promote)
    assert.equal(ws.oauth.client, null);
    // Flat keys fully removed from on-disk config
    assert.ok(!('clientId' in ws.oauth), 'Phase 11 §3: flat clientId key must be removed (was null)');
    assert.ok(!('clientSecret' in ws.oauth), 'Phase 11 §3: flat clientSecret key must be removed (was null)');
    assert.ok(!('authMethod' in ws.oauth), 'Phase 11 §3: flat authMethod key must be removed (was null)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
