import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostGuard, hostnameFromHostHeader, unmapIpv4 } from '../server/host-guard.js';

const IFACES = () => ({ lo: [{ address: '127.0.0.1' }], tailscale0: [{ address: '100.83.124.113' }, { address: 'fd7a:115c:a1e0::3733:7c72' }] });
const guard = (env = {}, extra = {}) => createHostGuard({ env, getHostname: () => 'codev2', getNetworkInterfaces: IFACES, ...extra });

test('hostnameFromHostHeader', () => {
  assert.equal(hostnameFromHostHeader('LocalHost:3100'), 'localhost');
  assert.equal(hostnameFromHostHeader('[::1]:3100'), '::1');
  assert.equal(hostnameFromHostHeader('['), null);
  assert.equal(hostnameFromHostHeader(undefined), null);
});

test('hostAllowed: IP literals, loopback names, own hostname, public URL, extras', () => {
  const g = guard({ BIFROST_ALLOWED_HOSTS: 'codev2.example.ts.net' }, { getPublicOrigin: () => 'https://bifrost.example.com' });
  for (const h of ['127.0.0.1:3100', '100.83.124.113:3100', '[::1]:3100', 'localhost:3100', 'foo.localhost', 'codev2:3100',
    'codev2.example.ts.net:3100', 'bifrost.example.com']) {
    assert.equal(g.hostAllowed(h), true, h);
  }
  for (const h of ['evil.example:3100', 'codev2.evil.example', '[', '', undefined]) {
    assert.equal(g.hostAllowed(h), false, String(h));
  }
  assert.equal(guard({ BIFROST_ALLOWED_HOSTS: '*' }).hostAllowed('evil.example'), true);
});

test('originAllowed: absent ok, null/foreign/non-http rejected, CORS + extras accepted', () => {
  const g = guard();
  assert.equal(g.originAllowed(undefined), true);
  assert.equal(g.originAllowed('http://localhost:3100'), true);
  assert.equal(g.originAllowed('http://codev2:3100'), true);
  assert.equal(g.originAllowed('http://[::1]:3100'), true);
  assert.equal(g.originAllowed('null'), false);
  assert.equal(g.originAllowed('http://evil.example'), false);
  assert.equal(g.originAllowed('chrome-extension://abc'), false);
  assert.equal(g.originAllowed('not a url'), false);
  assert.equal(guard({ BIFROST_CORS_ORIGIN: 'https://app.example.com' }).originAllowed('https://app.example.com'), true);
  assert.equal(guard({ BIFROST_ALLOWED_ORIGINS: 'https://claude.ai' }).originAllowed('https://claude.ai'), true);
  assert.equal(guard({ BIFROST_CORS_ORIGIN: '*' }).originAllowed('https://anything.example'), true);
});

test('originAllowed: IP origins only when loopback or own interface (CSRF from attacker IP)', () => {
  const g = guard();
  assert.equal(g.originAllowed('http://127.0.0.1:3100'), true);
  assert.equal(g.originAllowed('http://127.0.1.1:3100'), true);
  assert.equal(g.originAllowed('http://100.83.124.113:3100'), true);
  assert.equal(g.originAllowed('http://[fd7a:115c:a1e0::3733:7c72]:3100'), true);
  assert.equal(g.originAllowed('http://203.0.113.10'), false);
  assert.equal(g.originAllowed('http://[2001:db8::1]'), false);
  // Host (destination) still accepts any IP literal.
  assert.equal(g.hostAllowed('203.0.113.10:3100'), true);
});

test('IPv4-mapped loopback Origin (URL-normalized hex form) is accepted', () => {
  assert.equal(unmapIpv4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(unmapIpv4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(unmapIpv4('::1'), '::1');
  const g = guard();
  assert.equal(g.originAllowed('http://[::ffff:127.0.0.1]:3100'), true);
  assert.equal(g.originAllowed('http://[::ffff:cb00:710a]'), false); // 203.0.113.10
});
