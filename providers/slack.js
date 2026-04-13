import { BaseProvider } from './base.js';

const SLACK_API = 'https://slack.com/api';

export class SlackProvider extends BaseProvider {
  constructor(workspaceConfig) {
    super(workspaceConfig);
    this.botToken = workspaceConfig.credentials?.botToken;
    this.teamId = workspaceConfig.credentials?.teamId;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  async _fetch(method, params = {}) {
    const url = `${SLACK_API}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(params),
    });
    const body = await res.json();
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
    const result = { scopes: [], resources: { count: 0, samples: [] }, tools: [] };

    try {
      const auth = await this._fetch('auth.test');
      // Extract scopes from response headers (not available in JSON, parse from token type)
      if (auth.team_id && !this.teamId) {
        this.teamId = auth.team_id;
      }
      result.scopes.push(`team: ${auth.team || auth.team_id}`);
    } catch {
      return result;
    }

    // Check channels access
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

    // Check search access
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

    return result;
  }
}
