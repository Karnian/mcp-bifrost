/**
 * OAuth 2.0 manager for remote MCP servers (MCP spec 2025-06-18).
 *
 * Responsibilities:
 *   - Discover Resource Metadata (RFC 9728) + Authorization Server Metadata (RFC 8414)
 *   - Dynamic Client Registration (RFC 7591) with issuer-level client caching
 *   - PKCE S256 + HMAC-signed state + persisted pending store
 *   - Access token lifecycle: inject, refresh (with per-workspace mutex + rotation)
 *   - Audit events via WorkspaceManager.logAudit
 *
 * Security notes:
 *   - Issuer cache, pending store, and server secret files are chmod 0o600 on
 *     POSIX. On Windows chmod is skipped and `fileSecurityWarning` is emitted
 *     so the Admin UI can surface it.
 *   - Token values are never logged; sanitize() scrubs accidental inclusion.
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitize, tokenPrefix } from './oauth-sanitize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', '.ao', 'state');
const ISSUER_CACHE_PATH = join(STATE_DIR, 'oauth-issuer-cache.json');
const PENDING_PATH = join(STATE_DIR, 'oauth-pending.json');
const SERVER_SECRET_PATH = join(STATE_DIR, 'server-secret');

const DEFAULT_REDIRECT_PORT = 3100;
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_LEEWAY_MS = 60_000;

const BIFROST_CLIENT_NAME = 'MCP Bifrost';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Phase 10a §6-OBS.1 — mask a client_id for audit log storage.
 * Format: `${first4}***${last4}`. Never store raw clientId in audit.jsonl
 * because the file may be backed up / exported. Preserves enough prefix to
 * disambiguate workspace clients during incident response.
 */
export function maskClientId(clientId) {
  if (!clientId || typeof clientId !== 'string') return null;
  if (clientId.length <= 8) return '***';
  return `${clientId.slice(0, 4)}***${clientId.slice(-4)}`;
}

function parseRetryAfterMs(header) {
  if (!header) return null;
  const s = String(header).trim();
  // Numeric delta-seconds
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  // HTTP-date — parse and diff vs now
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

function isWindows(platform = process.platform) {
  return platform === 'win32';
}

async function chmod0600(path, { platform = process.platform } = {}) {
  if (isWindows(platform)) return { applied: false, warning: 'windows-skip' };
  try {
    await chmod(path, 0o600);
    return { applied: true };
  } catch (err) {
    return { applied: false, warning: err.message };
  }
}

async function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
  }
}

async function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonSecure(path, data, opts) {
  await ensureStateDir();
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
  return chmod0600(path, opts);
}

export class OAuthManager {
  constructor(wm, { stateDir = STATE_DIR, platform = process.platform, fetchImpl = globalThis.fetch, redirectPort, refreshTimeoutMs = REFRESH_TIMEOUT_MS } = {}) {
    this.wm = wm;
    this.platform = platform;
    this.fetch = fetchImpl;
    this._redirectPort = redirectPort;
    this._refreshTimeoutMs = refreshTimeoutMs;
    this._issuerCachePath = join(stateDir, 'oauth-issuer-cache.json');
    this._pendingPath = join(stateDir, 'oauth-pending.json');
    this._secretPath = join(stateDir, 'server-secret');
    this._stateDir = stateDir;
    this._clientCache = null; // lazy — workspace-scoped DCR / manual client cache
    this._pending = null; // lazy
    this._serverSecret = null; // lazy
    // Phase 10a §6.4: FIFO chain mutex shared by markAuthFailed AND _refreshWithMutex.
    // Same Map so that markAuthFailed ↔ refresh are mutually exclusive. Key is
    // `${workspaceId}::${identity}` — identity-level parallelism preserved.
    this._identityMutex = new Map();
    // Phase 10a §4.10a-4: auth-fail threshold (401 count at which fail-fast trips).
    this._authFailThreshold = parseInt(process.env.BIFROST_AUTH_FAIL_THRESHOLD || '', 10) || 3;
    this._fileSecurityWarning = isWindows(platform); // true if any file couldn't be chmod'd
  }

  // ────────────────────────────────────────────────────────────────────────
  // Redirect URI

  getRedirectUri() {
    const port = this._redirectPort || this.wm?.getServerConfig?.().port || DEFAULT_REDIRECT_PORT;
    return `http://localhost:${port}/oauth/callback`;
  }

  getFileSecurityWarning() {
    return this._fileSecurityWarning;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Server secret (for HMAC state signing)

  async _getServerSecret() {
    if (this._serverSecret) return this._serverSecret;
    const existing = existsSync(this._secretPath) ? await readFile(this._secretPath, 'utf-8').catch(() => null) : null;
    if (existing && existing.length >= 32) {
      this._serverSecret = existing.trim();
      return this._serverSecret;
    }
    const secret = b64url(randomBytes(32));
    await ensureStateDir();
    await writeFile(this._secretPath, secret, 'utf-8');
    const { applied } = await chmod0600(this._secretPath, { platform: this.platform });
    if (!applied) this._fileSecurityWarning = true;
    this._serverSecret = secret;
    return secret;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Discovery (RFC 9728 + RFC 8414)

  async discover(mcpUrl, { wwwAuthenticate } = {}) {
    const resourceUrl = new URL(mcpUrl);
    const candidates = [];

    // 1. Prefer resource_metadata from WWW-Authenticate when provided
    if (wwwAuthenticate) {
      const m = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate);
      if (m) candidates.push(m[1]);
    }

    // 2. Path-specific: /.well-known/oauth-protected-resource{path}
    const pathPart = resourceUrl.pathname === '/' ? '' : resourceUrl.pathname;
    if (pathPart) {
      candidates.push(`${resourceUrl.origin}/.well-known/oauth-protected-resource${pathPart}`);
    }
    // 3. Host root
    candidates.push(`${resourceUrl.origin}/.well-known/oauth-protected-resource`);

    let resourceMetadata = null;
    let usedResourceUrl = null;
    for (const url of candidates) {
      const res = await this.fetch(url).catch(() => null);
      if (res?.ok) {
        resourceMetadata = await res.json().catch(() => null);
        if (resourceMetadata) { usedResourceUrl = url; break; }
      }
    }
    if (!resourceMetadata) {
      throw new Error(`OAuth discovery: resource metadata not found (tried: ${candidates.join(', ')})`);
    }

    const authServers = resourceMetadata.authorization_servers;
    if (!Array.isArray(authServers) || authServers.length === 0) {
      throw new Error('OAuth discovery: resource metadata missing authorization_servers');
    }
    const issuer = authServers[0];

    // Auth server metadata — RFC 8414
    const asCandidates = [
      `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
      // OIDC fallback
      `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    ];
    let authServerMetadata = null;
    for (const url of asCandidates) {
      const res = await this.fetch(url).catch(() => null);
      if (res?.ok) {
        const json = await res.json().catch(() => null);
        if (json?.authorization_endpoint && json?.token_endpoint) {
          authServerMetadata = json;
          break;
        }
      }
    }
    if (!authServerMetadata) {
      throw new Error(`OAuth discovery: authorization server metadata not found for ${issuer}`);
    }

    return {
      resource: resourceMetadata.resource || resourceUrl.origin,
      resourceMetadata,
      resourceMetadataUrl: usedResourceUrl,
      issuer: authServerMetadata.issuer || issuer,
      authServerMetadata,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Client cache (Phase 10a — workspace-scoped DCR / manual client reuse)
  //
  // Key format: `${workspaceId}::${issuer}::${authMethod}`.
  // Legacy tests / callers that don't pass workspaceId land in the reserved
  // `__global__` bucket — equivalent to the Phase 6 issuer-level cache. The
  // production code paths (initializeAuthorization / registerManual /
  // admin/routes.js) all pass workspaceId so the production behavior is
  // strictly workspace-isolated.

  async _loadIssuerCache() {
    if (this._clientCache) return this._clientCache;
    this._clientCache = (await readJson(this._issuerCachePath)) || {};
    return this._clientCache;
  }

  async _saveIssuerCache() {
    const { applied } = await writeJsonSecure(this._issuerCachePath, this._clientCache, { platform: this.platform });
    if (!applied) this._fileSecurityWarning = true;
  }

  _cacheKey(arg1, arg2, arg3) {
    // Supports two call forms for back-compat:
    //   _cacheKey(issuer, authMethod)                   → legacy (global scope)
    //   _cacheKey(workspaceId, issuer, authMethod)      → Phase 10a scoped
    if (arg3 === undefined) {
      return `__global__::${arg1}::${arg2}`;
    }
    return `${arg1}::${arg2}::${arg3}`;
  }

  async getCachedClient(issuerOrWsId, authMethodOrIssuer, maybeAuthMethod) {
    const key = maybeAuthMethod === undefined
      ? this._cacheKey(issuerOrWsId, authMethodOrIssuer)
      : this._cacheKey(issuerOrWsId, authMethodOrIssuer, maybeAuthMethod);
    const cache = await this._loadIssuerCache();
    const entry = cache[key];
    if (!entry) return null;
    // TTL: expire cached entries after 24 hours
    const ttlMs = parseInt(process.env.BIFROST_OAUTH_CACHE_TTL_MS || '', 10) || 24 * 60 * 60 * 1000;
    if (entry.registeredAt && Date.now() - new Date(entry.registeredAt).getTime() > ttlMs) {
      delete cache[key];
      await this._saveIssuerCache();
      return null;
    }
    return entry;
  }

  async _storeCachedClient(issuerOrWsId, authMethodOrIssuer, entryOrAuthMethod, maybeEntry) {
    let key, entry;
    if (maybeEntry === undefined) {
      // Legacy 3-arg form: (issuer, authMethod, entry)
      key = this._cacheKey(issuerOrWsId, authMethodOrIssuer);
      entry = { ...entryOrAuthMethod, issuer: issuerOrWsId, authMethod: authMethodOrIssuer };
    } else {
      // Phase 10a 4-arg form: (workspaceId, issuer, authMethod, entry)
      key = this._cacheKey(issuerOrWsId, authMethodOrIssuer, entryOrAuthMethod);
      entry = { ...maybeEntry, workspaceId: issuerOrWsId, issuer: authMethodOrIssuer, authMethod: entryOrAuthMethod };
    }
    const cache = await this._loadIssuerCache();
    cache[key] = { ...entry, registeredAt: new Date().toISOString() };
    await this._saveIssuerCache();
  }

  /**
   * Phase 10a §4.10a-1: remove all cache entries bound to a workspace.
   * Called by WorkspaceManager.deleteWorkspace(hard=true) and
   * purgeExpiredWorkspaces().
   */
  async removeClient(workspaceId) {
    const cache = await this._loadIssuerCache();
    const prefix = `${workspaceId}::`;
    let removed = 0;
    for (const key of Object.keys(cache)) {
      if (key.startsWith(prefix)) {
        delete cache[key];
        removed++;
      }
    }
    if (removed > 0) {
      await this._saveIssuerCache();
      if (this.wm?.logAudit) {
        this.wm.logAudit('oauth.cache_purge', workspaceId, JSON.stringify({
          cause: 'delete',
          entriesRemoved: removed,
        }));
      }
    }
    return removed;
  }

  pickAuthMethod(authServerMetadata, { prefer = 'none' } = {}) {
    const methods = authServerMetadata.token_endpoint_auth_methods_supported || ['client_secret_basic'];
    if (methods.includes(prefer)) return prefer;
    if (methods.includes('none')) return 'none';
    if (methods.includes('client_secret_basic')) return 'client_secret_basic';
    return methods[0];
  }

  // ────────────────────────────────────────────────────────────────────────
  // Dynamic Client Registration (RFC 7591)
  //
  // Phase 10a §4.10a-1: `workspaceId` is optional for back-compat with Phase 6
  // tests but production callers (initializeAuthorization, admin/routes) MUST
  // supply it to get workspace-scoped cache isolation.
  // Phase 10a §4.10a-3: DCR errors are classified into three codes:
  //   DCR_RATE_LIMITED (429)   — honor Retry-After
  //   DCR_REJECTED     (4xx)   — do not retry, surface to admin
  //   DCR_TRANSIENT    (5xx)   — 3x retry with exponential backoff

  async registerClient(issuer, authServerMetadata, { workspaceId, authMethod, forceNew = false, reuse = true } = {}) {
    const method = authMethod || this.pickAuthMethod(authServerMetadata);

    if (reuse && !forceNew) {
      const cached = workspaceId
        ? await this.getCachedClient(workspaceId, issuer, method)
        : await this.getCachedClient(issuer, method);
      if (cached) return { ...cached, cached: true };
    }

    const endpoint = authServerMetadata.registration_endpoint;
    if (!endpoint) {
      const err = new Error('DCR_UNSUPPORTED: registration_endpoint missing');
      err.code = 'DCR_UNSUPPORTED';
      throw err;
    }

    const body = {
      client_name: BIFROST_CLIENT_NAME,
      redirect_uris: [this.getRedirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    };

    // Phase 10a §4.10a-3: retry-and-classify loop.
    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await this.fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (netErr) {
        // Network failure → transient, retry with backoff
        lastErr = Object.assign(new Error(`DCR_TRANSIENT: network error — ${netErr.message}`), {
          code: 'DCR_TRANSIENT',
          cause: netErr,
        });
        if (attempt < maxAttempts) {
          await this._sleep(this._dcrBackoffMs(attempt));
          continue;
        }
        break;
      }
      if (res.ok) {
        const json = await res.json();
        const entry = {
          clientId: json.client_id,
          clientSecret: json.client_secret || null,
          authMethod: method,
          source: 'dcr',
        };
        if (workspaceId) {
          await this._storeCachedClient(workspaceId, issuer, method, entry);
        } else {
          await this._storeCachedClient(issuer, method, entry);
        }
        // Observability — oauth.client_registered audit event (§6-OBS.1)
        if (this.wm?.logAudit) {
          this.wm.logAudit('oauth.client_registered', workspaceId || null, JSON.stringify({
            issuer,
            source: 'dcr',
            clientIdMasked: maskClientId(json.client_id),
            authMethod: method,
          }));
        }
        return { ...entry, cached: false };
      }
      // Non-2xx response — classify
      const text = await res.text().catch(() => '');
      const sanitized = sanitize(text).slice(0, 200);
      if (res.status === 429) {
        // Rate-limited — honor Retry-After
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after') ?? res.headers?.['retry-after']);
        const err = Object.assign(new Error(`DCR_RATE_LIMITED: ${sanitized}`), {
          code: 'DCR_RATE_LIMITED',
          status: 429,
          retryAfterMs,
        });
        if (this.wm?.logAudit) {
          this.wm.logAudit('oauth.dcr_rate_limited', workspaceId || null, JSON.stringify({ issuer, retryAfterMs }));
        }
        // 429 on first try → we could honor Retry-After and retry once more,
        // but a tight retry window is almost certainly still rate-limited.
        // Surface immediately so the admin UI can prompt the operator.
        throw err;
      }
      if (res.status >= 400 && res.status < 500) {
        // Client-side reject — no retry, require manual intervention
        const err = Object.assign(new Error(`DCR_REJECTED: ${res.status} ${sanitized}`), {
          code: 'DCR_REJECTED',
          status: res.status,
        });
        throw err;
      }
      // 5xx → transient, retry with backoff
      lastErr = Object.assign(new Error(`DCR_TRANSIENT: ${res.status} ${sanitized}`), {
        code: 'DCR_TRANSIENT',
        status: res.status,
      });
      if (attempt < maxAttempts) {
        await this._sleep(this._dcrBackoffMs(attempt));
        continue;
      }
    }
    throw lastErr ?? Object.assign(new Error('DCR_TRANSIENT: unknown'), { code: 'DCR_TRANSIENT' });
  }

  _dcrBackoffMs(attempt) {
    // 1s, 2s, 4s (cap 5s)
    return Math.min(1000 * 2 ** (attempt - 1), 5000);
  }

  _sleep(ms) {
    return new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  async registerManual(issuerOrOpts, optsOrUndefined) {
    // Back-compat: 2-arg form (issuer, { clientId, clientSecret, authMethod })
    // New form: ({ workspaceId, issuer, clientId, ... })
    let workspaceId, issuer, clientId, clientSecret, authMethod;
    if (typeof issuerOrOpts === 'string') {
      issuer = issuerOrOpts;
      ({ clientId, clientSecret = null, authMethod = 'none' } = optsOrUndefined || {});
    } else {
      ({ workspaceId, issuer, clientId, clientSecret = null, authMethod = 'none' } = issuerOrOpts || {});
    }
    const entry = { clientId, clientSecret, authMethod, source: 'manual' };
    if (workspaceId) {
      await this._storeCachedClient(workspaceId, issuer, authMethod, entry);
    } else {
      await this._storeCachedClient(issuer, authMethod, entry);
    }
    if (this.wm?.logAudit) {
      this.wm.logAudit('oauth.client_registered', workspaceId || null, JSON.stringify({
        issuer,
        source: 'manual',
        clientIdMasked: maskClientId(clientId),
        authMethod,
      }));
    }
    return { ...entry, cached: false };
  }

  // ────────────────────────────────────────────────────────────────────────
  // PKCE + state (6b)

  _newPkce() {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge, method: 'S256' };
  }

  async _signState(payload) {
    const secret = await this._getServerSecret();
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = b64url(createHmac('sha256', secret).update(body).digest());
    return `${body}.${sig}`;
  }

  async _verifyState(state) {
    if (typeof state !== 'string' || !state.includes('.')) return null;
    const [body, sig] = state.split('.');
    const secret = await this._getServerSecret();
    const expected = b64url(createHmac('sha256', secret).update(body).digest());
    // Timing-safe comparison to prevent signature forgery via timing attacks
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
    try {
      return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
    } catch {
      return null;
    }
  }

  async _loadPending() {
    if (this._pending) return this._pending;
    this._pending = (await readJson(this._pendingPath)) || {};
    return this._pending;
  }

  async _savePending() {
    const { applied } = await writeJsonSecure(this._pendingPath, this._pending, { platform: this.platform });
    if (!applied) this._fileSecurityWarning = true;
  }

  async purgeStalePending({ now = Date.now() } = {}) {
    const pending = await this._loadPending();
    let removed = 0;
    for (const [state, entry] of Object.entries(pending)) {
      if (!entry || entry.expiresAt < now) { delete pending[state]; removed++; }
    }
    if (removed > 0) await this._savePending();
    return removed;
  }

  async initializeAuthorization(workspaceId, { issuer, clientId, clientSecret, authMethod, authServerMetadata, resource, scope, identity = 'default' }) {
    if (!authServerMetadata?.authorization_endpoint) {
      throw new Error('initializeAuthorization: missing authorization_endpoint');
    }
    const pkce = this._newPkce();
    const random = b64url(randomBytes(16));
    const issuedAt = Date.now();
    const state = await this._signState({ r: random, w: workspaceId, i: identity, iat: issuedAt });

    const pending = await this._loadPending();
    pending[state] = {
      workspaceId,
      identity,
      issuer,
      clientId,
      clientSecret,
      authMethod,
      verifier: pkce.verifier,
      tokenEndpoint: authServerMetadata.token_endpoint,
      resource: resource || null,
      expiresAt: issuedAt + PENDING_TTL_MS,
      createdAt: new Date(issuedAt).toISOString(),
    };
    await this._savePending();

    const url = new URL(authServerMetadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.getRedirectUri());
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);
    if (resource) url.searchParams.set('resource', resource);
    if (scope) url.searchParams.set('scope', scope);

    if (this.wm?.logAudit) {
      this.wm.logAudit('oauth.authorize_start', workspaceId, JSON.stringify({ issuer, identity }), identity);
    }

    return { authorizationUrl: url.toString(), state };
  }

  async completeAuthorization(state, code) {
    const verified = await this._verifyState(state);
    if (!verified) {
      const err = new Error('invalid_state_signature');
      err.code = 'INVALID_STATE';
      throw err;
    }
    const pending = await this._loadPending();
    const entry = pending[state];
    if (!entry) {
      const err = new Error('state_not_found_or_already_used');
      err.code = 'STATE_NOT_FOUND';
      throw err;
    }
    if (entry.expiresAt < Date.now()) {
      delete pending[state];
      await this._savePending();
      const err = new Error('state_expired');
      err.code = 'STATE_EXPIRED';
      throw err;
    }
    // One-shot: remove immediately
    delete pending[state];
    await this._savePending();

    const tokens = await this._exchangeCode(entry, code);

    if (this.wm?.logAudit) {
      this.wm.logAudit('oauth.authorize_complete', entry.workspaceId, JSON.stringify({
        issuer: entry.issuer,
        identity: entry.identity || 'default',
        tokenPrefix: tokenPrefix(tokens.access_token),
      }), entry.identity || 'default');
    }

    const stored = this._persistTokens(entry.workspaceId, {
      issuer: entry.issuer,
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      authMethod: entry.authMethod,
      resource: entry.resource,
      tokens,
      identity: entry.identity || 'default',
    });
    return stored;
  }

  async _exchangeCode(entry, code) {
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', this.getRedirectUri());
    params.set('code_verifier', entry.verifier);
    if (entry.resource) params.set('resource', entry.resource);

    return this._tokenRequest(entry, params, 'authorize');
  }

  async _tokenRequest(entry, params, kind) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
    if (entry.authMethod === 'client_secret_basic' && entry.clientSecret) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${entry.clientId}:${entry.clientSecret}`).toString('base64');
    } else if (entry.authMethod === 'client_secret_post' && entry.clientSecret) {
      params.set('client_id', entry.clientId);
      params.set('client_secret', entry.clientSecret);
    } else {
      // public client — none
      params.set('client_id', entry.clientId);
    }

    const res = await this.fetch(entry.tokenEndpoint, { method: 'POST', headers, body: params.toString() });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`token_endpoint_${kind}_failed: ${res.status} ${sanitize(body).slice(0, 200)}`);
      err.code = 'TOKEN_ENDPOINT_ERROR';
      err.status = res.status;
      throw err;
    }
    let json;
    try { json = JSON.parse(body); } catch {
      throw new Error(`token_endpoint_${kind}_invalid_json`);
    }
    if (!json.access_token) {
      throw new Error(`token_endpoint_${kind}_missing_access_token`);
    }
    return json;
  }

  /**
   * Common token storage: writes tokenData into ws.oauth.byIdentity[identity],
   * mirrors to legacy ws.oauth.tokens for default, clears action_needed flags,
   * and fires a save. Used by both _persistTokens (authorize) and
   * _refreshWithMutex (refresh).
   */
  _storeTokens(ws, identity, tokenData) {
    if (!ws.oauth) ws.oauth = {};
    if (!ws.oauth.byIdentity) ws.oauth.byIdentity = {};
    ws.oauth.byIdentity[identity] = { tokens: tokenData };
    // Phase 7c-pre: keep the legacy `tokens` mirror for default identity only
    if (identity === 'default') ws.oauth.tokens = tokenData;
    // Per-identity action_needed map + legacy bool
    if (!ws.oauthActionNeededBy) ws.oauthActionNeededBy = {};
    ws.oauthActionNeededBy[identity] = false;
    if (identity === 'default') ws.oauthActionNeeded = false;
    // fire-and-forget save
    if (this.wm?._save) this.wm._save().catch(() => {});
  }

  _persistTokens(workspaceId, { issuer, clientId, clientSecret, authMethod, resource, tokens, identity = 'default' }) {
    const ws = this.wm?._getRawWorkspace?.(workspaceId);
    if (!ws) throw new Error(`workspace_not_found: ${workspaceId}`);

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Only fall back to legacy ws.oauth.tokens for the default identity; other
    // identities must start fresh to preserve isolation.
    const legacyFallback = identity === 'default' ? (ws.oauth?.tokens || {}) : {};
    const existing = ws.oauth?.byIdentity?.[identity]?.tokens || legacyFallback;
    const newTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || existing.refreshToken || null,
      expiresAt,
      tokenType: tokens.token_type || 'Bearer',
      scope: tokens.scope || null,
      lastRefreshAt: new Date().toISOString(),
    };

    // Phase 10a §3.4: write to ws.oauth.client.* AND mirror to flat fields for
    // back-compat (keep readable by old code / external scripts for 1 release).
    const clientBlock = {
      clientId,
      clientSecret: clientSecret || null,
      authMethod,
      // Preserve existing source marker if present (manual/dcr) — DCR path will
      // have populated it via admin/routes.js ensureClient(). Default to 'dcr'.
      source: ws.oauth?.client?.source || 'dcr',
      registeredAt: ws.oauth?.client?.registeredAt || new Date().toISOString(),
    };
    ws.oauth = {
      ...(ws.oauth || {}),
      enabled: true,
      issuer,
      client: clientBlock,
      // Legacy flat-field mirror (to be removed in Phase 11)
      clientId,
      clientSecret: clientSecret || null,
      authMethod,
      resource: resource || ws.oauth?.resource || null,
    };

    this._storeTokens(ws, identity, newTokens);
    return ws.oauth;
  }

  /**
   * Read the tokens object for a given identity. Handles legacy configs
   * where only ws.oauth.tokens existed (treats it as the default identity).
   */
  _tokensFor(ws, identity = 'default') {
    const byId = ws?.oauth?.byIdentity?.[identity]?.tokens;
    if (byId) return byId;
    // Legacy fallback: ws.oauth.tokens → default identity only
    if (identity === 'default' && ws?.oauth?.tokens) return ws.oauth.tokens;
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Token usage / refresh (6c)

  _isExpired(oauthTokens, { leewayMs = REFRESH_LEEWAY_MS, now = Date.now() } = {}) {
    if (!oauthTokens?.expiresAt) return false;
    return new Date(oauthTokens.expiresAt).getTime() - leewayMs <= now;
  }

  async getValidAccessToken(workspaceId, identity = 'default') {
    const ws = this.wm?._getRawWorkspace?.(workspaceId);
    if (!ws?.oauth?.enabled) throw new Error(`workspace_not_oauth: ${workspaceId}`);
    const current = this._tokensFor(ws, identity);
    if (!current?.accessToken) throw new Error(`workspace_not_authorized: ${workspaceId}::${identity}`);

    if (!this._isExpired(current)) {
      return current.accessToken;
    }
    await this._refreshWithMutex(workspaceId, identity);
    return this._tokensFor(ws, identity)?.accessToken;
  }

  async forceRefresh(workspaceId, identity = 'default') {
    return this._refreshWithMutex(workspaceId, identity);
  }

  /**
   * Phase 10a §6.4 — FIFO chain mutex keyed by (workspaceId, identity).
   *
   * Every call chains onto the tail of the Map<key, Promise>, so all ops on
   * the same (ws, identity) are serialized **without coalescing**. This is
   * required so that markAuthFailed and _refreshWithMutex are mutually
   * exclusive (coalescing would have piggy-backed markAuthFailed onto an
   * in-flight refresh and lost the action_needed write).
   */
  _withIdentityMutex(workspaceId, identity, fn) {
    const key = `${workspaceId}::${identity}`;
    const prev = this._identityMutex.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn());
    this._identityMutex.set(key, next);
    // Cleanup tail when this call is the last in the chain — prevents leaking
    // the Map entry for never-refreshed identities.
    next.finally(() => {
      if (this._identityMutex.get(key) === next) this._identityMutex.delete(key);
    }).catch(() => {});
    return next;
  }

  /**
   * Phase 10a §4.10a-4 — mark a (workspace, identity) tuple as requiring
   * re-authorization. Null out access token, flip the action_needed flag,
   * and emit an `oauth.threshold_trip` audit event.
   *
   * Serialized against refresh via the shared _identityMutex so a concurrent
   * refresh either completes first (and its tokens get immediately nulled by
   * this call) or observes the action_needed flag and returns early.
   */
  async markAuthFailed(workspaceId, identity = 'default', { correlationId = null, consecutiveCount = null } = {}) {
    return this._withIdentityMutex(workspaceId, identity, async () => {
      const ws = this.wm?._getRawWorkspace?.(workspaceId);
      if (!ws) return { marked: false, reason: 'workspace_not_found' };
      // null out access token in byIdentity map
      if (ws.oauth?.byIdentity?.[identity]?.tokens) {
        ws.oauth.byIdentity[identity].tokens.accessToken = null;
      }
      // Default identity also mirrors to legacy ws.oauth.tokens
      if (identity === 'default' && ws.oauth?.tokens) {
        ws.oauth.tokens.accessToken = null;
      }
      // Root-level action_needed map (NOT nested under oauth)
      if (!ws.oauthActionNeededBy) ws.oauthActionNeededBy = {};
      ws.oauthActionNeededBy[identity] = true;
      if (identity === 'default') ws.oauthActionNeeded = true;
      if (this.wm?._save) {
        await this.wm._save().catch(() => {});
      }
      if (this.wm?.logAudit) {
        this.wm.logAudit('oauth.threshold_trip', workspaceId, JSON.stringify({
          threshold: this._authFailThreshold,
          consecutiveCount: consecutiveCount ?? this._authFailThreshold,
          correlationId: correlationId || null,
        }), identity);
      }
      return { marked: true };
    });
  }

  async _refreshWithMutex(workspaceId, identity = 'default') {
    return this._withIdentityMutex(workspaceId, identity, () => this._runRefresh(workspaceId, identity));
  }

  async _runRefresh(workspaceId, identity) {
    // Observability: early-return if markAuthFailed already set action_needed
    // for this identity. §9 "Refresh early-return" assertion.
    const wsPre = this.wm?._getRawWorkspace?.(workspaceId);
    const actionNeeded = wsPre?.oauthActionNeededBy?.[identity]
      || (identity === 'default' && wsPre?.oauthActionNeeded);
    if (actionNeeded) {
      return { skipped: true, reason: 'action_needed' };
    }

    const task = (async () => {
      const ws = this.wm?._getRawWorkspace?.(workspaceId);
      const prev = this._tokensFor(ws, identity);
      if (!prev?.refreshToken) {
        const err = new Error('no_refresh_token');
        err.code = 'NO_REFRESH_TOKEN';
        throw err;
      }
      // Phase 10a §3.4 — prefer ws.oauth.client.*, fall back to flat fields.
      const client = ws.oauth?.client || null;
      const entry = {
        tokenEndpoint: ws.oauth.metadataCache?.token_endpoint || ws.oauth.tokenEndpoint,
        clientId: client?.clientId ?? ws.oauth.clientId,
        clientSecret: client?.clientSecret ?? ws.oauth.clientSecret,
        authMethod: client?.authMethod ?? (ws.oauth.authMethod || 'none'),
        resource: ws.oauth.resource,
      };
      // Resolve token endpoint lazily if missing
      if (!entry.tokenEndpoint) {
        const endpoint = ws.oauth.metadataCache?.token_endpoint;
        if (!endpoint) {
          const err = new Error('token_endpoint_unknown — re-authorize required');
          err.code = 'TOKEN_ENDPOINT_UNKNOWN';
          throw err;
        }
        entry.tokenEndpoint = endpoint;
      }
      const params = new URLSearchParams();
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', prev.refreshToken);
      if (entry.resource) params.set('resource', entry.resource);

      const tokens = await this._tokenRequest(entry, params, 'refresh');

      const updated = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || prev.refreshToken,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
        tokenType: tokens.token_type || prev.tokenType || 'Bearer',
        scope: tokens.scope || prev.scope || null,
        lastRefreshAt: new Date().toISOString(),
      };
      this._storeTokens(ws, identity, updated);
      if (this.wm?.logAudit) {
        this.wm.logAudit('oauth.refresh_success', workspaceId, JSON.stringify({
          issuer: ws.oauth.issuer,
          identity,
          tokenPrefix: tokenPrefix(tokens.access_token),
          rotated: Boolean(tokens.refresh_token),
        }), identity);
      }
      return updated;
    })();

    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('refresh_timeout')), this._refreshTimeoutMs);
      timeoutHandle.unref?.();
    });
    task.catch(() => {});
    const wrapped = Promise.race([task, timeout]).finally(() => clearTimeout(timeoutHandle));
    try {
      return await wrapped;
    } catch (err) {
      if (this.wm?.logAudit) {
        this.wm.logAudit('oauth.refresh_fail', workspaceId, sanitize(`identity=${identity} ${err.message}`), identity);
      }
      const ws = this.wm?._getRawWorkspace?.(workspaceId);
      if (ws && err.code !== 'NO_REFRESH_TOKEN' && err.code !== 'TOKEN_ENDPOINT_UNKNOWN') {
        if (!ws.oauthActionNeededBy) ws.oauthActionNeededBy = {};
        ws.oauthActionNeededBy[identity] = true;
        if (identity === 'default') ws.oauthActionNeeded = true;
      }
      throw err;
    }
  }
}
