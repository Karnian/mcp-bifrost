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
import { setPublicOriginProvider } from './public-origin.js';
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

  const server = createServer(async (req, res) => {
    applySecurityHeaders(res, req);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS' && process.env.BIFROST_CORS_ORIGIN) {
      res.writeHead(204);
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
  });

  server.headersTimeout = HEADERS_TIMEOUT;
  server.requestTimeout = REQUEST_TIMEOUT;

  const port = portOverride ?? wm.getServerConfig().port ?? 3100;
  const host = hostOverride ?? process.env.BIFROST_HOST ?? wm.getServerConfig().host ?? '127.0.0.1';

  let boundPort = null;
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        boundPort = typeof addr === 'object' && addr ? addr.port : port;
        const base = `http://${host}:${boundPort}`;
        const exposed = host === '0.0.0.0' || host === '::';
        logger.info(`[Bifrost] Server running on ${base}`);
        logger.info(`[Bifrost] MCP endpoint: POST ${base}/mcp`);
        logger.info(`[Bifrost] SSE endpoint: GET ${base}/sse`);
        logger.info(`[Bifrost] Admin UI: ${base}/admin/`);
        logger.info(`[Bifrost] Workspaces loaded: ${wm.getWorkspaces().length}`);
        if (exposed) {
          logger.warn('');
          logger.warn('[Bifrost] ⚠️  Server is bound to a public interface.');
          if (!tokenManager.isConfigured()) {
            logger.warn('[Bifrost] ⚠️  No MCP tokens configured — MCP endpoint is OPEN. Issue a token via Admin UI or set BIFROST_MCP_TOKEN.');
          }
          if (!wm.getAdminToken()) {
            logger.warn('[Bifrost] ⚠️  BIFROST_ADMIN_TOKEN not set — Admin UI/API is UNPROTECTED on the network!');
          }
          logger.warn('');
        }
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, host);
    });
  } catch (err) {
    // listen() failed — clean up partially-built state so we don't leak
    // the healthInterval timer, file watcher, or provider handles.
    clearInterval(healthInterval);
    try { await wm.close?.(); } catch { /* best effort */ }
    for (const [, provider] of wm.providers ?? []) {
      try { await provider.shutdown?.(); } catch { /* best effort */ }
    }
    throw err;
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
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    for (const [, provider] of wm.providers ?? []) {
      try { await provider.shutdown?.(); } catch { /* best effort */ }
    }
    try { await usage.flush?.(); } catch { /* best effort */ }
    try { await audit.flush?.(); } catch { /* best effort */ }
  }

  return { wm, tr, mcp, sse, oauth, slackOAuth, tokenManager, usage, audit, server, healthInterval, port: boundPort, host, stop };
}

// Auto-start only when executed as the entry point (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await startServer();
}

export { startServer, renderOAuthResultPage };
