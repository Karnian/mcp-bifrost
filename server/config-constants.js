/**
 * Centralized configuration constants.
 * All hardcoded values externalized as environment variables with sensible defaults.
 * Import from this module instead of hardcoding values in individual files.
 */

function envInt(key, fallback) {
  const v = parseInt(process.env[key] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Rate limiting
export const RATE_LIMIT_MAX = envInt('BIFROST_RATE_LIMIT_MAX', 10);
export const RATE_LIMIT_WINDOW_MS = envInt('BIFROST_RATE_LIMIT_WINDOW_MS', 60_000);

// SSE
export const SSE_KEEPALIVE_MS = envInt('BIFROST_SSE_KEEPALIVE_MS', 30_000);

// Health check
export const HEALTH_CHECK_INTERVAL_MS = envInt('BIFROST_HEALTH_CHECK_INTERVAL', 5 * 60 * 1000);

// OAuth
export const OAUTH_PENDING_TTL_MS = envInt('BIFROST_OAUTH_PENDING_TTL_MS', 10 * 60 * 1000);

// Audit
export const AUDIT_RING_SIZE = envInt('BIFROST_AUDIT_RING_SIZE', 50);

// Scrypt
export const SCRYPT_N = envInt('BIFROST_SCRYPT_N', 65536);

// Usage retention
export const USAGE_RETENTION_MS = envInt('BIFROST_USAGE_RETENTION_MS', 30 * 24 * 60 * 60 * 1000);

// Regex cache
export const REGEX_CACHE_LIMIT = envInt('BIFROST_REGEX_CACHE_LIMIT', 100);

// Resource size limit
export const MAX_RESOURCE_SIZE = envInt('BIFROST_MAX_RESOURCE_SIZE', 5 * 1024 * 1024);

// Server timeouts
export const HEADERS_TIMEOUT = envInt('BIFROST_HEADERS_TIMEOUT', 20_000);
export const REQUEST_TIMEOUT = envInt('BIFROST_REQUEST_TIMEOUT', 30_000);
