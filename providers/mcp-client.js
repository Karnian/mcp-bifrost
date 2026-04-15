import { spawn } from 'node:child_process';
import { BaseProvider } from './base.js';
import { logger } from '../server/logger.js';

/**
 * Generic MCP Client Provider.
 * Connects to an upstream MCP server (stdio / http / sse) and proxies tools.
 *
 * Transport modes:
 * - stdio: spawns a child process and speaks JSON-RPC over stdin/stdout
 * - http:  TODO (Phase 5c)
 * - sse:   TODO (Phase 5c)
 */
export class McpClientProvider extends BaseProvider {
  constructor(workspaceConfig, { tokenProvider = null, onUnauthorized = null, identity = 'default' } = {}) {
    super(workspaceConfig);
    this.transport = workspaceConfig.transport; // "stdio" | "http" | "sse"
    this.stdioConfig = {
      command: workspaceConfig.command,
      args: workspaceConfig.args || [],
      env: workspaceConfig.env || {},
    };
    this.httpConfig = {
      url: workspaceConfig.url,
      headers: workspaceConfig.headers || {},
    };
    // Phase 7c-pre: tokenProvider / onUnauthorized accept an optional identity
    // argument. Provider-level identity default is supplied at construction;
    // call-site overrides (7c) will pass an explicit identity.
    this._tokenProvider = tokenProvider; // async (identity?) => string
    this._onUnauthorized = onUnauthorized; // async (identity?) => void
    this._identity = identity;

    // Runtime state
    this._child = null;
    this._nextRpcId = 1;
    this._pending = new Map(); // id → {resolve, reject}
    this._stdoutBuffer = '';
    this._stderrRing = []; // last 50 lines
    this._initialized = false;
    this._initializing = null; // Promise while initializing
    this._toolsCache = null; // cached tools/list
    this._restartCount = 0;
    this._lastRestartAt = 0;
    this._stopping = false;
    this._onToolsChanged = null;

    // Phase 7e: HTTP/SSE notification stream state
    this._sessionId = null;                // Mcp-Session-Id from server
    this._streamAbort = null;              // AbortController for active GET stream
    this._streamReconnectTimer = null;
    this._streamBackoffMs = 30_000;        // initial reconnect delay
    this._streamBackoffMaxMs = 5 * 60_000; // cap at 5 min
    this._streamConnected = false;
    this._streamStopping = false;
  }

  onToolsChanged(cb) { this._onToolsChanged = cb; }

  async _ensureConnected() {
    if (this._initialized) return;
    if (this._initializing) return this._initializing;
    this._initializing = this._connect().finally(() => { this._initializing = null; });
    return this._initializing;
  }

  async _connect() {
    if (this.transport === 'stdio') {
      return this._connectStdio();
    }
    if (this.transport === 'http' || this.transport === 'sse') {
      return this._connectHttp();
    }
    throw new Error(`Transport "${this.transport}" not supported`);
  }

  async _connectStdio() {
    if (!this.stdioConfig.command) {
      throw new Error('stdio: command is required');
    }

    const child = spawn(this.stdioConfig.command, this.stdioConfig.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.stdioConfig.env },
    });

    this._child = child;
    this._stopping = false;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => this._onStderr(chunk));

    child.on('exit', (code, signal) => this._onExit(code, signal));
    child.on('error', (err) => this._rejectAll(err));

    // initialize handshake
    try {
      await this._rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mcp-bifrost', version: '0.1.0' },
      }, { timeoutMs: 5000 });
      this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      this._initialized = true;
    } catch (err) {
      this._killChild();
      throw err;
    }
  }

  async _connectHttp() {
    if (!this.httpConfig.url) {
      throw new Error(`${this.transport}: url is required`);
    }
    // HTTP/SSE doesn't need a persistent connection for initialize in Streamable HTTP mode;
    // we just POST each request. For SSE, we also open a GET stream for notifications (Phase 7e).
    // Handshake: send initialize to verify reachability.
    try {
      await this._rpcHttp('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-bifrost', version: '0.1.0' },
      }, { timeoutMs: 5000 });
      // initialized notification
      this._rpcHttp('notifications/initialized', {}, { timeoutMs: 3000, notification: true }).catch(() => {});
      this._initialized = true;
      // Phase 7e: start long-lived GET stream for server-sent notifications.
      this._startNotificationStream();
    } catch (err) {
      this._initialized = false;
      throw err;
    }
  }

  /**
   * Phase 7e: open a long-lived GET /mcp (or /sse) with Accept: text/event-stream.
   * Parse `data:` lines and dispatch JSON-RPC responses/notifications.
   * On disconnect, reconnect with exponential backoff (30s → 5min).
   * 401 → call onUnauthorized then reconnect (fresh token).
   */
  _startNotificationStream() {
    if (this._streamStopping) return;
    if (this._streamAbort) return; // already running
    const url = this.httpConfig.url;
    const tag = `[McpClient:${this.id}]`;
    (async () => {
      try {
        const controller = new AbortController();
        this._streamAbort = controller;
        const headers = await this._buildHeaders();
        headers['Accept'] = 'text/event-stream';
        logger.debug(`${tag} stream: connecting ${url}`);
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        const sid = res.headers.get('mcp-session-id');
        if (sid) this._sessionId = sid;

        if (res.status === 401) {
          logger.warn(`${tag} stream: 401 unauthorized, attempting refresh + reconnect`);
          // Try refresh once, then reconnect
          if (this._onUnauthorized) {
            try { await this._onUnauthorized(this._identity || 'default'); } catch {}
          }
          this._scheduleStreamReconnect();
          return;
        }
        if (res.status === 405 || res.status === 404) {
          // Server doesn't support GET stream — give up silently (not all MCP
          // 2025-03-26 servers implement the optional GET endpoint).
          logger.debug(`${tag} stream: server does not support GET stream (${res.status}), disabling`);
          return;
        }
        if (!res.ok || !res.body) {
          logger.warn(`${tag} stream: unexpected status ${res.status}, reconnecting`);
          this._scheduleStreamReconnect();
          return;
        }
        this._streamConnected = true;
        this._streamBackoffMs = 30_000; // reset on successful connect
        logger.debug(`${tag} stream: connected (session=${sid || 'none'})`);
        await this._readSseStream(res.body);
        // Normal end → reconnect
        this._streamConnected = false;
        logger.debug(`${tag} stream: closed, scheduling reconnect`);
        this._scheduleStreamReconnect();
      } catch (err) {
        // AbortError → shutdown; otherwise reconnect
        this._streamConnected = false;
        if (err.name !== 'AbortError' && !this._streamStopping) {
          logger.warn(`${tag} stream: error ${err.message}, reconnecting`);
          this._scheduleStreamReconnect();
        }
      } finally {
        this._streamAbort = null;
      }
    })();
  }

  async _readSseStream(body) {
    // Node fetch body is a ReadableStream of Uint8Array.
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line. Accept both LF ("\n\n")
        // and CRLF ("\r\n\r\n") terminations to interoperate with servers
        // that emit the spec-compliant CRLF form.
        while (true) {
          const crlfIdx = buffer.indexOf('\r\n\r\n');
          const lfIdx = buffer.indexOf('\n\n');
          let sepIdx = -1; let sepLen = 0;
          if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) { sepIdx = crlfIdx; sepLen = 4; }
          else if (lfIdx !== -1) { sepIdx = lfIdx; sepLen = 2; }
          if (sepIdx === -1) break;
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + sepLen);
          const dataLines = rawEvent.split(/\r?\n/)
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, ''));
          if (dataLines.length === 0) continue;
          const payload = dataLines.join('\n');
          try {
            const msg = JSON.parse(payload);
            this._handleStreamMessage(msg);
          } catch { /* malformed event — drop */ }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  _handleStreamMessage(msg) {
    // Response to an outstanding request (matched by id) — route back to _pending
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'RPC error'), { code: msg.error.code }));
        else pending.resolve(msg.result);
      }
      return;
    }
    // Server notification
    if (msg.method === 'notifications/tools/list_changed') {
      this._toolsCache = null;
      if (this._onToolsChanged) this._onToolsChanged(this.id);
      return;
    }
    if (msg.method === 'notifications/resources/list_changed') {
      // passthrough — no cache to invalidate at this layer
      if (this._onToolsChanged) this._onToolsChanged(this.id);
      return;
    }
    // Server-initiated request (elicitations etc.) — spec range outside
    // Bifrost's current support. Drop and debug-log.
    if (msg.method && msg.id !== undefined) {
      // intentionally dropped — upstream servers must tolerate no response
    }
  }

  _scheduleStreamReconnect() {
    if (this._streamStopping) return;
    if (this._streamReconnectTimer) return;
    const delay = this._streamBackoffMs;
    this._streamBackoffMs = Math.min(this._streamBackoffMs * 2, this._streamBackoffMaxMs);
    logger.debug(`[McpClient:${this.id}] stream: reconnect scheduled in ${delay}ms`);
    this._streamReconnectTimer = setTimeout(() => {
      this._streamReconnectTimer = null;
      if (!this._streamStopping) this._startNotificationStream();
    }, delay);
    this._streamReconnectTimer.unref?.();
  }

  _stopNotificationStream() {
    this._streamStopping = true;
    if (this._streamReconnectTimer) {
      clearTimeout(this._streamReconnectTimer);
      this._streamReconnectTimer = null;
    }
    if (this._streamAbort) {
      try { this._streamAbort.abort(); } catch {}
      this._streamAbort = null;
    }
    this._streamConnected = false;
  }

  isStreamConnected() { return this._streamConnected; }

  async _buildHeaders(identity) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...this.httpConfig.headers,
    };
    if (this._tokenProvider) {
      // Phase 7c-pre: pass identity explicitly; provider-default when unspecified.
      const token = await this._tokenProvider(identity || this._identity || 'default');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    // Phase 7e: propagate Mcp-Session-Id once the server assigns one.
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;
    return headers;
  }

  async _rpcHttp(method, params, { timeoutMs = 30000, notification = false, _retry = false, identity } = {}) {
    const id = this._nextRpcId++;
    const body = notification
      ? { jsonrpc: '2.0', method, params: params || {} }
      : { jsonrpc: '2.0', id, method, params: params || {} };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();

    // Phase 7e: register the pending request BEFORE sending so that a response
    // can arrive via either the POST body OR the long-lived GET stream (per
    // Streamable HTTP spec: server MAY answer via the open notification stream
    // when the client has one open). The POST path still wins the race if it
    // returns the result directly.
    let streamResolver;
    const streamPromise = notification ? null : new Promise((resolve, reject) => {
      streamResolver = { resolve, reject };
      this._pending.set(id, streamResolver);
    });

    try {
      const res = await fetch(this.httpConfig.url, {
        method: 'POST',
        headers: await this._buildHeaders(identity),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Phase 7e: capture Mcp-Session-Id on any response (server MAY issue on initialize)
      const sid = res.headers.get('mcp-session-id');
      if (sid && sid !== this._sessionId) {
        this._sessionId = sid;
      }

      if (res.status === 401 && this._onUnauthorized && !_retry) {
        if (!notification) this._pending.delete(id);
        try { await this._onUnauthorized(identity || this._identity || 'default'); } catch (err) { throw new Error(`HTTP 401 and refresh failed: ${err.message}`); }
        return this._rpcHttp(method, params, { timeoutMs, notification, _retry: true, identity });
      }

      if (notification) return null;

      // 202 Accepted / 204 No Content → server will deliver the response via
      // the open SSE stream. Wait on the _pending promise (with an overall
      // timeout) instead of parsing the POST body.
      if (res.status === 202 || res.status === 204) {
        const streamTimer = setTimeout(() => {
          const p = this._pending.get(id);
          if (p) { this._pending.delete(id); p.reject(new Error(`RPC timeout via stream: ${method}`)); }
        }, timeoutMs);
        streamTimer.unref?.();
        try { return await streamPromise; } finally { clearTimeout(streamTimer); }
      }

      if (!res.ok) { this._pending.delete(id); throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`); }

      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('text/event-stream')) {
        // Inline SSE: server emits the response as one SSE event within the POST body.
        const text = await res.text();
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith('data:')) {
            const payload = line.replace(/^data:\s?/, '');
            try {
              const msg = JSON.parse(payload);
              if (msg.id === id) {
                this._pending.delete(id);
                if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code });
                return msg.result;
              }
            } catch { /* continue */ }
          }
        }
        this._pending.delete(id);
        throw new Error('No matching response in SSE stream');
      }

      const msg = await res.json();
      this._pending.delete(id);
      if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code });
      return msg.result;
    } catch (err) {
      // Clean up pending entry if still present
      if (!notification) this._pending.delete(id);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _onStdout(chunk) {
    this._stdoutBuffer += chunk;
    let idx;
    while ((idx = this._stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this._stdoutBuffer.slice(0, idx).trim();
      this._stdoutBuffer = this._stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._handleMessage(msg);
    }
  }

  _onStderr(chunk) {
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      this._stderrRing.push({ at: new Date().toISOString(), line });
      if (this._stderrRing.length > 50) this._stderrRing.shift();
    }
  }

  _handleMessage(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || 'RPC error'), { code: msg.error.code }));
        else pending.resolve(msg.result);
      }
      return;
    }
    // Notification from server
    if (msg.method) {
      if (msg.method === 'notifications/tools/list_changed') {
        this._toolsCache = null; // invalidate
        if (this._onToolsChanged) this._onToolsChanged(this.id);
      }
    }
  }

  _onExit(code, signal) {
    this._initialized = false;
    this._child = null;
    this._rejectAll(new Error(`Child process exited (code=${code}, signal=${signal})`));
    if (this._stopping) return;
    // Crash — trigger restart with backoff
    const now = Date.now();
    const MIN_RESTART_INTERVAL = 5000;
    if (now - this._lastRestartAt < MIN_RESTART_INTERVAL) {
      this._restartCount++;
    } else {
      this._restartCount = 1;
    }
    this._lastRestartAt = now;
    if (this._restartCount > 5) return; // give up

    const delay = Math.min(1000 * 2 ** (this._restartCount - 1), 30000);
    setTimeout(() => {
      if (!this._stopping) this._ensureConnected().catch(() => {});
    }, delay).unref();
  }

  _rejectAll(err) {
    for (const [, pending] of this._pending) pending.reject(err);
    this._pending.clear();
  }

  _send(obj) {
    if (!this._child || !this._child.stdin.writable) {
      throw new Error('Not connected');
    }
    this._child.stdin.write(JSON.stringify(obj) + '\n');
  }

  async _rpc(method, params, opts = {}) {
    if (this.transport === 'http' || this.transport === 'sse') {
      return this._rpcHttp(method, params, opts);
    }
    return this._rpcStdio(method, params, opts);
  }

  async _rpcStdio(method, params, { timeoutMs = 30000 } = {}) {
    const id = this._nextRpcId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      timer.unref();
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    this._send({ jsonrpc: '2.0', id, method, params: params || {} });
    return promise;
  }

  _killChild() {
    if (!this._child) return;
    this._stopping = true;
    try {
      this._child.kill('SIGTERM');
      setTimeout(() => {
        if (this._child) try { this._child.kill('SIGKILL'); } catch {}
      }, 2000).unref();
    } catch {}
    this._child = null;
    this._initialized = false;
  }

  async shutdown() {
    if (this.transport === 'stdio') this._killChild();
    this._stopNotificationStream();
    this._initialized = false;
    this._rejectAll(new Error('Shutting down'));
  }

  // --- BaseProvider interface ---

  getTools() {
    // Synchronous — return cached list (may be empty until first tools/list)
    return this._toolsCache || [];
  }

  async refreshTools() {
    await this._ensureConnected();
    const res = await this._rpc('tools/list', {});
    this._toolsCache = (res.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      readOnly: t.annotations?.readOnlyHint === true,
    }));
    return this._toolsCache;
  }

  async callTool(toolName, args = {}) {
    await this._ensureConnected();
    try {
      const res = await this._rpc('tools/call', { name: toolName, arguments: args });
      return res; // pass through content/isError from upstream
    } catch (err) {
      return {
        content: [{ type: 'text', text: err.message }],
        isError: true,
      };
    }
  }

  async healthCheck() {
    try {
      await this._ensureConnected();
      // ping for liveness
      await this._rpc('ping', {}, { timeoutMs: 3000 }).catch(() => {
        // Some servers don't implement ping; fallback to tools/list
        return this._rpc('tools/list', {}, { timeoutMs: 3000 });
      });
      return { ok: true, message: 'Connected' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async validateCredentials() {
    try {
      await this._ensureConnected();
      return true;
    } catch {
      return false;
    }
  }

  async capabilityCheck() {
    const result = { scopes: [], resources: { count: 0, samples: [] }, tools: [] };
    try {
      const tools = await this.refreshTools();
      result.resources.count = tools.length;
      result.resources.samples = tools.slice(0, 5).map((t) => ({ name: t.name, type: 'tool' }));
      result.tools = tools.map((t) => ({ name: t.name, usable: 'usable' }));
    } catch (err) {
      // If tools/list fails, mark all as unavailable
      result.tools = [];
    }
    return result;
  }

  getLogs() {
    return this._stderrRing.slice();
  }
}
