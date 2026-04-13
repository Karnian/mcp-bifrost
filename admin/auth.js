/**
 * Admin authentication middleware.
 * Validates Bearer token against BIFROST_ADMIN_TOKEN env or config fallback.
 */
export function authenticateAdmin(req, res, wm) {
  const adminToken = wm.getAdminToken();
  if (!adminToken) {
    // No admin token configured — allow access (dev mode)
    return true;
  }

  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Admin token required' } });
    return false;
  }

  const token = auth.slice(7);
  if (token !== adminToken) {
    sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '토큰이 일치하지 않습니다' } });
    return false;
  }

  return true;
}

export function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString();
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
