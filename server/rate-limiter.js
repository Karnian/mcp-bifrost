/**
 * Sliding-window rate limiter (IP-based, in-memory).
 * Designed for Admin API brute-force protection, not DDoS defense.
 * Single process assumption — no shared state.
 */

const DEFAULT_MAX = 10;
const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minute
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_MS = 60 * 60 * 1000; // 1 hour

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
