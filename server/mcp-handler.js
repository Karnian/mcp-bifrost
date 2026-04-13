/**
 * MCP Protocol Handler — handles JSON-RPC requests for MCP protocol.
 * Implements: initialize, tools/list, tools/call, resources/list, resources/read
 */
export class McpHandler {
  constructor(workspaceManager, toolRegistry) {
    this.wm = workspaceManager;
    this.tr = toolRegistry;
  }

  async handle(request) {
    const { method, params, id } = request;

    try {
      let result;
      switch (method) {
        case 'initialize':
          result = this._initialize(params);
          break;
        case 'tools/list':
          result = this._toolsList();
          break;
        case 'tools/call':
          result = await this._toolsCall(params);
          break;
        case 'resources/list':
          result = this._resourcesList();
          break;
        case 'resources/read':
          result = await this._resourcesRead(params);
          break;
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

  _toolsList() {
    const tools = this.tr.getTools().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools };
  }

  async _toolsCall(params) {
    const { name, arguments: args = {} } = params || {};
    if (!name) {
      return this._toolError('Tool name is required', {
        category: 'internal',
        retryable: false,
      });
    }

    const resolved = this.tr.resolve(name);
    if (!resolved) {
      return this._toolError(`이 도구는 현재 비활성화되어 있습니다: ${name}`, {
        category: 'config_conflict',
        tool: name,
        retryable: false,
      });
    }

    // Meta tools
    if (resolved.type === 'meta') {
      return this._handleMetaTool(resolved.toolName, args);
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

    try {
      const result = await provider.callTool(resolved.toolName, args);
      return result;
    } catch (err) {
      const ws = this.wm.getWorkspace(resolved.workspaceId);
      const displayName = ws?.displayName || resolved.workspaceId;
      const category = this._categorizeError(err);

      return this._toolError(
        `${displayName}에서 ${resolved.toolName} 실행에 실패했습니다. ${err.message}`,
        {
          category,
          workspace: resolved.workspaceId,
          provider: resolved.provider,
          tool: resolved.toolName,
          retryable: category === 'connectivity' || category === 'rate_limit',
          userMessage: this._userMessage(category, displayName),
        }
      );
    }
  }

  _handleMetaTool(toolName, args) {
    switch (toolName) {
      case 'bifrost__list_workspaces': {
        const workspaces = this.wm.getWorkspaces().map(ws => ({
          id: ws.id,
          provider: ws.provider,
          displayName: ws.displayName,
          namespace: ws.namespace,
          status: ws.status,
          enabled: ws.enabled,
        }));
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
        const tools = this.tr.getTools()
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

  _resourcesList() {
    const resources = this.wm.getWorkspaces().map(ws => ({
      uri: `bifrost://workspaces/${ws.id}`,
      name: ws.displayName,
      description: `${ws.provider} 워크스페이스 (namespace: ${ws.namespace}, 상태: ${ws.status})`,
      mimeType: 'application/json',
    }));
    return { resources };
  }

  async _resourcesRead(params) {
    const { uri } = params || {};
    const match = uri?.match(/^bifrost:\/\/workspaces\/(.+)$/);
    if (!match) {
      return { contents: [] };
    }
    const ws = this.wm.getWorkspace(match[1]);
    if (!ws) {
      return { contents: [] };
    }
    const tools = this.tr.getTools()
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
