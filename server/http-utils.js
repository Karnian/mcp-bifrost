/**
 * Shared HTTP utilities.
 * Extracted from server/index.js and admin/auth.js for DRY (Phase 8d #14).
 */

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB

/**
 * Read and parse JSON body from an HTTP request with size limit.
 * @param {IncomingMessage} req
 * @param {{ maxBytes?: number, allowEmpty?: boolean }} opts
 * @returns {Promise<any>}
 */
export function readBody(req, { maxBytes, allowEmpty = false } = {}) {
  const limit = maxBytes || parseInt(process.env.BIFROST_MAX_BODY || '', 10) || DEFAULT_MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', c => {
      if (rejected) return; // already rejected, drain remaining data
      totalBytes += c.length;
      if (totalBytes > limit) {
        rejected = true;
        // Resume reading to drain the request body (so the server can send a response),
        // but don't accumulate any more data.
        req.resume();
        reject(Object.assign(new Error('Payload Too Large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString();
        if (!text && allowEmpty) { resolve({}); return; }
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
