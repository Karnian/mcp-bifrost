/**
 * Phase 9b — 프로덕션 보안/배포 테스트
 * trust proxy, security headers, CORS, config constants, workspace schema validation
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. Trust proxy — getClientIp ───

describe('getClientIp', () => {
  let getClientIp;

  it('loads getClientIp from rate-limiter', async () => {
    ({ getClientIp } = await import('../server/rate-limiter.js'));
    assert.equal(typeof getClientIp, 'function');
  });

  it('returns direct IP when trust proxy is disabled', async () => {
    ({ getClientIp } = await import('../server/rate-limiter.js'));
    const orig = process.env.BIFROST_TRUST_PROXY;
    delete process.env.BIFROST_TRUST_PROXY;
    try {
      const req = {
        socket: { remoteAddress: '192.168.1.1' },
        headers: { 'x-forwarded-for': '10.0.0.1, 172.16.0.1' },
      };
      assert.equal(getClientIp(req), '192.168.1.1');
    } finally {
      if (orig !== undefined) process.env.BIFROST_TRUST_PROXY = orig;
    }
  });

  it('returns rightmost untrusted IP when trust proxy is enabled', async () => {
    ({ getClientIp } = await import('../server/rate-limiter.js'));
    const origTrust = process.env.BIFROST_TRUST_PROXY;
    const origProxies = process.env.BIFROST_TRUSTED_PROXIES;
    process.env.BIFROST_TRUST_PROXY = '1';
    process.env.BIFROST_TRUSTED_PROXIES = '172.16.0.1';
    try {
      const req = {
        socket: { remoteAddress: '172.16.0.1' },
        headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.5, 172.16.0.1' },
      };
      // 172.16.0.1 is trusted, so rightmost untrusted is 192.168.1.5
      assert.equal(getClientIp(req), '192.168.1.5');
    } finally {
      if (origTrust !== undefined) process.env.BIFROST_TRUST_PROXY = origTrust;
      else delete process.env.BIFROST_TRUST_PROXY;
      if (origProxies !== undefined) process.env.BIFROST_TRUSTED_PROXIES = origProxies;
      else delete process.env.BIFROST_TRUSTED_PROXIES;
    }
  });

  it('returns leftmost IP when all are trusted', async () => {
    ({ getClientIp } = await import('../server/rate-limiter.js'));
    const origTrust = process.env.BIFROST_TRUST_PROXY;
    const origProxies = process.env.BIFROST_TRUSTED_PROXIES;
    process.env.BIFROST_TRUST_PROXY = '1';
    process.env.BIFROST_TRUSTED_PROXIES = '10.0.0.1,172.16.0.1';
    try {
      const req = {
        socket: { remoteAddress: '172.16.0.1' },
        headers: { 'x-forwarded-for': '10.0.0.1, 172.16.0.1' },
      };
      assert.equal(getClientIp(req), '10.0.0.1');
    } finally {
      if (origTrust !== undefined) process.env.BIFROST_TRUST_PROXY = origTrust;
      else delete process.env.BIFROST_TRUST_PROXY;
      if (origProxies !== undefined) process.env.BIFROST_TRUSTED_PROXIES = origProxies;
      else delete process.env.BIFROST_TRUSTED_PROXIES;
    }
  });

  it('returns direct IP when no X-Forwarded-For', async () => {
    ({ getClientIp } = await import('../server/rate-limiter.js'));
    const orig = process.env.BIFROST_TRUST_PROXY;
    process.env.BIFROST_TRUST_PROXY = '1';
    try {
      const req = { socket: { remoteAddress: '203.0.113.1' }, headers: {} };
      assert.equal(getClientIp(req), '203.0.113.1');
    } finally {
      if (orig !== undefined) process.env.BIFROST_TRUST_PROXY = orig;
      else delete process.env.BIFROST_TRUST_PROXY;
    }
  });
});

// ─── 2. Security headers ───

describe('applySecurityHeaders', () => {
  it('sets X-Content-Type-Options, X-Frame-Options, X-XSS-Protection', async () => {
    const { applySecurityHeaders } = await import('../server/security-headers.js');
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; } };
    applySecurityHeaders(res, { headers: {} });
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.equal(headers['X-XSS-Protection'], '0');
  });

  it('adds HSTS when trust proxy is enabled', async () => {
    const { applySecurityHeaders } = await import('../server/security-headers.js');
    const orig = process.env.BIFROST_TRUST_PROXY;
    process.env.BIFROST_TRUST_PROXY = '1';
    try {
      const headers = {};
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      applySecurityHeaders(res, { headers: {} });
      assert.ok(headers['Strict-Transport-Security']);
      assert.ok(headers['Strict-Transport-Security'].includes('max-age'));
    } finally {
      if (orig !== undefined) process.env.BIFROST_TRUST_PROXY = orig;
      else delete process.env.BIFROST_TRUST_PROXY;
    }
  });

  it('does not add HSTS when trust proxy is disabled', async () => {
    const { applySecurityHeaders } = await import('../server/security-headers.js');
    const orig = process.env.BIFROST_TRUST_PROXY;
    delete process.env.BIFROST_TRUST_PROXY;
    try {
      const headers = {};
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      applySecurityHeaders(res, { headers: {} });
      assert.equal(headers['Strict-Transport-Security'], undefined);
    } finally {
      if (orig !== undefined) process.env.BIFROST_TRUST_PROXY = orig;
    }
  });
});

// ─── 3. CORS ───

describe('CORS via applySecurityHeaders', () => {
  it('adds CORS headers when origin matches BIFROST_CORS_ORIGIN', async () => {
    const { applySecurityHeaders } = await import('../server/security-headers.js');
    const orig = process.env.BIFROST_CORS_ORIGIN;
    process.env.BIFROST_CORS_ORIGIN = 'https://example.com';
    try {
      const headers = {};
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      applySecurityHeaders(res, { headers: { origin: 'https://example.com' } });
      assert.equal(headers['Access-Control-Allow-Origin'], 'https://example.com');
      assert.ok(headers['Access-Control-Allow-Methods'].includes('POST'));
    } finally {
      if (orig !== undefined) process.env.BIFROST_CORS_ORIGIN = orig;
      else delete process.env.BIFROST_CORS_ORIGIN;
    }
  });

  it('does not add CORS headers when origin does not match', async () => {
    const { applySecurityHeaders } = await import('../server/security-headers.js');
    const orig = process.env.BIFROST_CORS_ORIGIN;
    process.env.BIFROST_CORS_ORIGIN = 'https://allowed.com';
    try {
      const headers = {};
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      applySecurityHeaders(res, { headers: { origin: 'https://evil.com' } });
      assert.equal(headers['Access-Control-Allow-Origin'], undefined);
    } finally {
      if (orig !== undefined) process.env.BIFROST_CORS_ORIGIN = orig;
      else delete process.env.BIFROST_CORS_ORIGIN;
    }
  });

  it('supports wildcard CORS origin', async () => {
    const { applySecurityHeaders } = await import('../server/security-headers.js');
    const orig = process.env.BIFROST_CORS_ORIGIN;
    process.env.BIFROST_CORS_ORIGIN = '*';
    try {
      const headers = {};
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      applySecurityHeaders(res, { headers: { origin: 'https://any.com' } });
      assert.equal(headers['Access-Control-Allow-Origin'], 'https://any.com');
    } finally {
      if (orig !== undefined) process.env.BIFROST_CORS_ORIGIN = orig;
      else delete process.env.BIFROST_CORS_ORIGIN;
    }
  });
});

// ─── 4. Config constants ───

describe('config-constants', () => {
  it('exports all expected constants with defaults', async () => {
    const c = await import('../server/config-constants.js');
    assert.equal(typeof c.RATE_LIMIT_MAX, 'number');
    assert.equal(typeof c.RATE_LIMIT_WINDOW_MS, 'number');
    assert.equal(typeof c.SSE_KEEPALIVE_MS, 'number');
    assert.equal(typeof c.HEALTH_CHECK_INTERVAL_MS, 'number');
    assert.equal(typeof c.AUDIT_RING_SIZE, 'number');
    assert.equal(typeof c.SCRYPT_N, 'number');
    assert.equal(typeof c.USAGE_RETENTION_MS, 'number');
    assert.equal(typeof c.MAX_RESOURCE_SIZE, 'number');
    assert.equal(typeof c.HEADERS_TIMEOUT, 'number');
    assert.equal(typeof c.REQUEST_TIMEOUT, 'number');

    // Verify defaults
    assert.equal(c.RATE_LIMIT_MAX, 10);
    assert.equal(c.SSE_KEEPALIVE_MS, 30_000);
    assert.equal(c.AUDIT_RING_SIZE, 50);
    assert.equal(c.MAX_RESOURCE_SIZE, 5 * 1024 * 1024);
  });
});

// ─── 5. Workspace schema validation ───

describe('validateWorkspacePayload', () => {
  let validateWorkspacePayload;

  it('loads validateWorkspacePayload', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    assert.equal(typeof validateWorkspacePayload, 'function');
  });

  it('accepts valid native workspace', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    const result = validateWorkspacePayload({
      displayName: 'My Notion',
      provider: 'notion',
      namespace: 'personal',
    });
    assert.equal(result.valid, true);
  });

  it('accepts valid mcp-client stdio workspace', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    const result = validateWorkspacePayload({
      kind: 'mcp-client',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      displayName: 'Filesystem',
    });
    assert.equal(result.valid, true);
  });

  it('rejects namespace with underscores', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    const result = validateWorkspacePayload({
      displayName: 'Test',
      namespace: 'my_workspace',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('namespace')));
  });

  it('rejects namespace with uppercase', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    const result = validateWorkspacePayload({
      displayName: 'Test',
      namespace: 'MyWorkspace',
    });
    assert.equal(result.valid, false);
  });

  it('rejects self-referencing mcp-client URL', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    const result = validateWorkspacePayload(
      {
        kind: 'mcp-client',
        transport: 'http',
        url: 'http://localhost:3100/mcp',
        displayName: 'Self',
      },
      { serverUrl: 'http://localhost:3100' }
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('circular')));
  });

  it('rejects invalid transport for mcp-client', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    const result = validateWorkspacePayload({
      kind: 'mcp-client',
      transport: 'websocket',
      displayName: 'Bad',
    });
    assert.equal(result.valid, false);
  });

  it('returns valid for null/non-object body', async () => {
    ({ validateWorkspacePayload } = await import('../server/workspace-schema.js'));
    assert.equal(validateWorkspacePayload(null).valid, false);
    assert.equal(validateWorkspacePayload('string').valid, false);
  });
});
