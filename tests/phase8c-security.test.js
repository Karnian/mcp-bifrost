/**
 * Phase 8c — 보안 보강 테스트
 * timingSafeEqual (admin auth + oauth state), rate limiter, CSP nonce
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. Admin auth timingSafeEqual ───

describe('Admin auth timingSafeEqual', () => {
  it('authenticates with correct token', async () => {
    const { authenticateAdmin, sendJson } = await import('../admin/auth.js');
    const wm = { getAdminToken: () => 'secret-token-123' };
    let statusCode;
    const res = {
      writeHead: (code) => { statusCode = code; },
      end: () => {},
    };
    const req = {
      headers: { authorization: 'Bearer secret-token-123' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const result = authenticateAdmin(req, res, wm);
    assert.equal(result, true);
  });

  it('rejects with wrong token', async () => {
    const { authenticateAdmin } = await import('../admin/auth.js');
    const wm = { getAdminToken: () => 'secret-token-123' };
    let statusCode;
    const res = {
      writeHead: (code) => { statusCode = code; },
      end: () => {},
    };
    const req = {
      headers: { authorization: 'Bearer wrong-token' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const result = authenticateAdmin(req, res, wm);
    assert.equal(result, false);
    assert.equal(statusCode, 403);
  });
});

// ─── 2. Rate Limiter ───

describe('RateLimiter', () => {
  it('allows requests within limit', async () => {
    const { RateLimiter } = await import('../server/rate-limiter.js');
    const rl = new RateLimiter({ max: 5, windowMs: 60_000 });
    try {
      for (let i = 0; i < 5; i++) {
        const result = rl.check('127.0.0.1');
        assert.equal(result.allowed, true);
      }
    } finally {
      rl.destroy();
    }
  });

  it('blocks after exceeding limit with retryAfterMs', async () => {
    const { RateLimiter } = await import('../server/rate-limiter.js');
    const rl = new RateLimiter({ max: 3, windowMs: 60_000 });
    try {
      for (let i = 0; i < 3; i++) rl.check('127.0.0.1');
      const blocked = rl.check('127.0.0.1');
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.remaining, 0);
      assert.ok(blocked.retryAfterMs > 0);
    } finally {
      rl.destroy();
    }
  });

  it('tracks IPs independently', async () => {
    const { RateLimiter } = await import('../server/rate-limiter.js');
    const rl = new RateLimiter({ max: 2, windowMs: 60_000 });
    try {
      rl.check('1.1.1.1');
      rl.check('1.1.1.1');
      const blocked = rl.check('1.1.1.1');
      assert.equal(blocked.allowed, false);
      // Different IP is still allowed
      const other = rl.check('2.2.2.2');
      assert.equal(other.allowed, true);
    } finally {
      rl.destroy();
    }
  });
});

// ─── 3. OAuth state timingSafeEqual ───

describe('OAuth state HMAC timingSafeEqual', () => {
  it('rejects tampered state signature', async () => {
    const { OAuthManager } = await import('../server/oauth-manager.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmpDir = await mkdtemp(join(tmpdir(), 'bifrost-8c-'));
    try {
      const mockWm = { _getRawWorkspace: () => null, getServerConfig: () => ({ port: 3100 }), logAudit: () => {} };
      const oauth = new OAuthManager(mockWm, { stateDir: tmpDir });
      // Generate a valid state
      const signed = await oauth._signState({ test: true });
      // Tamper with signature
      const [body, sig] = signed.split('.');
      const tampered = `${body}.${sig.slice(0, -1)}X`;
      const result = await oauth._verifyState(tampered);
      assert.equal(result, null, 'tampered state should be rejected');
      // Valid one should pass
      const valid = await oauth._verifyState(signed);
      assert.deepEqual(valid, { test: true });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 4. CSP nonce in OAuth callback ───

describe('OAuth callback CSP headers', () => {
  it('renderOAuthResultPage includes nonce in script tag', async () => {
    const { renderOAuthResultPage } = await import('../server/index.js');
    const html = renderOAuthResultPage({
      ok: true,
      title: 'Test',
      message: 'OK',
      nonce: 'abc123',
    });
    assert.ok(html.includes('nonce="abc123"'), 'script tag should have nonce attribute');
  });
});
