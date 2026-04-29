/**
 * Phase 12-8 — Slack App manifest template + operator setup guide.
 *
 * Coverage (plan §5):
 *   - templates/slack-app-manifest.yaml ships with required Phase 12 invariants
 *     (pkce_enabled: false, token_rotation_enabled: true, user-token only,
 *     org_deploy_enabled: false)
 *   - manifest endpoint stamps canonical redirect URL into the template
 *     verbatim (single source of truth — file under version control)
 *   - docs/SLACK_OAUTH_SETUP.md exists with the documented sections
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATE_PATH = join(ROOT, 'templates', 'slack-app-manifest.yaml');
const SETUP_DOC_PATH = join(ROOT, 'docs', 'SLACK_OAUTH_SETUP.md');

test('templates/slack-app-manifest.yaml: Phase 12 invariants present (line-anchored)', async () => {
  const yaml = await readFile(TEMPLATE_PATH, 'utf-8');
  // Codex 12-8 R1 NIT: line-anchored matches so a comment containing the
  // text doesn't satisfy the assertion. Multiline mode required.
  assert.match(yaml, /^\s*pkce_enabled:\s*false\s*$/m, 'PKCE must be off (confidential web app)');
  assert.match(yaml, /^\s*token_rotation_enabled:\s*true\s*$/m, 'rotation enabled by default');
  assert.match(yaml, /^\s*org_deploy_enabled:\s*false\s*$/m, 'Enterprise Grid org-wide install disabled');
  assert.match(yaml, /^\s*socket_mode_enabled:\s*false\s*$/m);
  // user-token scopes — bot section absent
  assert.match(yaml, /scopes:\s*[\s\S]*?user:/);
  assert.ok(!/^\s*bot:/m.test(yaml), 'no bot scopes in user-token-only manifest');
  assert.match(yaml, /^\s*-\s*search:read\s*$/m);
  assert.match(yaml, /^\s*-\s*channels:read\s*$/m);
  assert.match(yaml, /^\s*-\s*users:read\s*$/m);
  // redirect_urls placeholder line — not just any occurrence in comments
  assert.match(yaml, /^\s*-\s*https:\/\/your-bifrost-host\/oauth\/slack\/callback\s*$/m);
});

test('docs/SLACK_OAUTH_SETUP.md: required sections', async () => {
  const md = await readFile(SETUP_DOC_PATH, 'utf-8');
  for (const heading of [
    '사전 조건',
    'Slack App 생성',
    'Bifrost 등록',
    'Workspace 연결',
    '운영 시나리오',
    '보안 고려사항',
    '트러블슈팅',
  ]) {
    assert.ok(md.includes(heading), `setup guide must include "${heading}"`);
  }
  // R7 secret rotation step explicitly called out
  assert.match(md, /Slack App Credential rotation \(R7\)/);
  // Cloudflare random tunnel rejection
  assert.match(md, /random tunnel/i);
  // Codex 12-8 R1 REVISE 2: security table must cover all plan §6 invariants
  for (const fragment of [
    'Token rotation race',
    'auth.test',
    'incoming_webhook',
    'env override',
    'Slack OAuth 응답 검증',
  ]) {
    assert.ok(md.includes(fragment), `security section must cover "${fragment}"`);
  }
  // Codex 12-8 R1 REVISE 3: troubleshooting table covers all friendly mapped codes
  for (const code of [
    'bad_redirect_uri',
    'invalid_team_for_non_distributed_app',
    'unapproved_scope',
    'org_login_required',
    'invalid_client',
    'invalid_client_id',
    'invalid_grant',
    'access_denied',
  ]) {
    assert.ok(md.includes(code), `troubleshooting table must include "${code}"`);
  }
});

test('manifest endpoint loads from templates dir + replaces redirect placeholder', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { startServer } = await import('../server/index.js');
  const { PUBLIC_ORIGIN_ENV_VAR } = await import('../server/public-origin.js');

  const dir = await mkdtemp(join(tmpdir(), 'phase12-8-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    server: { port: 0, host: '127.0.0.1' }, workspaces: [],
  }), 'utf-8');
  const prev = process.env[PUBLIC_ORIGIN_ENV_VAR];
  process.env[PUBLIC_ORIGIN_ENV_VAR] = 'https://bifrost.test';
  const srv = await startServer({ port: 0, host: '127.0.0.1', configDir: dir });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/slack/manifest.yaml`);
    assert.equal(r.status, 200);
    const yaml = await r.text();
    // Canonical redirect baked in
    assert.match(yaml, /https:\/\/bifrost\.test\/oauth\/slack\/callback/);
    // Active redirect_urls must NOT carry the placeholder anymore.
    // (Comments may still mention `your-bifrost-host` as documentation.)
    assert.ok(
      !/^\s*-\s*https:\/\/your-bifrost-host\//m.test(yaml),
      'redirect_urls placeholder must be replaced',
    );
    // Phase 12 invariants survive end-to-end
    assert.match(yaml, /pkce_enabled:\s*false/);
    assert.match(yaml, /token_rotation_enabled:\s*true/);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env[PUBLIC_ORIGIN_ENV_VAR];
    else process.env[PUBLIC_ORIGIN_ENV_VAR] = prev;
  }
});
