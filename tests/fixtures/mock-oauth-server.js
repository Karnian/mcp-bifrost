/**
 * Mock OAuth 2.0 + MCP server for Phase 6 integration tests.
 *
 * Implements a minimal but spec-compliant subset:
 *   - RFC 9728 /.well-known/oauth-protected-resource
 *   - RFC 8414 /.well-known/oauth-authorization-server
 *   - RFC 7591 /register (DCR) — can be disabled via opts
 *   - /authorize (auto-approves by redirecting with ?code&state)
 *   - /token (grant_type=authorization_code, refresh_token)
 *   - /mcp (Bearer validation + initialize/tools/list)
 *
 * Knobs (via `new MockOAuthServer(opts)`):
 *   dcrEnabled: boolean (default true)
 *   rotationEnabled: boolean (default true)  — issue new refresh_token on refresh
 *   expiresIn: seconds (default 3600)
 *   failNextTokenExchange: increments counter to force 4xx on next token call
 */

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class MockOAuthServer {
  constructor({ dcrEnabled = true, rotationEnabled = true, expiresIn = 3600 } = {}) {
    this.dcrEnabled = dcrEnabled;
    this.rotationEnabled = rotationEnabled;
    this.expiresIn = expiresIn;
    this.clients = new Map(); // client_id -> { authMethod, secret? }
    this.codes = new Map();   // code -> { clientId, challenge, redirectUri }
    this.tokens = new Map();  // access_token -> { clientId, expiresAt }
    this.refreshTokens = new Map(); // refresh_token -> { clientId }
    this.failNextTokenExchange = 0;
    this.server = null;
    this.baseUrl = null;
    this.requests = []; // log for assertions
  }

  async start() {
    this.server = createServer((req, res) => this._handle(req, res));
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async stop() {
    if (this._streamRes) { try { this._streamRes.end(); } catch {} }
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }

  /**
   * Phase 7e helper: push a server-sent event (JSON-RPC notification) to the
   * currently-open GET /mcp stream, if any.
   */
  pushNotification(notification) {
    if (!this._streamRes) return false;
    const payload = JSON.stringify({ jsonrpc: '2.0', ...notification });
    this._streamRes.write(`data: ${payload}\n\n`);
    return true;
  }

  _send(res, status, body, headers = {}) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(payload);
  }

  async _readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf-8');
  }

  async _handle(req, res) {
    const url = new URL(req.url, this.baseUrl);
    this.requests.push({ method: req.method, path: url.pathname });

    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return this._send(res, 200, {
        resource: `${this.baseUrl}/mcp`,
        authorization_servers: [this.baseUrl],
        bearer_methods_supported: ['header'],
      });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const meta = {
        issuer: this.baseUrl,
        authorization_endpoint: `${this.baseUrl}/authorize`,
        token_endpoint: `${this.baseUrl}/token`,
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
      };
      if (this.dcrEnabled) meta.registration_endpoint = `${this.baseUrl}/register`;
      return this._send(res, 200, meta);
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      if (!this.dcrEnabled) return this._send(res, 404, { error: 'not_found' });
      const body = JSON.parse(await this._readBody(req) || '{}');
      const clientId = `mock_${b64url(randomBytes(8))}`;
      this.clients.set(clientId, { authMethod: body.token_endpoint_auth_method || 'none' });
      return this._send(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      // Auto-approve: redirect with ?code&state
      const clientId = url.searchParams.get('client_id');
      const challenge = url.searchParams.get('code_challenge');
      const method = url.searchParams.get('code_challenge_method');
      const state = url.searchParams.get('state');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!clientId || !challenge || method !== 'S256' || !state || !redirectUri) {
        return this._send(res, 400, { error: 'invalid_request' });
      }
      const code = `code_${b64url(randomBytes(16))}`;
      this.codes.set(code, { clientId, challenge, redirectUri });
      const redir = new URL(redirectUri);
      redir.searchParams.set('code', code);
      redir.searchParams.set('state', state);
      res.writeHead(302, { Location: redir.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      if (this.failNextTokenExchange > 0) {
        this.failNextTokenExchange--;
        return this._send(res, 400, { error: 'invalid_grant' });
      }
      const raw = await this._readBody(req);
      const params = new URLSearchParams(raw);
      const grant = params.get('grant_type');
      if (grant === 'authorization_code') {
        const code = params.get('code');
        const entry = this.codes.get(code);
        if (!entry) return this._send(res, 400, { error: 'invalid_grant' });
        // Verify PKCE
        const verifier = params.get('code_verifier');
        const recomputed = b64url(createHash('sha256').update(verifier || '').digest());
        if (recomputed !== entry.challenge) return this._send(res, 400, { error: 'invalid_grant', error_description: 'pkce mismatch' });
        this.codes.delete(code);
        const access = `AT.${b64url(randomBytes(16))}`;
        const refresh = `RT.${b64url(randomBytes(16))}`;
        this.tokens.set(access, { clientId: entry.clientId, expiresAt: Date.now() + this.expiresIn * 1000 });
        this.refreshTokens.set(refresh, { clientId: entry.clientId });
        return this._send(res, 200, { access_token: access, refresh_token: refresh, expires_in: this.expiresIn, token_type: 'Bearer' });
      }
      if (grant === 'refresh_token') {
        const rt = params.get('refresh_token');
        const entry = this.refreshTokens.get(rt);
        if (!entry) return this._send(res, 400, { error: 'invalid_grant' });
        const access = `AT.${b64url(randomBytes(16))}`;
        this.tokens.set(access, { clientId: entry.clientId, expiresAt: Date.now() + this.expiresIn * 1000 });
        const body = { access_token: access, expires_in: this.expiresIn, token_type: 'Bearer' };
        if (this.rotationEnabled) {
          const newRt = `RT.${b64url(randomBytes(16))}`;
          this.refreshTokens.delete(rt);
          this.refreshTokens.set(newRt, { clientId: entry.clientId });
          body.refresh_token = newRt;
        }
        return this._send(res, 200, body);
      }
      return this._send(res, 400, { error: 'unsupported_grant_type' });
    }
    // Phase 7e: GET /mcp with Accept: text/event-stream opens a notification stream
    if (url.pathname === '/mcp' && req.method === 'GET') {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token || !this.tokens.has(token)) {
        return this._send(res, 401, { error: 'invalid_token' }, {
          'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
        });
      }
      const sid = this._streamSessionId || (this._streamSessionId = `sess_${b64url(randomBytes(8))}`);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Mcp-Session-Id': sid,
      });
      // Flush an initial comment line so the client's fetch resolves promptly
      // and the stream is confirmed connected before we push any events.
      res.write(': connected\n\n');
      this._streamRes = res;
      req.on('close', () => { this._streamRes = null; });
      return;
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token || !this.tokens.has(token)) {
        return this._send(res, 401, { error: 'invalid_token' }, {
          'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
        });
      }
      const raw = await this._readBody(req);
      const body = JSON.parse(raw);
      if (body.method === 'initialize') {
        return this._send(res, 200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } });
      }
      if (body.method === 'tools/list') {
        return this._send(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object', properties: {} } }] } });
      }
      if (body.method === 'ping') {
        return this._send(res, 200, { jsonrpc: '2.0', id: body.id, result: {} });
      }
      return this._send(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } });
    }
    this._send(res, 404, { error: 'not_found', path: url.pathname });
  }
}
