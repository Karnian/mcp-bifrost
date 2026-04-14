/**
 * Admin authentication middleware.
 * - Admin API is localhost-only by default (even with Bearer token) for safety,
 *   because it can configure stdio commands (RCE surface).
 * - Set BIFROST_ADMIN_EXPOSE=1 to allow remote Admin API access.
 */
export function authenticateAdmin(req, res, wm) {
  // Admin exposure guard
  const allowRemote = process.env.BIFROST_ADMIN_EXPOSE === '1';
  if (!allowRemote && !isLocalRequest(req)) {
    sendJson(res, 403, {
      ok: false,
      error: {
        code: 'ADMIN_LOCAL_ONLY',
        message: 'Admin API is restricted to localhost. Set BIFROST_ADMIN_EXPOSE=1 to allow remote access.',
      },
    });
    return false;
  }

  const adminToken = wm.getAdminToken();
  if (!adminToken) {
    // No admin token configured — allow access (dev mode, localhost only due to above guard)
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

function isLocalRequest(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Check if a command is in the allowed list (if one is set).
 * BIFROST_ALLOWED_COMMANDS env = comma-separated list (e.g. "npx,node,uvx,python3")
 * Empty/unset = allow all.
 */
export function isCommandAllowed(command) {
  const allowList = process.env.BIFROST_ALLOWED_COMMANDS;
  if (!allowList) return true;
  const allowed = allowList.split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  // Match by basename (so /usr/bin/node and node both work)
  const cmdBase = command.split(/[\\/]/).pop();
  return allowed.some(a => a === command || a === cmdBase);
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
