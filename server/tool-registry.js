/**
 * ToolRegistry — namespace-based tool registration + reverse lookup table.
 * Display name pattern: {provider}_{namespace}__{tool_name}
 * Resolution uses an internal reverse map, not string parsing, so upstream
 * tool names containing "__" or "_" are handled correctly.
 */
export class ToolRegistry {
  constructor(workspaceManager) {
    this.wm = workspaceManager;
    this.toolsVersion = 1;
    // mcpName → { workspaceId, originalName }
    this._reverseMap = new Map();
  }

  bumpVersion() {
    this.toolsVersion++;
  }

  /**
   * Build the full MCP tool list from all enabled workspaces.
   * Applies toolFilter and returns namespaced tools with enriched descriptions.
   */
  getTools() {
    const tools = [];
    const reverseMap = new Map();
    const workspaces = this.wm.getEnabledWorkspaces();

    for (const ws of workspaces) {
      const provider = this.wm.getProvider(ws.id);
      if (!provider) continue;

      const rawTools = provider.getTools();
      const capability = this.wm.getCapability?.(ws.id);
      for (const tool of rawTools) {
        if (!this._passesFilter(ws, tool.name)) continue;
        if (this._isUnavailable(capability, tool.name)) continue;

        let mcpName = this._namespacedName(ws.provider, ws.namespace, tool.name);
        // Collision avoidance: sanitize any character that would confuse parsers
        mcpName = mcpName.replace(/[^a-zA-Z0-9_.-]/g, '_');
        // Disambiguate if sanitization caused collision with existing mapping
        let candidate = mcpName;
        let suffix = 2;
        while (reverseMap.has(candidate)) {
          candidate = `${mcpName}_${suffix++}`;
        }
        mcpName = candidate;

        reverseMap.set(mcpName, { workspaceId: ws.id, originalName: tool.name, provider: ws.provider, namespace: ws.namespace });
        const description = this._enrichDescription(ws, tool);

        tools.push({
          name: mcpName,
          description,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          _workspace: ws.id,
          _originalName: tool.name,
        });
      }
    }

    // Meta tools
    for (const m of this._metaTools()) {
      reverseMap.set(m.name, { workspaceId: null, originalName: m._originalName });
      tools.push(m);
    }

    this._reverseMap = reverseMap;
    return tools;
  }

  /**
   * Resolve a namespaced tool call to workspace + original tool name.
   * Uses reverse lookup table (populated by getTools) rather than string parsing.
   */
  resolve(mcpToolName) {
    // Populate cache lazily if empty
    if (this._reverseMap.size === 0) this.getTools();

    if (mcpToolName.startsWith('bifrost__')) {
      return { type: 'meta', toolName: mcpToolName };
    }
    const entry = this._reverseMap.get(mcpToolName);
    if (!entry || !entry.workspaceId) return null;
    return {
      type: 'workspace',
      workspaceId: entry.workspaceId,
      toolName: entry.originalName,
      provider: entry.provider,
      namespace: entry.namespace,
    };
  }

  _namespacedName(provider, namespace, toolName) {
    return `${provider}_${namespace}__${toolName}`;
  }

  _enrichDescription(ws, tool) {
    const readOnly = tool.readOnly ? ' (읽기 전용)' : '';
    const providerLabel = ws.kind === 'mcp-client'
      ? `MCP(${ws.transport})`
      : ws.provider.charAt(0).toUpperCase() + ws.provider.slice(1);
    const desc = tool.description || tool.name;
    return `[${ws.displayName}] ${desc}. ${providerLabel} 워크스페이스.${readOnly}`;
  }

  _passesFilter(ws, toolName) {
    const filter = ws.toolFilter;
    if (!filter || filter.mode === 'all') return true;
    if (filter.mode === 'include') {
      return (filter.enabled || []).includes(toolName);
    }
    return true;
  }

  _isUnavailable(capability, toolName) {
    if (!capability?.tools) return false;
    const toolCap = capability.tools.find(t => t.name === toolName);
    return toolCap?.usable === 'unavailable';
  }

  _metaTools() {
    return [
      {
        name: 'bifrost__list_workspaces',
        description: 'List all connected workspaces with their status and display names.',
        inputSchema: { type: 'object', properties: {} },
        _workspace: null,
        _originalName: 'list_workspaces',
      },
      {
        name: 'bifrost__workspace_info',
        description: 'Get detailed information about a specific workspace including accessible resources and active tools.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace_id: { type: 'string', description: 'The workspace ID to query' },
          },
          required: ['workspace_id'],
        },
        _workspace: null,
        _originalName: 'workspace_info',
      },
    ];
  }

  getToolCount() {
    return this.getTools().length;
  }
}
