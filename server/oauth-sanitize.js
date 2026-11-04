/**
 * OAuth-related log sanitization.
 *
 * Redacts token-like substrings from error messages / audit text before they
 * reach the error log or console. Also provides tokenPrefix() for audit
 * metadata that records a masked identifier.
 */

const PATTERNS = [
  // Authorization: Bearer <token>
  { re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, repl: '$1***' },
  // Key-value pairs in URLs / form bodies
  { re: /(access_token=)[^&\s"'<>]+/gi, repl: '$1***' },
  { re: /(refresh_token=)[^&\s"'<>]+/gi, repl: '$1***' },
  { re: /(client_secret=)[^&\s"'<>]+/gi, repl: '$1***' },
  // client_id is not a secret, but raw IDs are kept out of logs/audit
  // (cf. maskClientId) — an AS may echo the request body in its errors.
  { re: /(client_id=)([^&\s"'<>]+)/gi, repl: (_, k, v) => k + maskId(v) },
  { re: /(code=)[A-Za-z0-9._\-~+/=]{12,}/g, repl: '$1***' },
  { re: /(code_verifier=)[^&\s"'<>]+/gi, repl: '$1***' },
  // JSON-style fields
  { re: /("access_token"\s*:\s*")[^"]+(")/gi, repl: '$1***$2' },
  { re: /("refresh_token"\s*:\s*")[^"]+(")/gi, repl: '$1***$2' },
  { re: /("client_secret"\s*:\s*")[^"]+(")/gi, repl: '$1***$2' },
  { re: /("client_id"\s*:\s*")([^"]+)(")/gi, repl: (_, a, v, b) => a + maskId(v) + b },
];

function maskId(v) {
  return v.length <= 8 ? '***' : `${v.slice(0, 4)}***${v.slice(-4)}`;
}

export function sanitize(input) {
  if (input == null) return input;
  let str = typeof input === 'string' ? input : String(input);
  for (const { re, repl } of PATTERNS) {
    str = str.replace(re, repl);
  }
  return str;
}

/**
 * Produce a compact masked identifier for an opaque token so it can be logged
 * for audit purposes without exposing the secret. Returns `null` if the token
 * is too short to mask safely.
 */
export function tokenPrefix(token) {
  if (!token || typeof token !== 'string') return null;
  if (token.length < 8) return '***';
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}
