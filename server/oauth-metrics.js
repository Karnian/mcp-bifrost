/**
 * Phase 11-4 §6-OBS.2 — lightweight in-memory counter aggregator for OAuth
 * observability (client registration, cache, refresh, fail-fast).
 *
 * Process-memory only. No persistence, no Prometheus export — those are
 * deferred. Keeps the dependency surface zero beyond stdlib so this module
 * can be wired into any OAuthManager or admin route without new devdeps.
 *
 * Design:
 *   - `inc(name, labels, delta)` is the single mutation entry; it stably
 *     serializes label keys (sorted) so two call sites using the same
 *     name+labels land on the same counter regardless of property order.
 *   - `snapshot()` returns a defensive copy array (Admin UI sorts client-
 *     side). Counters are never mutated through the snapshot.
 *   - `reset()` is test-only and not referenced by production code paths.
 *
 * Counters defined by the plan (see docs/OAUTH_CLIENT_ISOLATION_PLAN.md §6-OBS.2):
 *   oauth_threshold_trip_total   {workspace, identity}
 *   oauth_dcr_total              {workspace, issuer, status}         status: "200" | "4xx" | "5xx" | "429"
 *   oauth_refresh_total          {workspace, identity, status}       status: "ok" | "fail_4xx" | "fail_net"
 *   oauth_cache_hit_total        {workspace}
 *   oauth_cache_miss_total       {workspace}
 */

function stableStringify(labels) {
  if (!labels || typeof labels !== 'object') return '{}';
  const keys = Object.keys(labels).sort();
  const parts = [];
  for (const k of keys) {
    const v = labels[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(String(v))}`);
  }
  return `{${parts.join(',')}}`;
}

export class OAuthMetrics {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=10000] — soft cap on the counter Map.
   *   When exceeded, oldest-insertion entries are evicted one at a time
   *   (Map preserves insertion order). A running Bifrost with churn on
   *   workspace/identity/issuer labels can otherwise grow unbounded since
   *   the recorder is process-memory only. Set to 0 to disable the cap
   *   (tests).
   */
  constructor({ maxEntries = 10_000 } = {}) {
    this._counters = new Map();
    this._maxEntries = Math.max(0, maxEntries | 0);
  }

  inc(name, labels = {}, delta = 1) {
    if (typeof name !== 'string' || !name) return;
    if (!Number.isFinite(delta) || delta <= 0) return;
    const key = `${name}|${stableStringify(labels)}`;
    const existing = this._counters.get(key);
    if (existing) {
      existing.value += delta;
      return;
    }
    const normalized = {};
    for (const k of Object.keys(labels || {})) {
      const v = labels[k];
      if (v === undefined || v === null || v === '') continue;
      normalized[k] = String(v);
    }
    this._counters.set(key, { name, labels: normalized, value: delta });
    // Phase 11-6 §9 — soft cap. Evict the oldest insertion-order entries
    // until size fits. The cap is only hit by pathological high-cardinality
    // churn (workspace/identity/issuer tuples never stabilize); the
    // expected steady-state label space is tiny.
    if (this._maxEntries > 0) {
      while (this._counters.size > this._maxEntries) {
        const firstKey = this._counters.keys().next().value;
        if (firstKey === undefined) break;
        this._counters.delete(firstKey);
      }
    }
  }

  snapshot() {
    return Array.from(this._counters.values()).map(c => ({
      name: c.name,
      labels: { ...c.labels },
      value: c.value,
    }));
  }

  reset() {
    this._counters.clear();
  }

  /**
   * Phase 11-6 §9 — drop every counter whose `workspace` label matches the
   * supplied id. Called from OAuthManager.removeClient() so hard-delete
   * and TTL-expire paths of WorkspaceManager also purge stale metrics
   * entries. Returns the number of entries removed so callers (or tests)
   * can surface the effect.
   */
  pruneWorkspace(workspaceId) {
    if (!workspaceId) return 0;
    const target = String(workspaceId);
    let removed = 0;
    for (const [key, entry] of this._counters) {
      if (entry.labels?.workspace === target) {
        this._counters.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Observability: how many counter entries are currently resident. Admin
   * UI + tests can use this to sanity-check the soft cap + prune paths.
   */
  size() {
    return this._counters.size;
  }
}

/**
 * Map an HTTP status code into one of the four label buckets used by
 * `oauth_dcr_total`. Keeps the bucket set small so cardinality stays
 * bounded. Network/unknown failures use "5xx" for parity with the
 * refresh-fail "fail_net" bucket — they share the "transient, retry"
 * semantics so users can diff the two counters to isolate reach-ability.
 */
export function dcrStatusBucket(status) {
  if (status === 429) return '429';
  if (typeof status !== 'number' || !Number.isFinite(status)) return '5xx';
  if (status >= 200 && status < 300) return '200';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}
