import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('SseManager', () => {
  let SseManager;

  before(async () => {
    ({ SseManager } = await import('../server/sse-manager.js'));
  });

  it('should start with zero sessions', () => {
    const sse = new SseManager();
    assert.equal(sse.getSessionCount(), 0);
  });

  it('should create session with mock response', () => {
    const sse = new SseManager();
    const events = [];
    const mockRes = {
      writeHead: () => {},
      write: (data) => events.push(data),
      on: (ev, cb) => { if (ev === 'close') {} },
    };
    const sessionId = sse.createSession(mockRes);
    assert.ok(sessionId);
    assert.equal(sse.getSessionCount(), 1);
    // Should have sent endpoint event
    assert.ok(events.some(e => e.includes('endpoint')));
  });

  it('should send to specific session', () => {
    const sse = new SseManager();
    const events = [];
    const mockRes = {
      writeHead: () => {},
      write: (data) => events.push(data),
      on: (ev, cb) => { if (ev === 'close') {} },
    };
    const sessionId = sse.createSession(mockRes);
    const sent = sse.sendToSession(sessionId, { test: true });
    assert.ok(sent);
    assert.ok(events.some(e => e.includes('"test":true')));
  });

  it('should broadcast to all sessions', () => {
    const sse = new SseManager();
    const events1 = [];
    const events2 = [];
    const mock1 = { writeHead: () => {}, write: (d) => events1.push(d), on: () => {} };
    const mock2 = { writeHead: () => {}, write: (d) => events2.push(d), on: () => {} };
    sse.createSession(mock1);
    sse.createSession(mock2);
    sse.broadcast('message', { hello: true });
    assert.ok(events1.some(e => e.includes('hello')));
    assert.ok(events2.some(e => e.includes('hello')));
  });

  it('should broadcast notifications', () => {
    const sse = new SseManager();
    const events = [];
    const mockRes = { writeHead: () => {}, write: (d) => events.push(d), on: () => {} };
    sse.createSession(mockRes);
    sse.broadcastNotification('notifications/tools/list_changed');
    assert.ok(events.some(e => e.includes('list_changed')));
  });
});

describe('5-state status model', () => {
  let WorkspaceManager;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
  });

  it('should return limited when capabilityCheck has limited tools', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Limited', credentials: { token: 'x' } });
    // Simulate health OK
    wm.healthCache.set(ws.id, { ok: true, checkedAt: new Date().toISOString() });
    // Simulate capability with limited tool
    wm.capabilityCache.set(ws.id, {
      tools: [
        { name: 'search_pages', usable: 'usable' },
        { name: 'read_page', usable: 'limited', reason: 'Some pages not shared' },
      ],
    });
    const result = wm.getWorkspace(ws.id);
    assert.equal(result.status, 'limited');
  });

  it('should return healthy when all tools usable', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'All Good', credentials: { token: 'x' } });
    wm.healthCache.set(ws.id, { ok: true, checkedAt: new Date().toISOString() });
    wm.capabilityCache.set(ws.id, {
      tools: [
        { name: 'search_pages', usable: 'usable' },
        { name: 'read_page', usable: 'usable' },
      ],
    });
    const result = wm.getWorkspace(ws.id);
    assert.equal(result.status, 'healthy');
  });

  it('should return error when healthCheck fails', async () => {
    const wm = new WorkspaceManager();
    const ws = await wm.addWorkspace({ provider: 'notion', displayName: 'Error', credentials: { token: 'x' } });
    wm.healthCache.set(ws.id, { ok: false, message: 'Token invalid', checkedAt: new Date().toISOString() });
    const result = wm.getWorkspace(ws.id);
    assert.equal(result.status, 'error');
  });
});

describe('ToolRegistry with capabilityCheck integration', () => {
  let WorkspaceManager, ToolRegistry;

  before(async () => {
    ({ WorkspaceManager } = await import('../server/workspace-manager.js'));
    ({ ToolRegistry } = await import('../server/tool-registry.js'));
  });

  it('should bump version', () => {
    const wm = new WorkspaceManager();
    const tr = new ToolRegistry(wm);
    assert.equal(tr.toolsVersion, 1);
    tr.bumpVersion();
    assert.equal(tr.toolsVersion, 2);
  });
});
