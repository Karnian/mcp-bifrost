/**
 * Phase 7e — MCP notifications over HTTP/SSE subscription tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClientProvider } from '../providers/mcp-client.js';
import { MockOAuthServer } from './fixtures/mock-oauth-server.js';

async function waitForStream(provider, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (provider.isStreamConnected()) return true;
    await delay(20);
  }
  return false;
}

async function seededProvider(mock) {
  // Mint an access token directly in the mock and use it as a static header.
  const access = 'AT.preseeded_test_token';
  mock.tokens.set(access, { clientId: 'test', expiresAt: Date.now() + 3600_000 });
  const provider = new McpClientProvider(
    { id: 'w1', transport: 'http', url: `${mock.baseUrl}/mcp`, headers: {} },
    { tokenProvider: async () => access }
  );
  return provider;
}

test('stream opens on connect and receives Mcp-Session-Id', async () => {
  const mock = new MockOAuthServer();
  await mock.start();
  try {
    const prov = await seededProvider(mock);
    await prov._ensureConnected();
    const ok = await waitForStream(prov);
    assert.equal(ok, true, 'stream should be connected shortly after handshake');
    assert.ok(prov._sessionId && prov._sessionId.startsWith('sess_'), 'Mcp-Session-Id should be captured');
    await prov.shutdown();
  } finally { await mock.stop(); }
});

test('notifications/tools/list_changed invalidates toolsCache and fires onToolsChanged', async () => {
  const mock = new MockOAuthServer();
  await mock.start();
  try {
    const prov = await seededProvider(mock);
    let notified = 0;
    prov.onToolsChanged(() => notified++);
    await prov._ensureConnected();
    await waitForStream(prov);
    // Warm cache
    await prov.refreshTools();
    assert.ok(prov.getTools().length > 0);
    // Fire notification
    const pushed = mock.pushNotification({ method: 'notifications/tools/list_changed', params: {} });
    assert.equal(pushed, true);
    // Wait for propagation
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && notified === 0) await delay(20);
    assert.equal(notified, 1);
    assert.equal(prov._toolsCache, null, 'toolsCache should be invalidated');
    await prov.shutdown();
  } finally { await mock.stop(); }
});

test('malformed stream event is dropped without crashing', async () => {
  const mock = new MockOAuthServer();
  await mock.start();
  try {
    const prov = await seededProvider(mock);
    await prov._ensureConnected();
    await waitForStream(prov);
    // Write junk directly to the stream
    if (mock._streamRes) mock._streamRes.write('data: this is not json\n\n');
    // Also send a valid event afterwards — should still be parsed
    let notified = 0;
    prov.onToolsChanged(() => notified++);
    mock.pushNotification({ method: 'notifications/tools/list_changed', params: {} });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && notified === 0) await delay(20);
    assert.equal(notified, 1, 'valid event after malformed one still propagates');
    await prov.shutdown();
  } finally { await mock.stop(); }
});

test('Mcp-Session-Id is sent as request header on subsequent POST', async () => {
  const mock = new MockOAuthServer();
  await mock.start();
  try {
    const prov = await seededProvider(mock);
    await prov._ensureConnected();
    await waitForStream(prov);
    const sid = prov._sessionId;
    assert.ok(sid);
    // Make another POST — capture via mock.requests (needs header instrumentation)
    // Instead, directly verify _buildHeaders reflects the sessionId.
    const headers = await prov._buildHeaders();
    assert.equal(headers['Mcp-Session-Id'], sid);
    await prov.shutdown();
  } finally { await mock.stop(); }
});

test('stream reconnect is scheduled with 30s initial backoff after disconnect', async () => {
  const mock = new MockOAuthServer();
  await mock.start();
  try {
    const prov = await seededProvider(mock);
    await prov._ensureConnected();
    await waitForStream(prov);
    assert.equal(prov._streamBackoffMs, 30_000, 'backoff should reset to 30s on healthy connect');
    // Force disconnect
    if (mock._streamRes) { try { mock._streamRes.end(); } catch {} }
    // Give the client a tick to react
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && prov.isStreamConnected()) await delay(20);
    assert.equal(prov.isStreamConnected(), false);
    // Reconnect should be scheduled (backoff next = 60s after this attempt).
    // We don't wait 30s — just verify the timer is set (or the reconnect already fired).
    assert.ok(prov._streamReconnectTimer || prov._streamAbort || prov._streamConnected);
    await prov.shutdown();
  } finally { await mock.stop(); }
});

test('GET /mcp returning 405 does not loop reconnect', async () => {
  // Build a minimal mock that returns 405 for GET
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mcp') {
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }
    // Accept POST initialize to reach the GET path.
    if (req.method === 'POST' && req.url === '/mcp') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} } }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const prov = new McpClientProvider(
      { id: 'w1', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} },
      { tokenProvider: async () => 'any' }
    );
    await prov._ensureConnected();
    await delay(100);
    // After 405, stream should NOT be scheduling endless reconnects.
    assert.equal(prov._streamReconnectTimer, null, 'should not schedule reconnect on 405');
    await prov.shutdown();
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('202 Accepted POST + stream-delivered response is routed via _pending', async () => {
  const { createServer } = await import('node:http');
  const pushedResponses = [];
  let streamRes;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mcp') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'S1' });
      res.write(': hi\n\n');
      streamRes = res;
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} } }));
          return;
        }
        if (body.method === 'notifications/initialized') {
          res.writeHead(202); res.end(); return;
        }
        // Any other RPC: return 202 and deliver the response via the GET stream
        res.writeHead(202); res.end();
        setTimeout(() => {
          if (streamRes) streamRes.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { streamed: true, echo: body.method } })}\n\n`);
        }, 10);
        return;
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const prov = new McpClientProvider(
      { id: 'w1', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} },
      { tokenProvider: async () => 'any' }
    );
    await prov._ensureConnected();
    await waitForStream(prov);
    // Make a call that the server answers via the stream
    const result = await prov._rpcHttp('custom/ping', { x: 1 });
    assert.deepEqual(result, { streamed: true, echo: 'custom/ping' });
    await prov.shutdown();
  } finally {
    try { if (streamRes) streamRes.end(); } catch {}
    await new Promise(r => server.close(r));
  }
});

test('CRLF-terminated SSE events are parsed correctly', async () => {
  const { createServer } = await import('node:http');
  let streamRes;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mcp') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'S-CRLF' });
      // Spec-compliant CRLF
      res.write(': hi\r\n\r\n');
      streamRes = res;
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const prov = new McpClientProvider(
      { id: 'w1', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} },
      { tokenProvider: async () => 'any' }
    );
    let notified = 0;
    prov.onToolsChanged(() => notified++);
    await prov._ensureConnected();
    await waitForStream(prov);
    // Push a CRLF-terminated notification
    streamRes.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} })}\r\n\r\n`);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && notified === 0) await delay(20);
    assert.equal(notified, 1, 'CRLF event should parse');
    await prov.shutdown();
  } finally {
    try { if (streamRes) streamRes.end(); } catch {}
    await new Promise(r => server.close(r));
  }
});

test('stream logs connecting/connected transitions (observability for E2E #13)', async () => {
  const mock = new MockOAuthServer();
  await mock.start();
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const prov = await seededProvider(mock);
    await prov._ensureConnected();
    await waitForStream(prov);
    await prov.shutdown();
    const streamLogs = logs.filter(l => l.includes('[McpClient:w1] stream:'));
    assert.ok(streamLogs.some(l => l.includes('connecting')), `expected 'connecting' log, got: ${streamLogs.join(' | ')}`);
    assert.ok(streamLogs.some(l => l.includes('connected')), `expected 'connected' log, got: ${streamLogs.join(' | ')}`);
  } finally {
    console.log = origLog;
    await mock.stop();
  }
});

test('shutdown clears stream reconnect timer', async () => {
  const mock = new MockOAuthServer();
  await mock.start();
  try {
    const prov = await seededProvider(mock);
    await prov._ensureConnected();
    await waitForStream(prov);
    await prov.shutdown();
    assert.equal(prov._streamConnected, false);
    assert.equal(prov._streamReconnectTimer, null);
    assert.equal(prov._streamAbort, null);
  } finally { await mock.stop(); }
});
