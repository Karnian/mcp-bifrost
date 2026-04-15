import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OAuthManager } from '../server/oauth-manager.js';

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function mockWm(workspaces = {}) {
  const audits = [];
  const map = new Map(Object.entries(workspaces));
  return {
    audits,
    logAudit: (action, ws, details) => audits.push({ action, ws, details }),
    logError: () => {},
    _getRawWorkspace: (id) => map.get(id) || null,
    _save: async () => {},
    getServerConfig: () => ({ port: 3100 }),
    _setWs: (id, ws) => map.set(id, ws),
  };
}

test('PKCE verifier/challenge use S256 correctly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    const pk = mgr._newPkce();
    assert.equal(pk.method, 'S256');
    assert.ok(pk.verifier.length >= 40);
    const expected = createHash('sha256').update(pk.verifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(pk.challenge, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state HMAC: round-trip sign/verify', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    const state = await mgr._signState({ r: 'abc', w: 'ws-1', iat: 1 });
    const verified = await mgr._verifyState(state);
    assert.deepEqual(verified, { r: 'abc', w: 'ws-1', iat: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state HMAC: tampered state rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    const state = await mgr._signState({ r: 'abc', w: 'ws-1', iat: 1 });
    const [body, sig] = state.split('.');
    const tampered = `${body}X.${sig}`;
    assert.equal(await mgr._verifyState(tampered), null);
    assert.equal(await mgr._verifyState('garbage'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('initializeAuthorization builds correct URL and persists pending state with chmod', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const wm = mockWm({ 'ws-1': { id: 'ws-1' } });
    const mgr = new OAuthManager(wm, { stateDir: dir });
    const asMeta = {
      authorization_endpoint: 'https://auth.example/authorize',
      token_endpoint: 'https://auth.example/token',
    };
    const { authorizationUrl, state } = await mgr.initializeAuthorization('ws-1', {
      issuer: 'https://auth.example',
      clientId: 'cid',
      authMethod: 'none',
      authServerMetadata: asMeta,
      resource: 'https://mcp.example/mcp',
      scope: 'read',
    });
    const u = new URL(authorizationUrl);
    assert.equal(u.origin + u.pathname, 'https://auth.example/authorize');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('client_id'), 'cid');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3100/oauth/callback');
    assert.equal(u.searchParams.get('state'), state);
    assert.equal(u.searchParams.get('resource'), 'https://mcp.example/mcp');
    assert.equal(u.searchParams.get('scope'), 'read');
    assert.ok(u.searchParams.get('code_challenge'));

    const pendingPath = join(dir, 'oauth-pending.json');
    const raw = JSON.parse(await readFile(pendingPath, 'utf-8'));
    assert.ok(raw[state]);
    assert.equal(raw[state].workspaceId, 'ws-1');
    assert.ok(raw[state].verifier);
    if (process.platform !== 'win32') {
      const st = await stat(pendingPath);
      assert.equal(st.mode & 0o777, 0o600);
    }

    // audit fired
    assert.ok(wm.audits.some(a => a.action === 'oauth.authorize_start' && a.ws === 'ws-1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeAuthorization rejects invalid / expired / reused state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const wm = mockWm({ 'ws-1': { id: 'ws-1' } });
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 }) }) });
    // Forged state
    await assert.rejects(() => mgr.completeAuthorization('garbage', 'code'), (e) => e.code === 'INVALID_STATE');

    // Valid flow but with tampered pending deletion
    const asMeta = { authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token' };
    const { state } = await mgr.initializeAuthorization('ws-1', { issuer: 'https://auth.example', clientId: 'cid', authMethod: 'none', authServerMetadata: asMeta });

    // Expire it by mutating the file
    const pending = JSON.parse(await readFile(join(dir, 'oauth-pending.json'), 'utf-8'));
    pending[state].expiresAt = Date.now() - 1;
    await writeFile(join(dir, 'oauth-pending.json'), JSON.stringify(pending));
    mgr._pending = null; // force reload

    await assert.rejects(() => mgr.completeAuthorization(state, 'code'), (e) => e.code === 'STATE_EXPIRED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completeAuthorization exchanges code and persists tokens (one-shot state)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const ws = { id: 'ws-1' };
    const wm = mockWm({ 'ws-1': ws });
    let tokenCalls = 0;
    const fetchImpl = async (url, init) => {
      tokenCalls++;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'the-code');
      assert.ok(form.get('code_verifier'));
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT.123', refresh_token: 'RT.456', expires_in: 3600, token_type: 'Bearer' }) };
    };
    const mgr = new OAuthManager(wm, { stateDir: dir, fetchImpl });
    const asMeta = { authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token' };
    const { state } = await mgr.initializeAuthorization('ws-1', { issuer: 'https://auth.example', clientId: 'cid', authMethod: 'none', authServerMetadata: asMeta });
    const saved = await mgr.completeAuthorization(state, 'the-code');
    assert.equal(saved.tokens.accessToken, 'AT.123');
    assert.equal(saved.tokens.refreshToken, 'RT.456');
    assert.equal(saved.issuer, 'https://auth.example');
    assert.equal(tokenCalls, 1);
    // One-shot: re-use should fail
    await assert.rejects(() => mgr.completeAuthorization(state, 'the-code'), (e) => e.code === 'STATE_NOT_FOUND');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('purgeStalePending removes expired entries on startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    // Seed expired + fresh
    const now = Date.now();
    const pending = {
      'state-expired': { workspaceId: 'a', expiresAt: now - 1000 },
      'state-fresh': { workspaceId: 'b', expiresAt: now + 5 * 60_000 },
    };
    await writeFile(join(dir, 'oauth-pending.json'), JSON.stringify(pending));
    const removed = await mgr.purgeStalePending();
    assert.equal(removed, 1);
    const after = JSON.parse(await readFile(join(dir, 'oauth-pending.json'), 'utf-8'));
    assert.ok(!after['state-expired']);
    assert.ok(after['state-fresh']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('server-secret file created with chmod 0o600 on POSIX', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX only');
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    await mgr._getServerSecret();
    const st = await stat(join(dir, 'server-secret'));
    assert.equal(st.mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('server-secret persists across OAuthManager instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-'));
  try {
    const a = new OAuthManager(mockWm(), { stateDir: dir });
    const sa = await a._getServerSecret();
    const b = new OAuthManager(mockWm(), { stateDir: dir });
    const sb = await b._getServerSecret();
    assert.equal(sa, sb);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
