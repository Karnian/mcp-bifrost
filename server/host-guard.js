/**
 * Host / Origin guard — DNS-rebinding defense.
 *
 * MCP 2025-03-26 (Streamable HTTP, "Security Warning") requires servers to
 * validate the Origin header. Bearer auth alone does not cover setups where
 * the admin token is unset (loopback peer + rebinding = admin access), and
 * same-origin GETs carry no Origin, so admin paths also check Host.
 *
 * Host (destination): a rebinding attack always arrives with the attacker's
 * DNS *name*, and an IP literal cannot be rebound, so any IP literal is fine.
 * Origin (source) is different: a page served from an attacker's IP is still
 * a foreign site (CSRF via text/plain POST needs no preflight). So Origin IPs
 * must be loopback or one of this machine's own interface addresses.
 * Names, for both, must be localhost, this machine's hostname, the public URL
 * host, or listed in BIFROST_ALLOWED_HOSTS.
 *
 * Env:
 *   BIFROST_ALLOWED_HOSTS   comma-separated extra hostnames (no port), or "*" to disable checks
 *   BIFROST_ALLOWED_ORIGINS comma-separated extra origins (scheme://host[:port]), or "*"
 *   BIFROST_CORS_ORIGIN     origins listed here are accepted as well
 */
import { isIP } from 'node:net';
import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from 'node:os';

function splitList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * IPv4-mapped IPv6 → dotted IPv4. WHATWG URL normalizes "[::ffff:127.0.0.1]"
 * to "::ffff:7f00:1", so both spellings are handled.
 */
export function unmapIpv4(ip) {
  const m = /^::ffff:(.+)$/.exec(ip);
  if (!m) return ip;
  if (m[1].includes('.')) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(m[1]);
  if (!hex) return ip;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Extract a lowercase hostname (IPv6 without brackets) from a Host header value. */
export function hostnameFromHostHeader(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const h = new URL(`http://${value}`).hostname.toLowerCase();
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {() => (string|null)} [opts.getPublicOrigin] canonical public origin, if any
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {() => string} [opts.getHostname]
 */
export function createHostGuard({
  getPublicOrigin = () => null,
  env = process.env,
  getHostname = osHostname,
  getNetworkInterfaces = osNetworkInterfaces,
} = {}) {
  function isOwnIp(ip) {
    const v = unmapIpv4(ip.toLowerCase());
    if (v === '::1' || /^127\./.test(v)) return true;
    try {
      for (const list of Object.values(getNetworkInterfaces() || {})) {
        for (const a of list || []) {
          if (String(a.address).toLowerCase() === v) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  function allowedNames() {
    const names = new Set(['localhost']);
    try { const h = getHostname(); if (h) names.add(h.toLowerCase()); } catch { /* ignore */ }
    try {
      const pub = getPublicOrigin();
      if (pub) names.add(new URL(pub).hostname.toLowerCase());
    } catch { /* ignore */ }
    for (const h of splitList(env.BIFROST_ALLOWED_HOSTS)) names.add(h.toLowerCase());
    return names;
  }

  function nameAllowed(hostname, { anyIp }) {
    if (!hostname) return false;
    if (isIP(hostname)) return anyIp || isOwnIp(hostname);
    if (hostname.endsWith('.localhost')) return true; // RFC 6761 — always loopback
    return allowedNames().has(hostname);
  }

  function hostAllowed(hostHeader) {
    if (splitList(env.BIFROST_ALLOWED_HOSTS).includes('*')) return true;
    return nameAllowed(hostnameFromHostHeader(hostHeader), { anyIp: true });
  }

  /** Requests without Origin (CLI / server-to-server clients) are allowed. */
  function originAllowed(originHeader) {
    if (originHeader === undefined) return true;
    const extra = [...splitList(env.BIFROST_ALLOWED_ORIGINS), ...splitList(env.BIFROST_CORS_ORIGIN)];
    if (extra.includes('*')) return true;
    if (typeof originHeader !== 'string' || originHeader === 'null') return false;
    if (extra.includes(originHeader)) return true;
    let parsed;
    try { parsed = new URL(originHeader); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (splitList(env.BIFROST_ALLOWED_HOSTS).includes('*')) return true;
    const h = parsed.hostname.toLowerCase();
    return nameAllowed(h.startsWith('[') ? h.slice(1, -1) : h, { anyIp: false });
  }

  return { hostAllowed, originAllowed };
}
