/**
 * Issue #3 — HEAD /mcp returns 404 → should be 405 (Allow: POST)
 *
 * Palantir M4-a worker-spawn preflight (HEAD-only, pass list
 * {200, 204, 405, 501}) requires a defined response on Bifrost's
 * POST-only `/mcp` and GET+POST `/sse` endpoints. Without these
 * handlers the raw http.createServer dispatcher falls through to a
 * generic 404, which Palantir classifies as `preflight_4xx` and
 * fail-closes worker spawn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';

async function bootServer() {
  const dir = await mkdtemp(join(tmpdir(), 'issue3-head-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({ server: { port: 0, host: '127.0.0.1' }, workspaces: [] }),
    'utf-8',
  );
  const srv = await startServer({ port: 0, host: '127.0.0.1', configDir: dir });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  return {
    srv,
    baseUrl,
    teardown: async () => {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('HEAD /mcp returns 405 with Allow: POST (RFC 7231 §6.5.5)', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/mcp`, { method: 'HEAD' });
    assert.equal(r.status, 405, 'HEAD on POST-only endpoint must be 405');
    assert.equal(r.headers.get('allow'), 'POST', 'Allow header must list POST');
    // HEAD MUST NOT return a body.
    const body = await r.text();
    assert.equal(body, '');
  } finally {
    await teardown();
  }
});

test('HEAD /sse returns 200 with Allow: GET, POST (no session opened)', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    // Race against a 1.5s budget — if the dispatcher accidentally fell
    // through to the GET branch, an SSE session would open and HEAD
    // would never resolve.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    let r;
    try {
      r = await fetch(`${baseUrl}/sse`, { method: 'HEAD', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(r.status, 200);
    const allow = (r.headers.get('allow') || '').toLowerCase();
    assert.ok(allow.includes('get'), 'Allow header must list GET');
    assert.ok(allow.includes('post'), 'Allow header must list POST');
    const body = await r.text();
    assert.equal(body, '');
  } finally {
    await teardown();
  }
});

test('HEAD /mcp passes Palantir M4-a preflight pass list {200,204,405,501}', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/mcp`, { method: 'HEAD' });
    assert.ok(
      [200, 204, 405, 501].includes(r.status),
      `status ${r.status} not in Palantir preflight pass list`,
    );
  } finally {
    await teardown();
  }
});

test('POST /mcp still works after HEAD handler addition (regression)', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'issue3-test', version: '1.0' },
        },
      }),
    });
    assert.equal(r.status, 200, 'POST /mcp must remain functional');
    const body = await r.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.ok(body.result, 'initialize must return a result envelope');
  } finally {
    await teardown();
  }
});

test('HEAD on unknown path still returns 404 (catch-all unchanged)', async () => {
  const { baseUrl, teardown } = await bootServer();
  try {
    const r = await fetch(`${baseUrl}/does-not-exist`, { method: 'HEAD' });
    assert.equal(r.status, 404);
  } finally {
    await teardown();
  }
});
