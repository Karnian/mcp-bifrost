/**
 * Phase 12-2 — Canonical public origin resolver for Slack OAuth.
 *
 * Slack OAuth requires the redirect_uri at /authorize and at the token
 * exchange to match exactly. Host-header–based auto-derivation is not
 * acceptable because (a) operators commonly run Bifrost behind a tunnel
 * whose hostname is configurable per session, (b) the Host header is
 * spoofable from any HTTP client. Instead, every code path that needs
 * the public origin (manifest YAML download, /authorize URL builder,
 * /oauth/slack/callback URL, token exchange redirect_uri) calls this
 * single resolver.
 *
 * Resolution chain (highest priority first):
 *   1. `BIFROST_PUBLIC_URL` env var — ops/deploy override
 *   2. file value — admin saves via UI (config/workspaces.json
 *      top-level `publicUrl` field), exposed through the registered
 *      provider callback.
 *   3. default fallback — `http://localhost:${BIFROST_PORT || 3100}` so
 *      a fresh checkout runs the OAuth flow without any setup.
 *
 * Contract:
 *   getPublicOrigin()         — always returns a usable origin (never
 *                               throws for missing config — falls back
 *                               to localhost). Throws PUBLIC_ORIGIN_*
 *                               codes only when the env / file value is
 *                               syntactically invalid.
 *   getPublicOriginOrNull()   — non-throwing variant.
 *   describePublicOrigin()    — reports {origin, valid, source, reason,
 *                               message}; UI uses this to render badges.
 *   getSlackRedirectUri()     — origin + '/oauth/slack/callback'.
 *   getSlackManifestRedirect()— alias of getSlackRedirectUri (single
 *                               source of truth so manifest download and
 *                               runtime cannot drift).
 *
 *   setPublicOriginProvider(fn) — wm registers a callback returning the
 *                                 file-stored value or null. server/index.js
 *                                 wires this once at startup.
 */

const ENV_VAR = 'BIFROST_PUBLIC_URL';
const SLACK_CALLBACK_PATH = '/oauth/slack/callback';
const DEFAULT_LOCALHOST_PORT = '3100';

let _fileProvider = null;

/**
 * Register a callback that returns the file-stored publicUrl (or null
 * when not configured). Called once during server boot. Subsequent calls
 * replace the provider — used in tests that swap fixtures.
 */
export function setPublicOriginProvider(fn) {
  _fileProvider = typeof fn === 'function' ? fn : null;
}

function readEnv() {
  // Read every call so test setup that mutates process.env is observed.
  const raw = process.env[ENV_VAR];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFileValue() {
  if (!_fileProvider) return null;
  try {
    const raw = _fileProvider();
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function defaultLocalhostOrigin() {
  const port = (process.env.BIFROST_PORT && /^\d+$/.test(process.env.BIFROST_PORT))
    ? process.env.BIFROST_PORT
    : DEFAULT_LOCALHOST_PORT;
  return `http://localhost:${port}`;
}

/**
 * Validate + canonicalize a raw origin string. Throws PUBLIC_ORIGIN_*
 * codes for syntactic / semantic violations. Used by both env and file
 * sources so the rules stay identical regardless of where the value
 * came from.
 */
export function validatePublicOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    const e = new Error(`Public origin is not a valid URL: ${err.message}`);
    e.code = 'PUBLIC_ORIGIN_INVALID';
    throw e;
  }
  // Path / query / fragment mean the operator likely pasted the wrong
  // value (e.g. https://host/admin) — Slack only accepts an origin-level
  // redirect URI base. Strip + warn? We choose to be strict: refuse so
  // the manifest never advertises the wrong path.
  if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
    const e = new Error(`Public origin must be an origin (no path), got: ${value}`);
    e.code = 'PUBLIC_ORIGIN_HAS_PATH';
    throw e;
  }
  if (parsed.search || parsed.hash) {
    const e = new Error(`Public origin must not include query or fragment: ${value}`);
    e.code = 'PUBLIC_ORIGIN_HAS_QUERY';
    throw e;
  }
  // HTTPS required, with one narrow dev exemption: HTTP on a loopback host.
  // Codex 12-2 BLOCKER: the previous "https or loopback" rule accepted any
  // non-HTTPS protocol (ftp://localhost, ws://127.0.0.1, …) on loopback,
  // which lets a misconfigured env advertise a redirect URI that Slack
  // cannot dispatch to. Tighten to (https) OR (http+loopback).
  const host = parsed.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const isHttps = parsed.protocol === 'https:';
  const isHttp = parsed.protocol === 'http:';
  if (!isHttps && !(isHttp && isLoopback)) {
    const e = new Error(`Public origin must use HTTPS (HTTP only allowed on loopback). Got protocol "${parsed.protocol}".`);
    e.code = 'PUBLIC_ORIGIN_NOT_HTTPS';
    throw e;
  }
  // Use URL.origin to canonicalize: strip default ports, remove trailing
  // slash. This is what gets concatenated with /oauth/slack/callback so
  // "https://x.test/" and "https://x.test" resolve identically.
  return parsed.origin;
}

/**
 * Resolve to the highest-priority configured origin.
 * Throws PUBLIC_ORIGIN_* if env/file value is syntactically invalid.
 * Falls back to localhost when nothing is configured.
 */
export function getPublicOrigin() {
  const env = readEnv();
  if (env) return validatePublicOrigin(env);
  const file = readFileValue();
  if (file) return validatePublicOrigin(file);
  return defaultLocalhostOrigin();
}

export function getPublicOriginOrNull() {
  try {
    return getPublicOrigin();
  } catch {
    return null;
  }
}

/**
 * Reports the resolution path so the UI can:
 *   - render the "source: env / file / default" badge
 *   - surface invalid env/file values (PUBLIC_ORIGIN_* codes)
 *   - tell operators on default localhost that they need to set a
 *     public origin to receive external workspace installs.
 */
export function describePublicOrigin() {
  const env = readEnv();
  if (env) {
    try {
      return { configured: true, source: 'env', raw: env, origin: validatePublicOrigin(env), valid: true, reason: null };
    } catch (err) {
      return { configured: true, source: 'env', raw: env, origin: null, valid: false, reason: err.code || 'invalid', message: err.message };
    }
  }
  const file = readFileValue();
  if (file) {
    try {
      return { configured: true, source: 'file', raw: file, origin: validatePublicOrigin(file), valid: true, reason: null };
    } catch (err) {
      return { configured: true, source: 'file', raw: file, origin: null, valid: false, reason: err.code || 'invalid', message: err.message };
    }
  }
  return {
    configured: false,
    source: 'default',
    raw: null,
    origin: defaultLocalhostOrigin(),
    valid: true,
    reason: 'dev-fallback',
    message: '환경변수 BIFROST_PUBLIC_URL 또는 Admin 화면 설정이 비어 있어 localhost fallback 으로 동작 중. 외부 workspace install 받으려면 public HTTPS origin 설정 필요.',
  };
}

export function getSlackRedirectUri() {
  return `${getPublicOrigin()}${SLACK_CALLBACK_PATH}`;
}

export function getSlackManifestRedirect() {
  // Single source of truth shared by manifest download + runtime.
  return getSlackRedirectUri();
}

export const PUBLIC_ORIGIN_ENV_VAR = ENV_VAR;
export const SLACK_OAUTH_CALLBACK_PATH = SLACK_CALLBACK_PATH;
