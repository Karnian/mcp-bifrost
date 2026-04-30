/**
 * MCP Server template library.
 * Each template describes how to configure a specific MCP server with
 * minimal user input. Sensitive values are exposed as `fields` to fill in.
 */
/**
 * Template categories for filtering.
 */
export const TEMPLATE_CATEGORIES = [
  { id: 'all', label: '전체' },
  { id: 'productivity', label: '생산성' },
  { id: 'development', label: '개발' },
  { id: 'communication', label: '커뮤니케이션' },
  { id: 'storage', label: '저장소' },
  { id: 'demo', label: '데모/테스트' },
];

/**
 * Search templates by name, description, or category.
 * @param {string} query
 * @param {string} [category] - filter by category id
 * @returns {Array}
 */
export function searchTemplates(query, category) {
  let results = TEMPLATES;
  if (category && category !== 'all') {
    results = results.filter(t => t.category === category);
  }
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q)
    );
  }
  return results;
}

export const TEMPLATES = [
  // --- Built-in MCP servers ---
  {
    id: 'filesystem',
    name: 'Filesystem',
    icon: 'FS',
    category: 'storage',
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
    category: 'development',
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
    category: 'demo',
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
    category: 'development',
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
    id: 'github-oauth',
    name: 'GitHub (Remote MCP · OAuth)',
    icon: 'GH',
    category: 'development',
    description: 'GitHub 공식 hosted MCP (Copilot MCP) + OAuth 2.0',
    kind: 'mcp-client',
    transport: 'http',
    // URL source: https://github.blog/changelog/ GitHub Copilot MCP (2025).
    // If unavailable in your region, replace with the URL GitHub publishes.
    url: 'https://api.githubcopilot.com/mcp/',
    oauth: true,
    fields: [],
  },
  {
    id: 'linear-oauth',
    name: 'Linear (Remote MCP · OAuth)',
    icon: 'L',
    category: 'productivity',
    description: 'Linear 공식 hosted MCP + OAuth 2.0',
    kind: 'mcp-client',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    oauth: true,
    fields: [],
  },
  {
    id: 'google-drive-oauth',
    name: 'Google Drive (Remote MCP · OAuth, stub)',
    icon: 'GD',
    category: 'storage',
    description: 'Google Drive hosted MCP (URL 미공개 — 사용자가 직접 입력 필요)',
    kind: 'mcp-client',
    transport: 'http',
    url: '', // user must fill in at Wizard Step 3
    oauth: true,
    stub: true,
    fields: [
      { name: 'url', label: 'MCP Endpoint URL', required: true, placeholder: 'https://drive.mcp.example/mcp' },
    ],
  },
  {
    id: 'notion-official-oauth',
    name: 'Notion (공식 MCP · OAuth)',
    icon: 'N',
    category: 'productivity',
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
    category: 'productivity',
    description: 'Notion 공식 MCP 서버 (권장)',
    kind: 'mcp-client',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envFields: [
      { name: 'OPENAPI_MCP_HEADERS', label: 'Headers JSON', required: true, secret: true, placeholder: '{"Authorization":"Bearer ntn_...","Notion-Version":"2022-06-28"}' },
    ],
  },

  // --- Native (Phase 12 OAuth) ---
  // Phase 12-6 (wizard 통합): Slack OAuth flow 는 `flow: 'slack-oauth'`
  // 플래그로 wizard step 2 를 우회하고 SPA 의 Slack 화면으로 hand-off
  // (showScreen 기반 — SPA 라우터 없음). Slack App credential 등록 +
  // popup install 은 그쪽에서 처리.
  {
    id: 'slack-oauth',
    name: 'Slack (OAuth)',
    icon: 'S',
    category: 'communication',
    description: 'Slack OAuth 2.0 install — 다수 외부 workspace 지원 (권장)',
    recommended: true,
    flow: 'slack-oauth',
    kind: 'native',
    provider: 'slack',
    fields: [],
  },

  // --- Native (legacy) providers ---
  {
    id: 'notion-native',
    name: 'Notion (내장)',
    icon: 'N',
    category: 'productivity',
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
    category: 'communication',
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
      // stub templates let the user override the URL at wizard time
      payload.url = values.url || template.url;
      payload.headers = template.headers || {};
      if (template.oauth) {
        payload.oauth = { enabled: true };
      }
    }
  }
  return payload;
}
