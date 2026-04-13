import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateAdmin, sendJson, readBody } from './auth.js';

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

export function createAdminRoutes(wm, tr) {
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
        const ws = await wm.addWorkspace(body);
        sendJson(res, 201, { ok: true, data: wm.getWorkspace(ws.id) });
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
