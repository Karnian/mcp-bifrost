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

export function createAdminRoutes(wm, tr, sse, oauth, tokenManager = null) {
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

      // POST /api/workspaces/:id/authorize — OAuth initialize (discovery + DCR + authorizationUrl)
      const authMatch = path.match(/^\/api\/workspaces\/([^/]+)\/authorize$/);
      if (authMatch && method === 'POST') {
        if (!oauth) return sendJson(res, 500, { ok: false, error: { code: 'OAUTH_NOT_CONFIGURED' } });
        const id = decodeURIComponent(authMatch[1]);
        const body = await readBody(req).catch(() => ({}));
        const ws = wm._getRawWorkspace(id);
        if (!ws) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `Workspace '${id}' not found` } });
        if (ws.kind !== 'mcp-client' || (ws.transport !== 'http' && ws.transport !== 'sse')) {
          return sendJson(res, 400, { ok: false, error: { code: 'OAUTH_UNAVAILABLE', message: 'OAuth requires mcp-client HTTP/SSE transport' } });
        }
        try {
          // Discovery (use cached when metadataCache is present + not forced)
          const force = body?.forceDiscovery === true;
          let asMetadata = ws.oauth?.metadataCache;
          let issuer = ws.oauth?.issuer;
          let resource = ws.oauth?.resource;
          if (!asMetadata || force) {
            const disc = await oauth.discover(ws.url, { wwwAuthenticate: body?.wwwAuthenticate });
            issuer = disc.issuer;
            asMetadata = disc.authServerMetadata;
            resource = disc.resource;
            ws.oauth = { ...(ws.oauth || {}), enabled: true, issuer, resource, metadataCache: asMetadata };
          }
          // Register
          let authMethod = ws.oauth?.authMethod;
          let clientId = ws.oauth?.clientId;
          let clientSecret = ws.oauth?.clientSecret || null;
          if (!clientId || body?.forceRegister) {
            if (body?.manual && body.manual.clientId) {
              const reg = await oauth.registerManual(issuer, body.manual);
              clientId = reg.clientId; clientSecret = reg.clientSecret; authMethod = reg.authMethod;
            } else {
              const reg = await oauth.registerClient(issuer, asMetadata, { reuse: body?.reuse !== false });
              clientId = reg.clientId; clientSecret = reg.clientSecret; authMethod = reg.authMethod;
            }
            ws.oauth = { ...ws.oauth, clientId, clientSecret, authMethod };
          }
          await wm._save();

          const init = await oauth.initializeAuthorization(id, {
            issuer,
            clientId,
            clientSecret,
            authMethod,
            authServerMetadata: asMetadata,
            resource,
            scope: body?.scope,
          });
          sendJson(res, 200, { ok: true, data: { authorizationUrl: init.authorizationUrl, issuer, clientId, authMethod, fileSecurityWarning: oauth.getFileSecurityWarning() } });
        } catch (err) {
          const code = err.code || 'OAUTH_ERROR';
          const status = code === 'DCR_UNSUPPORTED' ? 422 : code === 'DCR_FAILED' ? 502 : 500;
          sendJson(res, status, { ok: false, error: { code, message: err.message } });
        }
        return;
      }

      // POST /api/oauth/discover — standalone discovery for Wizard preview
      if (path === '/api/oauth/discover' && method === 'POST') {
        if (!oauth) return sendJson(res, 500, { ok: false, error: { code: 'OAUTH_NOT_CONFIGURED' } });
        const body = await readBody(req);
        if (!body?.url) return sendJson(res, 400, { ok: false, error: { code: 'MISSING_URL' } });
        try {
          const disc = await oauth.discover(body.url, { wwwAuthenticate: body.wwwAuthenticate });
          const cached = await oauth.getCachedClient(disc.issuer, oauth.pickAuthMethod(disc.authServerMetadata));
          sendJson(res, 200, { ok: true, data: {
            issuer: disc.issuer,
            resource: disc.resource,
            dcrSupported: !!disc.authServerMetadata.registration_endpoint,
            methodsSupported: disc.authServerMetadata.token_endpoint_auth_methods_supported || [],
            authorizationEndpoint: disc.authServerMetadata.authorization_endpoint,
            tokenEndpoint: disc.authServerMetadata.token_endpoint,
            cachedClient: cached ? { clientId: cached.clientId, authMethod: cached.authMethod, source: cached.source } : null,
            metadataCache: disc.authServerMetadata,
          } });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: { code: 'DISCOVERY_FAILED', message: err.message } });
        }
        return;
      }

      // GET /api/oauth/audit — oauth audit events
      if (path === '/api/oauth/audit' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: wm.oauthAuditLog || [] });
        return;
      }

      // GET /api/oauth/security — fileSecurityWarning flag
      if (path === '/api/oauth/security' && method === 'GET') {
        sendJson(res, 200, { ok: true, data: {
          fileSecurityWarning: wm.fileSecurityWarning || oauth?.getFileSecurityWarning?.() || false,
          platform: process.platform,
        } });
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
            totalTools: await tr.getToolCount(),
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
        const tools = (await tr.getTools()).map(t => ({
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

      // --- Phase 7b: MCP token management ---
      if (path === '/api/tokens' && method === 'GET') {
        if (!tokenManager) return sendJson(res, 500, { ok: false, error: { code: 'TOKEN_MANAGER_UNAVAILABLE' } });
        sendJson(res, 200, { ok: true, data: tokenManager.list() });
        return;
      }
      if (path === '/api/tokens' && method === 'POST') {
        if (!tokenManager) return sendJson(res, 500, { ok: false, error: { code: 'TOKEN_MANAGER_UNAVAILABLE' } });
        const body = await readBody(req);
        try {
          const { id, plaintext, entry } = await tokenManager.issue({
            id: body.id,
            description: body.description,
            allowedWorkspaces: body.allowedWorkspaces,
            allowedProfiles: body.allowedProfiles,
          });
          sendJson(res, 201, { ok: true, data: { id, plaintext, entry, warning: 'plaintext 는 지금 한 번만 보여집니다. 이후 복구 불가.' } });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: { code: 'TOKEN_ISSUE_FAILED', message: err.message } });
        }
        return;
      }
      const tokenMatch = path.match(/^\/api\/tokens\/([^/]+)$/);
      if (tokenMatch && method === 'DELETE') {
        if (!tokenManager) return sendJson(res, 500, { ok: false, error: { code: 'TOKEN_MANAGER_UNAVAILABLE' } });
        const id = decodeURIComponent(tokenMatch[1]);
        try {
          await tokenManager.revoke(id);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 404, { ok: false, error: { code: 'TOKEN_NOT_FOUND', message: err.message } });
        }
        return;
      }
      const rotateMatch = path.match(/^\/api\/tokens\/([^/]+)\/rotate$/);
      if (rotateMatch && method === 'POST') {
        if (!tokenManager) return sendJson(res, 500, { ok: false, error: { code: 'TOKEN_MANAGER_UNAVAILABLE' } });
        const id = decodeURIComponent(rotateMatch[1]);
        try {
          const { plaintext } = await tokenManager.rotate(id);
          sendJson(res, 200, { ok: true, data: { id, plaintext, warning: 'plaintext 는 지금 한 번만 보여집니다.' } });
        } catch (err) {
          sendJson(res, 404, { ok: false, error: { code: 'TOKEN_NOT_FOUND', message: err.message } });
        }
        return;
      }

      // --- Phase 7a: profile CRUD ---
      if (path === '/api/profiles' && method === 'GET') {
        const profiles = wm.config?.server?.profiles || {};
        // Include preview: how many tools each profile matches right now.
        const allTools = await tr.getTools();
        const { matchPattern } = await import('../server/mcp-token-manager.js');
        const preview = {};
        for (const [name, def] of Object.entries(profiles)) {
          const matched = allTools.filter(t => {
            if (!t._workspace) return true;
            if (Array.isArray(def.workspacesInclude) && !def.workspacesInclude.some(p => matchPattern(p, t._workspace))) return false;
            if (Array.isArray(def.toolsInclude) && !def.toolsInclude.some(p => matchPattern(p, t._originalName) || matchPattern(p, t.name))) return false;
            return true;
          });
          preview[name] = { toolCount: matched.length, sampleTools: matched.slice(0, 5).map(t => t.name) };
        }
        sendJson(res, 200, { ok: true, data: { profiles, preview } });
        return;
      }
      if (path === '/api/profiles' && method === 'PUT') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { ok: false, error: { code: 'INVALID_PROFILES', message: 'profiles must be an object map' } });
        }
        // Shallow validate: each profile may have toolsInclude/workspacesInclude string arrays.
        for (const [name, def] of Object.entries(body)) {
          if (!def || typeof def !== 'object') return sendJson(res, 400, { ok: false, error: { code: 'INVALID_PROFILE', message: `profile '${name}' must be object` } });
          for (const key of ['toolsInclude', 'workspacesInclude']) {
            if (def[key] !== undefined && (!Array.isArray(def[key]) || def[key].some(x => typeof x !== 'string'))) {
              return sendJson(res, 400, { ok: false, error: { code: 'INVALID_PROFILE_FIELD', message: `profile '${name}'.${key} must be string[]` } });
            }
          }
        }
        if (!wm.config.server) wm.config.server = { port: 3100 };
        wm.config.server.profiles = body;
        await wm._save();
        wm.logAudit('profile.update', null, `Updated ${Object.keys(body).length} profile(s)`);
        sendJson(res, 200, { ok: true, data: body });
        return;
      }

      // GET /api/connect-info — server info for connect guide
      if (path === '/api/connect-info' && method === 'GET') {
        const serverConfig = wm.getServerConfig();
        const tunnelConfig = wm.config.tunnel || {};
        // Phase 7b: reflect multi-token + persisted tokens, not only the singular env.
        const mcpTokenSet = tokenManager ? tokenManager.isConfigured() : !!wm.getMcpToken();
        const hasLegacyToken = tokenManager ? tokenManager.hasLegacyToken() : !!wm.getMcpToken();
        const persistedTokenCount = tokenManager ? (tokenManager.list().filter(t => t.source === 'persisted').length) : 0;
        sendJson(res, 200, {
          ok: true,
          data: {
            port: serverConfig.port || 3100,
            mcpEndpoint: `http://localhost:${serverConfig.port || 3100}/mcp`,
            sseEndpoint: `http://localhost:${serverConfig.port || 3100}/sse`,
            tunnelEnabled: tunnelConfig.enabled || false,
            tunnelUrl: tunnelConfig.fixedDomain || null,
            mcpTokenConfigured: mcpTokenSet,
            hasLegacyToken,
            persistedTokenCount,
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
