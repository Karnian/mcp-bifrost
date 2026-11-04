/**
 * Optional hosts (BIFROST_HOST_OPTIONAL) — best-effort binds that never take
 * the required listeners down — and SIGTERM/SIGINT graceful shutdown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, installSignalHandlers, parseHostList } from '../server/index.js';

const ALT = '127.0.1.1';
const UNASSIGNED = '192.0.2.1'; // TEST-NET-1 — never on a local interface → EADDRNOTAVAIL

async function boot(opts) {
  const dir = await mkdtemp(join(tmpdir(), 'opt-hosts-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf-8');
  const srv = await startServer({ port: 0, configDir: dir, ...opts });
  return { srv, dir, teardown: async () => { await srv.stop(); await rm(dir, { recursive: true, force: true }); } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(20); }
  return false;
}

test('parseHostList keeps empty input empty', () => {
  assert.deepEqual(parseHostList(''), []);
  assert.deepEqual(parseHostList(undefined), []);
  assert.deepEqual(parseHostList(' 10.0.0.1, ,10.0.0.1'), ['10.0.0.1']);
});

test('unbindable optional host: required listener still serves, failure is retried with backoff', async () => {
  const { srv, teardown } = await boot({ host: '127.0.0.1', optionalHosts: UNASSIGNED, optionalRetry: { baseMs: 30, maxMs: 60 } });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'HEAD' });
    assert.equal(r.status, 405);
    assert.ok(await until(() => srv.getOptionalStatus()[UNASSIGNED].attempts >= 3), 'retries happen');
    const st = srv.getOptionalStatus()[UNASSIGNED];
    assert.equal(st.bound, false);
    assert.equal(st.lastError, 'EADDRNOTAVAIL');
  } finally {
    await teardown();
  }
  const after = srv.getOptionalStatus()[UNASSIGNED].attempts;
  await wait(200);
  assert.equal(srv.getOptionalStatus()[UNASSIGNED].attempts, after, 'no retries after stop()');
});

test('optional host whose port is taken binds once it frees up', async () => {
  // Take a port on ALT first, then start Bifrost on that same port.
  const blocker = createServer();
  await new Promise((r) => blocker.listen(0, ALT, r));
  const port = blocker.address().port;
  const { srv, teardown } = await boot({ port, host: '127.0.0.1', optionalHosts: ALT, optionalRetry: { baseMs: 30, maxMs: 30 } });
  try {
    assert.equal(srv.getOptionalStatus()[ALT].bound, false);
    assert.equal(srv.getOptionalStatus()[ALT].lastError, 'EADDRINUSE');
    await new Promise((r) => blocker.close(r));
    assert.ok(await until(() => srv.getOptionalStatus()[ALT].bound), 'retry bound after the port freed');
    const r = await fetch(`http://${ALT}:${port}/mcp`, { method: 'HEAD' });
    assert.equal(r.status, 405);
  } finally {
    await teardown();
  }
  for (const s of srv.servers) assert.equal(s.listening, false, 'stop() closes late-bound optional listeners too');
});

test('optional host duplicated in required list is ignored', async () => {
  const { srv, teardown } = await boot({ host: '127.0.0.1', optionalHosts: '127.0.0.1' });
  try {
    assert.deepEqual(srv.optionalHosts, []);
  } finally {
    await teardown();
  }
});

function fakeProc() {
  const p = new EventEmitter();
  p.exits = [];
  p.exit = (code) => { p.exits.push(code); };
  return p;
}
const quiet = { info() {}, warn() {}, error() {} };

test('SIGTERM → stop() then exit(0)', async () => {
  const proc = fakeProc();
  let stopped = 0;
  installSignalHandlers({ stop: async () => { stopped++; } }, { proc, log: quiet });
  proc.emit('SIGTERM', 'SIGTERM');
  assert.ok(await until(() => proc.exits.length === 1));
  assert.equal(stopped, 1);
  assert.deepEqual(proc.exits, [0]);
});

test('second signal while stopping forces exit(1); hung stop() hits the watchdog', async () => {
  const proc = fakeProc();
  installSignalHandlers({ stop: () => new Promise(() => {}) }, { proc, timeoutMs: 50, log: quiet });
  proc.emit('SIGINT', 'SIGINT');
  proc.emit('SIGTERM', 'SIGTERM');
  assert.deepEqual(proc.exits, [1]);
  assert.ok(await until(() => proc.exits.length === 2, 500));
  assert.deepEqual(proc.exits, [1, 1]);
});

test('stop() rejection → exit(1)', async () => {
  const proc = fakeProc();
  installSignalHandlers({ stop: async () => { throw new Error('boom'); } }, { proc, log: quiet });
  proc.emit('SIGTERM', 'SIGTERM');
  assert.ok(await until(() => proc.exits.length === 1));
  assert.deepEqual(proc.exits, [1]);
});

test('real process: SIGTERM with an open SSE stream exits 0 via graceful path', async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'opt-hosts-sig-'));
  await writeFile(join(dir, 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf-8');
  const mod = pathToFileURL(join(process.cwd(), 'server/index.js')).href;
  const code = `
    const { startServer, installSignalHandlers } = await import(${JSON.stringify(mod)});
    const app = await startServer({ port: 0, host: '127.0.0.1', configDir: ${JSON.stringify(dir)} });
    installSignalHandlers(app, { timeoutMs: 10000 });
    console.log('PORT=' + app.port);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    assert.ok(await until(() => /PORT=\d+/.test(out), 5000), 'child started');
    const port = Number(/PORT=(\d+)/.exec(out)[1]);
    const ac = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/sse`, { signal: ac.signal });
    assert.equal(sse.status, 200);
    const exited = new Promise((r) => child.once('exit', (c, s) => r({ c, s })));
    child.kill('SIGTERM');
    const { c, s } = await exited;
    ac.abort();
    assert.equal(s, null, 'not killed by the signal itself');
    assert.equal(c, 0);
    assert.match(out, /SIGTERM received — graceful shutdown/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() waits for in-flight request handling even after its socket is gone', async () => {
  // A closed connection does not mean the handler (tool call, OAuth exchange +
  // save) is done — stop() must wait for the handler itself.
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  const orig = srv.mcp.handle.bind(srv.mcp);
  let finished = false;
  srv.mcp.handle = async (...a) => { await wait(300); const r = await orig(...a); finished = true; return r; };
  try {
    const ac = new AbortController();
    const resP = fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }).catch(() => null);
    await wait(50);   // handler is running
    ac.abort();       // client socket goes away
    await wait(20);
    const t0 = Date.now();
    await srv.stop();
    assert.equal(finished, true, 'stop() returned while the handler was still running');
    // …and it returns as soon as the handler is done, not after the
    // socket force-close grace period (the old behaviour took ~4-5s here).
    assert.ok(Date.now() - t0 < 2000, `stop() took ${Date.now() - t0}ms`);
    await resP;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() waits for queued config writes (fire-and-forget OAuth saves)', async () => {
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  let written = false;
  srv.wm._writeLock = srv.wm._writeLock.then(() => wait(200)).then(() => { written = true; });
  await srv.stop();
  assert.equal(written, true);
  await rm(dir, { recursive: true, force: true });
});

test('real process: stop() that hangs ends in exit(1) via watchdog, not a silent exit(0)', async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const mod = pathToFileURL(join(process.cwd(), 'server/index.js')).href;
  const code = `
    const { installSignalHandlers } = await import(${JSON.stringify(mod)});
    installSignalHandlers({ stop: () => new Promise(() => {}) }, { timeoutMs: 300 });
    const keep = setInterval(() => {}, 1000);
    process.once('SIGTERM', () => clearInterval(keep)); // no other handles left after the signal
    console.log('READY');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    assert.ok(await until(() => out.includes('READY'), 5000));
    const exited = new Promise((r) => child.once('exit', (c) => r(c)));
    child.kill('SIGTERM');
    assert.equal(await exited, 1);
    assert.match(out, /forcing exit/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('POST /sse result reaches the SSE stream when shutdown starts mid tool call', async () => {
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  const orig = srv.mcp.handle.bind(srv.mcp);
  srv.mcp.handle = async (...a) => { await wait(300); return orig(...a); };
  let stream = '';
  const sseReq = httpRequest({ host: '127.0.0.1', port: srv.port, path: '/sse' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => { stream += d; });
  });
  sseReq.on('error', () => {});
  sseReq.end();
  try {
    assert.ok(await until(() => /sessionId=([\w-]+)/.test(stream)), 'endpoint event');
    const sessionId = /sessionId=([\w-]+)/.exec(stream)[1];
    const post = fetch(`http://127.0.0.1:${srv.port}/sse?sessionId=${sessionId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
    });
    await wait(50);
    await srv.stop();
    assert.equal((await post).status, 202);
    assert.ok(await until(() => /"id":7/.test(stream), 1000), 'tool result was delivered before the stream closed');
  } finally {
    sseReq.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() lets a large response finish flushing to a slow reader', async () => {
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  const big = 'x'.repeat(8 * 1024 * 1024);
  srv.mcp.handle = async (body) => ({ jsonrpc: '2.0', id: body.id, result: { big } });
  try {
    const got = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: srv.port, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.pause(); // apply backpressure: the server can't flush yet
        let n = 0;
        res.on('data', (d) => { n += d.length; });
        res.on('end', () => resolve({ n, complete: res.complete }));
        res.on('error', reject);
        setTimeout(async () => { const stopping = srv.stop(); await wait(100); res.resume(); await stopping; }, 100);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    });
    assert.equal(got.complete, true, 'response was cut off');
    assert.ok(got.n > big.length, `received ${got.n} bytes`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop() waits for an OAuth refresh/rotation chain; drain() does not spin on a stuck entry', async () => {
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  let refreshed = false;
  srv.oauth._withIdentityMutex('ws-x', 'default', async () => { await wait(300); refreshed = true; });
  await srv.stop();
  assert.equal(refreshed, true, 'stop() returned while a token refresh was still running');
  // A settled tail that was never removed must not loop forever.
  srv.oauth._identityMutex.set('stuck', Promise.resolve());
  await srv.oauth.drain();
  await rm(dir, { recursive: true, force: true });
});

test('pipelined request dispatched after stop() began gets 503, not new work', async () => {
  // Node dispatches each pipelined request as soon as it is parsed (only the
  // responses are serialized). So: A is in flight, stop() begins, and B's
  // bytes arrive on that same busy connection afterwards → must get 503.
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  const orig = srv.mcp.handle.bind(srv.mcp);
  let calls = 0;
  srv.mcp.handle = async (...a) => { calls++; await wait(300); return orig(...a); };
  const { connect } = await import('node:net');
  const sock = connect(srv.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  let buf = '';
  sock.on('data', (d) => { buf += d; });
  const reqText = (id) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
    return `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  };
  try {
    sock.write(reqText(1));                 // A
    await wait(50);                         // A is running
    const stopping = srv.stop();
    await wait(20);
    sock.write(reqText(2));                 // B on the same, still-busy connection
    await stopping;
    assert.ok(await until(() => (buf.match(/HTTP\/1\.1 /g) || []).length >= 2, 1000), `got: ${buf.slice(0, 200)}`);
    const statuses = [...buf.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(m => Number(m[1]));
    assert.deepEqual(statuses, [200, 503]);
    assert.match(buf, /SHUTTING_DOWN/);
    assert.equal(calls, 1, 'the pipelined request never reached the handler');
  } finally {
    sock.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test('after stop(), OAuth managers refuse new mutex work (late 401 → refresh)', async () => {
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  await srv.stop();
  await assert.rejects(srv.oauth._withIdentityMutex('ws', 'default', async () => 'refreshed'), { code: 'SHUTTING_DOWN' });
  await assert.rejects(srv.oauth._withWorkspaceMutex('ws', async () => 'rotated'), { code: 'SHUTTING_DOWN' });
  await assert.rejects(srv.slackOAuth._withWorkspaceMutex('ws', async () => 'refreshed'), { code: 'SHUTTING_DOWN' });
  await assert.rejects(srv.slackOAuth._withTeamInstallMutex('t', async () => 'installed'), { code: 'SHUTTING_DOWN' });
  await rm(dir, { recursive: true, force: true });
});

test('closing clears node http connections-checking interval (no retained timers)', async () => {
  const { srv, teardown } = await boot({ host: '127.0.0.1' });
  const sym = Object.getOwnPropertySymbols(srv.server).find(s => s.description === 'http.server.connectionsCheckingInterval');
  assert.ok(sym, 'node still exposes the interval under this description');
  await teardown();
  assert.equal(srv.server[sym]._destroyed, true);
});

test('after close(), work already running may still take nested locks (workspace → identity)', async () => {
  const { srv, dir } = await boot({ host: '127.0.0.1' });
  let inner = null;
  const outer = srv.oauth._withWorkspaceMutex('ws', async () => {
    await wait(100);                    // close() happens meanwhile
    inner = await srv.oauth._withIdentityMutex('ws', 'default', async () => 'exchanged');
  });
  await wait(20);
  srv.oauth.close();
  await outer;
  assert.equal(inner, 'exchanged', 'nested lock inside running work must not be refused');
  await assert.rejects(srv.oauth._withIdentityMutex('ws', 'default', async () => 'new'), { code: 'SHUTTING_DOWN' });
  await srv.stop();
  await rm(dir, { recursive: true, force: true });
});
