import { createServer } from 'node:http';
import { WorkspaceManager } from './workspace-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { McpHandler } from './mcp-handler.js';
import { SseManager } from './sse-manager.js';
import { createAdminRoutes } from '../admin/routes.js';

const wm = new WorkspaceManager();
const tr = new ToolRegistry(wm);
const mcp = new McpHandler(wm, tr);
const sse = new SseManager();

// Bump tool version + notify SSE clients when workspaces change
wm.onWorkspaceChange(() => {
  tr.bumpVersion();
  sse.broadcastNotification('notifications/tools/list_changed');
});

await wm.load();

// Run initial health checks in background
wm.testAll().catch(err => console.error('[Bifrost] Initial health check failed:', err.message));

// Background healthCheck every 5 minutes
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
setInterval(() => {
  wm.testAll().catch(err => console.error('[Bifrost] Background health check failed:', err.message));
}, HEALTH_CHECK_INTERVAL);

const adminRoutes = createAdminRoutes(wm, tr, sse);

function parseBearerToken(req) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function parseBearerFromQuery(url) {
  return url.searchParams.get('token') || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
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

function authenticateMcp(req, res, url) {
  const mcpToken = wm.getMcpToken();
  if (!mcpToken) {
    if (!isLocalhost(req)) {
      jsonResponse(res, 403, { jsonrpc: '2.0', error: { code: -32600, message: 'MCP token not configured. Only localhost access allowed.' } });
      return false;
    }
    return true;
  }
  const token = parseBearerToken(req) || parseBearerFromQuery(url);
  if (token === mcpToken) return true;
  jsonResponse(res, 401, { jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' } });
  return false;
}

function authenticateMcpSse(req, res, url) {
  const mcpToken = wm.getMcpToken();
  if (!mcpToken) {
    if (!isLocalhost(req)) {
      res.writeHead(403);
      res.end('MCP token not configured. Only localhost access allowed.');
      return false;
    }
    return true;
  }
  const token = parseBearerToken(req) || parseBearerFromQuery(url);
  if (token === mcpToken) return true;
  res.writeHead(401);
  res.end('Unauthorized');
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // --- MCP Streamable HTTP ---
  if (path === '/mcp' && req.method === 'POST') {
    if (!authenticateMcp(req, res, url)) return;
    const profile = url.searchParams.get('profile') || null;
    try {
      const body = await readBody(req);

      if (Array.isArray(body)) {
        const results = await Promise.all(body.map(r => mcp.handle(r, { profile })));
        jsonResponse(res, 200, results);
        return;
      }

      const result = await mcp.handle(body, { profile });

      if (body.id === undefined || body.id === null) {
        res.writeHead(204);
        res.end();
        return;
      }

      jsonResponse(res, 200, result);
    } catch (err) {
      jsonResponse(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err.message },
      });
    }
    return;
  }

  // --- SSE Transport ---
  if (path === '/sse' && req.method === 'GET') {
    if (!authenticateMcpSse(req, res, url)) return;
    sse.createSession(res);
    return;
  }

  if (path === '/sse' && req.method === 'POST') {
    if (!authenticateMcp(req, res, url)) return;
    const sessionId = url.searchParams.get('sessionId');
    const session = sessionId && sse.getSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return;
    }
    try {
      const body = await readBody(req);
      const result = await mcp.handle(body);
      // Send response back via SSE
      sse.sendToSession(sessionId, result);
      // Acknowledge the POST
      res.writeHead(202);
      res.end();
    } catch (err) {
      jsonResponse(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err.message },
      });
    }
    return;
  }

  // --- Admin API & UI ---
  if (path.startsWith('/api/') || path.startsWith('/admin')) {
    return adminRoutes(req, res, url);
  }

  // --- Health endpoint ---
  if (path === '/health') {
    jsonResponse(res, 200, { ok: true, version: '0.1.0' });
    return;
  }

  // --- Root redirect ---
  if (path === '/') {
    res.writeHead(302, { Location: '/admin/' });
    res.end();
    return;
  }

  jsonResponse(res, 404, { error: 'Not Found' });
});

const port = wm.getServerConfig().port || 3100;
server.listen(port, () => {
  console.log(`[Bifrost] Server running on http://localhost:${port}`);
  console.log(`[Bifrost] MCP endpoint: POST http://localhost:${port}/mcp`);
  console.log(`[Bifrost] SSE endpoint: GET http://localhost:${port}/sse`);
  console.log(`[Bifrost] Admin UI: http://localhost:${port}/admin/`);
  console.log(`[Bifrost] Workspaces loaded: ${wm.getWorkspaces().length}`);
});

export { wm, tr, mcp, sse, server };
