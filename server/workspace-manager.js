import { readFile, writeFile, rename, copyFile, watch, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotionProvider } from '../providers/notion.js';
import { SlackProvider } from '../providers/slack.js';
import { McpClientProvider } from '../providers/mcp-client.js';
import { sanitize } from './oauth-sanitize.js';
import { logger } from './logger.js';
import { validateSlackAppPayload } from './workspace-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const CONFIG_PATH = join(CONFIG_DIR, 'workspaces.json');
const BACKUP_PATH = join(CONFIG_DIR, 'workspaces.backup.json');
const TMP_PATH = join(CONFIG_DIR, 'workspaces.tmp.json');

const NATIVE_PROVIDERS = { notion: NotionProvider, slack: SlackProvider };

function generateId(provider, alias) {
  return `${provider}-${alias}`;
}

function aliasFromDisplayName(displayName) {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'workspace';
}

function maskTokenEntry(t) {
  if (!t) return null;
  return {
    hasAccessToken: !!t.accessToken,
    hasRefreshToken: !!t.refreshToken,
    accessTokenPrefix: t.accessToken ? `${t.accessToken.slice(0, 4)}***${t.accessToken.slice(-4)}` : null,
    expiresAt: t.expiresAt || null,
    tokenType: t.tokenType || null,
    scope: t.scope || null,
    lastRefreshAt: t.lastRefreshAt || null,
  };
}

function maskOAuth(oauth) {
  if (!oauth) return oauth;
  const masked = { ...oauth };
  // Phase 11 §3 — flat-field (ws.oauth.{clientId,clientSecret,authMethod})
  // mirror removed. Startup migration promotes any lingering flat fields
  // into ws.oauth.client and scrubs the originals, so mask from nested only.
  if (oauth.client && typeof oauth.client === 'object') {
    const c = oauth.client;
    masked.client = {
      ...c,
      clientId: (c.clientId && typeof c.clientId === 'string' && c.clientId.length > 8)
        ? `${c.clientId.slice(0, 4)}***${c.clientId.slice(-4)}`
        : c.clientId || null,
      clientSecret: c.clientSecret ? '***' : null,
    };
  }
  // Legacy default tokens
  if (oauth.tokens) masked.tokens = maskTokenEntry(oauth.tokens);
  // Phase 7c-pre: byIdentity[*].tokens must be masked too.
  if (oauth.byIdentity && typeof oauth.byIdentity === 'object') {
    const maskedBy = {};
    for (const [identity, entry] of Object.entries(oauth.byIdentity)) {
      maskedBy[identity] = { tokens: maskTokenEntry(entry?.tokens) };
    }
    masked.byIdentity = maskedBy;
  }
  return masked;
}

function maskCredentials(credentials) {
  const masked = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value === 'string' && value.length > 4) {
      const prefix = value.slice(0, value.indexOf('_') + 1) || '';
      masked[key] = `${prefix}***${value.slice(-4)}`;
    } else {
      masked[key] = '***';
    }
  }
  return masked;
}

// Phase 12 §3.4 (B5) — strip raw Slack OAuth tokens from masked workspace
// responses. Token bodies (xoxe.xoxp- / xoxe-) must never appear in
// /api/workspaces output; admin UI surfaces only a short prefix + boolean
// hasRefreshToken flag. expiresAt is ISO 8601 (no masking needed — it's a
// timestamp, not a secret).
export function maskSlackOAuth(slackOAuth) {
  if (!slackOAuth || typeof slackOAuth !== 'object') return slackOAuth;
  const t = slackOAuth.tokens;
  if (!t || typeof t !== 'object') return slackOAuth;
  return {
    ...slackOAuth,
    tokens: {
      accessToken: t.accessToken && typeof t.accessToken === 'string'
        ? `${t.accessToken.slice(0, 12)}...`
        : null,
      refreshToken: t.refreshToken && typeof t.refreshToken === 'string'
        ? `${t.refreshToken.slice(0, 8)}...`
        : null,
      hasRefreshToken: !!t.refreshToken,
      expiresAt: t.expiresAt || null,
      tokenType: t.tokenType || null,
    },
  };
}

// Phase 12 §3.4 (v4) — masking for the top-level slackApp config block.
// Tracks two separate sources (clientId / clientSecret) so the Admin UI
// can render distinct badges when env-var override is partially in effect.
export function maskSlackApp(slackApp) {
  if (!slackApp || typeof slackApp !== 'object') return null;
  return {
    clientId: slackApp.clientId || null,
    hasSecret: !!slackApp.clientSecret,
    tokenRotationEnabled: slackApp.tokenRotationEnabled !== false,
    sources: {
      clientId: process.env.BIFROST_SLACK_CLIENT_ID
        ? 'env'
        : (slackApp.clientId ? 'file' : 'none'),
      clientSecret: process.env.BIFROST_SLACK_CLIENT_SECRET
        ? 'env'
        : (slackApp.clientSecret ? 'file' : 'none'),
    },
    createdAt: slackApp.createdAt || null,
    updatedAt: slackApp.updatedAt || null,
  };
}

export class WorkspaceManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.configDir] — override the config directory (tests
   *   inject a tmpdir). Defaults to `<repo>/config`. The three files
   *   (workspaces.json, workspaces.backup.json, workspaces.tmp.json) are
   *   placed inside this directory, so tests can exercise the atomic
   *   rename + hot-reload path without touching the real config.
   */
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.config = { workspaces: [], server: { port: 3100 }, tunnel: { enabled: false, fixedDomain: '' } };
    this.providers = new Map();
    this.healthCache = new Map();
    this.capabilityCache = new Map();
    this._writeLock = Promise.resolve();
    this._onChange = null;
    this._loaded = false; // only save to disk after explicit load()
    this._saving = false; // self-save guard for file watcher
    this.errorLog = []; // last 50 errors
    this.auditLog = []; // last 10 config changes
    this.oauthAuditLog = []; // separate ring (50) for oauth.* events
    this.fileSecurityWarning = process.platform === 'win32';
    // Phase 11-8 §7 — DI-able paths so watcher + atomic save can be
    // exercised against a tmpdir in tests. Production callers pass no arg
    // and land on the shared CONFIG_DIR constant.
    this._configDir = configDir;
    this._configPath = join(configDir, 'workspaces.json');
    this._backupPath = join(configDir, 'workspaces.backup.json');
    this._tmpPath = join(configDir, 'workspaces.tmp.json');
    // Phase 11-9 (post-OSS-publish) — graceful watcher lifecycle. close()
    // sets `_stopped` so any in-flight reload debounce or watcher loop
    // exits without throwing into an uninstrumented unhandledRejection.
    this._stopped = false;
    this._reloadTimer = null;
  }

  async load() {
    if (!existsSync(this._configPath)) {
      this._loaded = true;
      await this._save();
      this._startFileWatcher();
      return;
    }
    try {
      const raw = await readFile(this._configPath, 'utf-8');
      this.config = JSON.parse(raw);
    } catch {
      if (existsSync(this._backupPath)) {
        const backup = await readFile(this._backupPath, 'utf-8');
        this.config = JSON.parse(backup);
        logger.error('[WorkspaceManager] Loaded from backup');
      } else {
        logger.error('[WorkspaceManager] No valid config found, using defaults');
      }
    }
    if (!this.config.workspaces) this.config.workspaces = [];
    const mutated = this._migrateLegacy();
    this._loaded = true;
    // Phase 11 §3 — persist migration results so on-disk config converges
    // to nested-only (Phase 10a §3.4 deprecation window is closed). Without
    // this, the scrub only exists in memory until the next unrelated write.
    // Codex Phase 11-3 R2 follow-up: do NOT silently swallow startup save
    // failure — log loudly so operators notice a degraded state. We still
    // allow boot to continue (runtime behaves correctly on the in-memory
    // migrated config) but surface the persistence failure in errorLog.
    if (mutated) {
      try {
        await this._save();
      } catch (err) {
        logger.error(`[WorkspaceManager] Phase 11 §3: startup migration could not persist scrubbed config: ${err.message}. Runtime is using in-memory migration; flat fields remain on disk until the next successful save.`);
        this.logError('config', null, `Phase 11 migration persistence failed: ${err.message}`);
      }
    }
    await this._initProviders();
    this._startFileWatcher();
  }

  _migrateLegacy() {
    // Legacy entries without `kind` → assume native (Notion/Slack REST wrapper)
    let migrated = 0;
    let oauthMirrored = 0;
    let clientBlockMigrated = 0;
    let clientMismatchWarned = 0;
    let flatScrubbed = 0;
    for (const ws of this.config.workspaces) {
      if (!ws.kind) {
        ws.kind = 'native';
        migrated++;
      }
      // Phase 7c-pre: mirror legacy ws.oauth.tokens into byIdentity.default.tokens.
      // Keep the legacy `tokens` field intact for back-compat readers.
      if (ws.oauth?.tokens && !ws.oauth?.byIdentity?.default?.tokens) {
        ws.oauth.byIdentity = {
          ...(ws.oauth.byIdentity || {}),
          default: { tokens: ws.oauth.tokens },
        };
        oauthMirrored++;
      }
      // Phase 11 §3: migrate flat ws.oauth.{clientId,clientSecret,authMethod}
      // into nested ws.oauth.client AND scrub the flat keys. The 1-release
      // deprecation window (Phase 10a §3.4) is now closed — no code reads
      // flat fields anymore. Any config written by an old CLI that still
      // carries flat fields gets promoted on first load.
      if (ws.oauth && ws.oauth.clientId && !ws.oauth.client) {
        ws.oauth.client = {
          clientId: ws.oauth.clientId,
          clientSecret: ws.oauth.clientSecret ?? null,
          authMethod: ws.oauth.authMethod || 'none',
          source: ws.oauth.clientSource || 'legacy-flat',
          registeredAt: ws.oauth.clientRegisteredAt || new Date().toISOString(),
        };
        clientBlockMigrated++;
      }
      // Phase 11 §3 — divergence check: if BOTH nested and flat exist and
      // their clientIds disagree, prefer nested (already authoritative) but
      // log a warning BEFORE we scrub so operators notice. Silent on match.
      if (ws.oauth?.client && ws.oauth.clientId && ws.oauth.client.clientId !== ws.oauth.clientId) {
        logger.warn(`[WorkspaceManager] Phase 11 §3: ws.oauth.client.clientId diverges from legacy ws.oauth.clientId for workspace '${ws.id}'. Scrubbing legacy flat fields; preferring nested client.*`);
        clientMismatchWarned++;
      }
      // Phase 11 §3 — scrub flat-field mirror in ALL cases where ws.oauth
      // exists and flat keys are present, regardless of whether nested is
      // populated. This covers:
      //   (1) nested populated (common post-10a case) → scrub flat mirror
      //   (2) nested===null + flat keys lingering (Phase 10a disambiguation
      //       output left flat=null in place) → scrub the dead keys anyway
      //   (3) first-time flat→nested promotion above → scrub originals
      // Codex Phase 11-3 R1 called out case (2) as previously unhandled.
      if (ws.oauth && typeof ws.oauth === 'object') {
        let scrubbed = false;
        if ('clientId' in ws.oauth) { delete ws.oauth.clientId; scrubbed = true; }
        if ('clientSecret' in ws.oauth) { delete ws.oauth.clientSecret; scrubbed = true; }
        if ('authMethod' in ws.oauth) { delete ws.oauth.authMethod; scrubbed = true; }
        if (scrubbed) flatScrubbed++;
      }
    }
    if (migrated > 0) {
      logger.info(`[WorkspaceManager] Migrated ${migrated} legacy workspace(s) to kind=native`);
    }
    if (oauthMirrored > 0) {
      logger.info(`[WorkspaceManager] Phase 7c-pre: mirrored ${oauthMirrored} OAuth tokens to byIdentity.default`);
    }
    if (clientBlockMigrated > 0) {
      logger.info(`[WorkspaceManager] Phase 10a: migrated ${clientBlockMigrated} flat OAuth client field(s) to ws.oauth.client`);
    }
    if (clientMismatchWarned > 0) {
      logger.warn(`[WorkspaceManager] Phase 10a: ${clientMismatchWarned} workspace(s) have conflicting nested vs flat OAuth client fields`);
    }
    if (flatScrubbed > 0) {
      logger.info(`[WorkspaceManager] Phase 11 §3: scrubbed legacy flat OAuth field mirror from ${flatScrubbed} workspace(s)`);
    }
    // Phase 11 §3 — report whether the config was mutated so callers can
    // decide whether to persist. `load()` and the hot-reload watcher use
    // this to converge on-disk config to nested-only.
    return (migrated + oauthMirrored + clientBlockMigrated + clientMismatchWarned + flatScrubbed) > 0;
  }

  /**
   * Phase 10a §4.10a-4 — public diagnostic API. Returns the nested OAuth client
   * block or `null` if the workspace has no persisted client. Used by §9
   * assertions (cache purge tests) and the Admin UI.
   */
  getOAuthClient(workspaceId) {
    const ws = this.config.workspaces.find(w => w.id === workspaceId);
    if (!ws?.oauth) return null;
    // Phase 11 §3 — nested-only. Startup migration guarantees ws.oauth.client
    // is populated for any OAuth workspace that previously used flat fields.
    if (ws.oauth.client) {
      const c = ws.oauth.client;
      // Return masked view (clientSecret redacted). Keep clientId raw so
      // diagnostic consumers can compare/verify — it is not a bearer token.
      return {
        clientId: c.clientId || null,
        clientSecret: c.clientSecret ? '***' : null,
        authMethod: c.authMethod || null,
        source: c.source || null,
        registeredAt: c.registeredAt || null,
      };
    }
    return null;
  }

  async _initProviders() {
    this.providers.clear();
    for (const ws of this.config.workspaces) {
      this._createProvider(ws);
    }
  }

  setOAuthManager(oauth) {
    this._oauth = oauth;
  }

  setAuditLogger(audit) {
    this._audit = audit;
  }

  _createProvider(ws) {
    // Shutdown old provider if replacing
    const old = this.providers.get(ws.id);
    if (old?.shutdown) { try { old.shutdown(); } catch {} }

    if (ws.kind === 'mcp-client') {
      const opts = {};
      if (ws.oauth?.enabled && this._oauth) {
        // Phase 7c-pre: tokenProvider accepts an optional identity argument.
        // Undefined → default identity (backwards-compatible for callers that
        // don't know about byIdentity yet).
        opts.tokenProvider = async (identity) => this._oauth.getValidAccessToken(ws.id, identity || 'default').catch(() => null);
        opts.onUnauthorized = async (identity) => {
          try { await this._oauth.forceRefresh(ws.id, identity || 'default'); }
          catch (err) { this.logError('oauth.refresh', ws.id, err.message); throw err; }
        };
        // Phase 10a §4.10a-4 — threshold trip handler: mark workspace as needing
        // re-auth and stop the notification stream.
        opts.onAuthFailed = async (identity) => {
          try { await this._oauth.markAuthFailed(ws.id, identity || 'default'); }
          catch (err) { this.logError('oauth.mark_auth_failed', ws.id, err.message); }
          this._notifyChange();
        };
      }
      const provider = new McpClientProvider(ws, opts);
      provider.onToolsChanged(() => this._notifyChange());
      this.providers.set(ws.id, provider);
      // Phase 7c: skip warm-up when OAuth is enabled but no default tokens exist
      // — warming up would call refreshTools → 401 → forceRefresh → NO_REFRESH_TOKEN
      // and set oauthActionNeeded, which is a false positive pre-authorization.
      const needsAuth = ws.oauth?.enabled && !ws.oauth?.byIdentity?.default?.tokens?.accessToken && !ws.oauth?.tokens?.accessToken;
      if (!needsAuth) {
        provider.refreshTools().catch(() => {});
      }
      return;
    }
    // Native (default for backward compat)
    const ProviderClass = NATIVE_PROVIDERS[ws.provider];
    if (ProviderClass) {
      this.providers.set(ws.id, new ProviderClass(ws));
    }
  }

  async _save() {
    return this._saveImpl(() => this.config);
  }

  /**
   * Phase 12-3 (Codex R2 BLOCKER): write a *passed* snapshot to disk
   * without mutating this.config. Used by updateSlackOAuthAtomic to
   * achieve true clone-then-swap — the in-memory swap only happens if
   * _saveSnapshot resolves successfully. Concurrent reads during the
   * write window observe the OLD token; concurrent writes go through
   * the same _writeLock chain so they sequence after this snapshot
   * write completes (the swap-or-rollback in updateSlackOAuthAtomic
   * still acquires this.config exclusively).
   */
  async _saveSnapshot(snapshot) {
    if (!this._loaded) return; // skip disk I/O if not loaded from file
    return this._saveImpl(() => snapshot);
  }

  _saveImpl(getConfig) {
    if (!this._loaded) return Promise.resolve();
    this._writeLock = this._writeLock.then(async () => {
      this._saving = true;
      try {
        if (existsSync(this._configPath)) {
          await copyFile(this._configPath, this._backupPath);
          await this._chmod0600(this._backupPath);
        }
        await writeFile(this._tmpPath, JSON.stringify(getConfig(), null, 2), 'utf-8');
        await this._chmod0600(this._tmpPath);
        await rename(this._tmpPath, this._configPath);
        await this._chmod0600(this._configPath);
      } finally {
        this._saving = false;
      }
    }).catch(err => {
      this._saving = false;
      throw err;
    });
    return this._writeLock;
  }

  async _chmod0600(path) {
    if (process.platform === 'win32') {
      this.fileSecurityWarning = true;
      return;
    }
    try { await chmod(path, 0o600); } catch { /* best-effort */ }
  }

  getWorkspaces({ masked = true, includeDeleted = false } = {}) {
    return this.config.workspaces.filter(w => includeDeleted || !w.deletedAt).map(ws => {
      const health = this.healthCache.get(ws.id);
      const result = { ...ws, status: this._computeStatus(ws, health) };
      if (masked) this._maskSecrets(result, ws);
      return result;
    });
  }

  getWorkspace(id, { masked = true } = {}) {
    const ws = this.config.workspaces.find(w => w.id === id);
    if (!ws) return null;
    const health = this.healthCache.get(ws.id);
    const result = { ...ws, status: this._computeStatus(ws, health) };
    if (masked) this._maskSecrets(result, ws);
    return result;
  }

  _maskSecrets(result, ws) {
    if (ws.credentials) result.credentials = maskCredentials(ws.credentials);
    if (ws.env) result.env = maskCredentials(ws.env);
    if (ws.headers) result.headers = maskCredentials(ws.headers);
    if (ws.oauth) result.oauth = maskOAuth(ws.oauth);
    // Phase 12 §3.4 (B5) — slackOAuth raw tokens must never reach masked output.
    if (ws.slackOAuth) result.slackOAuth = maskSlackOAuth(ws.slackOAuth);
  }

  // Phase 12 §3.1 — top-level Slack App credential accessor. env vars override
  // file values per source; sources object is the canonical truth fed back to
  // the Admin UI. Unlike per-workspace credentials, slackApp lives at the same
  // level as workspaces[] in config/workspaces.json.
  getSlackAppRaw() {
    const file = this.config.slackApp || null;
    const envClientId = process.env.BIFROST_SLACK_CLIENT_ID;
    const envClientSecret = process.env.BIFROST_SLACK_CLIENT_SECRET;
    return {
      clientId: envClientId || file?.clientId || null,
      clientSecret: envClientSecret || file?.clientSecret || null,
      tokenRotationEnabled: file?.tokenRotationEnabled !== false,
      sources: {
        clientId: envClientId ? 'env' : (file?.clientId ? 'file' : 'none'),
        clientSecret: envClientSecret ? 'env' : (file?.clientSecret ? 'file' : 'none'),
      },
      createdAt: file?.createdAt || null,
      updatedAt: file?.updatedAt || null,
    };
  }

  getSlackApp() {
    // Masked view for /api/slack/app — never returns clientSecret. Calls
    // getSlackAppRaw() so the env-vs-file source determination stays single-
    // sourced.
    const raw = this.getSlackAppRaw();
    return {
      clientId: raw.clientId,
      hasSecret: !!raw.clientSecret,
      tokenRotationEnabled: raw.tokenRotationEnabled,
      sources: raw.sources,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  /**
   * Phase 12-3 (Codex R1 BLOCKER): atomic Slack OAuth token rotation via
   * clone-then-swap. Required by SlackOAuthManager._runRefresh so a save
   * failure leaves both disk AND in-memory state on the *previous* token,
   * never the partial new one. Without this helper the standard
   * updateWorkspace mutates ws.slackOAuth and re-creates the provider
   * BEFORE _save runs — a writeFile failure leaves the in-memory token
   * desync from disk and the subsequent action_needed flip can't undo it.
   *
   * Contract:
   *   1) read raw ws (must be slack/oauth)
   *   2) build a *new* slackOAuth object using mergeFn(currentSlackOAuth)
   *   3) build a snapshot of `this.config` with that object swapped in
   *   4) write the snapshot to tmp + atomic rename via _save (clone path)
   *   5) on success, swap this.config = snapshot, re-create provider
   *   6) on failure, throw — this.config and provider are untouched
   *
   * The snapshot is a structuredClone of this.config so concurrent mutations
   * to other workspaces during the disk write don't bleed into the swap.
   * (Phase 11 _save uses _writeLock to serialize disk I/O, so by the time
   * we write our snapshot it represents a coherent moment-in-time view of
   * other workspaces; the lock is FIFO so a concurrent updateWorkspace will
   * sequence after us.)
   */
  async updateSlackOAuthAtomic(workspaceId, mergeFn) {
    const idx = this.config.workspaces.findIndex(w => w.id === workspaceId);
    if (idx === -1) throw new Error(`Workspace '${workspaceId}' not found`);
    const ws = this.config.workspaces[idx];
    if (ws.provider !== 'slack' || ws.authMode !== 'oauth') {
      throw new Error(`Workspace '${workspaceId}' is not a Slack OAuth workspace`);
    }
    if (typeof mergeFn !== 'function') throw new Error('mergeFn must be a function');
    const nextSlackOAuth = mergeFn(ws.slackOAuth ? structuredClone(ws.slackOAuth) : null);
    if (!nextSlackOAuth) throw new Error('mergeFn must return the next slackOAuth payload');

    // Phase 12-3 (Codex R3 BLOCKER): build a snapshot for the disk write
    // ONLY — never publish via wholesale this.config replacement.
    // Replacement would discard any concurrent updateWorkspace mutation
    // (e.g. displayName change) that happened during the async save
    // window. Instead, after the disk write succeeds, mutate just the
    // slackOAuth field in place. _writeLock serializes disk I/O, so a
    // queued _save from updateWorkspace will sequence after us and
    // re-write disk with the merged state.
    const snapshot = structuredClone(this.config);
    snapshot.workspaces[idx].slackOAuth = nextSlackOAuth;

    await this._saveSnapshot(snapshot);

    // Disk write succeeded — commit the slackOAuth field IN PLACE so
    // concurrent mutations to other fields (displayName, enabled, etc.)
    // are preserved. structuredClone the next payload so callers can't
    // hold a reference and mutate our internal state through aliasing.
    this.config.workspaces[idx].slackOAuth = structuredClone(nextSlackOAuth);

    // Re-create provider — capability cache (etc.) should refresh on
    // rotation. _createProvider is sync apart from internal warm-up
    // calls that handle their own errors.
    this._createProvider(this.config.workspaces[idx]);
    return this.config.workspaces[idx];
  }

  async setSlackApp({ clientId, clientSecret, tokenRotationEnabled }) {
    // Phase 12-1 (Codex R1 REVISE): validate at the storage boundary so any
    // caller (admin route, migration script, test) is held to the same Slack
    // App format check as the public POST /api/slack/app endpoint.
    const v = validateSlackAppPayload({ clientId, clientSecret, tokenRotationEnabled });
    if (!v.valid) {
      const err = new Error(`slackApp payload invalid: ${v.errors.join('; ')}`);
      err.code = 'SLACK_APP_INVALID';
      err.errors = v.errors;
      throw err;
    }
    const now = new Date().toISOString();
    const prev = this.config.slackApp || null;
    this.config.slackApp = {
      clientId,
      clientSecret,
      tokenRotationEnabled: tokenRotationEnabled !== false,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    await this._save();
    this.logAudit('slack.app_credential_set', null, JSON.stringify({
      clientIdMasked: clientId.length > 8 ? `${clientId.slice(0, 4)}***${clientId.slice(-4)}` : '***',
      hadPrevious: !!prev,
      tokenRotationEnabled: this.config.slackApp.tokenRotationEnabled,
    }));
    this._notifyChange();
    return this.getSlackApp();
  }

  async deleteSlackApp({ force = false } = {}) {
    const slackOAuthDeps = this.config.workspaces.filter(
      w => w.provider === 'slack' && w.authMode === 'oauth' && !w.deletedAt
    );
    if (slackOAuthDeps.length > 0 && !force) {
      const err = new Error(`slackApp delete refused: ${slackOAuthDeps.length} OAuth workspace(s) depend on it. Pass force=true to override.`);
      err.code = 'SLACK_APP_HAS_DEPENDENTS';
      err.dependentCount = slackOAuthDeps.length;
      throw err;
    }
    delete this.config.slackApp;
    if (force) {
      // Force delete — flip dependent workspaces to action_needed so the user
      // knows to re-authorize after registering a new App credential.
      for (const ws of slackOAuthDeps) {
        if (!ws.slackOAuth) continue;
        ws.slackOAuth.status = 'action_needed';
      }
    }
    await this._save();
    this.logAudit(
      force ? 'slack.app_credential_deleted_force' : 'slack.app_credential_deleted',
      null,
      JSON.stringify({ dependentsTouched: force ? slackOAuthDeps.length : 0 })
    );
    this._notifyChange();
    return { deleted: true, dependentsTouched: force ? slackOAuthDeps.length : 0 };
  }

  getRawWorkspace(id) {
    return this.config.workspaces.find(w => w.id === id);
  }

  // Alias for backward compat (internal callers)
  _getRawWorkspace(id) {
    return this.getRawWorkspace(id);
  }

  async addWorkspace(data) {
    const kind = data.kind || 'native';
    // provider field = native provider name OR mcp-client canonical id
    const provider = data.provider || (kind === 'mcp-client' ? (data.transport || 'mcp') : 'unknown');

    let alias = data.alias || aliasFromDisplayName(data.displayName || '');
    // Phase 10a §4.10a-1 (Codex R1): reserve `__global__` so it cannot collide
    // with the legacy DCR cache bucket used for 2-arg back-compat callers.
    if (alias === '__global__') throw new Error(`alias "__global__" is reserved`);
    const existing = this.config.workspaces.map(w => w.alias);
    let candidate = alias;
    let counter = 1;
    while (existing.includes(candidate)) {
      candidate = `${alias}-${++counter}`;
    }
    alias = candidate;

    const namespace = alias;
    const id = data.id || generateId(provider, namespace);

    // Phase 10a §4.10a-1 (Codex R1): reserve `__global__` for the legacy DCR
    // cache bucket. A workspace with id="__global__" would otherwise collide
    // with `_cacheKey()`'s reserved sentinel and break isolation.
    if (id === '__global__') {
      throw new Error(`Workspace ID "__global__" is reserved`);
    }
    if (this.config.workspaces.some(w => w.id === id)) {
      throw new Error(`Workspace ID '${id}' already exists`);
    }

    const ws = {
      id,
      kind,
      provider,
      namespace,
      alias,
      displayName: data.displayName || alias,
      enabled: data.enabled !== false,
      toolFilter: data.toolFilter || { mode: 'all', enabled: [] },
    };

    if (kind === 'native') {
      ws.credentials = data.credentials || {};
      // Phase 12-1 (Codex R1 BLOCKER): persist authMode + slackOAuth for OAuth-mode
      // Slack workspaces. Without this, a valid OAuth payload (validated upstream
      // by validateWorkspacePayload) silently drops to token mode + loses tokens.
      if (data.authMode) ws.authMode = data.authMode;
      if (data.slackOAuth) ws.slackOAuth = data.slackOAuth;
    } else if (kind === 'mcp-client') {
      ws.transport = data.transport;
      if (data.transport === 'stdio') {
        ws.command = data.command;
        ws.args = data.args || [];
        ws.env = data.env || {};
      } else if (data.transport === 'http' || data.transport === 'sse') {
        ws.url = data.url;
        ws.headers = data.headers || {};
        if (data.oauth && typeof data.oauth === 'object') {
          // Phase 11 §3 — write nested ws.oauth.client from the start. If the
          // caller still passes legacy flat clientId/authMethod/etc., promote
          // those into client.* here (no persistent flat mirror).
          const hasClientInput = !!(data.oauth.client?.clientId || data.oauth.clientId);
          ws.oauth = {
            enabled: !!data.oauth.enabled,
            issuer: data.oauth.issuer || null,
            resource: data.oauth.resource || null,
            metadataCache: data.oauth.metadataCache || null,
            tokens: null,
          };
          if (hasClientInput) {
            const src = data.oauth.client || {};
            ws.oauth.client = {
              clientId: src.clientId ?? data.oauth.clientId ?? null,
              clientSecret: src.clientSecret ?? data.oauth.clientSecret ?? null,
              authMethod: src.authMethod ?? data.oauth.authMethod ?? 'none',
              source: src.source || 'manual',
              registeredAt: src.registeredAt || new Date().toISOString(),
            };
          }
        }
      }
    }

    this.config.workspaces.push(ws);
    this._createProvider(ws);
    await this._save();
    this.logAudit('add', ws.id, `Added ${kind}/${provider} workspace "${ws.displayName}"`);
    this._notifyChange();
    return ws;
  }

  async updateWorkspace(id, data) {
    const idx = this.config.workspaces.findIndex(w => w.id === id);
    if (idx === -1) throw new Error(`Workspace '${id}' not found`);

    const ws = this.config.workspaces[idx];

    // namespace is immutable
    if (data.namespace && data.namespace !== ws.namespace) {
      throw new Error('namespace is immutable and cannot be changed');
    }

    if (data.displayName !== undefined) ws.displayName = data.displayName;
    if (data.alias !== undefined) ws.alias = data.alias;
    if (data.enabled !== undefined) ws.enabled = data.enabled;
    if (data.toolFilter !== undefined) ws.toolFilter = data.toolFilter;

    // Credentials: only update if provided and non-empty (native kind)
    if (data.credentials && ws.credentials) {
      for (const [key, value] of Object.entries(data.credentials)) {
        if (value && !value.includes('***')) {
          ws.credentials[key] = value;
        }
      }
    }

    // Phase 12-1 (Codex R1 BLOCKER): allow updateWorkspace to flip authMode and
    // refresh slackOAuth for Slack OAuth workspaces. Skipping any field that
    // looks masked so a round-trip GET → PUT can't replay token prefixes.
    if (data.authMode !== undefined) ws.authMode = data.authMode;
    if (data.slackOAuth !== undefined) {
      const t = data.slackOAuth?.tokens;
      const looksMasked = t && (
        (typeof t.accessToken === 'string' && t.accessToken.endsWith('...')) ||
        (typeof t.refreshToken === 'string' && t.refreshToken.endsWith('...'))
      );
      if (!looksMasked) ws.slackOAuth = data.slackOAuth;
    }

    // MCP-client fields (mutable except transport)
    if (ws.kind === 'mcp-client') {
      if (ws.transport === 'stdio') {
        if (data.command !== undefined) ws.command = data.command;
        if (data.args !== undefined) ws.args = data.args;
        if (data.env !== undefined) {
          // Skip masked values
          const mergedEnv = { ...ws.env };
          for (const [k, v] of Object.entries(data.env)) {
            if (v && !String(v).includes('***')) mergedEnv[k] = v;
          }
          ws.env = mergedEnv;
        }
      } else if (ws.transport === 'http' || ws.transport === 'sse') {
        if (data.url !== undefined) ws.url = data.url;
        if (data.headers !== undefined) {
          const mergedHeaders = { ...ws.headers };
          for (const [k, v] of Object.entries(data.headers)) {
            if (v && !String(v).includes('***')) mergedHeaders[k] = v;
          }
          ws.headers = mergedHeaders;
        }
      }
    }

    this._createProvider(ws); // re-create provider with updated config
    await this._save();
    this.logAudit('update', ws.id, `Updated workspace "${ws.displayName}"`);
    this._notifyChange();
    return ws;
  }

  async deleteWorkspace(id, { hard = false } = {}) {
    const idx = this.config.workspaces.findIndex(w => w.id === id);
    if (idx === -1) throw new Error(`Workspace '${id}' not found`);
    const ws = this.config.workspaces[idx];

    if (hard) {
      this.config.workspaces.splice(idx, 1);
      // Phase 10a §4.10a-1 — hard delete purges DCR cache immediately.
      // Soft delete keeps the cache (Option Y) so restore within 30 days
      // doesn't require re-authorization.
      if (this._oauth?.removeClient) {
        try { await this._oauth.removeClient(id); } catch { /* best-effort */ }
      }
    } else {
      // Soft delete — mark as deleted, keep for 30 days
      ws.deletedAt = new Date().toISOString();
      ws.enabled = false;
    }

    this.providers.delete(id);
    this.healthCache.delete(id);
    this.capabilityCache.delete(id);
    await this._save();
    this.logAudit('delete', id, `${hard ? 'Hard' : 'Soft'} deleted workspace "${ws.displayName}"`);
    this._notifyChange();
  }

  async restoreWorkspace(id) {
    const ws = this.config.workspaces.find(w => w.id === id);
    if (!ws) throw new Error(`Workspace '${id}' not found`);
    if (!ws.deletedAt) throw new Error(`Workspace '${id}' is not deleted`);
    delete ws.deletedAt;
    ws.enabled = true;
    this._createProvider(ws);
    await this._save();
    this.logAudit('restore', id, `Restored workspace "${ws.displayName}"`);
    this._notifyChange();
    return ws;
  }

  getDeletedWorkspaces() {
    // Phase 12-1 (Codex R1 BLOCKER): pipe through _maskSecrets so soft-deleted
    // Slack OAuth workspaces don't leak raw tokens via /api/workspaces/deleted.
    // The original (R8) credentials-only mask predates ws.slackOAuth and ws.oauth
    // nested tokens — both must be redacted on this surface too.
    return this.config.workspaces
      .filter(w => w.deletedAt)
      .map(ws => {
        const result = { ...ws };
        this._maskSecrets(result, ws);
        return result;
      });
  }

  async purgeExpiredWorkspaces({ now = Date.now() } = {}) {
    const thirtyDaysAgoMs = now - 30 * 24 * 60 * 60 * 1000;
    const expired = this.config.workspaces.filter(w => w.deletedAt && new Date(w.deletedAt).getTime() < thirtyDaysAgoMs);
    for (const ws of expired) {
      const idx = this.config.workspaces.indexOf(ws);
      if (idx !== -1) {
        this.config.workspaces.splice(idx, 1);
        this.logAudit('purge', ws.id, `Purged expired workspace "${ws.displayName}"`);
        // Phase 10a §4.10a-1 Option Y — cache purge happens at actual deletion
        // (expire), not at soft-delete time, so restore within 30 days is seamless.
        if (this._oauth?.removeClient) {
          try { await this._oauth.removeClient(ws.id); } catch { /* best-effort */ }
        }
      }
    }
    if (expired.length > 0) await this._save();
    return expired.length;
  }

  async testConnection(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`No provider for workspace '${id}'`);
    const health = await provider.healthCheck();
    this.healthCache.set(id, { ...health, checkedAt: new Date().toISOString() });
    // Also run capabilityCheck
    try {
      const cap = await provider.capabilityCheck();
      this.capabilityCache.set(id, { ...cap, checkedAt: new Date().toISOString() });
    } catch { /* capability check is best-effort */ }
    return health;
  }

  async testAll() {
    const results = {};
    for (const [id, provider] of this.providers) {
      try {
        const health = await provider.healthCheck();
        this.healthCache.set(id, { ...health, checkedAt: new Date().toISOString() });
        results[id] = health;
        // Also run capabilityCheck
        try {
          const cap = await provider.capabilityCheck();
          this.capabilityCache.set(id, { ...cap, checkedAt: new Date().toISOString() });
        } catch { /* best-effort */ }
      } catch (err) {
        const health = { ok: false, message: err.message, checkedAt: new Date().toISOString() };
        this.healthCache.set(id, health);
        results[id] = health;
      }
    }
    return results;
  }

  getCapability(id) {
    return this.capabilityCache.get(id) || null;
  }

  getProvider(id) {
    return this.providers.get(id);
  }

  getEnabledWorkspaces() {
    return this.config.workspaces.filter(w => w.enabled && !w.deletedAt);
  }

  getServerConfig() {
    return this.config.server || { port: 3100 };
  }

  getAdminToken() {
    return process.env.BIFROST_ADMIN_TOKEN || this.config.server?.adminToken;
  }

  getMcpToken() {
    return process.env.BIFROST_MCP_TOKEN || null;
  }

  _computeStatus(ws, health) {
    if (!ws.enabled) return 'disabled';
    // Phase 7c-pre: per-identity action_needed map supersedes single bool.
    // Any identity flagged → action_needed.
    const byId = ws.oauthActionNeededBy || {};
    if (Object.values(byId).some(Boolean)) return 'action_needed';
    if (ws.oauthActionNeeded) return 'action_needed';
    if (!health) return 'unknown';
    if (!health.ok) return 'error';

    // Check for action_needed: token expiry within 7 days, scope mismatch
    const cap = this.capabilityCache.get(ws.id);
    if (health.tokenExpiresAt) {
      const daysUntilExpiry = (new Date(health.tokenExpiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilExpiry <= 7) return 'action_needed';
    }
    if (cap?.scopeMismatch) return 'action_needed';

    // Check capability for limited
    if (cap?.tools) {
      const hasUnavailable = cap.tools.some(t => t.usable === 'unavailable');
      const hasLimited = cap.tools.some(t => t.usable === 'limited');
      if (hasUnavailable || hasLimited) return 'limited';
    }

    return 'healthy';
  }

  _startFileWatcher() {
    // Phase 11-9 (post-OSS-publish) — watch the PARENT DIRECTORY rather
    // than the config file itself. fs.watch on the file is bound to the
    // file's inode on Linux/macOS; an atomic rename (tmp + rename, used
    // by editors AND our own `_save()`) flips the inode and the file
    // watcher is forever stale. fs.watch on the parent directory tracks
    // the directory's own inode, which doesn't change when contents are
    // rewritten — a single watcher survives any number of atomic
    // replaces. We filter events by basename and debounce so the typical
    // unlink+create burst yields one reload, not two.
    //
    // Codex consultation referenced:
    //   - https://nodejs.org/api/fs.html#inodes  (fs.watch caveats)
    //   - chokidar normalises this but adds a runtime dependency
    //     unnecessary for a single-file watch.
    if (this._stopped) return;
    if (!existsSync(this._configDir)) return;
    let watcher;
    try {
      watcher = watch(this._configDir, { persistent: false });
    } catch { /* fs.watch not supported on this platform */
      return;
    }
    this._watcher = watcher;
    const target = basename(this._configPath);
    const DEBOUNCE_MS = 50;
    (async () => {
      for await (const event of watcher) {
        if (this._stopped) break;
        if (event.eventType !== 'change' && event.eventType !== 'rename') continue;
        // event.filename can be null on some Linux variants; fall through
        // and reload conservatively in that case.
        if (event.filename && event.filename !== target) continue;
        // Skip self-save burst — both the tmp write and the rename
        // surface here as parent-directory events.
        if (this._saving) continue;
        // Coalesce the unlink+create pair (or any rapid burst) into one
        // reload. Reset the timer on every event so we always read the
        // LATEST disk state.
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => {
          this._reloadTimer = null;
          if (this._stopped) return;
          this._reloadConfigFromDisk().catch(() => { /* logged inside */ });
        }, DEBOUNCE_MS);
      }
    })().catch(() => { /* watcher closed during stop() */ });
  }

  async _reloadConfigFromDisk() {
    if (this._stopped) return;
    if (!existsSync(this._configPath)) return; // file removed; nothing to do
    if (this._saving) return;
    try {
      const raw = await readFile(this._configPath, 'utf-8');
      // Phase 11-9 (Codex R1 blocker) — re-check `_stopped` after every
      // await yield so a concurrent `close()` can stop us cleanly
      // without the rest of the reload (config mutation, _save,
      // notifyChange) leaking through.
      if (this._stopped) return;
      const newConfig = JSON.parse(raw);
      // Phase 11-9 — equality short-circuit. If disk state equals our
      // in-memory state, this event is almost certainly our own
      // self-save bouncing back through the parent-dir watcher (the
      // `_saving` guard window is wider than the 50ms debounce, but
      // race timing can occasionally let a stale event through after
      // `_saving` has been cleared). Skip the reload so callers don't
      // see a spurious onWorkspaceChange notification.
      try {
        if (JSON.stringify(newConfig) === JSON.stringify(this.config)) return;
      } catch { /* fall through to full reload */ }
      this.config = newConfig;
      if (!this.config.workspaces) this.config.workspaces = [];
      // Phase 11 §3 — apply legacy→nested migration on hot-reload too.
      // Without this, an externally-edited config carrying flat
      // ws.oauth.{clientId,clientSecret,authMethod} would bypass the
      // Phase 11 scrub and reach runtime unnormalized — causing
      // mis-resolved client fields (reads are nested-only now) and
      // leaking flat clientSecret through masked admin views (maskOAuth
      // no longer masks flat fields).
      const mutated = this._migrateLegacy();
      await this._initProviders();
      if (this._stopped) return;
      if (mutated) {
        // Persist the scrubbed form so disk converges on single source.
        // Codex Phase 11-3 R2: log failures so operators notice. The
        // parent-dir watcher stays alive across this self-rename and
        // the `_saving` guard ensures we don't reload our own write.
        this._save().catch((err) => {
          logger.warn(`[WorkspaceManager] Phase 11 §3: hot-reload migration could not persist scrubbed config: ${err?.message || err}`);
        });
      }
      this._notifyChange();
      logger.info('[WorkspaceManager] Config hot-reloaded');
    } catch { /* ignore parse errors during write */ }
  }

  /**
   * Phase 11-9 (post-OSS-publish) — graceful watcher lifecycle. Called by
   * `server/index.js stop()` so the file watcher and any pending reload
   * timer don't survive past process shutdown. One-off scripts and
   * non-server tests don't need to call this.
   */
  async close() {
    this._stopped = true;
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
    try { this._watcher?.close(); } catch { /* already closed */ }
    this._watcher = null;
  }

  onWorkspaceChange(callback) {
    this._onChange = callback;
  }

  _notifyChange() {
    if (this._onChange) this._onChange();
  }

  logError(category, workspace, message) {
    this.errorLog.unshift({
      timestamp: new Date().toISOString(),
      category,
      workspace,
      message: sanitize(message),
    });
    if (this.errorLog.length > 50) this.errorLog.length = 50;
  }

  /**
   * Audit log entry. `identity` is optional (added in Phase 7g); callers that
   * predate it can continue passing the old 3-arg form (identity defaults to
   * null). Pass a 4th positional argument — e.g. `logAudit(action, ws, details,
   * 'bot_ci')` — to scope the entry to a specific identity, which enables
   * `/api/audit?identity=…` filtering in Phase 7g.
   */
  logAudit(action, workspace, details, identity = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      workspace,
      identity,
      details: sanitize(details),
    };
    if (typeof action === 'string' && action.startsWith('oauth.')) {
      this.oauthAuditLog.unshift(entry);
      if (this.oauthAuditLog.length > 50) this.oauthAuditLog.length = 50;
    } else {
      this.auditLog.unshift(entry);
      if (this.auditLog.length > 50) this.auditLog.length = 50;
    }
    // Phase 7g: mirror to audit.jsonl when the file-based logger is attached.
    if (this._audit?.record) {
      this._audit.record({ action, identity, workspace, details });
    }
  }

  getDiagnostics() {
    const workspaces = this.getWorkspaces();
    return {
      workspaces: workspaces.map(ws => ({
        id: ws.id,
        provider: ws.provider,
        displayName: ws.displayName,
        status: ws.status,
        lastHealth: this.healthCache.get(ws.id) || null,
        lastCapability: this.capabilityCache.get(ws.id) || null,
      })),
      errorLog: this.errorLog,
      auditLog: this.auditLog,
      oauthAuditLog: this.oauthAuditLog,
      fileSecurityWarning: this.fileSecurityWarning,
    };
  }
}
