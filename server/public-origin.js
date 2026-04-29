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
 * Contract:
 *   getPublicOrigin()        — strict; throws if BIFROST_PUBLIC_URL is missing
 *                              or the URL fails the HTTPS-or-localhost rule.
 *   getPublicOriginOrNull()  — non-throwing; returns null when unset/invalid.
 *                              Used by Admin UI bootstrap to render an
 *                              actionable warning before the user clicks
 *                              install.
 *   getSlackRedirectUri()    — origin + '/oauth/slack/callback'.
 *   getSlackManifestRedirect() — alias of getSlackRedirectUri (same source
 *                               of truth so manifest download and runtime
 *                               cannot drift).
 */

const ENV_VAR = 'BIFROST_PUBLIC_URL';
const SLACK_CALLBACK_PATH = '/oauth/slack/callback';

function readEnv() {
  // Read every call so test setup that mutates process.env is observed.
  const raw = process.env[ENV_VAR];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildOriginFrom(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    const e = new Error(`${ENV_VAR} is not a valid URL: ${err.message}`);
    e.code = 'PUBLIC_ORIGIN_INVALID';
    throw e;
  }
  // Path / query / fragment mean the operator likely pasted the wrong
  // value (e.g. https://host/admin) — Slack only accepts an origin-level
  // redirect URI base. Strip + warn? We choose to be strict: refuse so
  // the manifest never advertises the wrong path.
  if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
    const e = new Error(`${ENV_VAR} must be an origin (no path), got: ${value}`);
    e.code = 'PUBLIC_ORIGIN_HAS_PATH';
    throw e;
  }
  if (parsed.search || parsed.hash) {
    const e = new Error(`${ENV_VAR} must not include query or fragment: ${value}`);
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
    const e = new Error(`${ENV_VAR} must use HTTPS (HTTP only allowed on loopback). Got protocol "${parsed.protocol}".`);
    e.code = 'PUBLIC_ORIGIN_NOT_HTTPS';
    throw e;
  }
  // Use URL.origin to canonicalize: strip default ports, remove trailing
  // slash. This is what gets concatenated with /oauth/slack/callback so
  // "https://x.test/" and "https://x.test" resolve identically.
  return parsed.origin;
}

export function getPublicOrigin() {
  const raw = readEnv();
  if (!raw) {
    const e = new Error(`${ENV_VAR} is required for Slack OAuth (set to your public HTTPS origin, e.g. https://bifrost.example.com)`);
    e.code = 'PUBLIC_ORIGIN_MISSING';
    throw e;
  }
  return buildOriginFrom(raw);
}

export function getPublicOriginOrNull() {
  try {
    return getPublicOrigin();
  } catch {
    return null;
  }
}

export function describePublicOrigin() {
  // Reports the configured value + canonical form + reason if invalid.
  // Used by the Admin UI bootstrap (`GET /api/slack/app`) so the operator
  // can fix env-var typos before clicking install.
  const raw = readEnv();
  if (!raw) {
    return { configured: false, raw: null, origin: null, valid: false, reason: 'missing' };
  }
  try {
    const origin = buildOriginFrom(raw);
    return { configured: true, raw, origin, valid: true, reason: null };
  } catch (err) {
    return {
      configured: true,
      raw,
      origin: null,
      valid: false,
      reason: err.code || 'invalid',
      message: err.message,
    };
  }
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
