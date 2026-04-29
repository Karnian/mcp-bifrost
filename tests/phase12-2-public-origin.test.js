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
  PUBLIC_ORIGIN_ENV_VAR,
  SLACK_OAUTH_CALLBACK_PATH,
} from '../server/public-origin.js';

function withEnv(value, fn) {
  const prev = process.env[PUBLIC_ORIGIN_ENV_VAR];
  if (value === undefined) delete process.env[PUBLIC_ORIGIN_ENV_VAR];
  else process.env[PUBLIC_ORIGIN_ENV_VAR] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[PUBLIC_ORIGIN_ENV_VAR];
    else process.env[PUBLIC_ORIGIN_ENV_VAR] = prev;
  }
}

test('getPublicOrigin: missing env throws PUBLIC_ORIGIN_MISSING', () => {
  withEnv(undefined, () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_MISSING');
  });
});

test('getPublicOrigin: empty string treated as missing', () => {
  withEnv('   ', () => {
    assert.throws(() => getPublicOrigin(), err => err.code === 'PUBLIC_ORIGIN_MISSING');
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

test('getPublicOriginOrNull: never throws on invalid', () => {
  withEnv('http://bifrost.example.com', () => {
    assert.equal(getPublicOriginOrNull(), null);
  });
  withEnv(undefined, () => {
    assert.equal(getPublicOriginOrNull(), null);
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

test('describePublicOrigin: missing env reports configured=false', () => {
  withEnv(undefined, () => {
    const d = describePublicOrigin();
    assert.equal(d.configured, false);
    assert.equal(d.valid, false);
    assert.equal(d.reason, 'missing');
    assert.equal(d.origin, null);
  });
});

test('describePublicOrigin: valid HTTPS reports {configured,valid}', () => {
  withEnv('https://bifrost.example.com', () => {
    const d = describePublicOrigin();
    assert.equal(d.configured, true);
    assert.equal(d.valid, true);
    assert.equal(d.origin, 'https://bifrost.example.com');
  });
});

test('describePublicOrigin: invalid HTTP reports reason + message', () => {
  withEnv('http://bifrost.example.com', () => {
    const d = describePublicOrigin();
    assert.equal(d.configured, true);
    assert.equal(d.valid, false);
    assert.equal(d.reason, 'PUBLIC_ORIGIN_NOT_HTTPS');
    assert.ok(d.message.includes('HTTPS'));
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
