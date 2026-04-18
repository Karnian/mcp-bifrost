/**
 * MCP Token Manager — Phase 7b
 *
 * Multi-token authentication + ACL for MCP endpoints.
 *
 * Storage: `config/workspaces.json > server.mcpTokens` (hashed with scrypt).
 * Plaintext is surfaced ONLY once at issuance time; on disk we keep only
 * scrypt hash + 16-byte random salt (base64url, delimited by ":").
 *
 * Legacy support:
 *   - `BIFROST_MCP_TOKEN` (singular) → identity = "legacy", allowedWorkspaces=["*"],
 *     allowedProfiles=["*"]  (compat with pre-7b deployments)
 *   - `BIFROST_MCP_TOKENS` (plural, comma-separated `id:plaintext[:wsGlob][:profileGlob]`)
 *     → runtime registrations, never written to disk
 *
 * Resolve flow: `resolve(plaintext)` → walks envTokens (constant-time),
 * then walks persisted tokens (scrypt). Returns identity object or null.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// scrypt parameters — tuned for low-frequency (per-request) verification.
// N=2^15 is safe on commodity hardware (~50-80ms); MCP token checks run
// once per request so we can afford the cost.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 32;
const SALT_LEN = 16;
// Node's default scrypt maxmem is 32MB which is insufficient for N=2^15.
// Required memory ≈ 128 * N * r * p bytes = 128 * 32768 * 8 * 1 = 32MB + overhead.
// Set to 64MB to be safe without being wasteful.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export async function hashToken(plaintext, { saltBytes } = {}) {
  const salt = saltBytes || randomBytes(SALT_LEN);
  const derived = await scrypt(plaintext, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(salt)}$${b64url(derived)}`;
}

export async function verifyToken(plaintext, hashStr) {
  if (typeof hashStr !== 'string' || !hashStr.startsWith('scrypt$')) return false;
  const parts = hashStr.split('$');
  if (parts.length !== 6) return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = parseInt(nStr, 10);
  const r = parseInt(rStr, 10);
  const p = parseInt(pStr, 10);
  if (!N || !r || !p) return false;
  try {
    const salt = b64urlDecode(saltB64);
    const expected = b64urlDecode(hashB64);
    const derived = await scrypt(plaintext, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function maskPlaintext(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return '';
  if (plaintext.length <= 8) return '***';
  return `${plaintext.slice(0, 4)}***${plaintext.slice(-4)}`;
}

function parseEnvTokens(envStr) {
  if (!envStr) return [];
  const out = [];
  for (const chunk of envStr.split(',')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    // Format: id:plaintext[:wsGlob][:profileGlob]
    // wsGlob / profileGlob may contain `|` to separate multiple patterns; default "*"
    const parts = trimmed.split(':');
    if (parts.length < 2) continue;
    const [id, plaintext, wsGlob, profileGlob] = parts;
    out.push({
      id,
      plaintext,
      allowedWorkspaces: wsGlob ? wsGlob.split('|') : ['*'],
      allowedProfiles: profileGlob ? profileGlob.split('|') : ['*'],
      source: 'env',
    });
  }
  return out;
}

/**
 * Match pattern against value using simple glob ("*" matches anything,
 * `foo*` prefix, `*foo` suffix, `*foo*` contains, literal otherwise).
 */
const _patternCache = new Map(); // pattern → RegExp (LRU capped at 100)
const PATTERN_CACHE_MAX = 100;

export function matchPattern(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern) return false;
  if (!pattern.includes('*')) return pattern === value;
  let re = _patternCache.get(pattern);
  if (!re) {
    const src = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    re = new RegExp(src);
    if (_patternCache.size >= PATTERN_CACHE_MAX) {
      // Evict oldest entry
      const first = _patternCache.keys().next().value;
      _patternCache.delete(first);
    }
    _patternCache.set(pattern, re);
  }
  return re.test(value);
}

export function identityAllowsWorkspace(identity, workspaceId) {
  if (!identity) return false;
  const list = identity.allowedWorkspaces || [];
  return list.some(p => matchPattern(p, workspaceId));
}

export function identityAllowsProfile(identity, profileName) {
  if (!identity) return false;
  if (!profileName) return true; // no profile requested → always allowed
  const list = identity.allowedProfiles || [];
  return list.some(p => matchPattern(p, profileName));
}

export class McpTokenManager {
  /**
   * @param {WorkspaceManager} wm
   * @param {{ envToken?: string, envTokens?: string }} [opts]  — typically reads from process.env
   */
  constructor(wm, { envToken, envTokens } = {}) {
    this.wm = wm;
    this._envToken = envToken !== undefined ? envToken : (process.env.BIFROST_MCP_TOKEN || null);
    this._envTokens = parseEnvTokens(envTokens !== undefined ? envTokens : (process.env.BIFROST_MCP_TOKENS || ''));
  }

  _storedTokens() {
    return this.wm?.config?.server?.mcpTokens || [];
  }

  /**
   * Returns true iff ANY auth source is configured (legacy env, multi env, or persisted).
   * When false, the caller should treat the MCP endpoint as "open mode" (no token required).
   */
  isConfigured() {
    return Boolean(this._envToken) || this._envTokens.length > 0 || this._storedTokens().length > 0;
  }

  hasLegacyToken() {
    return Boolean(this._envToken);
  }

  /**
   * Resolve a bearer token (plaintext) to an identity, or null if invalid.
   * Constant-time comparison for env tokens, scrypt verify for persisted.
   */
  async resolve(bearer) {
    if (!bearer || typeof bearer !== 'string') return null;

    // 1. Legacy single env token → identity=legacy, full access
    if (this._envToken) {
      const a = Buffer.from(bearer);
      const b = Buffer.from(this._envToken);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return {
          id: 'legacy',
          source: 'env-legacy',
          allowedWorkspaces: ['*'],
          allowedProfiles: ['*'],
        };
      }
    }

    // 2. Multi env tokens (plaintext comparison, constant-time per entry)
    for (const entry of this._envTokens) {
      const a = Buffer.from(bearer);
      const b = Buffer.from(entry.plaintext);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return {
          id: entry.id,
          source: 'env',
          allowedWorkspaces: entry.allowedWorkspaces,
          allowedProfiles: entry.allowedProfiles,
        };
      }
    }

    // 3. Persisted tokens — prefix-based narrowing then scrypt verify
    const bearerPrefix = bearer.slice(0, 8);
    // Try prefix-matched entries first (fast path for newly issued tokens)
    const stored = this._storedTokens();
    const prefixMatched = stored.filter(e => e.prefix && e.prefix === bearerPrefix);
    const remaining = prefixMatched.length > 0
      ? stored.filter(e => !e.prefix || e.prefix !== bearerPrefix)
      : stored;
    for (const entry of [...prefixMatched, ...remaining]) {
      if (!entry.token) continue;
      const ok = await verifyToken(bearer, entry.token);
      if (ok) {
        this._touchLastUsed(entry.id);
        return {
          id: entry.id,
          source: 'persisted',
          allowedWorkspaces: entry.allowedWorkspaces || ['*'],
          allowedProfiles: entry.allowedProfiles || ['*'],
        };
      }
    }

    return null;
  }

  _touchLastUsed(id) {
    const stored = this._storedTokens();
    const entry = stored.find(t => t.id === id);
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    // fire-and-forget save (avoid blocking request path)
    this.wm?._save?.().catch(() => {});
  }

  /**
   * Issue a new persisted token. Returns { id, plaintext } — plaintext only once.
   */
  async issue({ id, description, allowedWorkspaces = ['*'], allowedProfiles = ['*'] } = {}) {
    const stored = this._storedTokens();
    if (!id) id = `tok_${b64url(randomBytes(9))}`;
    if (stored.some(t => t.id === id)) {
      throw new Error(`token_id_exists: ${id}`);
    }
    const plaintext = `bft_${b64url(randomBytes(32))}`;
    const hash = await hashToken(plaintext);
    const prefix = plaintext.slice(0, 8);

    const entry = {
      id,
      description: description || '',
      token: hash,
      prefix,
      allowedWorkspaces,
      allowedProfiles,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    // Ensure server.mcpTokens exists
    if (!this.wm.config.server) this.wm.config.server = { port: 3100 };
    if (!Array.isArray(this.wm.config.server.mcpTokens)) this.wm.config.server.mcpTokens = [];
    this.wm.config.server.mcpTokens.push(entry);
    await this.wm._save();
    this.wm.logAudit?.('token.issue', null, `Issued MCP token id=${id}`);

    return { id, plaintext, entry: this._maskEntry(entry) };
  }

  async revoke(id) {
    const stored = this._storedTokens();
    const idx = stored.findIndex(t => t.id === id);
    if (idx === -1) throw new Error(`token_not_found: ${id}`);
    stored.splice(idx, 1);
    await this.wm._save();
    this.wm.logAudit?.('token.revoke', null, `Revoked MCP token id=${id}`);
  }

  /**
   * Rotate: revoke + re-issue with same id. Returns new plaintext.
   */
  async rotate(id) {
    const stored = this._storedTokens();
    const existing = stored.find(t => t.id === id);
    if (!existing) throw new Error(`token_not_found: ${id}`);
    const plaintext = `bft_${b64url(randomBytes(32))}`;
    existing.token = await hashToken(plaintext);
    existing.prefix = plaintext.slice(0, 8);
    existing.rotatedAt = new Date().toISOString();
    await this.wm._save();
    this.wm.logAudit?.('token.rotate', null, `Rotated MCP token id=${id}`);
    return { id, plaintext };
  }

  list() {
    const persisted = this._storedTokens().map(e => this._maskEntry(e));
    const env = this._envTokens.map(e => ({
      id: e.id,
      description: '(환경변수)',
      allowedWorkspaces: e.allowedWorkspaces,
      allowedProfiles: e.allowedProfiles,
      source: 'env',
      hashed: false,
      createdAt: null,
      lastUsedAt: null,
    }));
    if (this._envToken) {
      env.unshift({
        id: 'legacy',
        description: 'BIFROST_MCP_TOKEN (legacy — 전체 허용)',
        allowedWorkspaces: ['*'],
        allowedProfiles: ['*'],
        source: 'env-legacy',
        hashed: false,
        createdAt: null,
        lastUsedAt: null,
      });
    }
    return [...env, ...persisted];
  }

  _maskEntry(entry) {
    return {
      id: entry.id,
      description: entry.description || '',
      allowedWorkspaces: entry.allowedWorkspaces || ['*'],
      allowedProfiles: entry.allowedProfiles || ['*'],
      source: 'persisted',
      hashed: true,
      createdAt: entry.createdAt || null,
      lastUsedAt: entry.lastUsedAt || null,
      rotatedAt: entry.rotatedAt || null,
    };
  }
}
