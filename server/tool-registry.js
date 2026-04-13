/**
 * ToolRegistry — namespace-based tool registration and lookup.
 * Pattern: {provider}_{namespace}__{tool_name}
 */
export class ToolRegistry {
  constructor(workspaceManager) {
    this.wm = workspaceManager;
    this.toolsVersion = 1;
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
    const workspaces = this.wm.getEnabledWorkspaces();

    for (const ws of workspaces) {
      const provider = this.wm.getProvider(ws.id);
      if (!provider) continue;

      const rawTools = provider.getTools();
      const capability = this.wm.getCapability?.(ws.id);
      for (const tool of rawTools) {
        if (!this._passesFilter(ws, tool.name)) continue;
        if (this._isUnavailable(capability, tool.name)) continue;

        const mcpName = this._namespacedName(ws.provider, ws.namespace, tool.name);
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

    // Add bifrost meta tools
    tools.push(...this._metaTools());

    return tools;
  }

  /**
   * Resolve a namespaced tool call to workspace + original tool name.
   */
  resolve(mcpToolName) {
    // Meta tools
    if (mcpToolName.startsWith('bifrost__')) {
      return { type: 'meta', toolName: mcpToolName };
    }

    // Parse {provider}_{namespace}__{tool_name}
    const doubleUnderIdx = mcpToolName.indexOf('__');
    if (doubleUnderIdx === -1) return null;

    const prefix = mcpToolName.slice(0, doubleUnderIdx);
    const toolName = mcpToolName.slice(doubleUnderIdx + 2);
    const firstUnder = prefix.indexOf('_');
    if (firstUnder === -1) return null;

    const provider = prefix.slice(0, firstUnder);
    const namespace = prefix.slice(firstUnder + 1);

    const ws = this.wm.getEnabledWorkspaces().find(
      w => w.provider === provider && w.namespace === namespace
    );
    if (!ws) return null;

    return { type: 'workspace', workspaceId: ws.id, toolName, provider, namespace };
  }

  _namespacedName(provider, namespace, toolName) {
    return `${provider}_${namespace}__${toolName}`;
  }

  _enrichDescription(ws, tool) {
    const readOnly = tool.readOnly ? ' (읽기 전용)' : '';
    const providerLabel = ws.provider.charAt(0).toUpperCase() + ws.provider.slice(1);
    return `[${ws.displayName}] ${tool.description}. ${providerLabel} 워크스페이스.${readOnly}`;
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
