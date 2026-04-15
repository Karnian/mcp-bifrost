/**
 * MCP Server template library.
 * Each template describes how to configure a specific MCP server with
 * minimal user input. Sensitive values are exposed as `fields` to fill in.
 */
export const TEMPLATES = [
  // --- Built-in MCP servers ---
  {
    id: 'filesystem',
    name: 'Filesystem',
    icon: 'FS',
    description: '로컬 파일 시스템 접근 (MCP 공식)',
    kind: 'mcp-client',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{{path}}'],
    fields: [
      { name: 'path', label: '경로', placeholder: '/Users/me/Documents', required: true },
    ],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    icon: 'HTTP',
    description: 'HTTP fetch via MCP (MCP 공식)',
    kind: 'mcp-client',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    fields: [],
  },
  {
    id: 'everything',
    name: 'Everything (Demo)',
    icon: 'DEMO',
    description: '모든 MCP 기능을 보여주는 테스트 서버',
    kind: 'mcp-client',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    fields: [],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: 'GH',
    description: 'GitHub API (공식 MCP)',
    kind: 'mcp-client',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envFields: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', required: true, secret: true },
    ],
  },
  {
    id: 'notion-official-oauth',
    name: 'Notion (공식 MCP · OAuth)',
    icon: 'N',
    description: 'Notion 공식 hosted MCP + OAuth 2.0 (권장)',
    kind: 'mcp-client',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    oauth: true,
    fields: [],
  },
  {
    id: 'notion-official',
    name: 'Notion (공식 MCP · stdio)',
    icon: 'N',
    description: 'Notion 공식 MCP 서버 (권장)',
    kind: 'mcp-client',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envFields: [
      { name: 'OPENAPI_MCP_HEADERS', label: 'Headers JSON', required: true, secret: true, placeholder: '{"Authorization":"Bearer ntn_...","Notion-Version":"2022-06-28"}' },
    ],
  },

  // --- Native (legacy) providers ---
  {
    id: 'notion-native',
    name: 'Notion (내장)',
    icon: 'N',
    description: 'Bifrost 내장 Notion 어댑터 (legacy)',
    legacy: true,
    kind: 'native',
    provider: 'notion',
    fields: [
      { name: 'token', label: 'Integration Token', required: true, secret: true, placeholder: 'ntn_...' },
    ],
  },
  {
    id: 'slack-native',
    name: 'Slack (내장)',
    icon: 'S',
    description: 'Bifrost 내장 Slack 어댑터 (legacy)',
    legacy: true,
    kind: 'native',
    provider: 'slack',
    fields: [
      { name: 'botToken', label: 'Bot Token', required: true, secret: true, placeholder: 'xoxb-...' },
      { name: 'teamId', label: 'Team ID', required: false, placeholder: 'T0001' },
    ],
  },
];

/**
 * Apply field values to a template, producing an addWorkspace payload.
 */
export function materializeTemplate(template, values) {
  const payload = {
    kind: template.kind,
    displayName: values.displayName || template.name,
  };

  if (template.kind === 'native') {
    payload.provider = template.provider;
    payload.credentials = {};
    for (const f of template.fields || []) {
      if (values[f.name]) payload.credentials[f.name] = values[f.name];
    }
  } else if (template.kind === 'mcp-client') {
    payload.transport = template.transport;
    if (template.transport === 'stdio') {
      payload.command = template.command;
      payload.args = (template.args || []).map(a =>
        a.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] || '')
      );
      payload.env = {};
      for (const ef of template.envFields || []) {
        if (values[ef.name]) payload.env[ef.name] = values[ef.name];
      }
    } else {
      payload.url = template.url;
      payload.headers = template.headers || {};
      if (template.oauth) {
        payload.oauth = { enabled: true };
      }
    }
  }
  return payload;
}
