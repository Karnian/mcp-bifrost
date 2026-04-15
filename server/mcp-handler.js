/**
 * MCP Protocol Handler — handles JSON-RPC requests for MCP protocol.
 * Implements: initialize, tools/list, tools/call, resources/list, resources/read, ping
 *
 * Phase 7b: identity + profile propagation + ACL enforcement (assertAllowed).
 * Every workspace-scoped operation re-checks identity.allowedWorkspaces to
 * prevent tools/list bypass via name guessing.
 */
import { identityAllowsWorkspace, identityAllowsProfile, matchPattern } from './mcp-token-manager.js';

export class McpHandler {
  constructor(workspaceManager, toolRegistry, { usage = null } = {}) {
    this.wm = workspaceManager;
    this.tr = toolRegistry;
    this._usage = usage;
  }

  async handle(request, options = {}) {
    const { method, params, id } = request;
    const { identity = null, profile = null } = options;
    const profileObj = this._resolveProfile(profile);

    try {
      let result;
      switch (method) {
        case 'initialize':
          result = this._initialize(params);
          break;
        case 'tools/list':
          result = await this._toolsList(identity, profileObj);
          break;
        case 'tools/call':
          result = await this._toolsCall(params, identity, profileObj);
          break;
        case 'resources/list':
          result = this._resourcesList(identity);
          break;
        case 'resources/read':
          result = this._resourcesRead(params, identity);
          break;
        case 'prompts/list':
          result = { prompts: [] };
          break;
        case 'prompts/get':
          return this._errorResponse(id, -32601, 'prompts/get not implemented');
        case 'ping':
          result = {};
          break;
        default:
          return this._errorResponse(id, -32601, `Method not found: ${method}`);
      }
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return this._errorResponse(id, -32603, err.message);
    }
  }

  _initialize(_params) {
    return {
      protocolVersion: '2025-03-26',
      capabilities: {
        tools: { listChanged: true },
        resources: {},
      },
      serverInfo: {
        name: 'mcp-bifrost',
        version: '0.1.0',
      },
    };
  }

  /**
   * Resolve profile name → profile object (config/workspaces.json > server.profiles).
   * Legacy value "read-only" falls back to a built-in filter if no explicit config.
   */
  _resolveProfile(profileName) {
    if (!profileName) return null;
    const profiles = this.wm.config?.server?.profiles || {};
    const explicit = profiles[profileName];
    if (explicit) return { name: profileName, ...explicit };
    // Built-in: read-only (Phase 6 legacy behavior)
    if (profileName === 'read-only') {
      return { name: 'read-only', builtIn: true };
    }
    return { name: profileName, unknown: true };
  }

  /**
   * Central ACL gate. Throws a JSON-RPC-ish error with code=-32600 when denied.
   * Callers should either let the error propagate (handle wraps it) or map to
   * a tool-error payload for tools/call.
   */
  _assertAllowed(identity, profileObj, { workspaceId = null, toolName = null } = {}) {
    // No identity: only permitted when MCP auth is disabled (server/index.js
    // short-circuits authenticateMcp when no token configured; in that mode
    // it calls handle() without identity, so we treat null identity as
    // "open mode" → allow).
    if (identity) {
      if (workspaceId && !identityAllowsWorkspace(identity, workspaceId)) {
        const err = new Error(`identity '${identity.id}' not allowed for workspace '${workspaceId}'`);
        err.code = -32600;
        throw err;
      }
      if (profileObj?.name && !identityAllowsProfile(identity, profileObj.name)) {
        const err = new Error(`identity '${identity.id}' not allowed for profile '${profileObj.name}'`);
        err.code = -32600;
        throw err;
      }
    }
    if (profileObj) {
      if (profileObj.unknown) {
        const err = new Error(`unknown profile: ${profileObj.name}`);
        err.code = -32602;
        throw err;
      }
      if (workspaceId && Array.isArray(profileObj.workspacesInclude)) {
        const ok = profileObj.workspacesInclude.some(p => matchPattern(p, workspaceId));
        if (!ok) {
          const err = new Error(`profile '${profileObj.name}' does not include workspace '${workspaceId}'`);
          err.code = -32600;
          throw err;
        }
      }
      if (toolName && Array.isArray(profileObj.toolsInclude)) {
        const ok = profileObj.toolsInclude.some(p => matchPattern(p, toolName));
        if (!ok) {
          const err = new Error(`profile '${profileObj.name}' does not include tool '${toolName}'`);
          err.code = -32600;
          throw err;
        }
      }
    }
  }

  async _toolsList(identity, profileObj) {
    let tools = await this.tr.getTools({ identity, profile: profileObj });

    // Legacy built-in "read-only" filter — only applied when profile has no toolsInclude
    if (profileObj?.builtIn && profileObj.name === 'read-only') {
      tools = tools.filter(t => {
        if (!t._workspace) return true;
        const provider = this.wm.getProvider(t._workspace);
        if (!provider) return false;
        const rawTool = provider.getTools().find(rt => rt.name === t._originalName);
        return rawTool?.readOnly !== false;
      });
    }

    return {
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  async _toolsCall(params, identity, profileObj) {
    const { name, arguments: args = {} } = params || {};
    if (!name) {
      return this._toolError('Tool name is required', {
        category: 'internal',
        retryable: false,
      });
    }

    const resolved = await this.tr.resolve(name);
    if (!resolved) {
      return this._toolError(`이 도구는 현재 비활성화되어 있습니다: ${name}`, {
        category: 'config_conflict',
        tool: name,
        retryable: false,
      });
    }

    // Meta tools — always allowed (no workspace context)
    if (resolved.type === 'meta') {
      return await this._handleMetaTool(resolved.toolName, args, identity, profileObj);
    }

    // 2nd-line ACL check (defense in depth vs tools/list bypass)
    try {
      this._assertAllowed(identity, profileObj, {
        workspaceId: resolved.workspaceId,
        toolName: name,
      });
    } catch (err) {
      return this._toolError(err.message, {
        category: 'unauthorized',
        workspace: resolved.workspaceId,
        tool: name,
        retryable: false,
      });
    }

    // Workspace tools
    const provider = this.wm.getProvider(resolved.workspaceId);
    if (!provider) {
      return this._toolError(`워크스페이스를 찾을 수 없습니다: ${resolved.workspaceId}`, {
        category: 'internal',
        workspace: resolved.workspaceId,
        retryable: false,
      });
    }

    // Retry with exponential backoff for transient errors
    const MAX_RETRIES = 2;
    let lastErr;
    const startedAt = Date.now();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await provider.callTool(resolved.toolName, args);
        // Phase 7g: record successful call (usage JSONL)
        if (this._usage) {
          try {
            this._usage.record({
              identity: identity?.id || 'anonymous',
              workspaceId: resolved.workspaceId,
              tool: name,
              durationMs: Date.now() - startedAt,
              ok: !result?.isError,
            });
          } catch { /* best effort */ }
        }
        return result;
      } catch (err) {
        lastErr = err;
        const category = this._categorizeError(err);
        const retryable = category === 'connectivity' || category === 'provider_outage' || category === 'rate_limit';
        if (!retryable || attempt === MAX_RETRIES) break;
        const delay = err.retryAfter ? err.retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 5000);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    const ws = this.wm.getWorkspace(resolved.workspaceId);
    const displayName = ws?.displayName || resolved.workspaceId;
    const category = this._categorizeError(lastErr);
    this.wm.logError(category, resolved.workspaceId, lastErr.message);
    // Phase 7g: record failed call
    if (this._usage) {
      try {
        this._usage.record({
          identity: identity?.id || 'anonymous',
          workspaceId: resolved.workspaceId,
          tool: name,
          durationMs: Date.now() - startedAt,
          ok: false,
        });
      } catch { /* best effort */ }
    }

    const meta = {
      category,
      workspace: resolved.workspaceId,
      provider: resolved.provider,
      tool: resolved.toolName,
      retryable: category === 'connectivity' || category === 'rate_limit' || category === 'provider_outage',
      userMessage: this._userMessage(category, displayName),
    };
    if (lastErr.retryAfter) meta.retryAfter = lastErr.retryAfter;

    return this._toolError(
      `${displayName}에서 ${resolved.toolName} 실행에 실패했습니다. ${lastErr.message}`,
      meta
    );
  }

  async _handleMetaTool(toolName, args, identity, profileObj) {
    switch (toolName) {
      case 'bifrost__list_workspaces': {
        let workspaces = this.wm.getWorkspaces().map(ws => ({
          id: ws.id,
          provider: ws.provider,
          displayName: ws.displayName,
          namespace: ws.namespace,
          status: ws.status,
          enabled: ws.enabled,
        }));
        // Respect identity/profile ACL — only list workspaces user can access
        if (identity) {
          workspaces = workspaces.filter(ws => identityAllowsWorkspace(identity, ws.id));
        }
        if (profileObj && Array.isArray(profileObj.workspacesInclude)) {
          workspaces = workspaces.filter(ws => profileObj.workspacesInclude.some(p => matchPattern(p, ws.id)));
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(workspaces, null, 2) }],
        };
      }
      case 'bifrost__workspace_info': {
        const ws = this.wm.getWorkspace(args.workspace_id);
        if (!ws) {
          return this._toolError(`워크스페이스를 찾을 수 없습니다: ${args.workspace_id}`, {
            category: 'config_conflict',
            retryable: false,
          });
        }
        try {
          this._assertAllowed(identity, profileObj, { workspaceId: ws.id });
        } catch (err) {
          return this._toolError(err.message, { category: 'unauthorized', workspace: ws.id, retryable: false });
        }
        const allTools = await this.tr.getTools({ identity, profile: profileObj });
        const tools = allTools
          .filter(t => t._workspace === ws.id)
          .map(t => ({ name: t.name, description: t.description }));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ...ws, tools, credentials: undefined }, null, 2),
          }],
        };
      }
      default:
        return this._toolError(`Unknown meta tool: ${toolName}`, {
          category: 'internal',
          retryable: false,
        });
    }
  }

  _resourcesList(identity) {
    let workspaces = this.wm.getWorkspaces();
    if (identity) {
      workspaces = workspaces.filter(ws => identityAllowsWorkspace(identity, ws.id));
    }
    const resources = workspaces.map(ws => ({
      uri: `bifrost://workspaces/${ws.id}`,
      name: ws.displayName,
      description: `${ws.provider} 워크스페이스 (namespace: ${ws.namespace}, 상태: ${ws.status})`,
      mimeType: 'application/json',
    }));
    return { resources };
  }

  async _resourcesRead(params, identity) {
    const { uri } = params || {};
    const match = uri?.match(/^bifrost:\/\/workspaces\/(.+)$/);
    if (!match) {
      return { contents: [] };
    }
    const ws = this.wm.getWorkspace(match[1]);
    if (!ws) {
      return { contents: [] };
    }
    if (identity && !identityAllowsWorkspace(identity, ws.id)) {
      const err = new Error(`identity '${identity.id}' not allowed for workspace '${ws.id}'`);
      err.code = -32600;
      throw err;
    }
    const allTools = await this.tr.getTools();
    const tools = allTools
      .filter(t => t._workspace === ws.id)
      .map(t => ({ name: t._originalName, usable: true }));

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          id: ws.id,
          provider: ws.provider,
          namespace: ws.namespace,
          displayName: ws.displayName,
          status: ws.status,
          tools,
          lastChecked: new Date().toISOString(),
        }),
      }],
    };
  }

  _toolError(message, meta) {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
      _meta: { bifrost: meta },
    };
  }

  _categorizeError(err) {
    if (err.status === 401 || err.status === 403) return 'credential';
    if (err.status === 429) return 'rate_limit';
    if (err.status >= 500) return 'provider_outage';
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return 'connectivity';
    return 'internal';
  }

  _userMessage(category, displayName) {
    switch (category) {
      case 'credential': return `${displayName}의 토큰이 만료되었거나 무효합니다. Bifrost Admin에서 갱신이 필요합니다.`;
      case 'rate_limit': return `${displayName}의 API 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.`;
      case 'connectivity': return `${displayName}에 연결할 수 없습니다. 네트워크 상태를 확인하세요.`;
      case 'provider_outage': return `${displayName}의 API 서버에 문제가 있습니다. 잠시 후 다시 시도하세요.`;
      default: return `${displayName}에서 오류가 발생했습니다.`;
    }
  }

  _errorResponse(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
