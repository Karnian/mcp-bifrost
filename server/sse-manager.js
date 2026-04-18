import { randomUUID } from 'node:crypto';

/**
 * SSE Session Manager — manages SSE connections for MCP protocol.
 * Handles session lifecycle, message routing, and notifications.
 */
export class SseManager {
  constructor() {
    this.sessions = new Map(); // sessionId → { res, createdAt }
  }

  createSession(res) {
    const sessionId = randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-SSE-Session-Id': sessionId,
    });

    // Send endpoint event so client knows where to POST messages
    this._sendEvent(res, 'endpoint', `/sse?sessionId=${sessionId}`);

    this.sessions.set(sessionId, { res, createdAt: new Date() });

    res.on('close', () => {
      this.sessions.delete(sessionId);
    });

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      if (this.sessions.has(sessionId)) {
        try {
          res.write(':ping\n\n');
        } catch {
          // Connection broken — clean up
          this.sessions.delete(sessionId);
          clearInterval(keepAlive);
        }
      } else {
        clearInterval(keepAlive);
      }
    }, 30000);
    keepAlive.unref(); // Don't prevent process exit

    return sessionId;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  sendToSession(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this._sendEvent(session.res, 'message', JSON.stringify(data));
    return true;
  }

  broadcast(eventName, data) {
    const payload = JSON.stringify(data);
    for (const [, session] of this.sessions) {
      this._sendEvent(session.res, eventName, payload);
    }
  }

  broadcastNotification(method, params = {}) {
    this.broadcast('message', {
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  getSessionCount() {
    return this.sessions.size;
  }

  _sendEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }
}
