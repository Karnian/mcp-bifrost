import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WorkspaceManager } from './workspace-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { McpHandler } from './mcp-handler.js';
import { SseManager } from './sse-manager.js';
import { createAdminRoutes, handleSlackOAuthCallback } from '../admin/routes.js';
import { OAuthManager } from './oauth-manager.js';
import { OAuthMetrics } from './oauth-metrics.js';
import { SlackOAuthManager } from './slack-oauth-manager.js';
import { setPublicOriginProvider, getPublicOriginOrNull } from './public-origin.js';
import { createHostGuard } from './host-guard.js';
import { McpTokenManager } from './mcp-token-manager.js';
import { UsageRecorder } from './usage-recorder.js';
import { AuditLogger } from './audit-logger.js';
import { escapeHtml } from './html-escape.js';
import { readBody as readBodyUtil } from './http-utils.js';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';
import { applySecurityHeaders } from './security-headers.js';
import { HEALTH_CHECK_INTERVAL_MS, HEADERS_TIMEOUT, REQUEST_TIMEOUT } from './config-constants.js';

const readBody = readBodyUtil;

function parseBearerToken(req) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function parseBearerFromQuery(url) {
  return url.searchParams.get('token') || null;
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Normalize a host setting into a de-duplicated, non-empty list.
 * Accepts a comma-separated string ("127.0.0.1,100.64.0.1") or an array.
 */
export function parseHosts(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const list = [...new Set(raw.map(h => String(h).trim()).filter(Boolean))];
  return list.length ? list : ['127.0.0.1'];
}

// Per-server close promise, shared by every caller (direct server.close(),
// stop(), bind-failure cleanup). `listening` flips to false as soon as close()
// is called — long before active connections drain — so it can't be used to
// tell "closed" from "closing".
const closeState = new WeakMap();

/**
 * Begin closing one server (idempotent). Resolves on the server's 'close'
 * event, i.e. after every connection has ended. A server that never listened
 * resolves immediately.
 */
export function beginClose(srv) {
  const existing = closeState.get(srv);
  if (existing) return existing;
  if (!srv.listening) return Promise.resolve();
  // Forget the entry once fully closed: later close() calls then get node's
  // native ERR_SERVER_NOT_RUNNING, and later closeServers() resolve at once.
  const done = new Promise((resolve) => srv.once('close', () => { closeState.delete(srv); resolve(); }));
  closeState.set(srv, done);
  (srv._bifrostNativeClose || srv.close).call(srv);
  srv.closeIdleConnections?.();
  return done;
}

/**
 * Close several http.Servers together. Closing starts on every listener up
 * front so none keeps accepting while another drains; long-lived sockets
 * (SSE streams never end on their own) are force-closed after `graceMs`.
 * Also waits for servers whose close was already in progress.
 */
export async function closeServers(servers, { graceMs = 5000 } = {}) {
  const pending = servers.map(beginClose);
  let timer;
  const force = new Promise((resolve) => {
    timer = setTimeout(() => {
      for (const srv of servers) srv.closeAllConnections?.();
      resolve();
    }, graceMs);
    timer.unref?.();
  });
  await Promise.race([Promise.all(pending), force]);
  clearTimeout(timer);
  await Promise.all(pending);
}

function isLocalhost(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function renderOAuthResultPage({ ok, title, message, nonce }) {
  const color = ok ? '#16a34a' : '#dc2626';
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;border-radius:12px;padding:2.5rem 3rem;max-width:480px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.3)}
h1{margin:0 0 .5rem;color:${color};font-size:1.5rem}
p{margin:.5rem 0;color:#94a3b8;line-height:1.6}
.hint{margin-top:1.5rem;font-size:.875rem;color:#64748b}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p>
<p class="hint">이 창을 닫고 Bifrost Admin UI 로 돌아가세요.</p></div>
<script${nonce ? ` nonce="${nonce}"` : ''}>setTimeout(()=>{try{window.close()}catch(e){}},4000)</script></body></html>`;
}

function oauthCspHeaders(nonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`,
  };
}

/**
 * Build and start the Bifrost HTTP server. Importing this module does NOT
 * auto-start — callers (CLI entry or tests) must invoke startServer() and are
 * responsible for tearing the returned server down via `server.close()`.
 */
async function startServer({ port: portOverride, host: hostOverride, configDir } = {}) {
  // Phase 12-4 §4.2 — configDir override so tests can boot a complete
  // server (including SlackOAuthManager wiring) against a tmpdir without
  // touching the real config/workspaces.json.
  const wm = configDir ? new WorkspaceManager({ configDir }) : new WorkspaceManager();
  const tr = new ToolRegistry(wm);
  const usage = new UsageRecorder();
  const audit = new AuditLogger();
  const mcp = new McpHandler(wm, tr, { usage });
  const sse = new SseManager();
  const oauthMetrics = new OAuthMetrics();
  const oauth = new OAuthManager(wm, { metrics: oauthMetrics });
  // Phase 12-4 §4.2 — SlackOAuthManager production wiring. Reuses the
  // same OAuthMetrics recorder so slack_install_total / slack_refresh_total
  // counters emerge alongside the mcp-client OAuth counters. Server
  // secret reuse is best-effort: if OAuthManager has not yet generated
  // its secret, SlackOAuthManager falls back to a process-private one,
  // which is fine because state HMAC verification is also process-local.
  const slackOAuth = new SlackOAuthManager(wm, {
    metrics: oauthMetrics,
    serverSecretProvider: () => oauth._getServerSecret(),
  });
  const tokenManager = new McpTokenManager(wm);
  wm.setOAuthManager(oauth);
  wm.setSlackOAuthManager(slackOAuth);
  wm.setAuditLogger?.(audit);
  // Phase 12 (UX 개선): wire wm-stored publicUrl into the OAuth resolver.
  // Resolution order at call time: BIFROST_PUBLIC_URL env > wm file value >
  // localhost fallback. Operators on a fresh checkout get OAuth working
  // without env vars; teams running in production set the env var to
  // bypass any UI mistake.
  setPublicOriginProvider(() => wm.getPublicUrl());

  wm.onWorkspaceChange(() => {
    tr.bumpVersion();
    sse.broadcastNotification('notifications/tools/list_changed');
  });

  await wm.load();

  oauth.purgeStalePending().catch(() => {});

  wm.testAll().catch(err => logger.error('[Bifrost] Initial health check failed:', err.message));

  const healthInterval = setInterval(() => {
    wm.testAll().catch(err => logger.error('[Bifrost] Background health check failed:', err.message));
  }, HEALTH_CHECK_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer — the listening
  // server handle is the one that holds the process open in production.
  healthInterval.unref?.();

  const adminRoutes = createAdminRoutes(wm, tr, sse, oauth, tokenManager, { usage, audit, oauthMetrics, slackOAuth });

  async function authenticateMcp(req, res, url) {
    if (!tokenManager.isConfigured()) {
      return null;
    }
    const token = parseBearerToken(req) || parseBearerFromQuery(url);
    if (!token) {
      jsonResponse(res, 401, { jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' } });
      return false;
    }
    const identity = await tokenManager.resolve(token);
    if (!identity) {
      jsonResponse(res, 401, { jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' } });
      return false;
    }
    return identity;
  }

  async function authenticateMcpSse(req, res, url) {
    if (!tokenManager.isConfigured()) {
      return null;
    }
    const token = parseBearerToken(req) || parseBearerFromQuery(url);
    if (!token) {
      res.writeHead(401);
      res.end('Unauthorized');
      return false;
    }
    const identity = await tokenManager.resolve(token);
    if (!identity) {
      res.writeHead(401);
      res.end('Unauthorized');
      return false;
    }
    return identity;
  }

  async function handleOAuthCallback(req, res, url) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const nonce = randomBytes(16).toString('base64');

    if (error) {
      res.writeHead(400, oauthCspHeaders(nonce));
      res.end(renderOAuthResultPage({
        ok: false,
        title: '인증 실패',
        message: `OAuth provider 오류: ${error}`,
        nonce,
      }));
      return;
    }

    if (!code || !state) {
      res.writeHead(400, oauthCspHeaders(nonce));
      res.end(renderOAuthResultPage({
        ok: false,
        title: '인증 실패',
        message: 'code 또는 state 파라미터가 누락되었습니다.',
        nonce,
      }));
      return;
    }

    try {
      const result = await oauth.completeAuthorization(state, code);
      // Phase 10a §4.10a-4 (Codex R2 blocker 1) — recover provider from any
      // prior stopped:auth_failed state so the refreshed tokens are actually
      // used.
      if (result?.workspaceId) {
        const provider = wm.getProvider?.(result.workspaceId);
        if (provider?.resetAuthState) {
          try { provider.resetAuthState({ identity: result.identity }); } catch { /* best-effort */ }
        }
        const ws = wm._getRawWorkspace?.(result.workspaceId);
        if (ws) {
          const identity = result.identity || 'default';
          if (ws.oauthActionNeededBy) ws.oauthActionNeededBy[identity] = false;
          if (identity === 'default') ws.oauthActionNeeded = false;
        }
      }
      tr.bumpVersion();
      sse.broadcastNotification('notifications/tools/list_changed');
      res.writeHead(200, oauthCspHeaders(nonce));
      res.end(renderOAuthResultPage({
        ok: true,
        title: '✓ 인증 완료',
        message: `${result.issuer} 에서 access_token 을 발급받았습니다.`,
        nonce,
      }));
    } catch (err) {
      wm.logError('oauth.callback', null, err.message);
      res.writeHead(400, oauthCspHeaders(nonce));
      res.end(renderOAuthResultPage({
        ok: false,
        title: '인증 실패',
        message: err.code === 'INVALID_STATE' ? 'state 검증 실패 (위조 또는 만료)'
          : err.code === 'STATE_EXPIRED' ? 'state 가 만료되었습니다 (10분 초과). 다시 시작하세요.'
          : err.code === 'STATE_NOT_FOUND' ? 'state 를 찾을 수 없습니다 (이미 사용되었거나 서버 재시작됨).'
          : `토큰 교환 실패: ${err.message}`,
        nonce,
      }));
    }
  }

  const hostGuard = createHostGuard({ getPublicOrigin: getPublicOriginOrNull });

  const handleRequest = async (req, res) => {
    applySecurityHeaders(res, req);

    // Parse against a fixed base: nothing below reads url.host/origin, and an
    // unparsable Host header (e.g. "[") used to throw here — before auth —
    // as an unhandled rejection that terminated the whole process.
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      jsonResponse(res, 400, { error: 'Bad Request' });
      return;
    }
    const path = url.pathname;

    // DNS-rebinding defense (MCP 2025-03-26 transport security): reject
    // foreign Origins everywhere; admin paths also require a known Host since
    // same-origin GETs carry no Origin.
    if (!hostGuard.originAllowed(req.headers.origin)) {
      jsonResponse(res, 403, { error: 'Forbidden', code: 'ORIGIN_NOT_ALLOWED' });
      return;
    }
    if ((path.startsWith('/api/') || path.startsWith('/admin')) && !hostGuard.hostAllowed(req.headers.host)) {
      jsonResponse(res, 403, { error: 'Forbidden', code: 'HOST_NOT_ALLOWED' });
      return;
    }

    if (req.method === 'OPTIONS' && process.env.BIFROST_CORS_ORIGIN) {
      res.writeHead(204);
      res.end();
      return;
    }

    // RFC 7231 §6.5.5 — preflight HEAD probes (e.g. Palantir M4-a worker
    // spawn check) need a defined response on POST-only / SSE endpoints.
    // POST-only `/mcp` answers 405 + Allow so the probe can decide
    // "endpoint live, method known"; `/sse` advertises SSE availability
    // (200 + Allow) without opening a long-lived stream session — note
    // that real GET /sse can be 401 when MCP auth is configured, so this
    // is not strict GET mirroring. Auth is intentionally skipped: the
    // probe response reveals nothing beyond what's already documented at
    // /admin and the spec.
    if (req.method === 'HEAD' && path === '/mcp') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    if (req.method === 'HEAD' && path === '/sse') {
      res.writeHead(200, { Allow: 'GET, HEAD, POST' });
      res.end();
      return;
    }

    if (path === '/mcp' && req.method === 'POST') {
      const identity = await authenticateMcp(req, res, url);
      if (identity === false) return;
      const profile = url.searchParams.get('profile') || null;
      try {
        const body = await readBody(req);

        if (Array.isArray(body)) {
          const results = await Promise.all(body.map(r => mcp.handle(r, { identity, profile })));
          jsonResponse(res, 200, results);
          return;
        }

        const result = await mcp.handle(body, { identity, profile });

        if (body.id === undefined || body.id === null) {
          res.writeHead(204);
          res.end();
          return;
        }

        jsonResponse(res, 200, result);
      } catch (err) {
        if (err.statusCode === 413) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Payload Too Large' } }));
          return;
        }
        jsonResponse(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err.message },
        });
      }
      return;
    }

    if (path === '/sse' && req.method === 'GET') {
      const identity = await authenticateMcpSse(req, res, url);
      if (identity === false) return;
      sse.createSession(res);
      return;
    }

    if (path === '/sse' && req.method === 'POST') {
      const identity = await authenticateMcp(req, res, url);
      if (identity === false) return;
      const profile = url.searchParams.get('profile') || null;
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId && sse.getSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }
      try {
        const body = await readBody(req);
        const result = await mcp.handle(body, { identity, profile });
        sse.sendToSession(sessionId, result);
        res.writeHead(202);
        res.end();
      } catch (err) {
        if (err.statusCode === 413) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Payload Too Large' } }));
          return;
        }
        jsonResponse(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err.message },
        });
      }
      return;
    }

    if (path === '/oauth/callback' && req.method === 'GET') {
      return handleOAuthCallback(req, res, url);
    }

    // Phase 12-5 — Slack OAuth install callback. Path is canonical
    // (must match BIFROST_PUBLIC_URL + SLACK_OAUTH_CALLBACK_PATH from
    // public-origin.js); we never auto-derive from Host.
    if (path === '/oauth/slack/callback' && req.method === 'GET') {
      return handleSlackOAuthCallback(req, res, url, { slackOAuth, sse, tr });
    }

    if (path.startsWith('/api/') || path.startsWith('/admin')) {
      return adminRoutes(req, res, url);
    }

    if (path === '/health') {
      jsonResponse(res, 200, { ok: true, version: '0.1.0' });
      return;
    }

    if (path === '/') {
      res.writeHead(302, { Location: '/admin/' });
      res.end();
      return;
    }

    jsonResponse(res, 404, { error: 'Not Found' });
  };

  // Last line of defense: node:http does not catch a rejected async request
  // listener, so any throw escaping a route would otherwise crash the hub.
  const requestHandler = (req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error(`[Bifrost] Unhandled request error on ${req.method} ${String(req.url).slice(0, 200)}: ${err?.message || err}`);
      if (!res.headersSent) {
        try { jsonResponse(res, 500, { error: 'Internal Server Error' }); } catch { res.destroy(); }
      } else {
        res.destroy();
      }
    });
  };

  let servers = [];
  const makeServer = ({ primary = false } = {}) => {
    const srv = createServer(requestHandler);
    srv.headersTimeout = HEADERS_TIMEOUT;
    srv.requestTimeout = REQUEST_TIMEOUT;
    // Keep node's close() contract (callback, ERR_SERVER_NOT_RUNNING) but
    // route it through the shared close promise. Closing the primary — the
    // legacy `server` handle — starts closing every extra listener at call
    // time, not on 'close' (which waits for the primary's SSE clients).
    const nativeClose = srv.close;
    srv._bifrostNativeClose = nativeClose;
    srv.close = function close(cb) {
      if (!closeState.has(srv) && !srv.listening) return nativeClose.call(srv, cb);
      beginClose(srv);
      if (primary) closeServers(servers.slice(1)).catch(() => { /* best effort */ });
      // Same as native: cb is a one-shot 'close' listener (this === srv).
      if (typeof cb === 'function') srv.once('close', cb);
      return srv;
    };
    return srv;
  };
  const server = makeServer({ primary: true });

  const port = portOverride ?? wm.getServerConfig().port ?? 3100;
  // BIFROST_HOST / server.host accept a comma-separated list (or an array) so
  // the hub can bind several specific interfaces (e.g. loopback + a Tailscale
  // address) without falling back to 0.0.0.0. The first entry is the primary
  // listener returned as `server`; extras share the same request handler.
  const hosts = parseHosts(hostOverride ?? process.env.BIFROST_HOST ?? wm.getServerConfig().host);
  const host = hosts[0];
  servers = [server, ...hosts.slice(1).map(() => makeServer())];

  const listenOn = (srv, listenPort, listenHost) => new Promise((resolve, reject) => {
    const onError = (err) => {
      srv.removeListener('listening', onListen);
      reject(err);
    };
    const onListen = () => {
      srv.removeListener('error', onError);
      const addr = srv.address();
      resolve(typeof addr === 'object' && addr ? addr.port : listenPort);
    };
    srv.once('error', onError);
    srv.once('listening', onListen);
    srv.listen(listenPort, listenHost);
  });

  let boundPort = null;
  try {
    boundPort = await listenOn(server, port, host);
    // Extras reuse the primary's bound port so port 0 (tests) stays consistent.
    for (let i = 1; i < hosts.length; i++) {
      await listenOn(servers[i], boundPort, hosts[i]);
    }
  } catch (err) {
    // listen() failed — clean up partially-built state so we don't leak
    // the healthInterval timer, file watcher, provider handles, or any
    // listener that did bind before the failure.
    await closeServers(servers, { graceMs: 0 });
    clearInterval(healthInterval);
    try { await wm.close?.(); } catch { /* best effort */ }
    for (const [, provider] of wm.providers ?? []) {
      try { await provider.shutdown?.(); } catch { /* best effort */ }
    }
    throw err;
  }

  const fmtHost = (h) => (h.includes(':') ? `[${h}]` : h);
  for (const h of hosts) {
    const base = `http://${fmtHost(h)}:${boundPort}`;
    logger.info(`[Bifrost] Server running on ${base}`);
    logger.info(`[Bifrost] MCP endpoint: POST ${base}/mcp`);
    logger.info(`[Bifrost] SSE endpoint: GET ${base}/sse`);
  }
  logger.info(`[Bifrost] Admin UI: http://${fmtHost(host)}:${boundPort}/admin/ (loopback clients only unless BIFROST_ADMIN_EXPOSE=1)`);
  logger.info(`[Bifrost] Workspaces loaded: ${wm.getWorkspaces().length}`);
  const isLoopbackHost = (h) => h === 'localhost' || h === '::1' || /^127\./.test(h);
  const nonLoopback = hosts.filter(h => !isLoopbackHost(h));
  if (nonLoopback.length > 0) {
    logger.warn('');
    logger.warn(`[Bifrost] ⚠️  Server is bound to a non-loopback interface: ${nonLoopback.join(', ')}`);
    if (!tokenManager.isConfigured()) {
      logger.warn('[Bifrost] ⚠️  No MCP tokens configured — MCP endpoint is OPEN. Issue a token via Admin UI or set BIFROST_MCP_TOKEN.');
    }
    if (!wm.getAdminToken()) {
      logger.warn('[Bifrost] ⚠️  BIFROST_ADMIN_TOKEN not set — Admin UI/API is UNPROTECTED on the network!');
    }
    logger.warn('');
  }

  server.on('close', () => {
    clearInterval(healthInterval);
    // Phase 11-9 (Codex R1 blocker) — direct server.close() callers
    // (anyone using the returned `server` handle without going through
    // `stop()`) still need the watcher + reload timer torn down.
    Promise.resolve(wm.close?.()).catch(() => { /* best effort */ });
  });

  async function stop() {
    clearInterval(healthInterval);
    // Phase 11-9 (post-OSS-publish) — close the file watcher BEFORE
    // tearing down providers so any pending hot-reload debounce timer
    // can't fire into a half-shut-down state. wm.close() is idempotent.
    try { await wm.close?.(); } catch { /* best effort */ }
    await closeServers(servers);
    for (const [, provider] of wm.providers ?? []) {
      try { await provider.shutdown?.(); } catch { /* best effort */ }
    }
    try { await usage.flush?.(); } catch { /* best effort */ }
    try { await audit.flush?.(); } catch { /* best effort */ }
  }

  return { wm, tr, mcp, sse, oauth, slackOAuth, tokenManager, usage, audit, server, servers, healthInterval, port: boundPort, host, hosts, stop };
}

// Auto-start only when executed as the entry point (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await startServer();
}

export { startServer, renderOAuthResultPage };
