/**
 * AuditLogger — Phase 7g
 *
 * Append-only JSONL audit log at `.ao/state/audit.jsonl`, parallel to
 * WorkspaceManager's in-memory ring buffer (which is preserved for
 * back-compat). Same rotation rules as UsageRecorder (10MB, 30-day purge,
 * chmod 0o600).
 *
 * Event shape: { t, action, identity, workspace, details }
 */

import { appendFile, chmod, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitize } from './oauth-sanitize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = join(__dirname, '..', '.ao', 'state');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 500;

function todayStr(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export class AuditLogger {
  constructor({ stateDir = DEFAULT_STATE_DIR, fileName = 'audit.jsonl', platform = process.platform, now = () => Date.now() } = {}) {
    this._stateDir = stateDir;
    this._path = join(stateDir, fileName);
    this._rotatedPrefix = fileName.replace(/\.jsonl$/, '');
    this._platform = platform;
    this._now = now;
    this._queue = [];
    this._flushing = null;
    this._flushTimer = null;
    this._fileSecurityWarning = platform === 'win32';
  }

  getFilePath() { return this._path; }

  async _ensureDir() {
    if (!existsSync(this._stateDir)) await mkdir(this._stateDir, { recursive: true });
  }

  async _chmod0600(path) {
    if (this._platform === 'win32') { this._fileSecurityWarning = true; return; }
    try { await chmod(path, 0o600); } catch { /* best effort */ }
  }

  record({ action, identity = null, workspace = null, details = '' } = {}) {
    const event = {
      t: new Date(this._now()).toISOString(),
      action,
      identity,
      workspace,
      details: sanitize(typeof details === 'string' ? details : JSON.stringify(details)),
    };
    this._queue.push(event);
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

  async flush() {
    if (this._flushing) return this._flushing;
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
      let target = rotated;
      let counter = 1;
      while (existsSync(target)) {
        target = rotated.replace(/\.jsonl$/, `.${counter++}.jsonl`);
      }
      await rename(this._path, target);
      await this._chmod0600(target);
    } catch {}
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
        if (st.mtimeMs < cutoff) await unlink(p).catch(() => {});
      }
    } catch {}
  }

  /**
   * Tail the audit log newest-first with optional filters.
   * @param {{ limit?: number, actionPrefix?: string, identity?: string, workspace?: string }} opts
   */
  async tail({ limit = 100, actionPrefix = null, identity = null, workspace = null } = {}) {
    if (!existsSync(this._path)) return [];
    const raw = await readFile(this._path, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (actionPrefix && !(e.action || '').startsWith(actionPrefix)) continue;
      if (identity && e.identity !== identity) continue;
      if (workspace && e.workspace !== workspace) continue;
      out.push(e);
    }
    return out;
  }
}
