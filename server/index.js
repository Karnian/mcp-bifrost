import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WorkspaceManager } from './workspace-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { McpHandler } from './mcp-handler.js';
import { createAdminRoutes } from '../admin/routes.js';

const wm = new WorkspaceManager();
const tr = new ToolRegistry(wm);
const mcp = new McpHandler(wm, tr);

// Bump tool version when workspaces change
wm.onWorkspaceChange(() => tr.bumpVersion());

await wm.load();

// Run initial health checks in background
wm.testAll().catch(err => console.error('[Bifrost] Initial health check failed:', err.message));

const adminRoutes = createAdminRoutes(wm, tr);

function parseBearerToken(req) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
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

function authenticateMcp(req, res) {
  const mcpToken = wm.getMcpToken();
  if (!mcpToken) {
    // No MCP token configured → local-only mode
    return true;
  }
  const token = parseBearerToken(req);
  if (token === mcpToken) return true;
  jsonResponse(res, 401, { jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' } });
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // --- MCP Streamable HTTP ---
  if (path === '/mcp' && req.method === 'POST') {
    if (!authenticateMcp(req, res)) return;
    try {
      const body = await readBody(req);

      // Handle batch requests
      if (Array.isArray(body)) {
        const results = await Promise.all(body.map(r => mcp.handle(r)));
        jsonResponse(res, 200, results);
        return;
      }

      // Single request
      const result = await mcp.handle(body);

      // Notifications (no id) don't get responses
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
  console.log(`[Bifrost] Admin UI: http://localhost:${port}/admin/`);
  console.log(`[Bifrost] Workspaces loaded: ${wm.getWorkspaces().length}`);
});

export { wm, tr, mcp, server };
