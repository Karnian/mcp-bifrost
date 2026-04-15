import { spawn } from 'node:child_process';
import { BaseProvider } from './base.js';

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
    // we just POST each request. For SSE, we also open a GET stream for notifications (omitted for simplicity).
    // Handshake: send initialize to verify reachability.
    try {
      await this._rpcHttp('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mcp-bifrost', version: '0.1.0' },
      }, { timeoutMs: 5000 });
      // initialized notification
      this._rpcHttp('notifications/initialized', {}, { timeoutMs: 3000, notification: true }).catch(() => {});
      this._initialized = true;
    } catch (err) {
      this._initialized = false;
      throw err;
    }
  }

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

    try {
      const res = await fetch(this.httpConfig.url, {
        method: 'POST',
        headers: await this._buildHeaders(identity),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 401 && this._onUnauthorized && !_retry) {
        try { await this._onUnauthorized(identity || this._identity || 'default'); } catch (err) { throw new Error(`HTTP 401 and refresh failed: ${err.message}`); }
        return this._rpcHttp(method, params, { timeoutMs, notification, _retry: true, identity });
      }

      if (notification) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);

      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('text/event-stream')) {
        // Parse first JSON-RPC response event from SSE stream
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const msg = JSON.parse(line.slice(6));
              if (msg.id === id) {
                if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code });
                return msg.result;
              }
            } catch { /* continue */ }
          }
        }
        throw new Error('No matching response in SSE stream');
      }

      const msg = await res.json();
      if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code });
      return msg.result;
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
