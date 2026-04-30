#!/usr/bin/env node
/**
 * Phase 10a §4.10a-6 — OAuth client isolation migration
 *
 * Migrates pre-Phase-10a `workspaces.json` to the Phase 10a schema:
 *   1. Flat `ws.oauth.{clientId,clientSecret,authMethod}` → nested `ws.oauth.client`
 *      (keeps flat fields mirrored for 1 release per §3.4).
 *   2. Detects workspaces that share the same OAuth clientId (the original
 *      Phase 10a bug: refresh-token supersede between workspaces). The first
 *      workspace per `${issuer}::${clientId}` group keeps the client; the rest
 *      are flagged with `oauthActionNeeded = true` so operators re-authorize
 *      (each workspace will get its own fresh client_id via the updated
 *      Phase 10a registerClient flow).
 *
 * Usage:
 *   node scripts/migrate-oauth-clients.mjs --dry-run  (default; prints report)
 *   node scripts/migrate-oauth-clients.mjs --apply    (writes + creates .pre-10a.bak)
 *   node scripts/migrate-oauth-clients.mjs --restore  (restores from .pre-10a.bak)
 *
 * Safety:
 *   - `--apply` creates `config/workspaces.json.pre-10a.bak` (chmod 0o600) first.
 *   - `--restore` copies .pre-10a.bak back over workspaces.json then exits.
 *   - Dry-run never writes anywhere.
 */

import { readFile, writeFile, copyFile, chmod, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'workspaces.json');
const DEFAULT_PENDING_PATH = join(__dirname, '..', '.ao', 'state', 'oauth-pending.json');

function backupPathFor(configPath) {
  // Phase 10a (Codex R2 cleanup): backup file must be a sibling of the actual
  // config file, not always the repo-global path. Previously `--config=...`
  // override was silently dropped here.
  return `${configPath}.pre-10a.bak`;
}

function parseArgs(argv) {
  // 2026-05-01 사고 후속 — `--pending=<path>` 옵션 추가. 기존엔 PENDING path
  // 가 하드코딩이라 테스트가 실제 .ao/state/oauth-pending.json 을 save+restore
  // 하던 sticky 위험이 있었음. sandboxed test 가 pending 도 tmp 로 가도록.
  const args = { dryRun: true, apply: false, restore: false, configPath: CONFIG_PATH, pendingPath: DEFAULT_PENDING_PATH };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') { args.apply = true; args.dryRun = false; }
    else if (a === '--restore') { args.restore = true; args.dryRun = false; }
    else if (a.startsWith('--config=')) args.configPath = a.slice('--config='.length);
    else if (a.startsWith('--pending=')) args.pendingPath = a.slice('--pending='.length);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/migrate-oauth-clients.mjs [--dry-run|--apply|--restore] [--config=path] [--pending=path]');
      process.exit(0);
    }
  }
  args.backupPath = backupPathFor(args.configPath);
  return args;
}

function inspect(config) {
  const report = {
    workspacesScanned: 0,
    flatToNested: [],       // [{id, issuer, clientId}]
    sharedClients: [],      // [{groupKey, workspaces:[...]}]
    alreadyMigrated: [],    // [{id}]
    nonOAuth: [],           // [{id}]
    conflicts: [],          // [{id, nestedClientId, flatClientId}]
  };
  const byGroup = new Map(); // `${issuer}::${clientId}` → [wsId,...]
  for (const ws of config.workspaces || []) {
    report.workspacesScanned++;
    if (!ws.oauth || !ws.oauth.enabled) { report.nonOAuth.push({ id: ws.id }); continue; }
    const nested = ws.oauth.client;
    const flatCid = ws.oauth.clientId;
    if (nested?.clientId && flatCid && nested.clientId !== flatCid) {
      report.conflicts.push({ id: ws.id, nestedClientId: nested.clientId, flatClientId: flatCid });
    }
    const cid = nested?.clientId || flatCid || null;
    if (!nested && flatCid) {
      report.flatToNested.push({ id: ws.id, issuer: ws.oauth.issuer, clientId: flatCid });
    } else if (nested) {
      report.alreadyMigrated.push({ id: ws.id });
    }
    if (cid && ws.oauth.issuer) {
      const key = `${ws.oauth.issuer}::${cid}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(ws.id);
    }
  }
  for (const [key, ids] of byGroup) {
    if (ids.length > 1) report.sharedClients.push({ groupKey: key, workspaces: ids });
  }
  return report;
}

function applyMigration(config) {
  // 1. Flat → nested per workspace. Phase 11 §3: also scrub the flat keys
  // after promotion so no mirror remains on disk. The 1-release deprecation
  // window closed in Phase 11 — all runtime read paths use nested only.
  const flatScrubbed = []; // [{id}]
  for (const ws of config.workspaces || []) {
    if (!ws.oauth) continue;
    if (!ws.oauth.client && ws.oauth.clientId) {
      ws.oauth.client = {
        clientId: ws.oauth.clientId,
        clientSecret: ws.oauth.clientSecret ?? null,
        authMethod: ws.oauth.authMethod || 'none',
        source: 'legacy-flat',
        registeredAt: ws.oauth.clientRegisteredAt || new Date().toISOString(),
      };
    }
    // Phase 11 §3 — scrub flat mirror in ALL cases (including client===null
    // + lingering flat=null keys from old Phase 10a disambiguation output).
    // Codex Phase 11-3 R1 called out that gating on `if (ws.oauth.client)`
    // left stale null flat keys on disk forever.
    let scrubbed = false;
    if ('clientId' in ws.oauth) { delete ws.oauth.clientId; scrubbed = true; }
    if ('clientSecret' in ws.oauth) { delete ws.oauth.clientSecret; scrubbed = true; }
    if ('authMethod' in ws.oauth) { delete ws.oauth.authMethod; scrubbed = true; }
    if (scrubbed) flatScrubbed.push({ id: ws.id });
  }
  // 2. Shared clientId disambiguation. For each group of workspaces with the
  //    same (issuer, clientId), keep the first one and flag the rest for re-auth.
  const groups = new Map();
  for (const ws of config.workspaces || []) {
    const cid = ws.oauth?.client?.clientId || ws.oauth?.clientId;
    const issuer = ws.oauth?.issuer;
    if (!cid || !issuer) continue;
    const key = `${issuer}::${cid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ws);
  }
  const disambiguated = [];
  for (const [key, wss] of groups) {
    if (wss.length <= 1) continue;
    // Keep wss[0], strip client from wss[1..] and set action_needed.
    // Phase 11 §3 — nested-only; flat keys (if any) are scrubbed above.
    for (let i = 1; i < wss.length; i++) {
      const ws = wss[i];
      ws.oauth.client = null;
      // Mark all existing identities as requiring re-authorization.
      const byId = ws.oauth.byIdentity || { default: { tokens: null } };
      ws.oauthActionNeededBy = ws.oauthActionNeededBy || {};
      for (const identity of Object.keys(byId)) {
        ws.oauthActionNeededBy[identity] = true;
        if (byId[identity]?.tokens) byId[identity].tokens.accessToken = null;
      }
      ws.oauthActionNeeded = true;
      if (ws.oauth.tokens) ws.oauth.tokens.accessToken = null;
      disambiguated.push({ id: ws.id, groupKey: key });
    }
  }
  return { disambiguated, flatScrubbed };
}

async function main() {
  const args = parseArgs(process.argv);
  const { configPath, backupPath, pendingPath } = args;
  if (args.restore) {
    if (!existsSync(backupPath)) {
      console.error(`[migrate-oauth-clients] backup not found: ${backupPath}`);
      process.exit(2);
    }
    await copyFile(backupPath, configPath);
    if (process.platform !== 'win32') {
      try { await chmod(configPath, 0o600); } catch {}
    }
    console.log(JSON.stringify({ ok: true, action: 'restore', from: backupPath, to: configPath }, null, 2));
    return;
  }
  if (!existsSync(configPath)) {
    console.error(`[migrate-oauth-clients] config not found: ${configPath}`);
    process.exit(2);
  }
  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw);
  const report = inspect(config);
  if (args.dryRun) {
    console.log(JSON.stringify({ action: 'dry-run', report }, null, 2));
    return;
  }
  // --apply
  await copyFile(configPath, backupPath);
  if (process.platform !== 'win32') {
    try { await chmod(backupPath, 0o600); } catch {}
  }
  const { disambiguated, flatScrubbed } = applyMigration(config);
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  if (process.platform !== 'win32') {
    try { await chmod(configPath, 0o600); } catch {}
  }
  // Phase 10a §4.10a-6 (Codex R8): purge pending auth states for disambiguated
  // workspaces. A stale callback for a workspace whose client was just nulled
  // could resurrect the pre-migration shared client via completeAuthorization.
  // The OAuthManager rotation check also protects against this at runtime
  // (null-inclusive), but purging here is defense-in-depth.
  let pendingPurged = 0;
  if (disambiguated.length > 0 && existsSync(pendingPath)) {
    try {
      const pendingRaw = await readFile(pendingPath, 'utf-8');
      const pending = JSON.parse(pendingRaw);
      const disambiguatedIds = new Set(disambiguated.map(d => d.id));
      for (const [state, entry] of Object.entries(pending)) {
        if (entry?.workspaceId && disambiguatedIds.has(entry.workspaceId)) {
          delete pending[state];
          pendingPurged++;
        }
      }
      if (pendingPurged > 0) {
        await writeFile(pendingPath, JSON.stringify(pending, null, 2), 'utf-8');
        if (process.platform !== 'win32') {
          try { await chmod(pendingPath, 0o600); } catch {}
        }
      }
    } catch { /* best-effort — the rotation check at runtime still guards */ }
  }
  console.log(JSON.stringify({
    ok: true,
    action: 'apply',
    backup: backupPath,
    backupMode: process.platform === 'win32' ? 'chmod-skipped' : '0o600',
    pendingPurged,
    report: { ...report, disambiguated, flatScrubbed },
  }, null, 2));
}

main().catch(err => {
  console.error('[migrate-oauth-clients] error:', err.message);
  process.exit(1);
});
