/**
 * Security headers middleware.
 * Applies standard security headers to all HTTP responses.
 */

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0', // CSP is primary defense; legacy header disabled
};

/**
 * Apply security headers to a response.
 * HSTS is only added when trust proxy is enabled (implies HTTPS termination).
 * CORS headers are added when BIFROST_CORS_ORIGIN is set.
 * @param {ServerResponse} res
 * @param {IncomingMessage} [req] - needed for CORS origin check
 */
export function applySecurityHeaders(res, req) {
  for (const [key, value] of Object.entries(HEADERS)) {
    res.setHeader(key, value);
  }

  // HSTS — only when behind a TLS-terminating proxy
  if (process.env.BIFROST_TRUST_PROXY === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // CORS
  const allowedOrigin = process.env.BIFROST_CORS_ORIGIN;
  if (allowedOrigin && req) {
    const origin = req.headers['origin'];
    if (origin) {
      // Support comma-separated origins or wildcard
      const origins = allowedOrigin.split(',').map(s => s.trim());
      if (origins.includes('*') || origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
        res.setHeader('Access-Control-Max-Age', '86400');
      }
    }
  }
}
