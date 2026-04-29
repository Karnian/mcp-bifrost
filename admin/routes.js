import { readFile, realpath } from 'node:fs/promises';
import { join, dirname, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateAdmin, sendJson, readBody, isCommandAllowed, safeTokenCompare, validateEnvVars } from './auth.js';
import { RateLimiter, getClientIp } from '../server/rate-limiter.js';
import { matchPattern } from '../server/mcp-token-manager.js';
import { validateWorkspacePayload, validateSlackAppPayload } from '../server/workspace-schema.js';
import { describePublicOrigin, getPublicOriginOrNull, getSlackRedirectUri, getSlackManifestRedirect } from '../server/public-origin.js';
import { describeSlackError } from '../server/slack-oauth-manager.js';
import { escapeHtml } from '../server/html-escape.js';
import { randomBytes } from 'node:crypto';

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
  const { usage = null, audit = null, slackOAuth = null } = extras;

  // Phase 11 §2 — Consolidated client-rotation helper.
  //
  // The three admin OAuth client-rotation paths (POST /oauth/register,
  // PUT /oauth/client, POST /oauth/authorize with rotation) previously
  // repeated near-identical rotation-commit + token-invalidation + pending-
  // purge + provider-recreate logic. This helper centralizes that sequence
  // so all three share one source of truth and drift is eliminated.
  //
  // Contract (matches what the three routes did individually):
  //   1. Commit the new client + purge pending auth states under
  //      _workspaceMutex via oauth.rotateClientUnderMutex(wsId, null, fn)
  //      — so every in-flight refresh/markAuthFailed quiesces before
  //      ws.oauth mutates AND no stale completeAuthorization callback can
  //      slip in between client-commit and pending-purge (a narrow race
  //      when the "rotated" client tuple happens to equal the old one,
  //      e.g. operator re-enters the same manual clientId). Pending purge
  //      MUST happen inside the same workspace lock as the commit —
  //      moving it outside the lock reopens that stale-callback window
  //      (Codex Phase 11 R1 blocker).
  //   2. Inside the mutex: replace ws.oauth.client (nested), mirror flat
  //      fields (§3.4 deprecation window), null ALL tokens under
  //      ws.oauth.byIdentity and legacy ws.oauth.tokens, set
  //      oauthActionNeededBy[identity]=true for every known identity
  //      (+ ws.oauthActionNeeded for 'default' compat), THEN purge
  //      pending auth states.
  //   3. Outside the mutex: wm._save() (can be re-invoked safely) and
  //      optional provider recreate.
  //   4. If recreateProvider is true (default): call wm._createProvider(ws)
  //      so the new client is effective immediately (POST/PUT paths).
  //      /authorize does NOT recreate (it expects the browser to follow up
  //      with /callback) — pass recreateProvider: false.
  //
  // Caller is responsible for purging the DCR cache BEFORE this helper
  // (oauth.removeClient(wsId)) if that's desired — the helper doesn't do
  // it so operators retain control over cache semantics per route.
  async function _rotateClientAndInvalidate(wsId, newClient, {
    reason = 'rotate',            // free-form: 'dcr-register', 'manual', 'authorize'
    recreateProvider = true,
    invalidateTokens = true,
  } = {}) {
    const ws = wm._getRawWorkspace(wsId);
    if (!ws) throw new Error(`_rotateClientAndInvalidate: workspace '${wsId}' not found`);
    if (!newClient || !newClient.clientId) {
      throw new Error('_rotateClientAndInvalidate: newClient.clientId is required');
    }
    const source = newClient.source
      || (reason === 'manual' ? 'manual' : reason === 'dcr-register' ? 'dcr' : (ws.oauth?.client?.source || 'dcr'));
    const registeredAt = newClient.registeredAt || new Date().toISOString();
    await oauth.rotateClientUnderMutex(wsId, null, async () => {
      // Phase 11 §3 — nested-only write. Flat mirror (§3.4) removed; all
      // read paths now use ws.oauth.client.* exclusively.
      ws.oauth = {
        ...ws.oauth,
        client: {
          clientId: newClient.clientId,
          clientSecret: newClient.clientSecret ?? null,
          authMethod: newClient.authMethod,
          source,
          registeredAt,
        },
      };
      // Scrub any leftover flat-field mirror from pre-Phase-11 writes.
      if ('clientId' in ws.oauth) delete ws.oauth.clientId;
      if ('clientSecret' in ws.oauth) delete ws.oauth.clientSecret;
      if ('authMethod' in ws.oauth) delete ws.oauth.authMethod;
      if (invalidateTokens) {
        if (ws.oauth.byIdentity) {
          for (const identity of Object.keys(ws.oauth.byIdentity)) {
            if (ws.oauth.byIdentity[identity]?.tokens) {
              ws.oauth.byIdentity[identity].tokens.accessToken = null;
              ws.oauth.byIdentity[identity].tokens.refreshToken = null;
            }
          }
        }
        if (ws.oauth.tokens) {
          ws.oauth.tokens.accessToken = null;
          ws.oauth.tokens.refreshToken = null;
        }
        ws.oauthActionNeededBy = ws.oauthActionNeededBy || {};
        for (const identity of Object.keys(ws.oauth?.byIdentity || { default: true })) {
          ws.oauthActionNeededBy[identity] = true;
        }
        ws.oauthActionNeeded = true;
      }
      // Phase 11 §2 (Codex R1 blocker): purge pending auth states INSIDE the
      // workspace-locked critical section. If a caller re-enters the same
      // client tuple (e.g. manual rotation with unchanged clientId), the
      // client-field discriminator in completeAuthorization cannot detect
      // rotation — the pending entry looks fresh. Only the one-shot pending
      // consumption is a reliable guard, and we must ensure no completeAuth
      // callback can grab the pending entry between our client-commit above
      // and the purge below. Keeping both under _workspaceMutex closes that
      // window: completeAuthorization also acquires _workspaceMutex, so it
      // FIFO-chains behind this rotation and sees an already-purged pending.
      if (oauth.purgePendingForWorkspace) {
        await oauth.purgePendingForWorkspace(wsId);
      }
    });
    await wm._save();
    if (recreateProvider && wm._createProvider) {
      wm._createProvider(ws);
    }
    return ws;
  }

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
          // Phase 10a §4.10a-2 — client resolution priority (Codex R4 fix):
          //   1. body.manual.clientId (operator-supplied) → ALWAYS honored, rotates
          //      any existing client. No silent ignore when a client already exists.
          //   2. body.forceRegister === true → fresh DCR, rotates existing client.
          //   3. Existing ws.oauth.client.clientId → reuse.
          //   4. Otherwise: DCR via registerClient({ workspaceId }).
          // Phase 11 §3 — nested-only reads. Flat-field fallback removed.
          let authMethod = ws.oauth?.client?.authMethod;
          let clientId = ws.oauth?.client?.clientId;
          let clientSecret = ws.oauth?.client?.clientSecret ?? null;
          let clientSource = ws.oauth?.client?.source || null;
          // Detect rotation: manual input OR explicit forceRegister OR missing client.
          const hasManual = !!(body?.manual && body.manual.clientId);
          const isRotation = hasManual || body?.forceRegister === true;
          const needsClient = !clientId || isRotation;
          if (needsClient) {
            if (hasManual) {
              // Phase 10a (Codex R3+R4): manual path — always honored, authMethod whitelist.
              const manualAuth = body.manual.authMethod || 'none';
              if (!['none', 'client_secret_basic', 'client_secret_post'].includes(manualAuth)) {
                return sendJson(res, 400, { ok: false, error: { code: 'UNSUPPORTED_AUTH_METHOD', message: `authMethod '${manualAuth}' not supported; use none/client_secret_basic/client_secret_post` } });
              }
              // Purge cache so registerManual replaces the stored client outright.
              if (oauth.removeClient) await oauth.removeClient(id);
              const reg = await oauth.registerManual({
                workspaceId: id,
                issuer,
                clientId: body.manual.clientId,
                clientSecret: body.manual.clientSecret ?? null,
                authMethod: manualAuth,
              });
              clientId = reg.clientId; clientSecret = reg.clientSecret; authMethod = reg.authMethod;
              clientSource = 'manual';
            } else {
              // DCR path. forceRegister → fresh; otherwise reuse.
              if (body?.forceRegister && oauth.removeClient) await oauth.removeClient(id);
              const reg = await oauth.registerClient(issuer, asMetadata, {
                workspaceId: id,
                reuse: !body?.forceRegister && body?.reuse !== false,
                forceNew: body?.forceRegister === true,
              });
              clientId = reg.clientId; clientSecret = reg.clientSecret; authMethod = reg.authMethod;
              clientSource = 'dcr';
            }
          }
          // Phase 11 §2 — rotation branch uses the consolidated helper.
          // First-time auth (isRotation=false) keeps the inline commit since
          // it neither rotates client fields semantically nor invalidates
          // tokens — and must preserve the existing registeredAt.
          if (isRotation) {
            // Helper purges pending auth states INSIDE the workspace-locked
            // critical section (Codex Phase 11 R1 fix — prevents stale
            // callback from consuming the pending row during same-client
            // manual rotation where the field discriminator can't detect
            // the rotation).
            await _rotateClientAndInvalidate(id, {
              clientId,
              clientSecret: clientSecret ?? null,
              authMethod,
              source: clientSource || ws.oauth?.client?.source || 'dcr',
            }, { reason: 'authorize', recreateProvider: false });
          } else {
            // First-time authorization — just persist the client fields with
            // preserved registeredAt. No mutex needed (no rotation race).
            // Phase 11 §3 — nested-only write.
            ws.oauth = {
              ...ws.oauth,
              client: {
                clientId,
                clientSecret: clientSecret ?? null,
                authMethod,
                source: clientSource || ws.oauth?.client?.source || 'dcr',
                registeredAt: ws.oauth?.client?.registeredAt || new Date().toISOString(),
              },
            };
            if ('clientId' in ws.oauth) delete ws.oauth.clientId;
            if ('clientSecret' in ws.oauth) delete ws.oauth.clientSecret;
            if ('authMethod' in ws.oauth) delete ws.oauth.authMethod;
            await wm._save();
          }

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
          // Phase 11 §2 — consolidated rotate + invalidate + purge + save +
          // recreate-provider via _rotateClientAndInvalidate helper.
          await _rotateClientAndInvalidate(id, {
            clientId: reg.clientId,
            clientSecret: reg.clientSecret ?? null,
            authMethod: reg.authMethod,
            source: reg.source,
          }, { reason: body?.manual ? 'manual' : 'dcr-register' });
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
          // Phase 11 §2 — consolidated rotation via _rotateClientAndInvalidate.
          await _rotateClientAndInvalidate(id, {
            clientId: reg.clientId,
            clientSecret: reg.clientSecret ?? null,
            authMethod: reg.authMethod,
            source: 'manual',
          }, { reason: 'manual' });
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

      // GET /api/oauth/redirect-uri — expose the exact redirect URI the
      // server expects. Phase 11-9 §12-2: the static-client wizard needs
      // this to tell the operator what to register in the provider's
      // integration console (Notion, GitHub, etc.).
      if (path === '/api/oauth/redirect-uri' && method === 'GET') {
        const uri = oauth?.getRedirectUri?.() || null;
        sendJson(res, 200, { ok: true, data: { redirectUri: uri } });
        return;
      }

      // GET /api/oauth/metrics — in-memory OAuth counter snapshot (Phase 11-4 §6-OBS.2).
      // Prefer the recorder wired into extras (server/index.js injects it) but
      // fall back to `oauth.metrics` so the admin UI keeps working even if the
      // caller forgot to pass it through extras.
      //
      // Codex R1 non-blocking: guard snapshot() so a broken recorder cannot
      // 500 the admin page. Consistent with the _metric() try/catch on the
      // OAuthManager side.
      if (path === '/api/oauth/metrics' && method === 'GET') {
        const metrics = extras.oauthMetrics || oauth?.metrics || null;
        let data = [];
        try {
          data = metrics?.snapshot?.() || [];
        } catch (err) {
          // Broken recorder must not 500 the admin page. Surface the fault
          // via error log so operators still see it in /api/diagnostics.
          wm.logError?.('oauth.metrics', null, `snapshot failed: ${err?.message || err}`);
          data = [];
        }
        sendJson(res, 200, { ok: true, data });
        return;
      }

      // GET /api/oauth/metrics/status — saturation summary (Phase 11-10 §1).
      // Lightweight health of the counter-map (resident entries, cap,
      // eviction counter). Separate from `/metrics` so the UI can show a
      // capacity badge without paginating through the whole snapshot.
      if (path === '/api/oauth/metrics/status' && method === 'GET') {
        const metrics = extras.oauthMetrics || oauth?.metrics || null;
        let data = { entries: 0, maxEntries: 0, capped: false, evictionsTotal: 0, saturation: 0 };
        try {
          if (metrics?.stats) data = metrics.stats();
        } catch (err) {
          wm.logError?.('oauth.metrics', null, `stats failed: ${err?.message || err}`);
        }
        sendJson(res, 200, { ok: true, data });
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

      // ─────────────────────────────────────────────────────────────
      // Phase 12-5 — Slack App + OAuth install endpoints
      // ─────────────────────────────────────────────────────────────

      // GET /api/slack/app — Slack App credential view (masked)
      if (path === '/api/slack/app' && method === 'GET') {
        const view = wm.getSlackApp();
        const origin = describePublicOrigin();
        sendJson(res, 200, {
          ok: true,
          data: {
            ...view,
            publicOrigin: origin,
            redirectUri: origin.valid ? `${origin.origin}/oauth/slack/callback` : null,
          },
        });
        return;
      }

      // POST /api/slack/app — register / update Slack App credentials
      if (path === '/api/slack/app' && method === 'POST') {
        const body = await readBody(req);
        const validation = validateSlackAppPayload(body);
        if (!validation.valid) {
          sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: validation.errors.join('; ') } });
          return;
        }
        try {
          const view = await wm.setSlackApp(body);
          sendJson(res, 200, { ok: true, data: view });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: { code: err.code || 'SLACK_APP_INVALID', message: err.message } });
        }
        return;
      }

      // DELETE /api/slack/app — remove credentials (force=true to override dependents)
      if (path === '/api/slack/app' && method === 'DELETE') {
        const force = url.searchParams.get('force') === 'true';
        try {
          const r = await wm.deleteSlackApp({ force });
          sendJson(res, 200, { ok: true, data: r });
        } catch (err) {
          if (err.code === 'SLACK_APP_HAS_DEPENDENTS') {
            sendJson(res, 409, {
              ok: false,
              error: {
                code: err.code,
                message: err.message,
                dependentCount: err.dependentCount,
              },
            });
          } else {
            sendJson(res, 500, { ok: false, error: { code: 'SLACK_APP_DELETE_FAILED', message: err.message } });
          }
        }
        return;
      }

      // POST /api/slack/install/start — initialize Slack OAuth install flow
      if (path === '/api/slack/install/start' && method === 'POST') {
        if (!slackOAuth) {
          sendJson(res, 500, { ok: false, error: { code: 'SLACK_OAUTH_UNAVAILABLE', message: 'SlackOAuthManager not attached' } });
          return;
        }
        try {
          const body = (await readBody(req).catch(() => null)) || {};
          const init = await slackOAuth.initializeInstall({
            scopes: Array.isArray(body.scopes) ? body.scopes : undefined,
            identityHint: typeof body.identityHint === 'string' ? body.identityHint : null,
          });
          sendJson(res, 200, { ok: true, data: init });
        } catch (err) {
          // Map well-known codes to friendly HTTP statuses. All
          // PUBLIC_ORIGIN_* codes share the same 412 (precondition)
          // bucket so admin UI can surface a single setup-required path
          // (Codex 12-5 R1 BLOCKER 4).
          const status = err.code === 'SLACK_APP_NOT_CONFIGURED' ? 412
            : (err.code && err.code.startsWith('PUBLIC_ORIGIN_')) ? 412
            : 500;
          sendJson(res, status, { ok: false, error: { code: err.code || 'SLACK_INSTALL_START_FAILED', message: err.message } });
        }
        return;
      }

      // GET /api/slack/install/status?installId=...
      if (path === '/api/slack/install/status' && method === 'GET') {
        if (!slackOAuth) {
          sendJson(res, 500, { ok: false, error: { code: 'SLACK_OAUTH_UNAVAILABLE' } });
          return;
        }
        const installId = url.searchParams.get('installId');
        if (!installId) {
          sendJson(res, 400, { ok: false, error: { code: 'MISSING_INSTALL_ID' } });
          return;
        }
        const status = slackOAuth.getInstallStatus(installId);
        sendJson(res, 200, { ok: true, data: status });
        return;
      }

      // GET /api/slack/manifest.yaml — operator-facing manifest template with
      // BIFROST_PUBLIC_URL stamped redirect_url. Admin token already required.
      if (path === '/api/slack/manifest.yaml' && method === 'GET') {
        const origin = getPublicOriginOrNull();
        if (!origin) {
          sendJson(res, 412, { ok: false, error: { code: 'PUBLIC_ORIGIN_MISSING', message: 'BIFROST_PUBLIC_URL must be configured before downloading the manifest.' } });
          return;
        }
        try {
          // Phase 12-8 (Codex R1 REVISE 1): use the canonical resolver so
          // manifest download and runtime redirect_uri come from the same
          // source — plan §6 "같은 resolver" invariant.
          const yaml = await renderSlackManifestYaml(getSlackManifestRedirect());
          res.writeHead(200, {
            'Content-Type': 'text/yaml; charset=utf-8',
            'Content-Disposition': 'attachment; filename="bifrost-slack-app-manifest.yaml"',
          });
          res.end(yaml);
        } catch (err) {
          sendJson(res, 500, { ok: false, error: { code: 'MANIFEST_TEMPLATE_MISSING', message: err.message } });
        }
        return;
      }

      // POST /api/workspaces/:id/slack/refresh — admin force refresh
      // (Codex 12-5 R1 BLOCKER 3): bypass leeway check via forceRefresh
      // so this endpoint actually exercises the Slack rotation path,
      // not just returning the cached access token.
      const slackRefreshMatch = path.match(/^\/api\/workspaces\/([^/]+)\/slack\/refresh$/);
      if (slackRefreshMatch && method === 'POST') {
        if (!slackOAuth) {
          sendJson(res, 500, { ok: false, error: { code: 'SLACK_OAUTH_UNAVAILABLE' } });
          return;
        }
        const id = decodeURIComponent(slackRefreshMatch[1]);
        try {
          const tok = await slackOAuth.forceRefresh(id);
          sendJson(res, 200, { ok: true, data: { tokenPrefix: tok ? `${tok.slice(0, 12)}...` : null } });
        } catch (err) {
          const status = err.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400;
          sendJson(res, status, { ok: false, error: { code: err.code || 'REFRESH_FAILED', message: err.message } });
        }
        return;
      }

      // POST /api/workspaces/:id/slack/disconnect[?keepEntry=true]
      // (Codex 12-5 R1 REVISE 6): mutex-held disconnect — revoke +
      // workspace mutation happen in the same critical section so a
      // concurrent ensureValidAccessToken can't observe a half-state.
      const slackDisconnectMatch = path.match(/^\/api\/workspaces\/([^/]+)\/slack\/disconnect$/);
      if (slackDisconnectMatch && method === 'POST') {
        if (!slackOAuth) {
          sendJson(res, 500, { ok: false, error: { code: 'SLACK_OAUTH_UNAVAILABLE' } });
          return;
        }
        const id = decodeURIComponent(slackDisconnectMatch[1]);
        const keepEntry = url.searchParams.get('keepEntry') === 'true';
        try {
          const mode = keepEntry ? 'keep-entry' : 'hard-delete';
          const result = await slackOAuth.revoke(id, { mode });
          sendJson(res, 200, { ok: true, data: { ...result, keepEntry } });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: { code: err.code || 'DISCONNECT_FAILED', message: err.message } });
        }
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

/**
 * Phase 12-5 — Slack OAuth callback handler. Used by server/index.js to
 * service GET /oauth/slack/callback. Renders an HTML page that
 * postMessages the result to the popup opener (strict targetOrigin) and
 * also drives the install-status polling fallback by setting the
 * SlackOAuthManager._installPending entry.
 */
export async function handleSlackOAuthCallback(req, res, url, { slackOAuth, sse, tr }) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const nonce = randomBytes(16).toString('base64');
  const origin = getPublicOriginOrNull();

  function renderResultPage({ ok, title, message, payload }) {
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');
    // Phase 12-5 (Codex R1 REVISE 5): only postMessage when we have a
    // canonical origin to target. Wildcard '*' would let any frame
    // observe install state — explicitly skip the call when origin is
    // missing so the polling fallback (GET /api/slack/install/status)
    // is the only completion path.
    const safeTargetOrigin = origin ? JSON.stringify(origin) : 'null';
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;border-radius:12px;padding:2rem 2.5rem;max-width:480px;text-align:center}
h1{margin:0 0 .5rem;color:${ok ? '#16a34a' : '#dc2626'};font-size:1.5rem}
p{margin:.5rem 0;color:#94a3b8;line-height:1.6}
.hint{margin-top:1rem;font-size:.875rem;color:#64748b}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p>
<p class="hint">이 창은 자동으로 닫힙니다.</p></div>
<script nonce="${nonce}">
(function(){
  var payload = ${safePayload};
  var target = ${safeTargetOrigin};
  try {
    if (target && window.opener) {
      window.opener.postMessage({ type: 'bifrost-slack-install', ...payload }, target);
    }
  } catch (e) {}
  // Auto-close after 4 seconds (Codex 12-5 R1 NIT).
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 4000);
})();
</script></body></html>`;
  }

  function cspHeaders() {
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`,
    };
  }

  if (!slackOAuth) {
    res.writeHead(500, cspHeaders());
    res.end(renderResultPage({
      ok: false,
      title: 'Slack 연결 실패',
      message: 'SlackOAuthManager 가 attach 되지 않았습니다 — server 가 정상 부팅됐는지 확인.',
      payload: { status: 'failed', error: 'SLACK_OAUTH_UNAVAILABLE' },
    }));
    return;
  }

  try {
    const result = await slackOAuth.completeInstall({ code, state, errorParam });
    if (tr?.bumpVersion) tr.bumpVersion();
    if (sse?.broadcastNotification) sse.broadcastNotification('notifications/tools/list_changed');
    res.writeHead(200, cspHeaders());
    res.end(renderResultPage({
      ok: true,
      title: '✓ Slack 연결 완료',
      message: `${result.team?.name || result.team?.id} 워크스페이스 연결 (${result.mode === 'create' ? '신규' : '재인증'})`,
      payload: {
        status: 'completed',
        installId: result.installId,
        workspaceId: result.workspaceId,
        mode: result.mode,
        teamId: result.team?.id,
        teamName: result.team?.name,
      },
    }));
  } catch (err) {
    res.writeHead(400, cspHeaders());
    res.end(renderResultPage({
      ok: false,
      title: 'Slack 연결 실패',
      message: err.code === 'STATE_INVALID' ? 'state 검증 실패 — 다시 시도해주세요.'
        : err.code === 'SLACK_AUTHORIZE_ERROR' ? describeSlackError(err.slackError)
        : err.code === 'SLACK_ENTERPRISE_INSTALL_REJECTED' ? describeSlackError('org_login_required')
        : err.code === 'PUBLIC_ORIGIN_MISSING' ? 'BIFROST_PUBLIC_URL 환경변수가 설정되어 있지 않습니다.'
        : (err.message || 'Slack 인증 도중 알 수 없는 오류가 발생했습니다.'),
      payload: {
        status: 'failed',
        error: err.code || 'SLACK_INSTALL_FAILED',
        slackError: err.slackError || null,
      },
    }));
  }
}

// Phase 12-8 — manifest template loader. Loads templates/slack-app-manifest.yaml
// once and substitutes the redirect URL placeholder so the file under
// version control is the single source of truth (the admin route + the
// docs reference the same payload).
let _slackManifestCache = null;
async function _loadSlackManifestTemplate() {
  if (_slackManifestCache) return _slackManifestCache;
  const path = join(__dirname, '..', 'templates', 'slack-app-manifest.yaml');
  _slackManifestCache = await readFile(path, 'utf-8');
  return _slackManifestCache;
}

async function renderSlackManifestYaml(redirectUrl) {
  const template = await _loadSlackManifestTemplate();
  // The template ships with `https://your-bifrost-host/oauth/slack/callback`
  // as the placeholder. Replace it with the live canonical redirect URL.
  return template.replace(
    /https:\/\/your-bifrost-host\/oauth\/slack\/callback/g,
    redirectUrl
  );
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
