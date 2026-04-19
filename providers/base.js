/**
 * BaseProvider — abstract interface for all providers.
 * Each service (Notion, Slack, ...) extends this class.
 */
export class BaseProvider {
  constructor(workspaceConfig) {
    if (new.target === BaseProvider) {
      throw new Error('BaseProvider is abstract and cannot be instantiated directly');
    }
    this.config = workspaceConfig;
    this.id = workspaceConfig.id;
    this.provider = workspaceConfig.provider;
    this.namespace = workspaceConfig.namespace;
    this.displayName = workspaceConfig.displayName;
  }

  /** @returns {Array<{name: string, description: string, inputSchema: object}>} */
  getTools() {
    throw new Error('getTools() must be implemented');
  }

  /** @returns {{content: Array, isError?: boolean}} */
  async callTool(_toolName, _args) {
    throw new Error('callTool() must be implemented');
  }

  /** @returns {{ok: boolean, message: string}} */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented');
  }

  /** @returns {boolean} */
  async validateCredentials() {
    throw new Error('validateCredentials() must be implemented');
  }

  /**
   * @returns {{
   *   scopes: string[],
   *   resources: {count: number, samples: Array},
   *   tools: Array<{name: string, usable: string, reason?: string}>
   * }}
   */
  async capabilityCheck() {
    throw new Error('capabilityCheck() must be implemented');
  }

  /**
   * Optional: return prompt definitions for this provider.
   * @returns {Array<{name: string, description: string, arguments?: Array}>}
   */
  getPrompts() {
    return [];
  }
}
