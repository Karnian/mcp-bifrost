import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateAdmin, sendJson, readBody, isCommandAllowed } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createAdminRoutes(wm, tr, sse) {
  return async (req, res, url) => {
    const path = url.pathname;
    const method = req.method;

    // --- Static files for Admin UI ---
    if (path.startsWith('/admin')) {
      return serveStatic(req, res, path);
    }

    // --- Admin API ---
    if (!path.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not Found' } });
      return;
    }

    // Admin exposure guard (also applies to login)
    if (process.env.BIFROST_ADMIN_EXPOSE !== '1') {
      const addr = req.socket?.remoteAddress || '';
      const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
      if (!isLocal) {
        sendJson(res, 403, { ok: false, error: { code: 'ADMIN_LOCAL_ONLY', message: 'Admin API is restricted to localhost. Set BIFROST_ADMIN_EXPOSE=1 to allow remote access.' } });
        return;
      }
    }

    // Auth check (except POST /api/auth/login)
    if (path === '/api/auth/login' && method === 'POST') {
      return handleLogin(req, res, wm);
    }

    if (!authenticateAdmin(req, res, wm)) return;

    // Route matching
    try {
      // GET /api/workspaces
      if (path === '/api/workspaces' && method === 'GET') {
        const workspaces = wm.getWorkspaces();
        sendJson(res, 200, { ok: true, data: workspaces });
        return;
      }

      // POST /api/workspaces
      if (path === '/api/workspaces' && method === 'POST') {
        const body = await readBody(req);
        // Command whitelist enforcement for stdio mcp-client
        if (body.kind === 'mcp-client' && body.transport === 'stdio' && body.command) {
          if (!isCommandAllowed(body.command)) {
            sendJson(res, 403, { ok: false, error: { code: 'COMMAND_NOT_ALLOWED', message: `Command "${body.command}" is not in BIFROST_ALLOWED_COMMANDS whitelist` } });
            return;
          }
        }
        const ws = await wm.addWorkspace(body);
        sendJson(res, 201, { ok: true, data: wm.getWorkspace(ws.id) });
        return;
      }

      // GET /api/workspaces/deleted — list soft-deleted workspaces
      if (path === '/api/workspaces/deleted' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: wm.getDeletedWorkspaces() });
        return;
      }

      // POST /api/workspaces/test-all
      if (path === '/api/workspaces/test-all' && method === 'POST') {
        const results = await wm.testAll();
        sendJson(res, 200, { ok: true, data: results });
        return;
      }

      // Workspace-specific routes: /api/workspaces/:id
      const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
      if (wsMatch) {
        const id = decodeURIComponent(wsMatch[1]);

        if (method === 'GET') {
          const ws = wm.getWorkspace(id);
          if (!ws) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `Workspace '${id}' not found` } });
          sendJson(res, 200, { ok: true, data: ws });
          return;
        }

        if (method === 'PUT') {
          const body = await readBody(req);
          await wm.updateWorkspace(id, body);
          sendJson(res, 200, { ok: true, data: wm.getWorkspace(id) });
          return;
        }

        if (method === 'DELETE') {
          await wm.deleteWorkspace(id);
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      // POST /api/workspaces/:id/test
      const testMatch = path.match(/^\/api\/workspaces\/([^/]+)\/test$/);
      if (testMatch && method === 'POST') {
        const id = decodeURIComponent(testMatch[1]);
        const result = await wm.testConnection(id);
        sendJson(res, 200, { ok: true, data: result });
        return;
      }

      // POST /api/workspaces/:id/restore
      const restoreMatch = path.match(/^\/api\/workspaces\/([^/]+)\/restore$/);
      if (restoreMatch && method === 'POST') {
        const id = decodeURIComponent(restoreMatch[1]);
        const ws = await wm.restoreWorkspace(id);
        sendJson(res, 200, { ok: true, data: wm.getWorkspace(ws.id) });
        return;
      }

      // GET /api/status
      if (path === '/api/status' && method === 'GET') {
        const workspaces = wm.getWorkspaces();
        sendJson(res, 200, {
          ok: true,
          data: {
            version: '0.1.0',
            workspaces: workspaces.length,
            enabledWorkspaces: workspaces.filter(w => w.enabled).length,
            toolsVersion: tr.toolsVersion,
            totalTools: tr.getToolCount(),
            activeSessions: sse?.getSessionCount() || 0,
          },
        });
        return;
      }

      // GET /api/diagnostics
      if (path === '/api/diagnostics' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: wm.getDiagnostics() });
        return;
      }

      // GET /api/tools — all exposed tools across workspaces
      if (path === '/api/tools' && method === 'GET') {
        const tools = tr.getTools().map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          workspace: t._workspace,
          originalName: t._originalName,
        }));
        sendJson(res, 200, { ok: true, data: tools });
        return;
      }

      // GET /api/export — export config (credentials stripped)
      if (path === '/api/export' && method === 'GET') {
        const workspaces = wm.getWorkspaces({ masked: false }).map(ws => ({
          provider: ws.provider,
          namespace: ws.namespace,
          alias: ws.alias,
          displayName: ws.displayName,
          enabled: ws.enabled,
          toolFilter: ws.toolFilter,
          // Credentials excluded for security
        }));
        sendJson(res, 200, { ok: true, data: { workspaces, exportedAt: new Date().toISOString() } });
        return;
      }

      // POST /api/import — import config
      if (path === '/api/import' && method === 'POST') {
        const body = await readBody(req);
        const imported = body.workspaces || [];
        const results = [];
        for (const wsData of imported) {
          try {
            const ws = await wm.addWorkspace(wsData);
            results.push({ id: ws.id, status: 'created' });
          } catch (err) {
            results.push({ displayName: wsData.displayName, status: 'error', message: err.message });
          }
        }
        sendJson(res, 200, { ok: true, data: { results } });
        return;
      }

      // GET /api/connect-info — server info for connect guide
      if (path === '/api/connect-info' && method === 'GET') {
        const serverConfig = wm.getServerConfig();
        const tunnelConfig = wm.config.tunnel || {};
        const mcpTokenSet = !!wm.getMcpToken();
        sendJson(res, 200, {
          ok: true,
          data: {
            port: serverConfig.port || 3100,
            mcpEndpoint: `http://localhost:${serverConfig.port || 3100}/mcp`,
            sseEndpoint: `http://localhost:${serverConfig.port || 3100}/sse`,
            tunnelEnabled: tunnelConfig.enabled || false,
            tunnelUrl: tunnelConfig.fixedDomain || null,
            mcpTokenConfigured: mcpTokenSet,
          },
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'API endpoint not found' } });
    } catch (err) {
      const code = err.message.includes('not found') ? 'NOT_FOUND'
        : err.message.includes('immutable') ? 'NAMESPACE_IMMUTABLE'
        : err.message.includes('already exists') ? 'NAMESPACE_CONFLICT'
        : 'INTERNAL_ERROR';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 400;
      sendJson(res, status, { ok: false, error: { code, message: err.message } });
    }
  };
}

async function handleLogin(req, res, wm) {
  const body = await readBody(req);
  const adminToken = wm.getAdminToken();

  if (!adminToken) {
    sendJson(res, 200, { ok: true, data: { message: 'No admin token configured' } });
    return;
  }

  if (body.token === adminToken) {
    sendJson(res, 200, { ok: true, data: { message: 'Authenticated' } });
  } else {
    sendJson(res, 401, { ok: false, error: { code: 'INVALID_TOKEN', message: '토큰이 일치하지 않습니다' } });
  }
}

async function serveStatic(req, res, path) {
  let filePath = path.replace(/^\/admin\/?/, '') || 'index.html';
  if (!filePath || filePath === '' || !filePath.includes('.')) {
    filePath = 'index.html';
  }

  const fullPath = join(PUBLIC_DIR, filePath);
  try {
    const content = await readFile(fullPath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    // SPA fallback
    try {
      const index = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(index);
    } catch {
      sendJson(res, 404, { error: 'Admin UI not found' });
    }
  }
}
