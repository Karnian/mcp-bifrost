/**
 * BIFROST_ADMIN_EXPOSE=1 opens the Admin API to non-loopback peers, but it
 * must never open it *unauthenticated*: without an admin token ("dev mode")
 * remote peers are refused, both on the API and on /api/auth/login.
 *
 * 127.0.1.1 + localAddress stands in for a remote (e.g. Tailscale) peer —
 * see tests/multi-host-bind.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ALT = '127.0.1.1';
const TOKEN = 'test-admin-token-expose';

function call({ host, port, path, method = 'GET', localAddress, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest({
      host, port, path, method, localAddress,
      headers: payload ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer({ expose, token, configToken }, fn) {
  const prev = { expose: process.env.BIFROST_ADMIN_EXPOSE, token: process.env.BIFROST_ADMIN_TOKEN };
  if (expose) process.env.BIFROST_ADMIN_EXPOSE = '1'; else delete process.env.BIFROST_ADMIN_EXPOSE;
  if (token) process.env.BIFROST_ADMIN_TOKEN = token; else delete process.env.BIFROST_ADMIN_TOKEN;
  const dir = await mkdtemp(join(tmpdir(), 'admin-expose-'));
  await writeFile(join(dir, 'workspaces.json'),
    JSON.stringify({ server: { port: 0, host: '127.0.0.1', ...(configToken ? { adminToken: configToken } : {}) }, workspaces: [] }), 'utf-8');
  const srv = await startServer({ port: 0, host: `127.0.0.1,${ALT}`, configDir: dir });
  const remote = (opts) => call({ host: ALT, port: srv.port, localAddress: ALT, ...opts });
  const local = (opts) => call({ host: '127.0.0.1', port: srv.port, ...opts });
  try {
    await fn({ remote, local });
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
    for (const [k, env] of [['expose', 'BIFROST_ADMIN_EXPOSE'], ['token', 'BIFROST_ADMIN_TOKEN']]) {
      if (prev[k] === undefined) delete process.env[env]; else process.env[env] = prev[k];
    }
  }
}

test('EXPOSE=1 without admin token: remote peers refused (API + login), loopback allowed', async () => {
  await withServer({ expose: true, token: null }, async ({ remote, local }) => {
    const api = await remote({ path: '/api/workspaces' });
    assert.equal(api.status, 403);
    assert.equal(api.body.error.code, 'ADMIN_TOKEN_REQUIRED');

    const login = await remote({ path: '/api/auth/login', method: 'POST', body: { token: '' } });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'ADMIN_TOKEN_REQUIRED');

    // A write endpoint (stdio registration = RCE surface) must be refused too.
    const create = await remote({ path: '/api/workspaces', method: 'POST', body: { kind: 'mcp-client', transport: 'stdio', command: 'node', args: ['-e', '0'] } });
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'ADMIN_TOKEN_REQUIRED');

    assert.equal((await local({ path: '/api/workspaces' })).status, 200);
    const localLogin = await local({ path: '/api/auth/login', method: 'POST', body: { token: '' } });
    assert.equal(localLogin.status, 200);
  });
});

test('EXPOSE=1 with admin token: remote peers need the right Bearer', async () => {
  await withServer({ expose: true, token: TOKEN }, async ({ remote }) => {
    assert.equal((await remote({ path: '/api/workspaces' })).status, 401);
    assert.equal((await remote({ path: '/api/workspaces', headers: { Authorization: 'Bearer wrong' } })).status, 403);
    assert.equal((await remote({ path: '/api/workspaces', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.equal((await remote({ path: '/api/auth/login', method: 'POST', body: { token: 'wrong' } })).status, 401);
    assert.equal((await remote({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } })).status, 200);
  });
});

test('EXPOSE=1 with config-only server.adminToken: remote auth works', async () => {
  await withServer({ expose: true, token: null, configToken: TOKEN }, async ({ remote }) => {
    assert.equal((await remote({ path: '/api/workspaces' })).status, 401);
    assert.equal((await remote({ path: '/api/workspaces', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.equal((await remote({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } })).status, 200);
  });
});

test('EXPOSE unset: remote peers get ADMIN_LOCAL_ONLY regardless of token', async () => {
  await withServer({ expose: false, token: null }, async ({ remote }) => {
    const api = await remote({ path: '/api/workspaces' });
    assert.equal(api.status, 403);
    assert.equal(api.body.error.code, 'ADMIN_LOCAL_ONLY');
    const login = await remote({ path: '/api/auth/login', method: 'POST', body: { token: '' } });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'ADMIN_LOCAL_ONLY');
  });
});

test('admin UI clears the token input on login success and on logout', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = await readFile(join(here, '..', 'admin', 'public', 'app.js'), 'utf-8');
  const logout = /function logout\(\) \{([\s\S]*?)\n\}/.exec(js);
  assert.ok(logout, 'logout() not found');
  assert.match(logout[1], /\$\('#admin-token'\)\.value = ''/);
  const success = /if \(data\.ok\) \{([\s\S]*?)await enterDashboard\(\);/.exec(js);
  assert.ok(success, 'login success branch not found');
  assert.match(success[1], /\$\('#admin-token'\)\.value = ''/);
});
