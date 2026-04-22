/**
 * Phase 11-9 §12-2 / Phase 11-10 §2 — Static OAuth client wizard helpers.
 *
 * Extracted from `app.js` so the matching logic + rendering are testable
 * from Node without a DOM. The browser entry imports from here; Node
 * tests import the same exports.
 *
 * Public surface:
 *   - STATIC_CLIENT_GUIDES  — provider hostname → guidance map
 *   - guideFor(url)          — pick a guide by `new URL(url).hostname`
 *   - renderStaticClientBody({ redirectUri, guide, esc })
 */

// Keys are hostname suffixes matched against `new URL(workspaceUrl).hostname`.
// Match rule (`guideFor`): hostname === key OR hostname.endsWith(`.${key}`).
// That prevents false positives like `user-notion.com.attacker.tld` matching
// the `notion.com` key.
export const STATIC_CLIENT_GUIDES = {
  'notion.com': {
    label: 'Notion',
    docsUrl: 'https://www.notion.so/my-integrations',
    steps: [
      'Notion Integrations 페이지에서 <b>New integration</b> 클릭',
      'Associated workspace, name 설정 후 <b>Save</b>',
      '<b>Configure integration settings</b> 에서 <b>Public integration</b> 선택',
      '아래 Redirect URI 를 <b>Redirect URIs</b> 필드에 붙여넣기',
      '<b>OAuth client ID</b> 와 <b>OAuth client secret</b> 을 복사해 아래 폼에 입력',
    ],
  },
  'notion.so': {
    // Notion historically hosts OAuth under notion.so; alias to the same guide.
    label: 'Notion',
    docsUrl: 'https://www.notion.so/my-integrations',
    steps: [
      'Notion Integrations 페이지에서 <b>New integration</b> 클릭',
      'Associated workspace, name 설정 후 <b>Save</b>',
      '<b>Configure integration settings</b> 에서 <b>Public integration</b> 선택',
      '아래 Redirect URI 를 <b>Redirect URIs</b> 필드에 붙여넣기',
      '<b>OAuth client ID</b> 와 <b>OAuth client secret</b> 을 복사해 아래 폼에 입력',
    ],
  },
  'github.com': {
    label: 'GitHub',
    docsUrl: 'https://github.com/settings/applications/new',
    steps: [
      'GitHub > Developer settings > OAuth Apps 에서 <b>New OAuth App</b> 클릭',
      'Homepage / Application name 설정',
      '아래 Redirect URI 를 <b>Authorization callback URL</b> 에 붙여넣기',
      'Register application 클릭 후 Client ID / Generate a new client secret',
    ],
  },
};

/**
 * Resolve a workspace URL into a guide entry or null.
 *
 * Uses `new URL(...).hostname` with an exact-or-suffix match so a key
 * like `notion.com` accepts `mcp.notion.com` but rejects
 * `user-notion.com.attacker.tld`.
 */
export function guideFor(workspaceUrl) {
  if (!workspaceUrl) return null;
  let host;
  try {
    host = new URL(String(workspaceUrl)).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  for (const needle of Object.keys(STATIC_CLIENT_GUIDES)) {
    const n = needle.toLowerCase();
    if (host === n || host.endsWith(`.${n}`)) return STATIC_CLIENT_GUIDES[needle];
  }
  return null;
}

/**
 * Render the guidance block HTML embedded above the manual-client form.
 *
 * The `esc` function is injected so browser + Node callers can supply
 * the same HTML-escape impl they use elsewhere (app.js already defines
 * one). When omitted, a conservative default is used.
 */
export function renderStaticClientBody({ redirectUri = null, guide = null, esc = defaultEsc } = {}) {
  const heading = guide
    ? `<p><b>${esc(guide.label)}</b> 은 Dynamic Client Registration 을 지원하지 않아 Public integration 으로 직접 등록해야 합니다.</p>`
    : `<p>이 MCP 서버는 Dynamic Client Registration 을 지원하지 않습니다. Provider 콘솔에서 OAuth client 를 직접 발급하세요.</p>`;
  const stepsHtml = guide
    ? `<ol class="bifrost-modal-steps">${guide.steps.map(s => `<li>${s}</li>`).join('')}</ol>
       <p><a href="${esc(guide.docsUrl)}" target="_blank" rel="noopener noreferrer">→ ${esc(guide.label)} integration 페이지 열기</a></p>`
    : '';
  const redirectRow = redirectUri
    ? `<div class="bifrost-modal-copyrow">
         <label>Redirect URI (provider 에 등록)</label>
         <div class="bifrost-modal-copybox">
           <code id="bifrost-redirect-uri">${esc(redirectUri)}</code>
           <button type="button" class="btn-copy" data-copy-target="#bifrost-redirect-uri">복사</button>
         </div>
       </div>`
    : '';
  return `${heading}${stepsHtml}${redirectRow}`;
}

function defaultEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
