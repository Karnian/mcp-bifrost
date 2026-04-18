/**
 * UsageRecorder — Phase 7g
 *
 * Append-only JSONL event log for MCP tool calls, rotated daily when a file
 * exceeds 10MB, purged after 30 days. Also maintains an in-memory rolling
 * aggregate for cheap Admin UI queries.
 *
 * Event shape:
 *   { t, identity, ws, tool, durationMs, ok }
 *
 * Security: chmod 0o600 on POSIX; Windows falls back to fileSecurityWarning.
 */

import { appendFile, chmod, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = join(__dirname, '..', '.ao', 'state');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 1000;

function todayStr(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export class UsageRecorder {
  constructor({ stateDir = DEFAULT_STATE_DIR, fileName = 'usage.jsonl', platform = process.platform, now = () => Date.now() } = {}) {
    this._stateDir = stateDir;
    this._path = join(stateDir, fileName);
    this._rotatedPrefix = fileName.replace(/\.jsonl$/, ''); // "usage" → usage-YYYYMMDD.jsonl
    this._platform = platform;
    this._now = now;
    this._queue = [];
    this._flushing = null;
    this._flushTimer = null;
    this._aggregate = new Map(); // key=`${identity}::${ws}::${tool}` → { count24h, count7d, errors, lastMs, lastAt }
    this._events24h = []; // sliding window for precise 24h/7d aggregation
    this._fileSecurityWarning = platform === 'win32';
  }

  getFilePath() { return this._path; }
  getFileSecurityWarning() { return this._fileSecurityWarning; }

  async _ensureDir() {
    if (!existsSync(this._stateDir)) await mkdir(this._stateDir, { recursive: true });
  }

  async _chmod0600(path) {
    if (this._platform === 'win32') { this._fileSecurityWarning = true; return; }
    try { await chmod(path, 0o600); } catch { /* best effort */ }
  }

  /**
   * Enqueue an event. Guarantees to flush within FLUSH_INTERVAL_MS.
   * Synchronous — does not block the caller on disk I/O.
   */
  record({ identity = 'anonymous', workspaceId = null, tool = null, durationMs = 0, ok = true, t = new Date(this._now()).toISOString() } = {}) {
    const event = { t, identity, ws: workspaceId, tool, durationMs, ok };
    this._queue.push(event);
    this._updateAggregate(event);
    this._scheduleFlush();
    return event;
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    this._flushTimer.unref?.();
  }

  /**
   * Flush queued events to disk, rotating if needed.
   * Reentrant-safe: if a flush is already in flight, chains a follow-up pass
   * that drains events enqueued during the in-flight flush. Only one pending
   * follow-up is tracked to avoid unbounded recursion.
   */
  async flush() {
    if (this._flushing) {
      if (!this._pendingFlush) {
        this._pendingFlush = this._flushing.then(() => {
          this._pendingFlush = null;
          return this.flush();
        });
      }
      return this._pendingFlush;
    }
    const batch = this._queue.splice(0, this._queue.length);
    if (batch.length === 0) return;
    this._flushing = (async () => {
      await this._ensureDir();
      await this._rotateIfNeeded();
      const lines = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
      await appendFile(this._path, lines, 'utf-8');
      await this._chmod0600(this._path);
      await this._purgeOldRotations();
    })().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  async _rotateIfNeeded() {
    if (!existsSync(this._path)) return;
    try {
      const st = await stat(this._path);
      if (st.size < MAX_FILE_BYTES) return;
      const rotated = join(this._stateDir, `${this._rotatedPrefix}-${todayStr(new Date(this._now()))}.jsonl`);
      // If a rotated file for today already exists, append a counter suffix.
      let target = rotated;
      let counter = 1;
      while (existsSync(target)) {
        target = rotated.replace(/\.jsonl$/, `.${counter++}.jsonl`);
      }
      await rename(this._path, target);
      await this._chmod0600(target);
    } catch { /* best effort */ }
  }

  async _purgeOldRotations() {
    try {
      const entries = await readdir(this._stateDir);
      const cutoff = this._now() - RETENTION_MS;
      for (const name of entries) {
        if (!name.startsWith(`${this._rotatedPrefix}-`) || !name.endsWith('.jsonl')) continue;
        const p = join(this._stateDir, name);
        const st = await stat(p).catch(() => null);
        if (!st) continue;
        if (st.mtimeMs < cutoff) {
          await unlink(p).catch(() => {});
        }
      }
    } catch { /* best effort */ }
  }

  _updateAggregate(event) {
    const key = `${event.identity}::${event.ws || ''}::${event.tool || ''}`;
    let agg = this._aggregate.get(key);
    if (!agg) {
      agg = { identity: event.identity, ws: event.ws, tool: event.tool, count24h: 0, count7d: 0, errors: 0, totalMs: 0, lastAt: event.t };
      this._aggregate.set(key, agg);
    }
    this._events24h.push({ t: Date.parse(event.t), key, durationMs: event.durationMs, ok: event.ok });
    this._trimWindow();
    // Recount rolling windows from window list
    // (O(n) per record; acceptable for moderate traffic and keeps this precise.)
    agg.count24h = 0; agg.count7d = 0; agg.errors = 0; agg.totalMs = 0;
    for (const e of this._events24h) {
      if (e.key !== key) continue;
      agg.count7d++;
      if (!e.ok) agg.errors++;
      agg.totalMs += e.durationMs;
      if (this._now() - e.t <= 24 * 60 * 60 * 1000) agg.count24h++;
    }
    agg.lastAt = event.t;
  }

  _trimWindow() {
    const cutoff = this._now() - 7 * 24 * 60 * 60 * 1000;
    while (this._events24h.length && this._events24h[0].t < cutoff) {
      this._events24h.shift();
    }
  }

  /**
   * Aggregate window query.
   * @param {{ since?: '24h'|'7d', by?: 'workspace'|'token'|'tool' }} opts
   * @returns {Array<{ key, count, avgMs, errorRate, lastAt, ... }>}
   */
  query({ since = '24h', by = 'tool' } = {}) {
    this._trimWindow();
    const windowMs = since === '7d' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const cutoff = this._now() - windowMs;
    const buckets = new Map();
    for (const e of this._events24h) {
      if (e.t < cutoff) continue;
      const agg = this._aggregate.get(e.key);
      if (!agg) continue;
      const groupKey = by === 'workspace' ? (agg.ws || '-')
        : by === 'token' ? (agg.identity || '-')
        : (agg.tool || '-');
      let b = buckets.get(groupKey);
      if (!b) {
        b = { key: groupKey, count: 0, errors: 0, totalMs: 0, lastAt: null };
        buckets.set(groupKey, b);
      }
      b.count++;
      if (!e.ok) b.errors++;
      b.totalMs += e.durationMs;
      b.lastAt = agg.lastAt;
    }
    return Array.from(buckets.values())
      .map(b => ({
        key: b.key,
        count: b.count,
        avgMs: b.count > 0 ? Math.round(b.totalMs / b.count) : 0,
        errorRate: b.count > 0 ? b.errors / b.count : 0,
        errors: b.errors,
        lastAt: b.lastAt,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** Top-level summary for Admin UI. */
  topSummary({ since = '24h' } = {}) {
    return {
      since,
      topTools: this.query({ since, by: 'tool' }).slice(0, 10),
      topIdentities: this.query({ since, by: 'token' }).slice(0, 5),
      topWorkspaces: this.query({ since, by: 'workspace' }).slice(0, 10),
    };
  }

  /** Read raw events from disk, newest first. Used for debugging / export. */
  async readRecent({ limit = 100 } = {}) {
    if (!existsSync(this._path)) return [];
    const raw = await readFile(this._path, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* skip */ }
    }
    return out;
  }
}
