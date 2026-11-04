/**
 * client_secret_basic token requests: Basic-only by default, with one narrow
 * fallback for ASes that also demand client_id in the form body.
 *
 * - MCP Python SDK ClientAuthenticator (seen on mcp 1.30.0, the m365 DCR
 *   facade) answers Basic-only with 401 "Missing client_id".
 * - Cloudflare workers-oauth-provider rejects Basic + body client_id.
 * Both must work; nothing else may be retried (a code / refresh token must
 * never be presented twice after the AS may have processed it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager, isMissingClientIdError } from '../server/oauth-manager.js';
import { sanitize } from '../server/oauth-sanitize.js';

const ENDPOINT = 'http://as.test/token';
const OK = () => new Response(JSON.stringify({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
const json = (status, body) => new Response(JSON.stringify(body), { status });

/** AS behaviours, keyed by what they do with a Basic request. */
const AS = {
  // MCP Python SDK: form client_id is mandatory, then Basic is verified.
  sdk: (req) => (req.body.get('client_id')
    ? OK()
    : json(401, { error: 'unauthorized_client', error_description: 'Missing client_id' })),
  // Cloudflare-style: Basic + body client_id is two auth methods → reject.
  strict: (req) => (req.body.has('client_id')
    ? json(400, { error: 'invalid_request', error_description: 'Client authentication via multiple methods' })
    : OK()),
};

async function withManager(asImpl, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-basic-'));
  const seen = [];
  const fetchImpl = async (url, init) => {
    const req = { url, headers: init.headers, body: new URLSearchParams(init.body), signal: init.signal };
    seen.push(req);
    return asImpl(req);
  };
  try {
    const mgr = new OAuthManager({ getServerConfig: () => ({ port: 3100 }) }, { stateDir: dir, fetchImpl });
    await fn(mgr, seen);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const basicEntry = { tokenEndpoint: ENDPOINT, authMethod: 'client_secret_basic', clientId: 'cid-basic-0001', clientSecret: 's3cret' };
const refreshParams = () => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'RT' });
const BASIC = 'Basic ' + Buffer.from('cid-basic-0001:s3cret').toString('base64');

test('strict AS: Basic-only, single request, no body client_id', async () => {
  await withManager(AS.strict, async (mgr, seen) => {
    await mgr._exchangeCode({ ...basicEntry, verifier: 'v' }, 'code-1');
    await mgr._tokenRequest(basicEntry, refreshParams(), 'refresh');
    assert.equal(seen.length, 2);
    for (const r of seen) {
      assert.equal(r.headers.Authorization, BASIC);
      assert.equal(r.body.has('client_id'), false);
      assert.equal(r.body.has('client_secret'), false);
    }
  });
});

for (const kind of ['authorize', 'refresh']) {
  test(`SDK AS (${kind}): "Missing client_id" → one retry with body client_id, then remembered`, async () => {
    await withManager(AS.sdk, async (mgr, seen) => {
      const call = () => (kind === 'authorize'
        ? mgr._exchangeCode({ ...basicEntry, verifier: 'v' }, 'code-1')
        : mgr._tokenRequest(basicEntry, refreshParams(), 'refresh'));
      const ac = new AbortController();
      if (kind === 'refresh') {
        await mgr._tokenRequest(basicEntry, refreshParams(), 'refresh', { signal: ac.signal });
      } else {
        await call();
      }
      assert.equal(seen.length, 2);
      assert.equal(seen[0].body.has('client_id'), false);
      assert.equal(seen[1].body.get('client_id'), 'cid-basic-0001');
      assert.equal(seen[1].headers.Authorization, BASIC);
      assert.equal(seen[1].body.has('client_secret'), false, 'secret stays in the header');
      if (kind === 'refresh') assert.equal(seen[1].signal, ac.signal, 'retry keeps the abort signal');

      await call();
      assert.equal(seen.length, 3, 'quirk remembered — no failing first attempt');
      assert.equal(seen[2].body.get('client_id'), 'cid-basic-0001');
    });
  });
}

test('quirk memo is per token endpoint + client', async () => {
  await withManager(AS.sdk, async (mgr, seen) => {
    await mgr._tokenRequest(basicEntry, refreshParams(), 'refresh');
    await mgr._tokenRequest({ ...basicEntry, clientId: 'cid-basic-0002' }, refreshParams(), 'refresh');
    assert.equal(seen.length, 4);
    assert.equal(seen[2].body.has('client_id'), false);
  });
});

test('no retry on other errors (invalid_grant, invalid_client, 5xx)', async () => {
  for (const res of [
    () => json(400, { error: 'invalid_grant', error_description: 'authorization code does not exist' }),
    () => json(401, { error: 'invalid_client', error_description: 'Invalid client_secret' }),
    () => json(503, { error: 'temporarily_unavailable' }),
    () => new Response('Missing client_id', { status: 401 }),
  ]) {
    await withManager(res, async (mgr, seen) => {
      await assert.rejects(mgr._tokenRequest(basicEntry, refreshParams(), 'refresh'), { code: 'TOKEN_ENDPOINT_ERROR' });
      assert.equal(seen.length, 1);
    });
  }
});

test('post / none clients never retry and keep their body credentials', async () => {
  const missing = () => json(401, { error: 'unauthorized_client', error_description: 'Missing client_id' });
  for (const entry of [
    { tokenEndpoint: ENDPOINT, authMethod: 'client_secret_post', clientId: 'cid-post', clientSecret: 's3cret' },
    { tokenEndpoint: ENDPOINT, authMethod: 'none', clientId: 'cid-none', clientSecret: null },
  ]) {
    await withManager(missing, async (mgr, seen) => {
      await assert.rejects(mgr._tokenRequest(entry, refreshParams(), 'refresh'));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].headers.Authorization, undefined);
      assert.equal(seen[0].body.get('client_id'), entry.clientId);
      assert.equal(seen[0].body.get('client_secret'), entry.clientSecret ?? null);
    });
  }
});

test('token errors that echo the request do not leak the raw client_id', async () => {
  const echo = (req) => new Response(`bad request: ${req.body.toString()} ${JSON.stringify({ client_id: 'cid-basic-0001' })} cid-basic-0001`, { status: 400 });
  await withManager(echo, async (mgr) => {
    await assert.rejects(
      mgr._tokenRequest(basicEntry, refreshParams(), 'refresh'),
      (err) => {
        assert.equal(err.message.includes('cid-basic-0001'), false, err.message);
        assert.match(err.message, /cid-\*\*\*0001/);
        return true;
      },
    );
  });
});

test('short client_id echoed in an error is not leaked (body omitted)', async () => {
  const echo = () => json(401, { error: 'invalid_client', error_description: "Rejected client 'cid'" });
  await withManager(echo, async (mgr) => {
    await assert.rejects(
      mgr._tokenRequest({ ...basicEntry, clientId: 'cid' }, refreshParams(), 'refresh'),
      (err) => {
        assert.equal(err.message.includes("'cid'"), false, err.message);
        assert.match(err.message, /^token_endpoint_refresh_failed: 401 \[response body omitted/);
        return true;
      },
    );
  });
  // A short ID that does not appear keeps the (sanitized) body for diagnosis.
  const other = () => json(400, { error: 'invalid_grant', error_description: 'expired' });
  await withManager(other, async (mgr) => {
    await assert.rejects(mgr._tokenRequest({ ...basicEntry, clientId: 'zq' }, refreshParams(), 'refresh'), /invalid_grant/);
  });
});

test('isMissingClientIdError is narrow', () => {
  const body = (o) => JSON.stringify(o);
  assert.equal(isMissingClientIdError(401, body({ error: 'unauthorized_client', error_description: 'Missing client_id' })), true);
  assert.equal(isMissingClientIdError(400, body({ error: 'invalid_request', error_description: 'missing client_id ' })), true);
  assert.equal(isMissingClientIdError(500, body({ error: 'unauthorized_client', error_description: 'Missing client_id' })), false);
  assert.equal(isMissingClientIdError(401, body({ error: 'invalid_grant', error_description: 'Missing client_id' })), false);
  assert.equal(isMissingClientIdError(401, body({ error: 'unauthorized_client', error_description: 'Missing client_id or code' })), false);
  assert.equal(isMissingClientIdError(401, 'Missing client_id'), false);
});

test('sanitize masks client_id in form and JSON text', () => {
  const out = sanitize('client_id=abcdefghijkl&x=1 {"client_id": "mock_1234567890"} client_id=short');
  assert.equal(out, 'client_id=abcd***ijkl&x=1 {"client_id": "mock***7890"} client_id=***');
});
