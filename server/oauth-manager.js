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
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  constructor(wm, { stateDir = STATE_DIR, platform = process.platform, fetchImpl = globalThis.fetch, redirectPort } = {}) {
    this.wm = wm;
    this.platform = platform;
    this.fetch = fetchImpl;
    this._redirectPort = redirectPort;
    this._issuerCachePath = join(stateDir, 'oauth-issuer-cache.json');
    this._pendingPath = join(stateDir, 'oauth-pending.json');
    this._secretPath = join(stateDir, 'server-secret');
    this._stateDir = stateDir;
    this._issuerCache = null; // lazy
    this._pending = null; // lazy
    this._serverSecret = null; // lazy
    this._refreshMutex = new Map(); // workspaceId -> Promise
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
  // Issuer cache (RFC 7591 client reuse)

  async _loadIssuerCache() {
    if (this._issuerCache) return this._issuerCache;
    this._issuerCache = (await readJson(this._issuerCachePath)) || {};
    return this._issuerCache;
  }

  async _saveIssuerCache() {
    const { applied } = await writeJsonSecure(this._issuerCachePath, this._issuerCache, { platform: this.platform });
    if (!applied) this._fileSecurityWarning = true;
  }

  _cacheKey(issuer, authMethod) {
    return `${issuer}::${authMethod}`;
  }

  async getCachedClient(issuer, authMethod) {
    const cache = await this._loadIssuerCache();
    return cache[this._cacheKey(issuer, authMethod)] || null;
  }

  async _storeCachedClient(issuer, authMethod, entry) {
    const cache = await this._loadIssuerCache();
    cache[this._cacheKey(issuer, authMethod)] = { ...entry, issuer, authMethod, registeredAt: new Date().toISOString() };
    await this._saveIssuerCache();
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

  async registerClient(issuer, authServerMetadata, { authMethod, forceNew = false, reuse = true } = {}) {
    const method = authMethod || this.pickAuthMethod(authServerMetadata);

    if (reuse && !forceNew) {
      const cached = await this.getCachedClient(issuer, method);
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

    const res = await this.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`DCR_FAILED: ${res.status} ${sanitize(text).slice(0, 200)}`);
      err.code = 'DCR_FAILED';
      err.status = res.status;
      throw err;
    }
    const json = await res.json();

    const entry = {
      clientId: json.client_id,
      clientSecret: json.client_secret || null,
      authMethod: method,
      source: 'dcr',
    };
    await this._storeCachedClient(issuer, method, entry);
    return { ...entry, cached: false };
  }

  async registerManual(issuer, { clientId, clientSecret = null, authMethod = 'none' }) {
    const entry = { clientId, clientSecret, authMethod, source: 'manual' };
    await this._storeCachedClient(issuer, authMethod, entry);
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
    if (sig !== expected) return null;
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

  async initializeAuthorization(workspaceId, { issuer, clientId, clientSecret, authMethod, authServerMetadata, resource, scope }) {
    if (!authServerMetadata?.authorization_endpoint) {
      throw new Error('initializeAuthorization: missing authorization_endpoint');
    }
    const pkce = this._newPkce();
    const random = b64url(randomBytes(16));
    const issuedAt = Date.now();
    const state = await this._signState({ r: random, w: workspaceId, iat: issuedAt });

    const pending = await this._loadPending();
    pending[state] = {
      workspaceId,
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
      this.wm.logAudit('oauth.authorize_start', workspaceId, JSON.stringify({ issuer }));
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
        tokenPrefix: tokenPrefix(tokens.access_token),
      }));
    }

    const stored = this._persistTokens(entry.workspaceId, {
      issuer: entry.issuer,
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      authMethod: entry.authMethod,
      resource: entry.resource,
      tokens,
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

  _persistTokens(workspaceId, { issuer, clientId, clientSecret, authMethod, resource, tokens }) {
    const ws = this.wm?._getRawWorkspace?.(workspaceId);
    if (!ws) throw new Error(`workspace_not_found: ${workspaceId}`);

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    ws.oauth = {
      ...(ws.oauth || {}),
      enabled: true,
      issuer,
      clientId,
      clientSecret: clientSecret || null,
      authMethod,
      resource: resource || ws.oauth?.resource || null,
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || ws.oauth?.tokens?.refreshToken || null,
        expiresAt,
        tokenType: tokens.token_type || 'Bearer',
        scope: tokens.scope || null,
        lastRefreshAt: new Date().toISOString(),
      },
    };
    // fire-and-forget save
    if (this.wm?._save) this.wm._save().catch(() => {});
    return ws.oauth;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Token usage / refresh (6c)

  _isExpired(oauthTokens, { leewayMs = REFRESH_LEEWAY_MS, now = Date.now() } = {}) {
    if (!oauthTokens?.expiresAt) return false;
    return new Date(oauthTokens.expiresAt).getTime() - leewayMs <= now;
  }

  async getValidAccessToken(workspaceId) {
    const ws = this.wm?._getRawWorkspace?.(workspaceId);
    if (!ws?.oauth?.enabled) throw new Error(`workspace_not_oauth: ${workspaceId}`);
    if (!ws.oauth.tokens?.accessToken) throw new Error(`workspace_not_authorized: ${workspaceId}`);

    if (!this._isExpired(ws.oauth.tokens)) {
      return ws.oauth.tokens.accessToken;
    }
    await this._refreshWithMutex(workspaceId);
    return ws.oauth.tokens.accessToken;
  }

  async forceRefresh(workspaceId) {
    return this._refreshWithMutex(workspaceId);
  }

  async _refreshWithMutex(workspaceId) {
    const existing = this._refreshMutex.get(workspaceId);
    if (existing) return existing;

    const task = (async () => {
      const ws = this.wm?._getRawWorkspace?.(workspaceId);
      if (!ws?.oauth?.tokens?.refreshToken) {
        const err = new Error('no_refresh_token');
        err.code = 'NO_REFRESH_TOKEN';
        throw err;
      }
      const entry = {
        tokenEndpoint: ws.oauth.metadataCache?.token_endpoint || ws.oauth.tokenEndpoint,
        clientId: ws.oauth.clientId,
        clientSecret: ws.oauth.clientSecret,
        authMethod: ws.oauth.authMethod || 'none',
        resource: ws.oauth.resource,
      };
      // Resolve token endpoint lazily if missing
      if (!entry.tokenEndpoint) {
        // Attempt rediscovery via issuer metadata cache
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
      params.set('refresh_token', ws.oauth.tokens.refreshToken);
      if (entry.resource) params.set('resource', entry.resource);

      const tokens = await this._tokenRequest(entry, params, 'refresh');

      const prev = ws.oauth.tokens;
      ws.oauth.tokens = {
        accessToken: tokens.access_token,
        // Rotation: replace only when server returns new refresh_token
        refreshToken: tokens.refresh_token || prev.refreshToken,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
        tokenType: tokens.token_type || prev.tokenType || 'Bearer',
        scope: tokens.scope || prev.scope || null,
        lastRefreshAt: new Date().toISOString(),
      };
      if (this.wm?._save) this.wm._save().catch(() => {});
      if (this.wm?.logAudit) {
        this.wm.logAudit('oauth.refresh_success', workspaceId, JSON.stringify({
          issuer: ws.oauth.issuer,
          tokenPrefix: tokenPrefix(tokens.access_token),
          rotated: Boolean(tokens.refresh_token),
        }));
      }
      return ws.oauth.tokens;
    })();

    const timeout = new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('refresh_timeout')), REFRESH_TIMEOUT_MS);
      t.unref?.();
    });

    const wrapped = Promise.race([task, timeout]);
    this._refreshMutex.set(workspaceId, wrapped);
    try {
      return await wrapped;
    } catch (err) {
      if (this.wm?.logAudit) {
        this.wm.logAudit('oauth.refresh_fail', workspaceId, sanitize(err.message));
      }
      // Mark workspace as action_needed so Dashboard surfaces it
      const ws = this.wm?._getRawWorkspace?.(workspaceId);
      if (ws) ws.oauthActionNeeded = true;
      throw err;
    } finally {
      this._refreshMutex.delete(workspaceId);
    }
  }
}
