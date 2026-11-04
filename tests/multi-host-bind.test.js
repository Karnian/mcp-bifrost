/**
 * Multi-host bind — BIFROST_HOST / server.host accept a comma-separated list
 * so the hub can listen on several specific interfaces (loopback + a
 * Tailscale address, …) instead of falling back to 0.0.0.0.
 *
 * 127.0.1.1 is used as the "second interface": on Linux the whole 127/8
 * block is routed to lo, and it is exactly what a Debian/Ubuntu hostname
 * resolves to locally. It also proves the Admin API still refuses
 * non-127.0.0.1 peers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, parseHosts } from '../server/index.js';

const ALT = '127.0.1.1';

async function bootServer(hostValue) {
  const dir = await mkdtemp(join(tmpdir(), 'multi-host-'));
  await writeFile(
    join(dir, 'workspaces.json'),
    JSON.stringify({ server: { port: 0, host: '127.0.0.1' }, workspaces: [] }),
    'utf-8',
  );
  const srv = await startServer({ port: 0, host: hostValue, configDir: dir });
  return {
    srv,
    dir,
    teardown: async () => {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('parseHosts: comma list, array, trim, dedupe, empty → loopback', () => {
  assert.deepEqual(parseHosts('127.0.0.1, 127.0.1.1 ,127.0.0.1'), ['127.0.0.1', '127.0.1.1']);
  assert.deepEqual(parseHosts(['::1', ' 127.0.0.1 ']), ['::1', '127.0.0.1']);
  assert.deepEqual(parseHosts('0.0.0.0'), ['0.0.0.0']);
  assert.deepEqual(parseHosts(''), ['127.0.0.1']);
  assert.deepEqual(parseHosts(' , '), ['127.0.0.1']);
  assert.deepEqual(parseHosts(undefined), ['127.0.0.1']);
});

test('single host keeps legacy shape (server + host string)', async () => {
  const { srv, teardown } = await bootServer('127.0.0.1');
  try {
    assert.equal(srv.host, '127.0.0.1');
    assert.deepEqual(srv.hosts, ['127.0.0.1']);
    assert.equal(srv.servers.length, 1);
    assert.equal(srv.servers[0], srv.server);
  } finally {
    await teardown();
  }
});

test('comma-separated hosts: every address serves /mcp on the same port', async () => {
  const { srv, teardown } = await bootServer(`127.0.0.1,${ALT}`);
  try {
    assert.deepEqual(srv.hosts, ['127.0.0.1', ALT]);
    assert.equal(srv.servers.length, 2);
    for (const h of srv.hosts) {
      const r = await fetch(`http://${h}:${srv.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(r.status, 200, `ping via ${h}`);
      const body = await r.json();
      assert.deepEqual(body.result, {}, `ping result via ${h}`);
    }
  } finally {
    await teardown();
  }
});

function rawGet({ host, port, path, localAddress, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, localAddress, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Admin API stays loopback-only (127.0.0.1) on extra interfaces', async () => {
  const prevExpose = process.env.BIFROST_ADMIN_EXPOSE;
  const prevToken = process.env.BIFROST_ADMIN_TOKEN;
  delete process.env.BIFROST_ADMIN_EXPOSE;
  process.env.BIFROST_ADMIN_TOKEN = 'test-admin-token-multihost';
  const auth = { Authorization: 'Bearer test-admin-token-multihost' };
  const { srv, teardown } = await bootServer(`127.0.0.1,${ALT}`);
  try {
    // Connecting to 127.0.1.1 from this host would pick 127.0.0.1 as the
    // source address (a genuinely local peer → allowed). Force the source to
    // ALT so the peer looks non-127.0.0.1, as a Tailscale client would.
    // A valid Bearer must NOT help a non-loopback peer.
    const remote = await rawGet({ host: ALT, port: srv.port, path: '/api/workspaces', localAddress: ALT, headers: auth });
    assert.equal(remote.status, 403);
    assert.equal(remote.body.error.code, 'ADMIN_LOCAL_ONLY');
    const local = await rawGet({ host: '127.0.0.1', port: srv.port, path: '/api/workspaces', headers: auth });
    assert.equal(local.status, 200);
  } finally {
    await teardown();
    if (prevExpose !== undefined) process.env.BIFROST_ADMIN_EXPOSE = prevExpose;
    if (prevToken !== undefined) process.env.BIFROST_ADMIN_TOKEN = prevToken;
    else delete process.env.BIFROST_ADMIN_TOKEN;
  }
});

test('unparsable Host header is ignored (no crash, normal routing)', async () => {
  const { srv, teardown } = await bootServer('127.0.0.1');
  try {
    const status = await new Promise((resolve, reject) => {
      const sock = connect(srv.port, '127.0.0.1', () => {
        sock.write('GET /mcp HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve(Number(buf.split(' ')[1])));
      sock.on('error', reject);
    });
    assert.equal(status, 404, 'fixed-base parsing ignores Host entirely');
    // Server still answers afterwards.
    const r = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'HEAD' });
    assert.equal(r.status, 405);
  } finally {
    await teardown();
  }
});

test('direct server.close() on the primary also closes extra listeners', async () => {
  const { srv, dir } = await bootServer(`127.0.0.1,${ALT}`);
  try {
    await new Promise((r) => srv.server.close(r));
    // Extras close asynchronously after the primary's 'close' event.
    for (let i = 0; i < 50 && srv.servers.some(s => s.listening); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    for (const s of srv.servers) assert.equal(s.listening, false);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() with an open SSE stream stops accepting on every listener and finishes', async () => {
  const { srv, teardown } = await bootServer(`127.0.0.1,${ALT}`);
  const ac = new AbortController();
  const sse = await fetch(`http://127.0.0.1:${srv.port}/sse`, { signal: ac.signal });
  assert.equal(sse.status, 200);
  const started = Date.now();
  const stopping = teardown();
  // Every listener must refuse new connections right away, not after the
  // first one finishes draining its SSE client.
  await assert.rejects(fetch(`http://${ALT}:${srv.port}/mcp`, { method: 'HEAD' }));
  await stopping;
  assert.ok(Date.now() - started < 8000, 'SSE stream must not block shutdown indefinitely');
  ac.abort();
});

function openSse(host, port) {
  // Raw request so the stream stays open independently of fetch internals.
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path: '/sse' }, (res) => resolve({ res, req }));
    req.on('error', reject);
    req.end();
  });
}

const closed = (srv) => new Promise((r) => srv.once('close', r));

test('direct server.close() with SSE on the primary: extras stop accepting at call time', async () => {
  const { srv, dir } = await bootServer(`127.0.0.1,${ALT}`);
  const sse = await openSse('127.0.0.1', srv.port);
  try {
    srv.server.close();
    // Primary's 'close' is blocked by the SSE client; extras must not wait for it.
    await assert.rejects(fetch(`http://${ALT}:${srv.port}/mcp`, { method: 'HEAD' }));
  } finally {
    await srv.stop();
    sse.req.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() after a direct close still waits for every listener to finish', async () => {
  // Case A — SSE on the primary, primary closed directly, then stop().
  {
    const { srv, dir } = await bootServer(`127.0.0.1,${ALT}`);
    const sse = await openSse('127.0.0.1', srv.port);
    let primaryClosed = false;
    srv.server.once('close', () => { primaryClosed = true; });
    srv.server.close();
    await srv.stop();
    assert.equal(primaryClosed, true, 'stop() returned while the primary was still draining');
    sse.req.destroy();
    await rm(dir, { recursive: true, force: true });
  }
  // Case B — SSE on an extra, primary closed (fully) directly, then stop().
  {
    const { srv, dir } = await bootServer(`127.0.0.1,${ALT}`);
    const sse = await openSse(ALT, srv.port);
    let extraClosed = false;
    srv.servers[1].once('close', () => { extraClosed = true; });
    const primaryDone = closed(srv.server);
    srv.server.close();
    await primaryDone;
    await srv.stop();
    assert.equal(extraClosed, true, 'stop() returned while an extra was still draining');
    sse.req.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test('server.close() keeps node semantics when not running', async () => {
  const { srv, teardown } = await bootServer('127.0.0.1');
  await teardown();
  const err = await new Promise((r) => srv.server.close(r));
  assert.equal(err?.code, 'ERR_SERVER_NOT_RUNNING');
});

test('server.close(cb) keeps node callback binding (this === server)', async () => {
  const { srv, dir } = await bootServer('127.0.0.1');
  try {
    const self = await new Promise((r) => srv.server.close(function () { r(this); }));
    assert.equal(self, srv.server);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('text/plain POST from an attacker-IP Origin is rejected before admin routing', async () => {
  const { srv, teardown } = await bootServer('127.0.0.1');
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'http://203.0.113.10' },
      body: JSON.stringify({ kind: 'mcp-client', transport: 'stdio', command: 'true' }),
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await teardown();
  }
});

test('Origin / Host guard (DNS rebinding)', async () => {
  const { srv, teardown } = await bootServer('127.0.0.1');
  const base = `http://127.0.0.1:${srv.port}`;
  const ping = (headers = {}) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  try {
    assert.equal((await ping()).status, 200, 'no Origin (CLI clients) allowed');
    assert.equal((await ping({ Origin: `http://localhost:${srv.port}` })).status, 200);
    assert.equal((await ping({ Origin: `http://127.0.0.1:${srv.port}` })).status, 200);
    const evil = await ping({ Origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal((await evil.json()).code, 'ORIGIN_NOT_ALLOWED');
    assert.equal((await ping({ Origin: 'null' })).status, 403);
    // Admin paths: rebinding arrives with the attacker's name in Host.
    const adminEvil = await rawGet({ host: '127.0.0.1', port: srv.port, path: '/api/workspaces', headers: { Host: `evil.example:${srv.port}` } });
    assert.equal(adminEvil.status, 403);
    assert.equal(adminEvil.body.code, 'HOST_NOT_ALLOWED');
    const adminIp = await rawGet({ host: '127.0.0.1', port: srv.port, path: '/api/workspaces' });
    assert.notEqual(adminIp.status, 403);
    // Non-admin paths ignore Host (tunnel / MagicDNS names keep working).
    const mcpName = await rawGet({ host: '127.0.0.1', port: srv.port, path: '/health', headers: { Host: 'codev2.example.ts.net' } });
    assert.equal(mcpName.status, 200);
  } finally {
    await teardown();
  }
});

test('stop() closes every listener', async () => {
  const { srv, teardown } = await bootServer(`127.0.0.1,${ALT}`);
  const servers = srv.servers;
  await teardown();
  for (const s of servers) assert.equal(s.listening, false);
});

test('bind failure on an extra host releases the primary listener', async () => {
  // Occupy ALT on a port, then ask Bifrost for 127.0.0.1+ALT on that port.
  const blocker = createServer();
  await new Promise((r) => blocker.listen(0, ALT, r));
  const port = blocker.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'multi-host-fail-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf-8');
  try {
    await assert.rejects(
      startServer({ port, host: `127.0.0.1,${ALT}`, configDir: dir }),
      (err) => err.code === 'EADDRINUSE',
    );
    // Primary must have been released — we can bind 127.0.0.1:port ourselves.
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((r) => probe.close(r));
  } finally {
    await new Promise((r) => blocker.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
