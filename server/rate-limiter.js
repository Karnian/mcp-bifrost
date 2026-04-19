/**
 * Sliding-window rate limiter (IP-based, in-memory).
 * Designed for Admin API brute-force protection, not DDoS defense.
 * Single process assumption — no shared state.
 */

const DEFAULT_MAX = 10;
const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Extract client IP from request, respecting trust proxy settings.
 * When BIFROST_TRUST_PROXY=1, uses rightmost untrusted IP from X-Forwarded-For.
 * @param {IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
  const directIp = req.socket?.remoteAddress || '127.0.0.1';

  if (process.env.BIFROST_TRUST_PROXY !== '1') {
    return directIp;
  }

  // Trusted proxies from env (CIDR not supported yet — exact IP match)
  const trustedRaw = process.env.BIFROST_TRUSTED_PROXIES || '';
  const trusted = new Set(trustedRaw.split(',').map(s => s.trim()).filter(Boolean));

  // Only trust XFF if the direct peer is itself a trusted proxy (or localhost).
  // Without this check, any client can spoof XFF to evade IP-based rate limiting.
  const peerIsTrusted = trusted.size === 0
    ? _isLoopback(directIp)  // no trusted proxies configured — only trust loopback
    : trusted.has(directIp) || trusted.has(_normalizeIp(directIp));

  if (!peerIsTrusted) {
    return directIp;
  }

  const xff = req.headers['x-forwarded-for'];
  if (!xff) return directIp;

  const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
  if (ips.length === 0) return directIp;

  // Walk from rightmost to find first untrusted IP
  for (let i = ips.length - 1; i >= 0; i--) {
    if (!trusted.has(ips[i])) {
      return ips[i];
    }
  }
  // All IPs are trusted — use leftmost (client)
  return ips[0];
}

function _isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function _normalizeIp(ip) {
  // Strip IPv6-mapped IPv4 prefix
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

export class RateLimiter {
  constructor({ max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS } = {}) {
    this._max = max;
    this._windowMs = windowMs;
    this._hits = new Map(); // ip → { timestamps: number[] }
    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref?.();
  }

  /**
   * Check and record a hit.
   * @returns {{ allowed: boolean, remaining: number, retryAfterMs?: number }}
   */
  check(ip) {
    const now = Date.now();
    let entry = this._hits.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      this._hits.set(ip, entry);
    }
    // Trim timestamps outside window
    const cutoff = now - this._windowMs;
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);

    if (entry.timestamps.length >= this._max) {
      const oldest = entry.timestamps[0];
      const retryAfterMs = oldest + this._windowMs - now;
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    entry.timestamps.push(now);
    return { allowed: true, remaining: this._max - entry.timestamps.length };
  }

  _cleanup() {
    const staleThreshold = Date.now() - STALE_MS;
    for (const [ip, entry] of this._hits) {
      if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1] < staleThreshold) {
        this._hits.delete(ip);
      }
    }
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  get size() {
    return this._hits.size;
  }
}
