/**
 * Phase 12-1 — Workspace schema extension + Slack masking.
 *
 * Coverage (plan §3.3 + §3.4 / B5):
 *   1. nativeWorkspaceSchema accepts authMode='oauth' + slackOAuth
 *   2. authMode='oauth' rejects botToken (batch validation)
 *   3. slackOAuth required when authMode='oauth'
 *   4. authMode='oauth' rejected for non-slack providers
 *   5. slackOAuth.tokens.tokenType invariant (must be 'user')
 *   6. expiresAt is ISO-8601 string only (number rejected)
 *   7. slackAppSchema validates clientId format
 *   8. maskSlackOAuth strips raw access/refresh tokens
 *   9. _maskSecrets() routes slackOAuth through maskSlackOAuth
 *  10. maskSlackApp.sources tracks env vs file (5-case matrix)
 *  11. WorkspaceManager.getSlackApp / setSlackApp / deleteSlackApp
 *  12. deleteSlackApp refuses with dependents (force=true overrides)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateWorkspacePayload,
  validateSlackAppPayload,
} from '../server/workspace-schema.js';
import {
  WorkspaceManager,
  maskSlackOAuth,
  maskSlackApp,
} from '../server/workspace-manager.js';

// ──────────────────────────────────────────────────────────────────────
// Schema validation

test('schema: provider=slack + authMode=oauth + slackOAuth accepted', () => {
  const r = validateWorkspacePayload({
    kind: 'native',
    provider: 'slack',
    authMode: 'oauth',
    displayName: 'ACME',
    slackOAuth: {
      team: { id: 'T01ABC', name: 'ACME' },
      tokens: {
        accessToken: 'xoxe.xoxp-1-abc',
        refreshToken: 'xoxe-1-xyz',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        tokenType: 'user',
      },
    },
  });
  assert.equal(r.valid, true, r.errors?.join('; '));
});

test('schema: provider=slack + authMode=oauth + botToken rejected (batch)', () => {
  const r = validateWorkspacePayload({
    kind: 'native',
    provider: 'slack',
    authMode: 'oauth',
    credentials: { botToken: 'xoxb-leak' },
    slackOAuth: {
      team: { id: 'T01ABC', name: 'ACME' },
      tokens: { accessToken: 'xoxe.xoxp-1-abc', tokenType: 'user' },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('botToken')), `expected botToken error, got: ${r.errors?.join('; ')}`);
});

test('schema: provider=slack + authMode=oauth without slackOAuth → rejected', () => {
  const r = validateWorkspacePayload({
    kind: 'native',
    provider: 'slack',
    authMode: 'oauth',
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('slackOAuth required')), r.errors?.join('; '));
});

test('schema: authMode=oauth on non-slack provider → rejected (Phase 12 invariant)', () => {
  const r = validateWorkspacePayload({
    kind: 'native',
    provider: 'notion',
    authMode: 'oauth',
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('authMode=oauth only supported for provider=slack')), r.errors?.join('; '));
});

test('schema: slackOAuth.tokens.tokenType must be "user" (invariant)', () => {
  const r = validateWorkspacePayload({
    kind: 'native',
    provider: 'slack',
    authMode: 'oauth',
    slackOAuth: {
      team: { id: 'T01', name: 'X' },
      tokens: { accessToken: 'xoxb-leak', tokenType: 'bot' },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /tokenType/i.test(e)), r.errors?.join('; '));
});

test('schema: slackOAuth.tokens.expiresAt as number rejected (must be ISO 8601)', () => {
  const r = validateWorkspacePayload({
    kind: 'native',
    provider: 'slack',
    authMode: 'oauth',
    slackOAuth: {
      team: { id: 'T01', name: 'X' },
      tokens: { accessToken: 'xoxe.xoxp-1', expiresAt: 1700000000, tokenType: 'user' },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /expiresAt/.test(e)), r.errors?.join('; '));
});

test('schema: token-mode workspace (no authMode set) backward-compat passes', () => {
  const r = validateWorkspacePayload({
    kind: 'native',
    provider: 'slack',
    credentials: { botToken: 'xoxb-legacy' },
  });
  assert.equal(r.valid, true, r.errors?.join('; '));
});

test('schema: validateSlackAppPayload accepts well-formed clientId', () => {
  const r = validateSlackAppPayload({
    clientId: '1234567890.0987654321',
    clientSecret: 'abcdef',
  });
  assert.equal(r.valid, true);
});

test('schema: validateSlackAppPayload rejects malformed clientId', () => {
  const r = validateSlackAppPayload({
    clientId: 'not-a-slack-id',
    clientSecret: 'abcdef',
  });
  assert.equal(r.valid, false);
});

// ──────────────────────────────────────────────────────────────────────
// Masking

test('maskSlackOAuth: strips raw accessToken / refreshToken bodies', () => {
  const masked = maskSlackOAuth({
    team: { id: 'T01', name: 'X' },
    tokens: {
      accessToken: 'xoxe.xoxp-1-abcdefghijklmno',
      refreshToken: 'xoxe-1-zzzzzzzz',
      expiresAt: '2026-05-01T22:00:00.000Z',
      tokenType: 'user',
    },
  });
  // Prefix-only — full body must be gone.
  assert.ok(!masked.tokens.accessToken.includes('abcdefghijklmno'));
  assert.ok(!masked.tokens.refreshToken.includes('zzzzzzzz'));
  assert.equal(masked.tokens.hasRefreshToken, true);
  assert.equal(masked.tokens.expiresAt, '2026-05-01T22:00:00.000Z');
  assert.equal(masked.tokens.tokenType, 'user');
});

test('maskSlackOAuth: hasRefreshToken=false when refreshToken absent (R13 case ①)', () => {
  const masked = maskSlackOAuth({
    team: { id: 'T01', name: 'X' },
    tokens: { accessToken: 'xoxp-non-rotating-long', tokenType: 'user' },
  });
  assert.equal(masked.tokens.hasRefreshToken, false);
  assert.equal(masked.tokens.refreshToken, null);
});

test('maskSlackOAuth: undefined input passes through', () => {
  assert.equal(maskSlackOAuth(undefined), undefined);
});

// 5-case env vs file matrix per plan §6 + §8.6
function caseEnvFile({ envClientId, envSecret, fileClientId, fileSecret }) {
  const prevEnvId = process.env.BIFROST_SLACK_CLIENT_ID;
  const prevEnvSecret = process.env.BIFROST_SLACK_CLIENT_SECRET;
  if (envClientId !== undefined) process.env.BIFROST_SLACK_CLIENT_ID = envClientId;
  else delete process.env.BIFROST_SLACK_CLIENT_ID;
  if (envSecret !== undefined) process.env.BIFROST_SLACK_CLIENT_SECRET = envSecret;
  else delete process.env.BIFROST_SLACK_CLIENT_SECRET;
  try {
    return maskSlackApp({
      clientId: fileClientId || null,
      clientSecret: fileSecret || null,
      tokenRotationEnabled: true,
    });
  } finally {
    if (prevEnvId === undefined) delete process.env.BIFROST_SLACK_CLIENT_ID;
    else process.env.BIFROST_SLACK_CLIENT_ID = prevEnvId;
    if (prevEnvSecret === undefined) delete process.env.BIFROST_SLACK_CLIENT_SECRET;
    else process.env.BIFROST_SLACK_CLIENT_SECRET = prevEnvSecret;
  }
}

test('maskSlackApp.sources: env+env (both env override)', () => {
  const r = caseEnvFile({ envClientId: 'envId.1', envSecret: 'envSecret', fileClientId: 'fileId.1', fileSecret: 'fileSecret' });
  assert.equal(r.sources.clientId, 'env');
  assert.equal(r.sources.clientSecret, 'env');
  assert.equal(r.hasSecret, true);
});

test('maskSlackApp.sources: env+file (clientId env, secret file)', () => {
  const r = caseEnvFile({ envClientId: 'envId.1', envSecret: undefined, fileClientId: 'fileId.1', fileSecret: 'fileSecret' });
  assert.equal(r.sources.clientId, 'env');
  assert.equal(r.sources.clientSecret, 'file');
});

test('maskSlackApp.sources: file+env (clientId file, secret env)', () => {
  const r = caseEnvFile({ envClientId: undefined, envSecret: 'envSecret', fileClientId: 'fileId.1', fileSecret: 'fileSecret' });
  assert.equal(r.sources.clientId, 'file');
  assert.equal(r.sources.clientSecret, 'env');
});

test('maskSlackApp.sources: file+file (no env override)', () => {
  const r = caseEnvFile({ envClientId: undefined, envSecret: undefined, fileClientId: 'fileId.1', fileSecret: 'fileSecret' });
  assert.equal(r.sources.clientId, 'file');
  assert.equal(r.sources.clientSecret, 'file');
});

test('maskSlackApp.sources: none+none (nothing configured)', () => {
  const r = caseEnvFile({ envClientId: undefined, envSecret: undefined, fileClientId: null, fileSecret: null });
  assert.equal(r.sources.clientId, 'none');
  assert.equal(r.sources.clientSecret, 'none');
  assert.equal(r.hasSecret, false);
});

// ──────────────────────────────────────────────────────────────────────
// _maskSecrets integration

test('_maskSecrets: routes slackOAuth through maskSlackOAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-mask-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({
      workspaces: [{
        id: 'slack-acme',
        kind: 'native',
        provider: 'slack',
        authMode: 'oauth',
        namespace: 'acme',
        alias: 'acme',
        displayName: 'ACME',
        enabled: true,
        slackOAuth: {
          team: { id: 'T01', name: 'ACME' },
          tokens: {
            accessToken: 'xoxe.xoxp-1-RAW-PLAINTEXT-LONG',
            refreshToken: 'xoxe-1-RAW-REFRESH',
            expiresAt: '2026-05-01T22:00:00.000Z',
            tokenType: 'user',
          },
          status: 'active',
        },
      }],
    }),
    'utf-8'
  );
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const wsList = wm.getWorkspaces({ masked: true });
    const ws = wsList.find(w => w.id === 'slack-acme');
    assert.ok(ws.slackOAuth, 'slackOAuth must be present in masked output');
    assert.ok(!JSON.stringify(ws).includes('RAW-PLAINTEXT-LONG'), 'raw access token leaked');
    assert.ok(!JSON.stringify(ws).includes('RAW-REFRESH'), 'raw refresh token leaked');
    assert.equal(ws.slackOAuth.tokens.hasRefreshToken, true);
    // Raw fetch keeps the original
    const raw = wm.getRawWorkspace('slack-acme');
    assert.equal(raw.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-RAW-PLAINTEXT-LONG');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('_maskSecrets: getWorkspace(id) also masks slackOAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-mask2-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({
      workspaces: [{
        id: 'slack-x',
        kind: 'native',
        provider: 'slack',
        authMode: 'oauth',
        namespace: 'x',
        alias: 'x',
        slackOAuth: {
          team: { id: 'T01', name: 'X' },
          tokens: { accessToken: 'xoxe.xoxp-1-SECRET-X', tokenType: 'user' },
        },
      }],
    }),
    'utf-8'
  );
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const ws = wm.getWorkspace('slack-x', { masked: true });
    assert.ok(!JSON.stringify(ws).includes('SECRET-X'));
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────
// WorkspaceManager.{getSlackApp,setSlackApp,deleteSlackApp}

test('WorkspaceManager.setSlackApp / getSlackApp roundtrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-app-'));
  // Make sure env override doesn't leak into this matrix case
  delete process.env.BIFROST_SLACK_CLIENT_ID;
  delete process.env.BIFROST_SLACK_CLIENT_SECRET;
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    await wm.setSlackApp({
      clientId: '1111111111.2222222222',
      clientSecret: 'topsecret',
      tokenRotationEnabled: true,
    });
    const view = wm.getSlackApp();
    assert.equal(view.clientId, '1111111111.2222222222');
    assert.equal(view.hasSecret, true);
    assert.equal(view.sources.clientSecret, 'file');
    // Persisted to disk + chmod 600 (best-effort)
    const onDisk = JSON.parse(await readFile(join(dir, 'workspaces.json'), 'utf-8'));
    assert.equal(onDisk.slackApp.clientSecret, 'topsecret');
    // getSlackAppRaw sees the actual secret for OAuth flow consumption
    const raw = wm.getSlackAppRaw();
    assert.equal(raw.clientSecret, 'topsecret');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager.deleteSlackApp refuses when OAuth workspaces exist (force overrides)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-deps-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({
      slackApp: {
        clientId: '1111.2222',
        clientSecret: 'sec',
        tokenRotationEnabled: true,
      },
      workspaces: [{
        id: 'slack-acme',
        kind: 'native',
        provider: 'slack',
        authMode: 'oauth',
        namespace: 'acme',
        alias: 'acme',
        slackOAuth: {
          team: { id: 'T01', name: 'ACME' },
          tokens: { accessToken: 'xoxe.xoxp-1', tokenType: 'user' },
          status: 'active',
        },
      }],
    }),
    'utf-8'
  );
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    await assert.rejects(
      () => wm.deleteSlackApp(),
      err => err.code === 'SLACK_APP_HAS_DEPENDENTS'
    );
    // App still present
    assert.ok(wm.getSlackApp().hasSecret);
    // Force flips dependents to action_needed
    const r = await wm.deleteSlackApp({ force: true });
    assert.equal(r.deleted, true);
    assert.equal(r.dependentsTouched, 1);
    const ws = wm.getRawWorkspace('slack-acme');
    assert.equal(ws.slackOAuth.status, 'action_needed');
    // App config gone
    assert.equal(wm.getSlackApp().hasSecret, false);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('addWorkspace: persists authMode + slackOAuth (Codex R1 BLOCKER fix)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-add-'));
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const tokens = {
      accessToken: 'xoxe.xoxp-1-PERSIST-CHECK',
      refreshToken: 'xoxe-1-RT',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: 'user',
    };
    const ws = await wm.addWorkspace({
      kind: 'native',
      provider: 'slack',
      authMode: 'oauth',
      displayName: 'ACME-OAuth',
      alias: 'acme-oauth',
      slackOAuth: {
        team: { id: 'T01', name: 'ACME' },
        tokens,
        status: 'active',
      },
    });
    assert.equal(ws.authMode, 'oauth');
    assert.deepEqual(ws.slackOAuth.team, { id: 'T01', name: 'ACME' });
    assert.equal(ws.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-PERSIST-CHECK');
    // Persisted to disk too
    const onDisk = JSON.parse(await readFile(join(dir, 'workspaces.json'), 'utf-8'));
    const stored = onDisk.workspaces.find(w => w.alias === 'acme-oauth');
    assert.equal(stored.authMode, 'oauth');
    assert.equal(stored.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-PERSIST-CHECK');
    // /api/workspaces masked output strips raw token
    const masked = wm.getWorkspace(ws.id, { masked: true });
    assert.ok(!JSON.stringify(masked).includes('PERSIST-CHECK'));
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateWorkspace: refreshes slackOAuth tokens (skips masked replays)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-update-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({
      workspaces: [{
        id: 'slack-acme',
        kind: 'native',
        provider: 'slack',
        authMode: 'oauth',
        namespace: 'acme',
        alias: 'acme',
        slackOAuth: {
          team: { id: 'T01', name: 'ACME' },
          tokens: { accessToken: 'xoxe.xoxp-1-OLD', tokenType: 'user' },
          status: 'active',
        },
      }],
    }),
    'utf-8'
  );
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    // Replaying a masked PUT (token bodies ending with "...") must NOT overwrite.
    await wm.updateWorkspace('slack-acme', {
      slackOAuth: {
        team: { id: 'T01', name: 'ACME' },
        tokens: { accessToken: 'xoxe.xoxp-1...', tokenType: 'user' },
      },
    });
    let raw = wm.getRawWorkspace('slack-acme');
    assert.equal(raw.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-OLD', 'masked PUT must not clobber');
    // Real refresh value (no trailing ...) does overwrite.
    await wm.updateWorkspace('slack-acme', {
      slackOAuth: {
        team: { id: 'T01', name: 'ACME' },
        tokens: { accessToken: 'xoxe.xoxp-1-NEW', tokenType: 'user' },
        status: 'active',
      },
    });
    raw = wm.getRawWorkspace('slack-acme');
    assert.equal(raw.slackOAuth.tokens.accessToken, 'xoxe.xoxp-1-NEW');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('getDeletedWorkspaces: masks slackOAuth tokens (Codex R1 BLOCKER fix)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-deleted-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({
      workspaces: [{
        id: 'slack-soft',
        kind: 'native',
        provider: 'slack',
        authMode: 'oauth',
        namespace: 'soft',
        alias: 'soft',
        deletedAt: new Date().toISOString(),
        enabled: false,
        slackOAuth: {
          team: { id: 'T99', name: 'SOFT' },
          tokens: {
            accessToken: 'xoxe.xoxp-1-DELETED-RAW',
            refreshToken: 'xoxe-1-DELETED-RT',
            tokenType: 'user',
          },
        },
      }],
    }),
    'utf-8'
  );
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const list = wm.getDeletedWorkspaces();
    assert.equal(list.length, 1);
    const dump = JSON.stringify(list[0]);
    assert.ok(!dump.includes('DELETED-RAW'), 'raw access token leaked through soft-delete');
    assert.ok(!dump.includes('DELETED-RT'), 'raw refresh token leaked through soft-delete');
    assert.equal(list[0].slackOAuth.tokens.hasRefreshToken, true);
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('setSlackApp: rejects malformed payload (Codex R1 REVISE — schema enforcement)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-setapp-'));
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    await assert.rejects(
      () => wm.setSlackApp({ clientId: 'not-slack-format', clientSecret: 'whatever' }),
      err => err.code === 'SLACK_APP_INVALID'
    );
    await assert.rejects(
      () => wm.setSlackApp({ clientId: '111.222', clientSecret: '' }),
      err => err.code === 'SLACK_APP_INVALID'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager.setPublicUrl + getPublicUrl roundtrip + canonicalize', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-publicurl-'));
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const canonical = await wm.setPublicUrl('https://stored.test/');
    assert.equal(canonical, 'https://stored.test'); // trailing slash stripped
    assert.equal(wm.getPublicUrl(), 'https://stored.test');
    // Persists to disk
    const onDisk = JSON.parse(await readFile(join(dir, 'workspaces.json'), 'utf-8'));
    assert.equal(onDisk.publicUrl, 'https://stored.test');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager.setPublicUrl rejects invalid origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-publicurl-bad-'));
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    await assert.rejects(
      () => wm.setPublicUrl('http://not-loopback.test'),
      err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS'
    );
    await assert.rejects(
      () => wm.setPublicUrl('https://x.test/admin'),
      err => err.code === 'PUBLIC_ORIGIN_HAS_PATH'
    );
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager.setPublicUrl atomic — disk fail leaves config unchanged (Codex UX R1 REVISE 3)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-publicurl-atomic-'));
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    await wm.setPublicUrl('https://orig.test');
    assert.equal(wm.getPublicUrl(), 'https://orig.test');
    // Inject snapshot save failure
    const realSnap = wm._saveSnapshot.bind(wm);
    wm._saveSnapshot = async () => { throw new Error('disk full'); };
    await assert.rejects(
      () => wm.setPublicUrl('https://new.test'),
      err => /disk full/.test(err.message)
    );
    // Runtime still on old value
    assert.equal(wm.getPublicUrl(), 'https://orig.test');
    // Restore + retry succeeds
    wm._saveSnapshot = realSnap;
    await wm.setPublicUrl('https://new.test');
    assert.equal(wm.getPublicUrl(), 'https://new.test');
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('WorkspaceManager.setPublicUrl empty string clears file value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-publicurl-clear-'));
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    await wm.setPublicUrl('https://x.test');
    assert.equal(wm.getPublicUrl(), 'https://x.test');
    const r = await wm.setPublicUrl('');
    assert.equal(r, null);
    assert.equal(wm.getPublicUrl(), null);
    const onDisk = JSON.parse(await readFile(join(dir, 'workspaces.json'), 'utf-8'));
    assert.ok(!('publicUrl' in onDisk));
  } finally {
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('getSlackAppRaw: env override beats file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase12-1-envrev-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({
      slackApp: { clientId: 'fileid.1', clientSecret: 'filesecret', tokenRotationEnabled: true },
      workspaces: [],
    }),
    'utf-8'
  );
  const prevEnvId = process.env.BIFROST_SLACK_CLIENT_ID;
  const prevEnvSecret = process.env.BIFROST_SLACK_CLIENT_SECRET;
  process.env.BIFROST_SLACK_CLIENT_ID = 'envid.2';
  process.env.BIFROST_SLACK_CLIENT_SECRET = 'envsecret';
  const wm = new WorkspaceManager({ configDir: dir });
  await wm.load();
  try {
    const raw = wm.getSlackAppRaw();
    assert.equal(raw.clientId, 'envid.2');
    assert.equal(raw.clientSecret, 'envsecret');
    assert.equal(raw.sources.clientId, 'env');
    assert.equal(raw.sources.clientSecret, 'env');
  } finally {
    if (prevEnvId === undefined) delete process.env.BIFROST_SLACK_CLIENT_ID;
    else process.env.BIFROST_SLACK_CLIENT_ID = prevEnvId;
    if (prevEnvSecret === undefined) delete process.env.BIFROST_SLACK_CLIENT_SECRET;
    else process.env.BIFROST_SLACK_CLIENT_SECRET = prevEnvSecret;
    await wm.close();
    await rm(dir, { recursive: true, force: true });
  }
});
