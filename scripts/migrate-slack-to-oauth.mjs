#!/usr/bin/env node
/**
 * Phase 12-9 — botToken → OAuth migration helper.
 *
 * Phase 12-D9 chose hard-delete over in-place conversion for botToken
 * Slack workspaces. This helper does NOT auto-convert; it just generates
 * a punch list of what to migrate so the operator runs the wizard with
 * pre-filled alias/namespace and avoids tool-name churn.
 *
 *   --report   (default) — print which Slack botToken workspaces exist + the
 *              prefilled wizard payload they should match. No file writes.
 *   --json     emit the report as JSON (CI / scripting).
 *   --apply    NOT SUPPORTED — phase 12-9 is intentionally read-only.
 *              An attempt to pass --apply prints a friendly error pointing
 *              at the wizard.
 *
 * The helper also surfaces any workspace whose stored slackOAuth response
 * carries a Phase 12 invariant violation (e.g. is_enterprise_install: true
 * leaked through, missing tokenType) so the operator notices BEFORE the
 * runtime tries to refresh.
 *
 * Exit codes:
 *   0 — clean (no botToken workspaces or all already converted)
 *   1 — botToken workspaces still exist (operator action required)
 *   2 — invariant violation detected (config corrupt, manual fix needed)
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'workspaces.json');

function parseArgs(argv) {
  // Phase 12-9 (Codex R1/R2 BLOCKER 2): collect all flags FIRST. If
  // --apply was seen anywhere we reject before any other action — this
  // forecloses the `--help --apply` and `--apply --help` bypasses too.
  const args = { mode: 'report', applyRequested: false, helpRequested: false, configPath: CONFIG_PATH };
  for (const a of argv.slice(2)) {
    if (a === '--report' || a === '--dry-run') args.mode = 'report';
    else if (a === '--json') args.mode = 'json';
    else if (a === '--apply') args.applyRequested = true;
    else if (a === '--help' || a === '-h') args.helpRequested = true;
    else if (a.startsWith('--config=')) args.configPath = a.slice('--config='.length);
  }
  return args;
}

function printHelp() {
  console.log('Usage: node scripts/migrate-slack-to-oauth.mjs [--report|--json] [--config=path]');
  console.log('Phase 12-D9: this helper is intentionally read-only. Use the Admin UI');
  console.log('Slack screen to (re-)connect each workspace via OAuth.');
}

/**
 * Inspect the loaded workspaces array. Returns:
 *   { botTokenWorkspaces: [{ id, alias, namespace, displayName, hasTeamId }],
 *     oauthWorkspaces:    [{ id, alias, namespace, team }],
 *     violations:         [{ id, code, detail }] }
 */
export function buildMigrationReport(config) {
  // Phase 12-9 (Codex R1 BLOCKER 1): soft-deleted Slack workspaces are
  // surfaced as a violation, not silently skipped. Their alias still
  // reserves the namespace, which would force the OAuth re-add to take
  // a suffix and break tool-name continuity.
  const allSlack = (config?.workspaces || []).filter(w => w.provider === 'slack');
  const list = allSlack.filter(w => !w.deletedAt);
  const softDeleted = allSlack.filter(w => w.deletedAt);
  const botTokenWorkspaces = [];
  const oauthWorkspaces = [];
  const violations = [];

  for (const ws of softDeleted) {
    violations.push({
      id: ws.id,
      code: 'SOFT_DELETED_BLOCKING_NAMESPACE',
      detail: `soft-deleted Slack workspace alias="${ws.alias}" still reserves the namespace. Hard-delete via DELETE /api/workspaces/${ws.id}?hard=true before re-adding via OAuth.`,
    });
  }

  for (const ws of list) {
    const authMode = ws.authMode || 'token';
    if (authMode === 'token') {
      const hasBotToken = !!(ws.credentials && ws.credentials.botToken);
      botTokenWorkspaces.push({
        id: ws.id,
        alias: ws.alias,
        namespace: ws.namespace,
        displayName: ws.displayName,
        hasBotToken,
        hasTeamId: !!(ws.credentials && ws.credentials.teamId),
      });
      continue;
    }

    if (authMode === 'oauth') {
      const oauth = ws.slackOAuth;
      if (!oauth) {
        violations.push({ id: ws.id, code: 'OAUTH_STATE_MISSING', detail: 'authMode=oauth but slackOAuth is absent' });
        continue;
      }
      // Phase 12-9 (silent-break defense): refuse to migrate a workspace
      // whose stored payload looks like an Enterprise Grid response.
      if (oauth.team?.id?.startsWith('E')) {
        violations.push({
          id: ws.id,
          code: 'ENTERPRISE_TEAM_LEAKED',
          detail: `team.id "${oauth.team.id}" looks like Enterprise Grid (T-prefixed expected). Phase 12 비범위.`,
        });
        continue;
      }
      if (!oauth.tokens?.tokenType) {
        violations.push({ id: ws.id, code: 'TOKEN_TYPE_MISSING', detail: 'slackOAuth.tokens.tokenType invariant violated' });
      } else if (oauth.tokens.tokenType !== 'user') {
        violations.push({
          id: ws.id,
          code: 'TOKEN_TYPE_NOT_USER',
          detail: `tokenType=${oauth.tokens.tokenType} — Phase 12 invariant requires 'user'`,
        });
      }
      // Phase 12-9 (Codex R1 REVISE 4): half-state defense in BOTH directions.
      const hasExp = !!oauth.tokens?.expiresAt;
      const hasRefresh = !!oauth.tokens?.refreshToken;
      if (hasExp !== hasRefresh) {
        violations.push({
          id: ws.id,
          code: 'ROTATION_HALF_STATE',
          detail: `expiresAt=${hasExp}, refreshToken=${hasRefresh} — must be both-present or both-absent`,
        });
      }
      // Phase 12-9 (Codex R1 REVISE 3): catch is_enterprise_install leak
      // even when team.id passes the E-prefix check. A config audited from
      // an older flow (or hand-edited) can still carry this flag.
      if (oauth.is_enterprise_install === true) {
        violations.push({
          id: ws.id,
          code: 'ENTERPRISE_INSTALL_LEAKED',
          detail: 'slackOAuth.is_enterprise_install: true — Phase 12 비범위.',
        });
      }
      // Same defense for raw enterprise.id leaking into the stored payload.
      if (oauth.enterprise && oauth.enterprise.id) {
        violations.push({
          id: ws.id,
          code: 'ENTERPRISE_ID_LEAKED',
          detail: `slackOAuth.enterprise.id="${oauth.enterprise.id}" present — Phase 12 비범위.`,
        });
      }
      oauthWorkspaces.push({
        id: ws.id,
        alias: ws.alias,
        namespace: ws.namespace,
        team: oauth.team,
        status: oauth.status || 'active',
      });
    }
  }

  return { botTokenWorkspaces, oauthWorkspaces, violations };
}

function renderHumanReport(report) {
  const lines = [];
  lines.push('# Phase 12-9 — Slack botToken → OAuth migration report');
  lines.push('');
  if (report.violations.length) {
    lines.push(`⚠ ${report.violations.length} invariant violation(s) detected — fix BEFORE migrating:`);
    for (const v of report.violations) {
      lines.push(`  - [${v.code}] ${v.id}: ${v.detail}`);
    }
    lines.push('');
  }
  if (!report.botTokenWorkspaces.length) {
    lines.push('✓ No botToken-mode Slack workspaces remain. Migration done.');
  } else {
    lines.push(`${report.botTokenWorkspaces.length} botToken workspace(s) to migrate (Phase 12-D9: hard-delete + re-add via OAuth wizard):`);
    for (const ws of report.botTokenWorkspaces) {
      lines.push('');
      lines.push(`  - id:           ${ws.id}`);
      lines.push(`    alias:        ${ws.alias}`);
      lines.push(`    namespace:    ${ws.namespace}    (preserve to keep tool name stable)`);
      lines.push(`    displayName:  ${ws.displayName || '(unset)'}`);
      lines.push(`    hasBotToken:  ${ws.hasBotToken}`);
      lines.push(`    hasTeamId:    ${ws.hasTeamId}`);
      lines.push(`    next steps:`);
      lines.push(`      1. Hard-delete the workspace from Admin UI (Detail → Delete).`);
      lines.push(`         (Soft-delete leaves the namespace blocked — Phase 12-D9 selects hard-delete.)`);
      lines.push(`      2. Open Slack screen → Connect Slack workspace.`);
      lines.push(`      3. After install completes, edit the new entry's alias to "${ws.alias}"`);
      lines.push(`         and namespace to "${ws.namespace}" so MCP tool names`);
      lines.push(`         (slack_${ws.namespace}__*) stay stable for downstream clients.`);
    }
  }
  if (report.oauthWorkspaces.length) {
    lines.push('');
    lines.push(`✓ ${report.oauthWorkspaces.length} OAuth-mode Slack workspace(s) already migrated:`);
    for (const ws of report.oauthWorkspaces) {
      lines.push(`  - ${ws.id} (alias=${ws.alias}, team=${ws.team?.name || ws.team?.id || '?'}, status=${ws.status})`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  // Apply-rejection takes precedence over help so any combination
  // (e.g. `--help --apply`, `--apply --help`, `--apply --json --help`)
  // surfaces the refusal rather than falling through the help branch.
  if (args.applyRequested) {
    console.error('Phase 12-D9: --apply is not supported. Hard-delete in Admin UI then');
    console.error('use the Slack OAuth wizard (Connect Slack workspace) for each entry.');
    console.error('Run --report to see the migration punch list.');
    process.exit(64);
  }
  if (args.helpRequested) {
    printHelp();
    process.exit(0);
  }
  if (!existsSync(args.configPath)) {
    console.error(`config not found: ${args.configPath}`);
    process.exit(2);
  }
  const raw = await readFile(args.configPath, 'utf-8');
  let config;
  try { config = JSON.parse(raw); }
  catch (err) {
    console.error(`config parse error: ${err.message}`);
    process.exit(2);
  }
  const report = buildMigrationReport(config);
  if (args.mode === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHumanReport(report));
  }
  if (report.violations.length) process.exit(2);
  if (report.botTokenWorkspaces.length) process.exit(1);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
