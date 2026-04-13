import { readFile, writeFile, rename, copyFile, watch } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotionProvider } from '../providers/notion.js';
import { SlackProvider } from '../providers/slack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const CONFIG_PATH = join(CONFIG_DIR, 'workspaces.json');
const BACKUP_PATH = join(CONFIG_DIR, 'workspaces.backup.json');
const TMP_PATH = join(CONFIG_DIR, 'workspaces.tmp.json');

const PROVIDERS = { notion: NotionProvider, slack: SlackProvider };

function generateId(provider, alias) {
  return `${provider}-${alias}`;
}

function aliasFromDisplayName(displayName) {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'workspace';
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
  }

  async load() {
    if (!existsSync(CONFIG_PATH)) {
      await this._save();
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
    this._loaded = true;
    await this._initProviders();
  }

  async _initProviders() {
    this.providers.clear();
    for (const ws of this.config.workspaces) {
      this._createProvider(ws);
    }
  }

  _createProvider(ws) {
    const ProviderClass = PROVIDERS[ws.provider];
    if (ProviderClass) {
      this.providers.set(ws.id, new ProviderClass(ws));
    }
  }

  async _save() {
    if (!this._loaded) return; // skip disk I/O if not loaded from file
    this._writeLock = this._writeLock.then(async () => {
      if (existsSync(CONFIG_PATH)) {
        await copyFile(CONFIG_PATH, BACKUP_PATH);
      }
      await writeFile(TMP_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
      await rename(TMP_PATH, CONFIG_PATH);
    });
    return this._writeLock;
  }

  getWorkspaces({ masked = true, includeDeleted = false } = {}) {
    return this.config.workspaces.filter(w => includeDeleted || !w.deletedAt).map(ws => {
      const health = this.healthCache.get(ws.id);
      const result = { ...ws, status: this._computeStatus(ws, health) };
      if (masked) {
        result.credentials = maskCredentials(ws.credentials || {});
      }
      return result;
    });
  }

  getWorkspace(id, { masked = true } = {}) {
    const ws = this.config.workspaces.find(w => w.id === id);
    if (!ws) return null;
    const health = this.healthCache.get(ws.id);
    const result = { ...ws, status: this._computeStatus(ws, health) };
    if (masked) {
      result.credentials = maskCredentials(ws.credentials || {});
    }
    return result;
  }

  _getRawWorkspace(id) {
    return this.config.workspaces.find(w => w.id === id);
  }

  async addWorkspace(data) {
    let alias = data.alias || aliasFromDisplayName(data.displayName || '');
    // Deduplicate alias
    const existing = this.config.workspaces.map(w => w.alias);
    let candidate = alias;
    let counter = 1;
    while (existing.includes(candidate)) {
      candidate = `${alias}-${++counter}`;
    }
    alias = candidate;

    const namespace = alias; // namespace = alias at creation time, immutable
    const id = data.id || generateId(data.provider, namespace);

    // Check id uniqueness
    if (this.config.workspaces.some(w => w.id === id)) {
      throw new Error(`Workspace ID '${id}' already exists`);
    }

    const ws = {
      id,
      provider: data.provider,
      namespace,
      alias,
      displayName: data.displayName || alias,
      credentials: data.credentials || {},
      enabled: data.enabled !== false,
      toolFilter: data.toolFilter || { mode: 'all', enabled: [] },
    };

    this.config.workspaces.push(ws);
    this._createProvider(ws);
    await this._save();
    this.logAudit('add', ws.id, `Added ${ws.provider} workspace "${ws.displayName}"`);
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

    // Credentials: only update if provided and non-empty
    if (data.credentials) {
      for (const [key, value] of Object.entries(data.credentials)) {
        if (value && !value.includes('***')) {
          ws.credentials[key] = value;
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
    if (!health) return 'unknown';
    if (!health.ok) return 'error';

    // Check capability for limited/action_needed
    const cap = this.capabilityCache.get(ws.id);
    if (cap?.tools) {
      const hasUnavailable = cap.tools.some(t => t.usable === 'unavailable');
      const hasLimited = cap.tools.some(t => t.usable === 'limited');
      if (hasUnavailable || hasLimited) return 'limited';
    }

    return 'healthy';
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
      message,
    });
    if (this.errorLog.length > 50) this.errorLog.length = 50;
  }

  logAudit(action, workspace, details) {
    this.auditLog.unshift({
      timestamp: new Date().toISOString(),
      action,
      workspace,
      details,
    });
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
    };
  }
}
