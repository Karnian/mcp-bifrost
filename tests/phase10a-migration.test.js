/**
 * Phase 10a §4.10a-6 — migrate-oauth-clients.mjs tests.
 * Covers §9 "마이그레이션 3 경로":
 *   --dry-run: no file changes, stdout report
 *   --apply:   .pre-10a.bak created (0o600), config rewritten, shared clients disambiguated
 *   --restore: diff original === restored === 0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'migrate-oauth-clients.mjs');
const REPO_CONFIG_PATH = join(__dirname, '..', 'config', 'workspaces.json');
const REPO_BACKUP_PATH = join(__dirname, '..', 'config', 'workspaces.json.pre-10a.bak');

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
  // The script uses config/workspaces.json relative to the repo root. We
  // substitute by writing a temp config and passing --config=... override.
  // We use the real repo path for --apply/--restore so that .pre-10a.bak
  // lands in the right place — but still sandbox via temp files.
  const dir = await mkdtemp(join(tmpdir(), 'phase10a-migration-'));
  const cfgPath = join(dir, 'workspaces.json');
  await writeFile(cfgPath, JSON.stringify(fixture, null, 2), 'utf-8');
  try { return await fn(cfgPath, dir); } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// We bypass the script's hardcoded BACKUP_PATH via --config override + running
// from a temp cwd. But the script's BACKUP_PATH is __dirname/../config/... which
// is always the repo path. So we also save/restore the real file if present.
async function protectRealConfig(fn) {
  let savedConfig = null, savedBackup = null;
  try {
    const [hasCfg, hasBak] = await Promise.all([
      stat(REPO_CONFIG_PATH).then(() => true).catch(() => false),
      stat(REPO_BACKUP_PATH).then(() => true).catch(() => false),
    ]);
    if (hasCfg) savedConfig = await readFile(REPO_CONFIG_PATH, 'utf-8');
    if (hasBak) savedBackup = await readFile(REPO_BACKUP_PATH, 'utf-8');
    return await fn();
  } finally {
    // Restore originals
    if (savedConfig !== null) await writeFile(REPO_CONFIG_PATH, savedConfig, 'utf-8');
    else await rm(REPO_CONFIG_PATH, { force: true });
    if (savedBackup !== null) await writeFile(REPO_BACKUP_PATH, savedBackup, 'utf-8');
    else await rm(REPO_BACKUP_PATH, { force: true });
  }
}

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
  await protectRealConfig(async () => {
    // Place fixture at the real repo path so the script reads it.
    await writeFile(REPO_CONFIG_PATH, JSON.stringify(fixtureSharedClient(), null, 2), 'utf-8');
    const before = await readFile(REPO_CONFIG_PATH, 'utf-8');
    const beforeMtime = (await stat(REPO_CONFIG_PATH)).mtimeMs;
    const r = await runScript(['--dry-run']);
    assert.equal(r.code, 0, `exit code 0; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.action, 'dry-run');
    assert.ok(out.report.flatToNested.length === 2);
    assert.equal(out.report.sharedClients.length, 1);
    assert.equal(out.report.sharedClients[0].groupKey, 'https://mcp.notion.com::SHARED_CID');
    assert.deepEqual(out.report.sharedClients[0].workspaces.sort(), ['http-notion-A', 'http-notion-B']);
    // No file change
    const after = await readFile(REPO_CONFIG_PATH, 'utf-8');
    assert.equal(after, before, 'dry-run must not modify file');
    // No backup created
    const bakExists = await stat(REPO_BACKUP_PATH).then(() => true).catch(() => false);
    assert.equal(bakExists, false, 'dry-run must not create backup');
  });
});

test('§4.10a-6: --apply creates .pre-10a.bak (0o600) + disambiguates shared + migrates flat', async () => {
  await protectRealConfig(async () => {
    await writeFile(REPO_CONFIG_PATH, JSON.stringify(fixtureSharedClient(), null, 2), 'utf-8');
    const r = await runScript(['--apply']);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.action, 'apply');
    // Backup exists + 0o600 on POSIX
    const bakStat = await stat(REPO_BACKUP_PATH);
    assert.ok(bakStat);
    if (process.platform !== 'win32') {
      assert.equal(bakStat.mode & 0o777, 0o600, 'backup must be chmod 0o600');
    }
    // Original rewritten
    const migrated = JSON.parse(await readFile(REPO_CONFIG_PATH, 'utf-8'));
    const [wsA, wsB] = migrated.workspaces;
    // wsA keeps client
    assert.ok(wsA.oauth.client);
    assert.equal(wsA.oauth.client.clientId, 'SHARED_CID');
    assert.equal(wsA.oauth.client.source, 'legacy-flat');
    // wsB stripped + action_needed
    assert.equal(wsB.oauth.client, null);
    assert.equal(wsB.oauth.clientId, null);
    assert.equal(wsB.oauthActionNeeded, true);
    assert.equal(wsB.oauthActionNeededBy.default, true);
    assert.equal(wsB.oauth.byIdentity.default.tokens.accessToken, null);
    // Report
    assert.equal(out.report.disambiguated.length, 1);
    assert.equal(out.report.disambiguated[0].id, 'http-notion-B');
  });
});

test('§4.10a-6: --restore replaces config with backup byte-for-byte', async () => {
  await protectRealConfig(async () => {
    const fixture = fixtureSharedClient();
    const originalJson = JSON.stringify(fixture, null, 2);
    await writeFile(REPO_CONFIG_PATH, originalJson, 'utf-8');
    // Apply once
    const apply = await runScript(['--apply']);
    assert.equal(apply.code, 0);
    // Config is now modified; bak should match original.
    const modified = await readFile(REPO_CONFIG_PATH, 'utf-8');
    assert.notEqual(modified, originalJson, 'apply must modify file');
    // Restore
    const restore = await runScript(['--restore']);
    assert.equal(restore.code, 0);
    const restored = await readFile(REPO_CONFIG_PATH, 'utf-8');
    assert.equal(restored, originalJson, 'restore must replicate original byte-for-byte');
  });
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
    // Repo-global backup must NOT be created
    const repoBakExists = await stat(REPO_BACKUP_PATH).then(() => true).catch(() => false);
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
  await protectRealConfig(async () => {
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
    await writeFile(REPO_CONFIG_PATH, JSON.stringify(fixture, null, 2), 'utf-8');
    const r = await runScript(['--apply']);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.report.disambiguated.length, 0, 'no disambiguation needed');
    assert.equal(out.report.flatToNested.length, 0, 'no flat-to-nested needed');
    assert.equal(out.report.alreadyMigrated.length, 1);
    assert.equal(out.report.nonOAuth.length, 1);
  });
});
