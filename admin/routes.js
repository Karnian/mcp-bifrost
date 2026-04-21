import { readFile, realpath } from 'node:fs/promises';
import { join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateAdmin, sendJson, readBody, isCommandAllowed, safeTokenCompare, validateEnvVars } from './auth.js';
import { RateLimiter, getClientIp } from '../server/rate-limiter.js';
import { matchPattern } from '../server/mcp-token-manager.js';
import { validateWorkspacePayload } from '../server/workspace-schema.js';

const adminRateLimiter = new RateLimiter({ max: 10, windowMs: 60_000 });

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

export function createAdminRoutes(wm, tr, sse, oauth, tokenManager = null, extras = {}) {
  const { usage = null, audit = null } = extras;
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
    // authenticateAdmin handles both exposure guard (localhost check) and token check
    if (path === '/api/auth/login' && method === 'POST') {
      // Login still needs exposure guard before processing
      if (!_checkExposure(req, res)) return;
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
        // Schema validation
        const validation = validateWorkspacePayload(body);
        if (!validation.valid) {
          sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: validation.errors.join('; ') } });
          return;
        }
        // Command whitelist enforcement for stdio mcp-client
        if (body.kind === 'mcp-client' && body.transport === 'stdio' && body.command) {
          if (!isCommandAllowed(body.command)) {
            sendJson(res, 403, { ok: false, error: { code: 'COMMAND_NOT_ALLOWED', message: `Command "${body.command}" is not in BIFROST_ALLOWED_COMMANDS whitelist` } });
            return;
          }
        }
        // Env vars injection defense for stdio mcp-client
        if (body.kind === 'mcp-client' && body.transport === 'stdio' && body.env) {
          const { valid, blocked } = validateEnvVars(body.env);
          if (!valid) {
            sendJson(res, 400, { ok: false, error: { code: 'ENV_NOT_ALLOWED', message: `Blocked environment variables: ${blocked.join(', ')}` } });
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
          // Schema validation (same as POST)
          const putValidation = validateWorkspacePayload(body);
          if (!putValidation.valid) {
            sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: putValidation.errors.join('; ') } });
            return;
          }
          const existing = wm.getRawWorkspace(id);
          const effectiveKind = body.kind || existing?.kind;
          const effectiveTransport = body.transport || existing?.transport;
          // Command whitelist enforcement for stdio mcp-client (same as POST)
          if (effectiveKind === 'mcp-client' && effectiveTransport === 'stdio' && body.command) {
            if (!isCommandAllowed(body.command)) {
              sendJson(res, 403, { ok: false, error: { code: 'COMMAND_NOT_ALLOWED', message: `Command "${body.command}" is not in BIFROST_ALLOWED_COMMANDS whitelist` } });
              return;
            }
          }
          // Env vars injection defense for stdio mcp-client
          // Check both existing and target state (body may change kind/transport)
          if (body.env && typeof body.env === 'object') {
            if (effectiveKind === 'mcp-client' && effectiveTransport === 'stdio') {
              const { valid, blocked } = validateEnvVars(body.env);
              if (!valid) {
                sendJson(res, 400, { ok: false, error: { code: 'ENV_NOT_ALLOWED', message: `Blocked environment variables: ${blocked.join(', ')}` } });
                return;
              }
            }
          }
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

      // POST /api/workspaces/:id/tools/:toolName/test — tool test execution
      // Note: this calls the real tool (not a dry-run). Admin-only endpoint.
      const toolTestMatch = path.match(/^\/api\/workspaces\/([^/]+)\/tools\/([^/]+)\/test$/);
      if (toolTestMatch && method === 'POST') {
        const wsId = decodeURIComponent(toolTestMatch[1]);
        const toolName = decodeURIComponent(toolTestMatch[2]);
        const provider = wm.getProvider(wsId);
        if (!provider) {
          return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `Workspace '${wsId}' not found or not connected` } });
        }
        const tools = provider.getTools();
        const tool = tools.find(t => t.name === toolName);
        if (!tool) {
          return sendJson(res, 404, { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `Tool '${toolName}' not found in workspace '${wsId}'` } });
        }
        try {
          const body = await readBody(req).catch(() => ({}));
          const args = body?.arguments || {};
          const result = await provider.callTool(toolName, args);
          sendJson(res, 200, { ok: true, data: { tool: toolName, result, warning: 'This executed the real tool, not a dry-run' } });
        } catch (err) {
          sendJson(res, 200, { ok: true, data: { tool: toolName, result: { content: [{ type: 'text', text: err.message }], isError: true }, warning: 'This executed the real tool, not a dry-run' } });
        }
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
        // Phase 7c: validate identity BEFORE any side-effecting work (discover, register, _save).
        // Treat explicitly-present empty string as invalid (don't silently coerce to 'default').
        const identityRaw = body?.identity;
        const identity = identityRaw === undefined || identityRaw === null ? 'default' : String(identityRaw);
        if (!/^[a-zA-Z0-9_\-.]{1,64}$/.test(identity)) {
          return sendJson(res, 400, { ok: false, error: { code: 'INVALID_IDENTITY', message: 'identity must match [a-zA-Z0-9_\\-.]{1,64}' } });
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
          // Phase 10a §4.10a-2 — client resolution priority:
          //   1. Manual body.manual (wizard path): honor immediately, persist to ws.oauth.client
          //   2. ws.oauth.client.clientId (static/stored): reuse, no DCR
          //   3. Legacy flat ws.oauth.clientId (pre-10a workspaces): treat as stored
          //   4. Otherwise: call registerClient({ workspaceId }) for DCR with workspace-scoped cache
          // body.forceRegister bypasses (2)/(3) to force a fresh DCR.
          let authMethod = ws.oauth?.client?.authMethod ?? ws.oauth?.authMethod;
          let clientId = ws.oauth?.client?.clientId ?? ws.oauth?.clientId;
          let clientSecret = ws.oauth?.client?.clientSecret ?? ws.oauth?.clientSecret ?? null;
          let clientSource = ws.oauth?.client?.source || (clientId ? 'legacy-flat' : null);
          if (!clientId || body?.forceRegister) {
            if (body?.manual && body.manual.clientId) {
              const reg = await oauth.registerManual({
                workspaceId: id,
                issuer,
                clientId: body.manual.clientId,
                clientSecret: body.manual.clientSecret ?? null,
                authMethod: body.manual.authMethod || 'none',
              });
              clientId = reg.clientId; clientSecret = reg.clientSecret; authMethod = reg.authMethod;
              clientSource = 'manual';
            } else {
              const reg = await oauth.registerClient(issuer, asMetadata, {
                workspaceId: id,
                reuse: body?.reuse !== false,
                forceNew: body?.forceRegister === true,
              });
              clientId = reg.clientId; clientSecret = reg.clientSecret; authMethod = reg.authMethod;
              clientSource = 'dcr';
            }
          }
          // Phase 10a §3.4 — persist into ws.oauth.client AND mirror flat fields (1 release)
          ws.oauth = {
            ...ws.oauth,
            client: {
              clientId,
              clientSecret: clientSecret ?? null,
              authMethod,
              source: clientSource || ws.oauth?.client?.source || 'dcr',
              registeredAt: ws.oauth?.client?.registeredAt || new Date().toISOString(),
            },
            clientId,
            clientSecret: clientSecret ?? null,
            authMethod,
          };
          await wm._save();

          const init = await oauth.initializeAuthorization(id, {
            issuer,
            clientId,
            clientSecret,
            authMethod,
            authServerMetadata: asMetadata,
            resource,
            scope: body?.scope,
            identity,
          });
          sendJson(res, 200, { ok: true, data: { authorizationUrl: init.authorizationUrl, issuer, clientId, authMethod, identity, fileSecurityWarning: oauth.getFileSecurityWarning() } });
        } catch (err) {
          const code = err.code || 'OAUTH_ERROR';
          // Phase 10a §4.10a-3 — map DCR classification to HTTP status.
          let status = 500;
          if (code === 'DCR_UNSUPPORTED') status = 422;
          else if (code === 'DCR_RATE_LIMITED') status = 429;
          else if (code === 'DCR_REJECTED') status = 502;
          else if (code === 'DCR_TRANSIENT') status = 503;
          else if (code === 'DCR_FAILED') status = 502; // legacy
          const payload = { ok: false, error: { code, message: err.message } };
          if (err.retryAfterMs) payload.error.retryAfterMs = err.retryAfterMs;
          sendJson(res, status, payload);
        }
        return;
      }

      // POST /api/oauth/discover — standalone discovery for Wizard preview
      // Phase 10a §4.10a-1b: `cachedClient` field removed. DCR cache is now
      // workspace-scoped (§4.10a-1) and this endpoint has no workspaceId context
      // (preview happens before workspace creation), so cache lookup is meaningless.
      if (path === '/api/oauth/discover' && method === 'POST') {
        if (!oauth) return sendJson(res, 500, { ok: false, error: { code: 'OAUTH_NOT_CONFIGURED' } });
        const body = await readBody(req);
        if (!body?.url) return sendJson(res, 400, { ok: false, error: { code: 'MISSING_URL' } });
        try {
          const disc = await oauth.discover(body.url, { wwwAuthenticate: body.wwwAuthenticate });
          sendJson(res, 200, { ok: true, data: {
            issuer: disc.issuer,
            resource: disc.resource,
            dcrSupported: !!disc.authServerMetadata.registration_endpoint,
            methodsSupported: disc.authServerMetadata.token_endpoint_auth_methods_supported || [],
            authorizationEndpoint: disc.authServerMetadata.authorization_endpoint,
            tokenEndpoint: disc.authServerMetadata.token_endpoint,
            metadataCache: disc.authServerMetadata,
          } });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: { code: 'DISCOVERY_FAILED', message: err.message } });
        }
        return;
      }

      // Phase 10a §4.10a-5 — POST /api/workspaces/:id/oauth/register
      // Force a fresh DCR re-registration (or manual override). Discards the old
      // cached client for this workspace, issues a new one, and returns the new
      // client info. Does NOT trigger authorization — operator must call
      // /authorize afterward to re-grant. Frontend shows this as "Re-register".
      const registerMatch = path.match(/^\/api\/workspaces\/([^/]+)\/oauth\/register$/);
      if (registerMatch && method === 'POST') {
        if (!oauth) return sendJson(res, 500, { ok: false, error: { code: 'OAUTH_NOT_CONFIGURED' } });
        const id = decodeURIComponent(registerMatch[1]);
        const ws = wm._getRawWorkspace(id);
        if (!ws) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
        if (ws.kind !== 'mcp-client' || (ws.transport !== 'http' && ws.transport !== 'sse')) {
          return sendJson(res, 400, { ok: false, error: { code: 'OAUTH_UNAVAILABLE' } });
        }
        const body = await readBody(req).catch(() => ({}));
        try {
          // Purge existing cache entries for this workspace (§4.10a-1)
          if (oauth.removeClient) await oauth.removeClient(id);
          // Need discovery metadata
          let md = ws.oauth?.metadataCache;
          let issuer = ws.oauth?.issuer;
          if (!md) {
            const disc = await oauth.discover(ws.url, { wwwAuthenticate: body?.wwwAuthenticate });
            md = disc.authServerMetadata;
            issuer = disc.issuer;
            ws.oauth = { ...(ws.oauth || {}), enabled: true, issuer, resource: disc.resource, metadataCache: md };
          }
          let reg;
          if (body?.manual && body.manual.clientId) {
            // Phase 10a (Codex R2 cleanup): whitelist authMethod on manual path
            // too — previously only PUT /oauth/client validated, which persisted
            // unusable methods if operator used POST /oauth/register with a bad method.
            const manualAuth = body.manual.authMethod || 'none';
            if (!['none', 'client_secret_basic', 'client_secret_post'].includes(manualAuth)) {
              return sendJson(res, 400, { ok: false, error: { code: 'UNSUPPORTED_AUTH_METHOD', message: `authMethod '${manualAuth}' not supported; use none/client_secret_basic/client_secret_post` } });
            }
            reg = await oauth.registerManual({
              workspaceId: id,
              issuer,
              clientId: body.manual.clientId,
              clientSecret: body.manual.clientSecret ?? null,
              authMethod: manualAuth,
            });
            reg.source = 'manual';
          } else {
            reg = await oauth.registerClient(issuer, md, { workspaceId: id, forceNew: true, reuse: false });
            reg.source = 'dcr';
          }
          ws.oauth = {
            ...ws.oauth,
            client: {
              clientId: reg.clientId,
              clientSecret: reg.clientSecret ?? null,
              authMethod: reg.authMethod,
              source: reg.source,
              registeredAt: new Date().toISOString(),
            },
            // mirror flat fields (§3.4, one release)
            clientId: reg.clientId,
            clientSecret: reg.clientSecret ?? null,
            authMethod: reg.authMethod,
          };
          // Mark all identities as requiring re-authorization — old tokens
          // are bound to the old client_id and invalid.
          if (ws.oauth.byIdentity) {
            for (const identity of Object.keys(ws.oauth.byIdentity)) {
              if (ws.oauth.byIdentity[identity]?.tokens) {
                ws.oauth.byIdentity[identity].tokens.accessToken = null;
              }
            }
          }
          if (ws.oauth.tokens) ws.oauth.tokens.accessToken = null;
          ws.oauthActionNeededBy = ws.oauthActionNeededBy || {};
          for (const identity of Object.keys(ws.oauth?.byIdentity || { default: true })) {
            ws.oauthActionNeededBy[identity] = true;
          }
          ws.oauthActionNeeded = true;
          // Phase 10a §4.10a-5 (Codex R2 blocker 2) — purge pending auth states
          // for this workspace so a stale browser tab/callback cannot resurrect
          // the pre-rotation client.
          if (oauth.purgePendingForWorkspace) await oauth.purgePendingForWorkspace(id);
          await wm._save();
          // Phase 10a §4.10a-5 (Codex R2 blocker 1) — recreate the provider so
          // the new client is effective immediately (especially if the old
          // provider was in stopped:auth_failed).
          if (wm._createProvider) wm._createProvider(ws);
          sendJson(res, 200, { ok: true, data: wm.getOAuthClient(id) });
        } catch (err) {
          const code = err.code || 'OAUTH_ERROR';
          let status = 500;
          if (code === 'DCR_UNSUPPORTED') status = 422;
          else if (code === 'DCR_RATE_LIMITED') status = 429;
          else if (code === 'DCR_REJECTED') status = 502;
          else if (code === 'DCR_TRANSIENT') status = 503;
          const payload = { ok: false, error: { code, message: err.message } };
          if (err.retryAfterMs) payload.error.retryAfterMs = err.retryAfterMs;
          sendJson(res, status, payload);
        }
        return;
      }

      // Phase 10a §4.10a-5 — PUT /api/workspaces/:id/oauth/client
      // Set static / manual OAuth client (without running discovery). Operator
      // provides clientId + optional clientSecret + authMethod. Marks the
      // workspace as needing re-authorization. Use case: Notion integration
      // pre-registered on the provider side.
      const clientMatch = path.match(/^\/api\/workspaces\/([^/]+)\/oauth\/client$/);
      if (clientMatch && method === 'PUT') {
        if (!oauth) return sendJson(res, 500, { ok: false, error: { code: 'OAUTH_NOT_CONFIGURED' } });
        const id = decodeURIComponent(clientMatch[1]);
        const ws = wm._getRawWorkspace(id);
        if (!ws) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
        const body = await readBody(req).catch(() => ({}));
        if (!body?.clientId || typeof body.clientId !== 'string') {
          return sendJson(res, 400, { ok: false, error: { code: 'INVALID_CLIENT_ID' } });
        }
        const authMethod = body.authMethod || 'none';
        if (!['none', 'client_secret_basic', 'client_secret_post'].includes(authMethod)) {
          return sendJson(res, 400, { ok: false, error: { code: 'UNSUPPORTED_AUTH_METHOD' } });
        }
        const issuer = ws.oauth?.issuer;
        if (!issuer) {
          return sendJson(res, 400, { ok: false, error: { code: 'ISSUER_MISSING', message: 'Run discovery first (/authorize)' } });
        }
        try {
          // Purge cache to avoid stale lookup returning the old client
          if (oauth.removeClient) await oauth.removeClient(id);
          const reg = await oauth.registerManual({
            workspaceId: id,
            issuer,
            clientId: body.clientId,
            clientSecret: body.clientSecret ?? null,
            authMethod,
          });
          ws.oauth = {
            ...ws.oauth,
            client: {
              clientId: reg.clientId,
              clientSecret: reg.clientSecret ?? null,
              authMethod: reg.authMethod,
              source: 'manual',
              registeredAt: new Date().toISOString(),
            },
            clientId: reg.clientId,
            clientSecret: reg.clientSecret ?? null,
            authMethod: reg.authMethod,
          };
          // Invalidate any existing tokens + flag action_needed
          if (ws.oauth.byIdentity) {
            for (const identity of Object.keys(ws.oauth.byIdentity)) {
              if (ws.oauth.byIdentity[identity]?.tokens) {
                ws.oauth.byIdentity[identity].tokens.accessToken = null;
              }
            }
          }
          if (ws.oauth.tokens) ws.oauth.tokens.accessToken = null;
          ws.oauthActionNeededBy = ws.oauthActionNeededBy || {};
          for (const identity of Object.keys(ws.oauth?.byIdentity || { default: true })) {
            ws.oauthActionNeededBy[identity] = true;
          }
          ws.oauthActionNeeded = true;
          // Phase 10a §4.10a-5 (Codex R2 blocker 2) — purge pending auth states
          if (oauth.purgePendingForWorkspace) await oauth.purgePendingForWorkspace(id);
          await wm._save();
          // Phase 10a §4.10a-5 (Codex R2 blocker 1) — recreate provider
          if (wm._createProvider) wm._createProvider(ws);
          sendJson(res, 200, { ok: true, data: wm.getOAuthClient(id) });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: { code: err.code || 'OAUTH_ERROR', message: err.message } });
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
          // Per-entry schema validation
          const importValidation = validateWorkspacePayload(wsData);
          if (!importValidation.valid) {
            results.push({ displayName: wsData.displayName, status: 'error', message: `Validation: ${importValidation.errors.join('; ')}` });
            continue;
          }
          // Command whitelist + env injection defense (same as POST/PUT)
          if (wsData.kind === 'mcp-client' && wsData.transport === 'stdio') {
            if (wsData.command && !isCommandAllowed(wsData.command)) {
              results.push({ displayName: wsData.displayName, status: 'error', message: `Command "${wsData.command}" is not in BIFROST_ALLOWED_COMMANDS whitelist` });
              continue;
            }
            if (wsData.env) {
              const { valid, blocked } = validateEnvVars(wsData.env);
              if (!valid) {
                results.push({ displayName: wsData.displayName, status: 'error', message: `Blocked environment variables: ${blocked.join(', ')}` });
                continue;
              }
            }
          }
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
        // matchPattern imported at top level (Phase 8e)
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
        // Validate: each profile may have toolsInclude/workspacesInclude string arrays.
        for (const [name, def] of Object.entries(body)) {
          if (!def || typeof def !== 'object') return sendJson(res, 400, { ok: false, error: { code: 'INVALID_PROFILE', message: `profile '${name}' must be object` } });
          for (const key of ['toolsInclude', 'workspacesInclude']) {
            if (def[key] !== undefined) {
              if (!Array.isArray(def[key]) || def[key].some(x => typeof x !== 'string')) {
                return sendJson(res, 400, { ok: false, error: { code: 'INVALID_PROFILE_FIELD', message: `profile '${name}'.${key} must be string[]` } });
              }
              // Glob pattern length + ReDoS prevention
              for (const pattern of def[key]) {
                if (pattern.length > 256) {
                  return sendJson(res, 400, { ok: false, error: { code: 'PATTERN_TOO_LONG', message: `profile '${name}'.${key}: pattern exceeds 256 chars` } });
                }
                // Reject nested quantifiers (ReDoS risk): patterns like a{*}{*} or **/**/**
                if (/(\*{2,}.*){3,}/.test(pattern)) {
                  return sendJson(res, 400, { ok: false, error: { code: 'PATTERN_REDOS', message: `profile '${name}'.${key}: pattern has potential ReDoS risk` } });
                }
              }
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

      // --- Phase 7g: Usage + Audit endpoints ---
      // GET /api/usage/timeseries
      if (path === '/api/usage/timeseries' && method === 'GET') {
        if (!usage) return sendJson(res, 500, { ok: false, error: { code: 'USAGE_UNAVAILABLE' } });
        const range = url.searchParams.get('range') || '24h';
        if (!['24h', '7d'].includes(range)) {
          return sendJson(res, 400, { ok: false, error: { code: 'INVALID_RANGE', message: 'range must be 24h or 7d' } });
        }
        sendJson(res, 200, { ok: true, data: usage.timeseries({ range }) });
        return;
      }

      if (path === '/api/usage' && method === 'GET') {
        if (!usage) return sendJson(res, 500, { ok: false, error: { code: 'USAGE_UNAVAILABLE' } });
        const since = url.searchParams.get('since') || '24h';
        const by = url.searchParams.get('by') || null;
        const data = by ? usage.query({ since, by }) : usage.topSummary({ since });
        sendJson(res, 200, { ok: true, data });
        return;
      }
      if (path === '/api/audit' && method === 'GET') {
        if (!audit) return sendJson(res, 500, { ok: false, error: { code: 'AUDIT_UNAVAILABLE' } });
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
        const actionPrefix = url.searchParams.get('action') || null;
        const identity = url.searchParams.get('identity') || null;
        const workspace = url.searchParams.get('workspace') || null;
        try {
          const data = await audit.tail({ limit, actionPrefix, identity, workspace });
          sendJson(res, 200, { ok: true, data });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: { code: 'AUDIT_READ_FAILED', message: err.message } });
        }
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

function _checkExposure(req, res) {
  if (process.env.BIFROST_ADMIN_EXPOSE === '1') return true;
  const addr = req.socket?.remoteAddress || '';
  const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!isLocal) {
    sendJson(res, 403, { ok: false, error: { code: 'ADMIN_LOCAL_ONLY', message: 'Admin API is restricted to localhost. Set BIFROST_ADMIN_EXPOSE=1 to allow remote access.' } });
    return false;
  }
  return true;
}

async function handleLogin(req, res, wm) {
  // Rate limit — brute-force protection (respects trust proxy)
  const ip = getClientIp(req);
  const rl = adminRateLimiter.check(ip);
  if (!rl.allowed) {
    const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ ok: false, error: { code: 'RATE_LIMITED', message: `Too many requests. Retry after ${retryAfter}s` } }));
    return;
  }
  const body = await readBody(req);
  const adminToken = wm.getAdminToken();

  if (!adminToken) {
    sendJson(res, 200, { ok: true, data: { message: 'No admin token configured' } });
    return;
  }

  if (adminToken && safeTokenCompare(body.token || '', adminToken)) {
    sendJson(res, 200, { ok: true, data: { message: 'Authenticated' } });
  } else if (!adminToken) {
    sendJson(res, 200, { ok: true, data: { message: 'Authenticated' } });
  } else {
    sendJson(res, 401, { ok: false, error: { code: 'INVALID_TOKEN', message: '토큰이 일치하지 않습니다' } });
  }
}

async function serveStatic(req, res, path) {
  // Decode percent-encoded sequences before checking for traversal
  let filePath;
  try {
    filePath = decodeURIComponent(path.replace(/^\/admin\/?/, '') || 'index.html');
  } catch {
    filePath = path.replace(/^\/admin\/?/, '') || 'index.html';
  }
  if (!filePath || filePath === '' || !filePath.includes('.')) {
    filePath = 'index.html';
  }

  // Fast reject: block any path containing ".." segments (before filesystem access)
  if (filePath.includes('..')) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  const fullPath = join(PUBLIC_DIR, filePath);

  // Path traversal defense: resolve symlinks, then verify the real path is inside PUBLIC_DIR
  try {
    const realFullPath = await realpath(fullPath);
    const realPublicDir = await realpath(PUBLIC_DIR);
    const rel = relative(realPublicDir, realFullPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
  } catch {
    // File doesn't exist — fall through to SPA fallback below
  }

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
