import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitize, tokenPrefix } from '../server/oauth-sanitize.js';
import { OAuthManager } from '../server/oauth-manager.js';

function mockWm() {
  const audits = [];
  const errors = [];
  const workspaces = new Map();
  return {
    audits, errors, workspaces,
    logAudit: (action, ws, details) => audits.push({ action, ws, details }),
    logError: (category, ws, message) => errors.push({ category, ws, message }),
    _getRawWorkspace: (id) => workspaces.get(id) || null,
    _save: async () => {},
    getServerConfig: () => ({ port: 3100 }),
  };
}

function stubFetch(handlers) {
  return async (url, init) => {
    const entry = handlers[url] ?? handlers[String(url)];
    if (typeof entry === 'function') return entry(url, init);
    if (!entry) return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
    return { ok: true, status: 200, text: async () => JSON.stringify(entry), json: async () => entry };
  };
}

test('sanitize scrubs token-bearing patterns', () => {
  const input = 'GET /x Authorization: Bearer eyJ.ab.cd and refresh_token=rtok_12345678 plus code=XYZ0123456789ABC';
  const out = sanitize(input);
  assert.ok(!out.includes('eyJ.ab.cd'), 'bearer value must be scrubbed');
  assert.ok(!out.includes('rtok_12345678'));
  assert.ok(!out.includes('XYZ0123456789ABC'));
  assert.ok(out.includes('Authorization: Bearer ***'));
});

test('sanitize scrubs JSON token fields', () => {
  const out = sanitize('{"access_token":"abc.def.ghi","refresh_token":"r123"}');
  assert.ok(!out.includes('abc.def.ghi'));
  assert.ok(!out.includes('r123'));
});

test('tokenPrefix masks long values', () => {
  assert.equal(tokenPrefix('abcdefghij'), 'abcd***ghij');
  assert.equal(tokenPrefix('short'), '***');
  assert.equal(tokenPrefix(null), null);
});

test('OAuthManager.discover uses WWW-Authenticate hint first', async () => {
  const handlers = {
    'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp': {
      resource: 'https://mcp.notion.com/mcp',
      authorization_servers: ['https://auth.example'],
      bearer_methods_supported: ['header'],
    },
    'https://auth.example/.well-known/oauth-authorization-server': {
      issuer: 'https://auth.example',
      authorization_endpoint: 'https://auth.example/authorize',
      token_endpoint: 'https://auth.example/token',
      registration_endpoint: 'https://auth.example/register',
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl: stubFetch(handlers) });
    const r = await mgr.discover('https://mcp.notion.com/mcp', {
      wwwAuthenticate: 'Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"',
    });
    assert.equal(r.issuer, 'https://auth.example');
    assert.equal(r.authServerMetadata.token_endpoint, 'https://auth.example/token');
    assert.equal(r.resource, 'https://mcp.notion.com/mcp');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.discover falls back to host-root resource metadata', async () => {
  const handlers = {
    'https://mcp.notion.com/.well-known/oauth-protected-resource': {
      resource: 'https://mcp.notion.com',
      authorization_servers: ['https://auth.example'],
    },
    'https://auth.example/.well-known/oauth-authorization-server': {
      issuer: 'https://auth.example',
      authorization_endpoint: 'https://auth.example/authorize',
      token_endpoint: 'https://auth.example/token',
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl: stubFetch(handlers) });
    const r = await mgr.discover('https://mcp.notion.com/');
    assert.equal(r.issuer, 'https://auth.example');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.registerClient does DCR and caches by (issuer, authMethod)', async () => {
  let registrationCalls = 0;
  const handlers = {
    'https://auth.example/register': (url, init) => {
      registrationCalls++;
      return { ok: true, status: 201, text: async () => '{}', json: async () => ({ client_id: 'dyn_abc' }) };
    },
  };
  const authServerMetadata = {
    registration_endpoint: 'https://auth.example/register',
    token_endpoint_auth_methods_supported: ['none'],
  };
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl: stubFetch(handlers) });
    const first = await mgr.registerClient('https://auth.example', authServerMetadata);
    const second = await mgr.registerClient('https://auth.example', authServerMetadata);
    assert.equal(first.clientId, 'dyn_abc');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(registrationCalls, 1, 'should hit cache on 2nd call');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.registerClient throws DCR_UNSUPPORTED when no registration_endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl: stubFetch({}) });
    await assert.rejects(
      () => mgr.registerClient('https://auth.example', { token_endpoint_auth_methods_supported: ['none'] }),
      (err) => err.code === 'DCR_UNSUPPORTED',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.registerClient throws DCR_REJECTED on 4xx (phase10a §4.10a-3)', async () => {
  const handlers = {
    'https://auth.example/register': () => ({ ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) }),
  };
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl: stubFetch(handlers) });
    await assert.rejects(
      () => mgr.registerClient('https://auth.example', { registration_endpoint: 'https://auth.example/register' }),
      (err) => err.code === 'DCR_REJECTED' && err.status === 403,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.registerManual caches without HTTP call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl: async () => { throw new Error('should not fetch'); } });
    const reg = await mgr.registerManual('https://auth.example', { clientId: 'manual_cid', clientSecret: 'sec', authMethod: 'client_secret_basic' });
    assert.equal(reg.source, 'manual');
    const cached = await mgr.getCachedClient('https://auth.example', 'client_secret_basic');
    assert.equal(cached.clientId, 'manual_cid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager.pickAuthMethod prefers public "none" when supported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    assert.equal(mgr.pickAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'] }), 'none');
    assert.equal(mgr.pickAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_basic'] }), 'client_secret_basic');
    assert.equal(mgr.pickAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_post'] }), 'client_secret_post');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager issuer cache file is chmod 0o600 on POSIX', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX only');
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir, fetchImpl: async () => ({ ok: true, status: 201, text: async () => '{}', json: async () => ({ client_id: 'cid' }) }) });
    await mgr.registerClient('https://auth.example', { registration_endpoint: 'https://auth.example/register', token_endpoint_auth_methods_supported: ['none'] });
    const file = join(dir, 'oauth-issuer-cache.json');
    const st = await stat(file);
    const mode = st.mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got ${mode.toString(8)}`);
    const content = await readFile(file, 'utf-8');
    assert.match(content, /cid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuthManager on win32 platform sets fileSecurityWarning and skips chmod', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-test-'));
  try {
    const mgr = new OAuthManager(mockWm(), {
      stateDir: dir,
      platform: 'win32',
      fetchImpl: async () => ({ ok: true, status: 201, text: async () => '{}', json: async () => ({ client_id: 'cid' }) }),
    });
    await mgr.registerClient('https://auth.example', { registration_endpoint: 'https://auth.example/register', token_endpoint_auth_methods_supported: ['none'] });
    assert.equal(mgr.getFileSecurityWarning(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
