/**
 * Phase 12-2 — BIFROST_PUBLIC_URL canonical resolver.
 *
 * Coverage (plan §4.0 + §6 redirect_uri):
 *   - missing env → throw
 *   - HTTP non-localhost → reject
 *   - HTTPS / localhost loopback / IPv6 loopback → accept
 *   - trailing slash strip via URL.origin
 *   - reject when path / query / fragment present
 *   - manifest download / authorize / callback all use same redirect_uri
 *   - getPublicOriginOrNull never throws
 *   - describePublicOrigin reports {configured,valid,reason}
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPublicOrigin,
  getPublicOriginOrNull,
  getSlackRedirectUri,
  getSlackManifestRedirect,
  describePublicOrigin,
  setPublicOriginProvider,
  validatePublicOrigin,
  PUBLIC_ORIGIN_ENV_VAR,
  SLACK_OAUTH_CALLBACK_PATH,
} from '../server/public-origin.js';

function withEnv(value, fn) {
  const prev = process.env[PUBLIC_ORIGIN_ENV_VAR];
  if (value === undefined) delete process.env[PUBLIC_ORIGIN_ENV_VAR];
  else process.env[PUBLIC_ORIGIN_ENV_VAR] = value;
  // Reset file provider so test cases can fully isolate the env path
  // unless they explicitly set their own provider.
  setPublicOriginProvider(null);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[PUBLIC_ORIGIN_ENV_VAR];
    else process.env[PUBLIC_ORIGIN_ENV_VAR] = prev;
    setPublicOriginProvider(null);
  }
}

function withFile(value, fn) {
  setPublicOriginProvider(() => value);
  try { return fn(); } finally { setPublicOriginProvider(null); }
}

test('getPublicOrigin: missing env falls back to localhost (UX 개선)', () => {
  withEnv(undefined, () => {
    // Phase 12 (UX 개선): env 미설정은 더 이상 throw 가 아님.
    // localhost fallback 으로 동작 (file provider 도 비어 있을 때).
    const origin = getPublicOrigin();
    assert.match(origin, /^http:\/\/localhost:\d+$/);
  });
});

test('getPublicOrigin: empty string treated as missing → localhost fallback', () => {
  withEnv('   ', () => {
    const origin = getPublicOrigin();
    assert.match(origin, /^http:\/\/localhost:\d+$/);
  });
});

test('getPublicOrigin: http on non-loopback rejected (PUBLIC_ORIGIN_NOT_HTTPS)', () => {
  withEnv('http://bifrost.example.com', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS');
  });
});

test('getPublicOrigin: https accepted (canonical origin returned)', () => {
  withEnv('https://bifrost.example.com', () => {
    assert.equal(getPublicOrigin(), 'https://bifrost.example.com');
  });
});

test('getPublicOrigin: trailing slash stripped', () => {
  withEnv('https://bifrost.example.com/', () => {
    assert.equal(getPublicOrigin(), 'https://bifrost.example.com');
  });
});

test('getPublicOrigin: localhost loopback accepted on HTTP (dev)', () => {
  withEnv('http://localhost:3100', () => {
    assert.equal(getPublicOrigin(), 'http://localhost:3100');
  });
});

test('getPublicOrigin: 127.0.0.1 loopback accepted on HTTP', () => {
  withEnv('http://127.0.0.1:3100', () => {
    assert.equal(getPublicOrigin(), 'http://127.0.0.1:3100');
  });
});

test('getPublicOrigin: IPv6 loopback accepted on HTTP', () => {
  withEnv('http://[::1]:3100', () => {
    assert.equal(getPublicOrigin(), 'http://[::1]:3100');
  });
});

// Codex 12-2 round 2 regression — non-HTTP/HTTPS protocols must be rejected
// even on loopback. The previous "any-protocol if loopback" rule advertised
// origins like ftp://localhost via the manifest, which Slack cannot redirect to.
test('getPublicOrigin: ftp on loopback rejected (non-HTTP protocol)', () => {
  withEnv('ftp://localhost:21', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS');
  });
});

test('getPublicOrigin: ws on loopback rejected (non-HTTP protocol)', () => {
  withEnv('ws://127.0.0.1:3100', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS');
  });
});

test('getPublicOrigin: ftp on IPv6 loopback rejected', () => {
  withEnv('ftp://[::1]:21', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS');
  });
});

test('getPublicOrigin: path included → PUBLIC_ORIGIN_HAS_PATH', () => {
  withEnv('https://bifrost.example.com/admin', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_HAS_PATH');
  });
});

test('getPublicOrigin: query included → PUBLIC_ORIGIN_HAS_QUERY', () => {
  withEnv('https://bifrost.example.com?x=1', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_HAS_QUERY');
  });
});

test('getPublicOrigin: fragment included → PUBLIC_ORIGIN_HAS_QUERY', () => {
  withEnv('https://bifrost.example.com#x', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_HAS_QUERY');
  });
});

test('getPublicOrigin: malformed URL → PUBLIC_ORIGIN_INVALID', () => {
  withEnv('not a url', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_INVALID');
  });
});

test('getPublicOriginOrNull: invalid env still returns null (no throw)', () => {
  withEnv('http://bifrost.example.com', () => {
    assert.equal(getPublicOriginOrNull(), null);
  });
});

test('getPublicOriginOrNull: missing env returns localhost fallback (UX 개선)', () => {
  withEnv(undefined, () => {
    const v = getPublicOriginOrNull();
    assert.match(v, /^http:\/\/localhost:\d+$/);
  });
});

test('getPublicOriginOrNull: returns canonical origin on success', () => {
  withEnv('https://bifrost.example.com/', () => {
    assert.equal(getPublicOriginOrNull(), 'https://bifrost.example.com');
  });
});

test('getSlackRedirectUri: origin + canonical callback path', () => {
  withEnv('https://bifrost.example.com', () => {
    assert.equal(getSlackRedirectUri(), 'https://bifrost.example.com/oauth/slack/callback');
  });
});

test('getSlackRedirectUri: matches getSlackManifestRedirect (single source of truth)', () => {
  withEnv('https://bifrost.example.com', () => {
    assert.equal(getSlackRedirectUri(), getSlackManifestRedirect());
  });
});

test('SLACK_OAUTH_CALLBACK_PATH: contract', () => {
  assert.equal(SLACK_OAUTH_CALLBACK_PATH, '/oauth/slack/callback');
});

test('describePublicOrigin: missing env + no file → source=default + localhost fallback', () => {
  withEnv(undefined, () => {
    const d = describePublicOrigin();
    assert.equal(d.configured, false);
    assert.equal(d.source, 'default');
    assert.equal(d.valid, true);
    assert.equal(d.reason, 'dev-fallback');
    assert.match(d.origin, /^http:\/\/localhost:\d+$/);
    assert.ok(d.message);
  });
});

test('describePublicOrigin: valid HTTPS env reports source=env', () => {
  withEnv('https://bifrost.example.com', () => {
    const d = describePublicOrigin();
    assert.equal(d.configured, true);
    assert.equal(d.source, 'env');
    assert.equal(d.valid, true);
    assert.equal(d.origin, 'https://bifrost.example.com');
  });
});

test('describePublicOrigin: invalid HTTP env reports source=env + invalid', () => {
  withEnv('http://bifrost.example.com', () => {
    const d = describePublicOrigin();
    assert.equal(d.configured, true);
    assert.equal(d.source, 'env');
    assert.equal(d.valid, false);
    assert.equal(d.reason, 'PUBLIC_ORIGIN_NOT_HTTPS');
    assert.ok(d.message.includes('HTTPS'));
  });
});

// ─── file provider (Admin UI 저장값) ─────────────────────────────────

test('resolution chain: env > file > localhost fallback', () => {
  // file 만 있으면 file 사용
  withEnv(undefined, () => {
    withFile('https://from-file.test', () => {
      assert.equal(getPublicOrigin(), 'https://from-file.test');
      const d = describePublicOrigin();
      assert.equal(d.source, 'file');
      assert.equal(d.origin, 'https://from-file.test');
    });
  });
  // env + file 둘 다 있으면 env 우선
  withEnv('https://from-env.test', () => {
    withFile('https://from-file.test', () => {
      assert.equal(getPublicOrigin(), 'https://from-env.test');
      const d = describePublicOrigin();
      assert.equal(d.source, 'env');
    });
  });
  // env 무효 + file 유효 → env 가 throw 한다 (env 가 우선이므로 file fallback 안 함)
  withEnv('http://bad.test', () => {
    withFile('https://from-file.test', () => {
      assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS');
      const d = describePublicOrigin();
      assert.equal(d.source, 'env');
      assert.equal(d.valid, false);
    });
  });
  // 둘 다 없으면 default
  withEnv(undefined, () => {
    const origin = getPublicOrigin();
    assert.match(origin, /^http:\/\/localhost:\d+$/);
    const d = describePublicOrigin();
    assert.equal(d.source, 'default');
    assert.equal(d.reason, 'dev-fallback');
  });
});

test('file provider: invalid value throws PUBLIC_ORIGIN_*', () => {
  withEnv(undefined, () => {
    withFile('http://bad-non-loopback.test', () => {
      assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS');
      const d = describePublicOrigin();
      assert.equal(d.source, 'file');
      assert.equal(d.valid, false);
    });
  });
});

test('validatePublicOrigin: same rules as getPublicOrigin', () => {
  // Re-uses the same validator so file save path can pre-validate.
  assert.equal(validatePublicOrigin('https://x.test/'), 'https://x.test');
  assert.throws(() => validatePublicOrigin('http://x.test'), err => err.code === 'PUBLIC_ORIGIN_NOT_HTTPS');
  assert.throws(() => validatePublicOrigin('https://x.test/admin'), err => err.code === 'PUBLIC_ORIGIN_HAS_PATH');
  assert.equal(validatePublicOrigin('http://localhost:3100'), 'http://localhost:3100');
});

test('BIFROST_PORT env tunes localhost fallback', () => {
  withEnv(undefined, () => {
    const prev = process.env.BIFROST_PORT;
    process.env.BIFROST_PORT = '4567';
    try {
      assert.equal(getPublicOrigin(), 'http://localhost:4567');
    } finally {
      if (prev === undefined) delete process.env.BIFROST_PORT;
      else process.env.BIFROST_PORT = prev;
    }
  });
});

test('redirect_uri stable across repeated calls (canonicalization)', () => {
  // The same env should produce the same redirect URI deterministically —
  // /authorize, callback dispatch, manifest download all need to compare
  // string-equal.
  withEnv('https://bifrost.example.com/', () => {
    const a = getSlackRedirectUri();
    const b = getSlackRedirectUri();
    assert.equal(a, b);
    assert.equal(a, 'https://bifrost.example.com/oauth/slack/callback');
  });
});
