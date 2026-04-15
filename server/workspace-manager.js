import { readFile, writeFile, rename, copyFile, watch, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotionProvider } from '../providers/notion.js';
import { SlackProvider } from '../providers/slack.js';
import { McpClientProvider } from '../providers/mcp-client.js';
import { sanitize } from './oauth-sanitize.js';

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
  if (oauth.clientId && typeof oauth.clientId === 'string' && oauth.clientId.length > 8) {
    masked.clientId = `${oauth.clientId.slice(0, 4)}***${oauth.clientId.slice(-4)}`;
  }
  if (oauth.clientSecret) masked.clientSecret = '***';
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

export class WorkspaceManager {
  constructor() {
    this.config = { workspaces: [], server: { port: 3100 }, tunnel: { enabled: false, fixedDomain: '' } };
    this.providers = new Map();
    this.healthCache = new Map();
    this.capabilityCache = new Map();
    this._writeLock = Promise.resolve();
    this._onChange = null;
    this._loaded = false; // only save to disk after explicit load()
    this.errorLog = []; // last 50 errors
    this.auditLog = []; // last 10 config changes
    this.oauthAuditLog = []; // separate ring (50) for oauth.* events
    this.fileSecurityWarning = process.platform === 'win32';
  }

  async load() {
    if (!existsSync(CONFIG_PATH)) {
      this._loaded = true;
      await this._save();
      this._startFileWatcher();
      return;
    }
    try {
      const raw = await readFile(CONFIG_PATH, 'utf-8');
      this.config = JSON.parse(raw);
    } catch {
      if (existsSync(BACKUP_PATH)) {
        const backup = await readFile(BACKUP_PATH, 'utf-8');
        this.config = JSON.parse(backup);
        console.error('[WorkspaceManager] Loaded from backup');
      } else {
        console.error('[WorkspaceManager] No valid config found, using defaults');
      }
    }
    if (!this.config.workspaces) this.config.workspaces = [];
    this._migrateLegacy();
    this._loaded = true;
    await this._initProviders();
    this._startFileWatcher();
  }

  _migrateLegacy() {
    // Legacy entries without `kind` → assume native (Notion/Slack REST wrapper)
    let migrated = 0;
    let oauthMirrored = 0;
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
    }
    if (migrated > 0) {
      console.log(`[WorkspaceManager] Migrated ${migrated} legacy workspace(s) to kind=native`);
    }
    if (oauthMirrored > 0) {
      console.log(`[WorkspaceManager] Phase 7c-pre: mirrored ${oauthMirrored} OAuth tokens to byIdentity.default`);
    }
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
    if (!this._loaded) return; // skip disk I/O if not loaded from file
    this._writeLock = this._writeLock.then(async () => {
      if (existsSync(CONFIG_PATH)) {
        await copyFile(CONFIG_PATH, BACKUP_PATH);
        await this._chmod0600(BACKUP_PATH);
      }
      await writeFile(TMP_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
      await this._chmod0600(TMP_PATH);
      await rename(TMP_PATH, CONFIG_PATH);
      await this._chmod0600(CONFIG_PATH);
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
  }

  _getRawWorkspace(id) {
    return this.config.workspaces.find(w => w.id === id);
  }

  async addWorkspace(data) {
    const kind = data.kind || 'native';
    // provider field = native provider name OR mcp-client canonical id
    const provider = data.provider || (kind === 'mcp-client' ? (data.transport || 'mcp') : 'unknown');

    let alias = data.alias || aliasFromDisplayName(data.displayName || '');
    const existing = this.config.workspaces.map(w => w.alias);
    let candidate = alias;
    let counter = 1;
    while (existing.includes(candidate)) {
      candidate = `${alias}-${++counter}`;
    }
    alias = candidate;

    const namespace = alias;
    const id = data.id || generateId(provider, namespace);

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
          ws.oauth = {
            enabled: !!data.oauth.enabled,
            issuer: data.oauth.issuer || null,
            clientId: data.oauth.clientId || null,
            clientSecret: data.oauth.clientSecret || null,
            authMethod: data.oauth.authMethod || 'none',
            resource: data.oauth.resource || null,
            metadataCache: data.oauth.metadataCache || null,
            tokens: null,
          };
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
    return this.config.workspaces
      .filter(w => w.deletedAt)
      .map(ws => ({ ...ws, credentials: maskCredentials(ws.credentials || {}) }));
  }

  async purgeExpiredWorkspaces() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const expired = this.config.workspaces.filter(w => w.deletedAt && w.deletedAt < thirtyDaysAgo);
    for (const ws of expired) {
      const idx = this.config.workspaces.indexOf(ws);
      if (idx !== -1) {
        this.config.workspaces.splice(idx, 1);
        this.logAudit('purge', ws.id, `Purged expired workspace "${ws.displayName}"`);
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
    if (!existsSync(CONFIG_PATH)) return;
    try {
      const watcher = watch(CONFIG_PATH, { persistent: false });
      (async () => {
        for await (const event of watcher) {
          if (event.eventType === 'change') {
            try {
              const raw = await readFile(CONFIG_PATH, 'utf-8');
              const newConfig = JSON.parse(raw);
              this.config = newConfig;
              if (!this.config.workspaces) this.config.workspaces = [];
              await this._initProviders();
              this._notifyChange();
              console.log('[WorkspaceManager] Config hot-reloaded');
            } catch { /* ignore parse errors during write */ }
          }
        }
      })().catch(() => {}); // watcher closed
    } catch { /* fs.watch not supported or file gone */ }
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

  logAudit(action, workspace, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      workspace,
      details: sanitize(details),
    };
    if (typeof action === 'string' && action.startsWith('oauth.')) {
      this.oauthAuditLog.unshift(entry);
      if (this.oauthAuditLog.length > 50) this.oauthAuditLog.length = 50;
      return;
    }
    this.auditLog.unshift(entry);
    if (this.auditLog.length > 10) this.auditLog.length = 10;
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
