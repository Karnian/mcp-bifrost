import { BaseProvider } from './base.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export class NotionProvider extends BaseProvider {
  constructor(workspaceConfig) {
    super(workspaceConfig);
    this.token = workspaceConfig.credentials?.token;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    };
  }

  async _fetch(path, options = {}) {
    const url = `${NOTION_API}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { ...this._headers(), ...options.headers },
    });
    const body = await res.json();
    if (!res.ok) {
      const err = new Error(body.message || `Notion API error: ${res.status}`);
      err.status = res.status;
      err.code = body.code;
      throw err;
    }
    return body;
  }

  getTools() {
    return [
      {
        name: 'search_pages',
        description: 'Search pages in Notion',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query string' },
            page_size: { type: 'number', description: 'Number of results (max 100)', default: 10 },
          },
        },
      },
      {
        name: 'read_page',
        description: 'Read a page content from Notion',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            page_id: { type: 'string', description: 'The page ID to read' },
          },
          required: ['page_id'],
        },
      },
      {
        name: 'list_databases',
        description: 'List databases in Notion',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            page_size: { type: 'number', description: 'Number of results (max 100)', default: 10 },
          },
        },
      },
    ];
  }

  async callTool(toolName, args = {}) {
    switch (toolName) {
      case 'search_pages': return this._searchPages(args);
      case 'read_page': return this._readPage(args);
      case 'list_databases': return this._listDatabases(args);
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
    }
  }

  async _searchPages({ query = '', page_size = 10 }) {
    const body = await this._fetch('/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        page_size: Math.min(page_size, 100),
        filter: { value: 'page', property: 'object' },
      }),
    });
    const pages = body.results.map(p => ({
      id: p.id,
      title: this._extractTitle(p),
      url: p.url,
      last_edited: p.last_edited_time,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }],
    };
  }

  async _readPage({ page_id }) {
    if (!page_id) {
      return {
        content: [{ type: 'text', text: 'page_id is required' }],
        isError: true,
      };
    }
    const [page, blocks] = await Promise.all([
      this._fetch(`/pages/${page_id}`),
      this._fetch(`/blocks/${page_id}/children?page_size=100`),
    ]);
    const result = {
      id: page.id,
      title: this._extractTitle(page),
      url: page.url,
      properties: page.properties,
      content: blocks.results.map(b => this._blockToText(b)),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  async _listDatabases({ page_size = 10 }) {
    const body = await this._fetch('/search', {
      method: 'POST',
      body: JSON.stringify({
        page_size: Math.min(page_size, 100),
        filter: { value: 'database', property: 'object' },
      }),
    });
    const databases = body.results.map(d => ({
      id: d.id,
      title: d.title?.map(t => t.plain_text).join('') || 'Untitled',
      url: d.url,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(databases, null, 2) }],
    };
  }

  async healthCheck() {
    try {
      await this._fetch('/users/me');
      return { ok: true, message: 'Connected' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async validateCredentials() {
    try {
      await this._fetch('/users/me');
      return true;
    } catch {
      return false;
    }
  }

  async capabilityCheck() {
    const result = { scopes: [], resources: { count: 0, samples: [] }, tools: [] };
    try {
      const me = await this._fetch('/users/me');
      result.scopes.push(`bot: ${me.bot?.owner?.type || 'unknown'}`);
    } catch {
      return result;
    }

    try {
      const search = await this._fetch('/search', {
        method: 'POST',
        body: JSON.stringify({ page_size: 3 }),
      });
      result.resources.count = search.results.length;
      result.resources.samples = search.results.slice(0, 3).map(r => ({
        id: r.id,
        type: r.object,
        title: this._extractTitle(r),
      }));
    } catch { /* ignore */ }

    const tools = this.getTools();
    for (const tool of tools) {
      if (tool.name === 'search_pages') {
        result.tools.push({
          name: tool.name,
          usable: result.resources.count > 0 ? 'usable' : 'limited',
          reason: result.resources.count === 0 ? 'No shared pages found' : undefined,
        });
      } else {
        result.tools.push({ name: tool.name, usable: 'usable' });
      }
    }
    return result;
  }

  _extractTitle(obj) {
    if (obj.properties?.title?.title) {
      return obj.properties.title.title.map(t => t.plain_text).join('');
    }
    if (obj.properties?.Name?.title) {
      return obj.properties.Name.title.map(t => t.plain_text).join('');
    }
    if (obj.title) {
      return Array.isArray(obj.title)
        ? obj.title.map(t => t.plain_text).join('')
        : obj.title;
    }
    return 'Untitled';
  }

  _blockToText(block) {
    const type = block.type;
    const data = block[type];
    if (!data) return { type, text: '' };
    if (data.rich_text) {
      return { type, text: data.rich_text.map(t => t.plain_text).join('') };
    }
    return { type, text: JSON.stringify(data) };
  }
}
