/**
 * Phase 12-9 — botToken → OAuth migration helper + Enterprise Grid
 * silent-break schema defense.
 *
 * Coverage (plan §7 / §10 R9):
 *   - buildMigrationReport: detects botToken workspaces, OAuth workspaces,
 *     invariant violations (Enterprise team, half-state, tokenType wrong)
 *   - schema reject: team.id starting with 'E' → custom issue
 *   - schema reject: tokens half-state (expiresAt XOR refreshToken)
 *   - script CLI:
 *       - exit 0 when no botToken workspaces
 *       - exit 1 when botToken workspaces exist
 *       - exit 2 when invariant violation detected
 *       - --apply intentionally refused (Phase 12-D9: read-only)
 *   - JSON output mode for CI scripting
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildMigrationReport } from '../scripts/migrate-slack-to-oauth.mjs';
import { validateWorkspacePayload } from '../server/workspace-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'migrate-slack-to-oauth.mjs');

// ─── buildMigrationReport unit ──────────────────────────────────────

test('buildMigrationReport: detects botToken workspaces with prefilled metadata', () => {
  const config = {
    workspaces: [
      { id: 'slack-legacy', kind: 'native', provider: 'slack', alias: 'team1',
        namespace: 'team1', displayName: 'Team One',
        credentials: { botToken: 'xoxb-legacy', teamId: 'T01' } },
    ],
  };
  const r = buildMigrationReport(config);
  assert.equal(r.botTokenWorkspaces.length, 1);
  assert.deepEqual(r.botTokenWorkspaces[0], {
    id: 'slack-legacy', alias: 'team1', namespace: 'team1',
    displayName: 'Team One', hasBotToken: true, hasTeamId: true,
  });
  assert.equal(r.oauthWorkspaces.length, 0);
  assert.equal(r.violations.length, 0);
});

test('buildMigrationReport: skips non-Slack workspaces', () => {
  const config = {
    workspaces: [
      { id: 'notion-1', provider: 'notion' },
    ],
  };
  const r = buildMigrationReport(config);
  assert.equal(r.botTokenWorkspaces.length, 0);
  assert.equal(r.oauthWorkspaces.length, 0);
  assert.equal(r.violations.length, 0);
});

test('buildMigrationReport: soft-deleted Slack workspace surfaced as violation (Codex R1 BLOCKER 1)', () => {
  // Phase 12-D9 hard-delete invariant: soft-deleted entries reserve the
  // alias and break OAuth re-add namespace continuity.
  const config = {
    workspaces: [
      { id: 'slack-soft', provider: 'slack', alias: 't', namespace: 't',
        deletedAt: '2026-01-01T00:00:00Z',
        credentials: { botToken: 'x' } },
    ],
  };
  const r = buildMigrationReport(config);
  assert.ok(r.violations.find(v => v.code === 'SOFT_DELETED_BLOCKING_NAMESPACE'));
  // The soft-deleted workspace itself should NOT appear in the migrate list
  // (operator action is hard-delete, not re-classify).
  assert.equal(r.botTokenWorkspaces.length, 0);
});

test('buildMigrationReport: separates OAuth-mode workspaces', () => {
  const config = {
    workspaces: [
      { id: 'slack-oauth', kind: 'native', provider: 'slack', authMode: 'oauth',
        alias: 'oa', namespace: 'oa',
        slackOAuth: {
          team: { id: 'T01', name: 'OA' },
          tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
          status: 'active',
        } },
    ],
  };
  const r = buildMigrationReport(config);
  assert.equal(r.oauthWorkspaces.length, 1);
  assert.equal(r.oauthWorkspaces[0].team.id, 'T01');
});

test('buildMigrationReport: flags Enterprise leak (team.id starts with E)', () => {
  const config = {
    workspaces: [
      { id: 'slack-enterprise', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'E01ENTERPRISE', name: 'Enterprise' },
          tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
        } },
    ],
  };
  const r = buildMigrationReport(config);
  const violation = r.violations.find(v => v.code === 'ENTERPRISE_TEAM_LEAKED');
  assert.ok(violation, 'must surface Enterprise leak');
});

test('buildMigrationReport: flags tokenType invariant break', () => {
  const config = {
    workspaces: [
      { id: 'slack-bot', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'T01', name: 'X' },
          tokens: { accessToken: 'xoxb-leak', tokenType: 'bot' },
        } },
    ],
  };
  const r = buildMigrationReport(config);
  assert.ok(r.violations.find(v => v.code === 'TOKEN_TYPE_NOT_USER'));
});

test('buildMigrationReport: flags is_enterprise_install leak even when team.id passes (Codex R1 REVISE 3)', () => {
  const config = {
    workspaces: [
      { id: 'slack-leak', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'T01', name: 'X' },
          tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
          is_enterprise_install: true,
        } },
    ],
  };
  const r = buildMigrationReport(config);
  assert.ok(r.violations.find(v => v.code === 'ENTERPRISE_INSTALL_LEAKED'));
});

test('buildMigrationReport: flags raw enterprise.id leak', () => {
  const config = {
    workspaces: [
      { id: 'slack-eid', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'T01', name: 'X' },
          tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
          enterprise: { id: 'E01ENT', name: 'Ent' },
        } },
    ],
  };
  const r = buildMigrationReport(config);
  assert.ok(r.violations.find(v => v.code === 'ENTERPRISE_ID_LEAKED'));
});

test('buildMigrationReport: flags both half-state directions (Codex R1 REVISE 4)', () => {
  const config = {
    workspaces: [
      // refreshToken without expiresAt
      { id: 'slack-rt-only', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'T1', name: 'A' },
          tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user', refreshToken: 'r' },
        } },
      // expiresAt without refreshToken
      { id: 'slack-exp-only', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'T2', name: 'B' },
          tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user',
            expiresAt: '2026-12-31T00:00:00.000Z' },
        } },
    ],
  };
  const r = buildMigrationReport(config);
  const halfStateIds = r.violations.filter(v => v.code === 'ROTATION_HALF_STATE').map(v => v.id);
  assert.deepEqual(halfStateIds.sort(), ['slack-exp-only', 'slack-rt-only']);
});

test('buildMigrationReport: flags rotation half-state (expiresAt without refreshToken)', () => {
  const config = {
    workspaces: [
      { id: 'slack-half', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'T01', name: 'X' },
          tokens: {
            accessToken: 'xoxe.xoxp-1', tokenType: 'user',
            expiresAt: '2026-12-31T00:00:00.000Z',
          },
        } },
    ],
  };
  const r = buildMigrationReport(config);
  assert.ok(r.violations.find(v => v.code === 'ROTATION_HALF_STATE'));
});

// ─── Schema-level Enterprise + half-state reject ─────────────────

test('schema: team.id starting with E rejected (Phase 12 §10 R9)', () => {
  const r = validateWorkspacePayload({
    kind: 'native', provider: 'slack', authMode: 'oauth',
    slackOAuth: {
      team: { id: 'E01ENT', name: 'Ent' },
      tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /Enterprise Grid/.test(e)), r.errors?.join('; '));
});

test('schema: half-state rejected (expiresAt + no refreshToken)', () => {
  const r = validateWorkspacePayload({
    kind: 'native', provider: 'slack', authMode: 'oauth',
    slackOAuth: {
      team: { id: 'T1', name: 'X' },
      tokens: {
        accessToken: 'xoxe.xoxp-1', tokenType: 'user',
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /half-state/.test(e)), r.errors?.join('; '));
});

test('schema: half-state rejected (refreshToken + no expiresAt)', () => {
  const r = validateWorkspacePayload({
    kind: 'native', provider: 'slack', authMode: 'oauth',
    slackOAuth: {
      team: { id: 'T1', name: 'X' },
      tokens: {
        accessToken: 'xoxe.xoxp-1', tokenType: 'user',
        refreshToken: 'xoxe-1-RT',
      },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /half-state/.test(e)), r.errors?.join('; '));
});

// ─── Script CLI ──────────────────────────────────────────────────

async function runScript(configContent, args = ['--report']) {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-9-'));
  const cfgPath = join(dir, 'workspaces.json');
  await writeFile(cfgPath, JSON.stringify(configContent), 'utf-8');
  try {
    const res = spawnSync('node', [SCRIPT, ...args, `--config=${cfgPath}`], {
      encoding: 'utf-8',
    });
    return res;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('script: exit 0 when no botToken workspaces remain', async () => {
  const r = await runScript({ workspaces: [] });
  assert.equal(r.status, 0, r.stderr);
});

test('script: exit 1 when botToken workspaces exist (operator action required)', async () => {
  const r = await runScript({
    workspaces: [
      { id: 'slack-1', kind: 'native', provider: 'slack', alias: 't', namespace: 't',
        credentials: { botToken: 'xoxb-x' } },
    ],
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /botToken workspace\(s\) to migrate/);
  assert.match(r.stdout, /alias:\s+t/);
});

test('script: exit 2 when invariant violation detected', async () => {
  const r = await runScript({
    workspaces: [
      { id: 'slack-ent', kind: 'native', provider: 'slack', authMode: 'oauth',
        slackOAuth: {
          team: { id: 'E01ENT', name: 'Ent' },
          tokens: { accessToken: 'x', tokenType: 'user' },
        } },
    ],
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /ENTERPRISE_TEAM_LEAKED/);
});

test('script: --apply is refused (Phase 12-D9)', async () => {
  const r = await runScript({ workspaces: [] }, ['--apply']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /not supported/);
});

test('script: --apply combined with --json still refused (Codex R1 BLOCKER 2)', async () => {
  // Arg-order bypass — `--apply --json` previously took the `json` mode
  // and skipped the rejection. The flag-tracking parser rejects it now.
  const r = await runScript({ workspaces: [] }, ['--apply', '--json']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /not supported/);
  // Reverse order
  const r2 = await runScript({ workspaces: [] }, ['--json', '--apply']);
  assert.equal(r2.status, 64);
});

test('script: --apply combined with --help still refused (Codex R2 BLOCKER)', async () => {
  // The previous implementation's `--help` branch ran inside parseArgs
  // and called process.exit(0) before the apply guard could fire.
  for (const argv of [['--help', '--apply'], ['--apply', '--help'], ['--apply', '--json', '--help'], ['-h', '--apply']]) {
    const r = await runScript({ workspaces: [] }, argv);
    assert.equal(r.status, 64, `argv ${argv.join(' ')} expected 64, got ${r.status} (stdout=${r.stdout.slice(0, 200)})`);
    assert.match(r.stderr, /not supported/);
  }
});

test('script: --help alone still prints usage and exits 0', async () => {
  const r = await runScript({ workspaces: [] }, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test('script: --json emits parseable JSON', async () => {
  const r = await runScript({
    workspaces: [
      { id: 'slack-1', kind: 'native', provider: 'slack', alias: 't', namespace: 't',
        credentials: { botToken: 'xoxb-x' } },
    ],
  }, ['--json']);
  // exit 1 because botToken workspace present, but stdout still parses.
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.botTokenWorkspaces.length, 1);
  assert.deepEqual(parsed.violations, []);
});
