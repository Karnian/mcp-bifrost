/**
 * Phase 12-6 — Admin UI smoke tests.
 *
 * The Admin UI is a vanilla SPA — full E2E browser tests live in 12-10.
 * Here we cover what we can verify without a DOM:
 *   - /admin/ index.html ships the new Slack nav button + screen
 *   - app.js wires the postMessage listener with origin validation
 *   - app.js exposes the polling loop logic for installs
 *   - manifest download path requires admin token (covered in 12-5)
 *
 * Coverage purpose: prove the static SPA shell loads with the Phase 12-6
 * additions without breaking existing screens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'admin', 'public');

test('index.html: includes Slack nav button + screen markup', async () => {
  const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf-8');
  assert.match(html, /id="btn-nav-slack"/);
  assert.match(html, /id="slack-screen"/);
  assert.match(html, /id="btn-slack-install"/);
  assert.match(html, /id="btn-slack-manifest"/);
  assert.match(html, /id="slack-app-form"/);
});

test('app.js: registers postMessage listener with type=bifrost-slack-install', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /window\.addEventListener\('message'/);
  assert.match(js, /'bifrost-slack-install'/);
  // Validates origin if known (D8 contract)
  assert.match(js, /_slackPostMessageOrigin/);
});

test('app.js: install polling fallback wired (1.5s interval, 5min timeout)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /startSlackInstallPolling/);
  assert.match(js, /1500/);
  assert.match(js, /5 \* 60 \* 1000/);
});

test('app.js: postMessage origin enforcement is strict (Codex R1 BLOCKER 1)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  // _slackPostMessageOrigin must be assigned during loadSlack (otherwise
  // the strict-origin check is inert).
  assert.match(js, /_slackPostMessageOrigin\s*=\s*res\.data\.publicOrigin/);
  // Strict guard: drop messages when origin is missing/invalid.
  assert.match(js, /if\s*\(\s*!_slackPostMessageOrigin\s*\)\s*return/);
  // Compare ev.origin to canonical origin
  assert.match(js, /ev\.origin\s*!==\s*_slackPostMessageOrigin/);
});

test('app.js: dependents force-delete uses error CODE not message regex (Codex R1 BLOCKER 2)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /'SLACK_APP_HAS_DEPENDENTS'/);
  // The old free-form regex must be gone
  assert.ok(!/dependents\/i\.test\(err\.message\)/.test(js));
});

test('app.js: install timeout cleanup closes popup + resets state (Codex R1 REVISE 3)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /function endSlackInstall/);
  assert.match(js, /slackInstallPopup/);
  assert.match(js, /slackInstallPopup\.close/);
  // Timeout branch must call endSlackInstall (not just clearInterval)
  assert.match(js, /endSlackInstall\('install timeout/);
});

test('app.js: install polling guards against ticket id swap (Codex R2)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  // Polling tick must capture the install id BEFORE await and recheck after.
  assert.match(js, /const ticketId = slackInstallId/);
  assert.match(js, /ticketId !== slackInstallId/);
  // Install handler must abandon any prior flow on re-entry.
  assert.match(js, /if \(slackInstallId\) {[\s\S]*?endSlackInstall\(\)/);
});

test('templates.js: slack-oauth template exists with flow + recommended flag (wizard 통합)', async () => {
  const tpl = await readFile(join(PUBLIC_DIR, 'templates.js'), 'utf-8');
  assert.match(tpl, /id:\s*'slack-oauth'/);
  assert.match(tpl, /flow:\s*'slack-oauth'/);
  assert.match(tpl, /recommended:\s*true/);
  // Legacy slack-native still present (opt-in, not removed)
  assert.match(tpl, /id:\s*'slack-native'/);
});

test('app.js: selectTemplate branches to Slack screen for slack-oauth flow (wizard 통합)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  // selectTemplate must pivot, not fall through to step 2
  assert.match(js, /tpl\.flow === 'slack-oauth'/);
  assert.match(js, /openSlackInstallFromWizard/);
  // Prereq inspection covers PUBLIC_ORIGIN + BOTH clientId and hasSecret
  // (Codex R1 REVISE 1 — env override may set only half of the credential
  // pair; server still rejects with SLACK_APP_NOT_CONFIGURED).
  assert.match(js, /publicOrigin\?\.valid/);
  assert.match(js, /!d\.clientId \|\| !d\.hasSecret/);
  assert.match(js, /btn-slack-install/);
});

test('index.html: includes Public Origin form (UX 개선 — UI configurable)', async () => {
  const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf-8');
  assert.match(html, /id="slack-origin-form"/);
  assert.match(html, /id="slack-public-url"/);
  assert.match(html, /id="btn-slack-origin-clear"/);
});

test('app.js: PUT /api/slack/public-url 호출 + clear 버튼 wiring', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /'\/api\/slack\/public-url'/);
  assert.match(js, /publicUrl: value/);
  assert.match(js, /publicUrl: ''/); // clear path
});

test('app.js: renderSlackOrigin handles env / file / default sources', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /po\.source === 'env'/);
  assert.match(js, /po\.source === 'file'/);
  // env override should disable the input
  assert.match(js, /input\.disabled = true/);
});

test('app.js: renderSlackOrigin shows red dot when invalid (Codex UX R1 REVISE 1)', async () => {
  // invalid 검사가 dot rendering 의 source 분기보다 먼저 실행되어 invalid env
  // 가 green/정상 으로 잘못 표시되는 회귀 차단.
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  const invalidIdx = js.indexOf('if (!po.valid)');
  // The rendering branch starts with `dot = 'green'` for env source.
  // Confirm invalid → red precedes that.
  const envGreenIdx = js.indexOf("dot = 'green'");
  assert.ok(invalidIdx > 0, 'invalid branch must exist');
  assert.ok(envGreenIdx > 0, 'green-dot branch must exist');
  assert.ok(invalidIdx < envGreenIdx, 'invalid check must precede first green-dot assignment');
  // Red dot path must reference the reason / message
  assert.match(js, /dot = 'red'[\s\S]{0,400}설정 오류/);
});

test('app.js: showSlackBanner clears prior dismiss timer on re-show (Codex R1 NIT)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /_slackBannerDismissTimer/);
  assert.match(js, /clearTimeout\(_slackBannerDismissTimer\)/);
});

test('app.js: renderTemplates emits "추천" badge for recommended flag', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /tpl-badge-recommended/);
  assert.match(js, /추천</);
});

test('app.js: install-start sequence guard prevents stale response overwrite (Codex R3)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  // Monotonic sequence
  assert.match(js, /slackInstallStartSeq/);
  assert.match(js, /const mySeq = \+\+slackInstallStartSeq/);
  // Stale response is dropped
  assert.match(js, /if \(mySeq !== slackInstallStartSeq\)/);
});

test('app.js: workspace list shows action_needed reason + re-authorize button (Codex R1 REVISE 4)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /actionNeededReason/);
  assert.match(js, /Re-authorize/);
  assert.match(js, /data-act="reauthorize"/);
});

test('app.js: env-source badges rendered for env vs file (clientId / clientSecret matrix)', async () => {
  const js = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8');
  assert.match(js, /env override/);
  assert.match(js, /file ignored/);
  assert.match(js, /sources/);
});

test('SPA admin route still serves index.html through admin static path', async () => {
  // Verify the existing static handler still serves /admin/ index after
  // markup changes (no broken HTML / accidental syntax error).
  const dir = await mkdtemp(join(tmpdir(), 'phase12-6-spa-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({
    server: { port: 0, host: '127.0.0.1' }, workspaces: [],
  }), 'utf-8');
  const srv = await startServer({ port: 0, host: '127.0.0.1', configDir: dir });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/admin/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /id="btn-nav-slack"/);
    assert.match(html, /id="slack-screen"/);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
