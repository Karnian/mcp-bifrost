import { BaseProvider } from './base.js';

const SLACK_API = 'https://slack.com/api';
// Phase 12-4 §4.2 — auth.test rate-limit cooldown. Multiple OAuth-mode
// workspaces sharing one Slack App quickly hit Slack's per-team rate
// budget if every healthCheck/refresh re-pings auth.test. 60 s matches
// Slack's typical Tier 3 rate-limit window.
const CAPABILITY_COOLDOWN_MS = 60_000;

export class SlackProvider extends BaseProvider {
  constructor(workspaceConfig) {
    super(workspaceConfig);
    this.authMode = workspaceConfig.authMode || 'token';
    this.botToken = workspaceConfig.credentials?.botToken;
    this.teamId = workspaceConfig.credentials?.teamId;
    // Phase 12-4 §4.2 — _tokenProvider is injected by WorkspaceManager when
    // authMode === 'oauth'. Closure over SlackOAuthManager.ensureValidAccessToken
    // so token rotation is transparent to callTool().
    this._tokenProvider = workspaceConfig._tokenProvider || null;
    // Capability cooldown gate — last check timestamp.
    this._lastCapabilityCheck = 0;
    this._cachedCapability = null;
  }

  // Phase 12-4 §4.2 — _headers() is async because OAuth mode pulls a
  // freshly-validated access token via _tokenProvider on every request.
  // Token-mode keeps backwards compatibility (no provider, returns
  // botToken). Every fetch helper below awaits _headers() so a stale
  // access_token can't slip past the refresh path.
  async _headers() {
    let token;
    if (this.authMode === 'oauth') {
      if (!this._tokenProvider) {
        throw new Error(`SlackProvider OAuth mode requires _tokenProvider injection (workspace=${this.id})`);
      }
      token = await this._tokenProvider();
      if (!token) {
        const err = new Error(`SlackProvider _tokenProvider returned no token (workspace=${this.id}) — re-authorize required`);
        err.code = 'SLACK_NO_TOKEN';
        throw err;
      }
    } else {
      token = this.botToken;
      if (!token) {
        const err = new Error(`SlackProvider token mode requires credentials.botToken (workspace=${this.id})`);
        err.code = 'SLACK_NO_TOKEN';
        throw err;
      }
    }
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  async _fetch(method, params = {}) {
    const url = `${SLACK_API}/${method}`;
    const headers = await this._headers();
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    const body = await res.json();
    const scopeHeader = res.headers.get('x-oauth-scopes');
    if (scopeHeader) {
      body._scopes = scopeHeader.split(',').map(s => s.trim());
    }
    if (!body.ok) {
      const err = new Error(body.error || `Slack API error: ${method}`);
      err.slackError = body.error;
      if (body.error === 'ratelimited') {
        err.status = 429;
        err.retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10);
      }
      throw err;
    }
    return body;
  }

  getTools() {
    return [
      {
        name: 'search_messages',
        description: 'Search messages in Slack',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            count: { type: 'number', description: 'Number of results (max 100)', default: 20 },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_channel',
        description: 'Read recent messages from a Slack channel',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel ID' },
            limit: { type: 'number', description: 'Number of messages (max 100)', default: 20 },
          },
          required: ['channel'],
        },
      },
      {
        name: 'list_channels',
        description: 'List channels in Slack',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of channels (max 200)', default: 50 },
            types: { type: 'string', description: 'Channel types (public_channel,private_channel)', default: 'public_channel' },
          },
        },
      },
    ];
  }

  async callTool(toolName, args = {}) {
    switch (toolName) {
      case 'search_messages': return this._searchMessages(args);
      case 'read_channel': return this._readChannel(args);
      case 'list_channels': return this._listChannels(args);
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
    }
  }

  async _searchMessages({ query, count = 20 }) {
    if (!query) {
      return { content: [{ type: 'text', text: 'query is required' }], isError: true };
    }
    const body = await this._fetch('search.messages', {
      query,
      count: Math.min(count, 100),
    });
    const messages = (body.messages?.matches || []).map(m => ({
      channel: { id: m.channel?.id, name: m.channel?.name },
      user: m.user || m.username,
      text: m.text,
      ts: m.ts,
      permalink: m.permalink,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
    };
  }

  async _readChannel({ channel, limit = 20 }) {
    if (!channel) {
      return { content: [{ type: 'text', text: 'channel is required' }], isError: true };
    }
    const body = await this._fetch('conversations.history', {
      channel,
      limit: Math.min(limit, 100),
    });
    const messages = (body.messages || []).map(m => ({
      user: m.user,
      text: m.text,
      ts: m.ts,
      type: m.type,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
    };
  }

  async _listChannels({ limit = 50, types = 'public_channel' }) {
    const body = await this._fetch('conversations.list', {
      limit: Math.min(limit, 200),
      types,
    });
    const channels = (body.channels || []).map(c => ({
      id: c.id,
      name: c.name,
      topic: c.topic?.value,
      num_members: c.num_members,
      is_private: c.is_private,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(channels, null, 2) }],
    };
  }

  async healthCheck() {
    try {
      const res = await this._fetch('auth.test');
      if (res.team_id && !this.teamId) {
        this.teamId = res.team_id;
      }
      return { ok: true, message: `Connected to ${res.team || 'Slack'}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async validateCredentials() {
    try {
      await this._fetch('auth.test');
      return true;
    } catch {
      return false;
    }
  }

  async capabilityCheck() {
    // Phase 12-4 §4.2 — cooldown gate so multi-workspace deployments
    // don't pummel Slack's auth.test rate budget. Returns the cached
    // capability snapshot when a check ran within COOLDOWN_MS.
    const now = Date.now();
    if (this._cachedCapability && (now - this._lastCapabilityCheck) < CAPABILITY_COOLDOWN_MS) {
      return this._cachedCapability;
    }
    const result = { scopes: [], resources: { count: 0, samples: [] }, tools: [] };

    let grantedScopes = [];
    try {
      const auth = await this._fetch('auth.test');
      if (auth.team_id && !this.teamId) {
        this.teamId = auth.team_id;
      }
      result.scopes.push(`team: ${auth.team || auth.team_id}`);
      if (auth._scopes) {
        grantedScopes = auth._scopes;
        result.scopes.push(...grantedScopes.map(s => `scope: ${s}`));
      }
    } catch (err) {
      // On auth.test failure cache the empty result briefly so we don't
      // refire on every status poll. The cooldown applies whether the
      // check succeeded or failed.
      this._cachedCapability = result;
      this._lastCapabilityCheck = now;
      return result;
    }

    let hasChannelsRead = false;
    try {
      const channels = await this._fetch('conversations.list', { limit: 3 });
      result.resources.count = channels.channels?.length || 0;
      result.resources.samples = (channels.channels || []).slice(0, 3).map(c => ({
        id: c.id,
        name: c.name,
        type: 'channel',
      }));
      hasChannelsRead = true;
    } catch (err) {
      if (err.slackError === 'missing_scope') {
        result.scopes.push('missing: channels:read');
      }
    }

    let hasSearchAccess = false;
    try {
      await this._fetch('search.messages', { query: 'test', count: 1 });
      hasSearchAccess = true;
    } catch (err) {
      if (err.slackError === 'missing_scope') {
        result.scopes.push('missing: search:read');
      }
    }

    const tools = this.getTools();
    for (const tool of tools) {
      if (tool.name === 'list_channels' || tool.name === 'read_channel') {
        result.tools.push({
          name: tool.name,
          usable: hasChannelsRead ? 'usable' : 'unavailable',
          reason: hasChannelsRead ? undefined : 'channels:read scope missing',
        });
      } else if (tool.name === 'search_messages') {
        result.tools.push({
          name: tool.name,
          usable: hasSearchAccess ? 'usable' : 'unavailable',
          reason: hasSearchAccess ? undefined : 'search:read scope missing',
        });
      }
    }

    this._cachedCapability = result;
    this._lastCapabilityCheck = now;
    return result;
  }
}
