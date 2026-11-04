/**
 * toolFilter changes must take effect for tools/call immediately — not only
 * after the next tools/list rebuilds the name → workspace reverse map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../server/tool-registry.js';

function makeWm() {
  const ws = {
    id: 'http-m365', kind: 'mcp-client', provider: 'http', namespace: 'm365',
    displayName: 'M365', transport: 'http', enabled: true,
    toolFilter: { mode: 'all', enabled: [] },
  };
  const provider = {
    getTools: () => [
      { name: 'me_get_profile', description: 'read', readOnly: true },
      { name: 'mail_send', description: 'write', readOnly: false },
    ],
  };
  return {
    ws,
    getEnabledWorkspaces: () => (ws.enabled ? [ws] : []),
    getProvider: () => provider,
    getCapability: () => null,
  };
}

test('filter change + bumpVersion: excluded tool no longer resolves', async () => {
  const wm = makeWm();
  const tr = new ToolRegistry(wm);
  await tr.getTools();
  assert.ok(await tr.resolve('http_m365__mail_send'));
  wm.ws.toolFilter = { mode: 'include', enabled: ['me_get_profile'] };
  tr.bumpVersion();
  assert.equal(await tr.resolve('http_m365__mail_send'), null);
  assert.ok(await tr.resolve('http_m365__me_get_profile'));
});

test('filter change without bumpVersion: resolve re-checks live config', async () => {
  const wm = makeWm();
  const tr = new ToolRegistry(wm);
  await tr.getTools();
  wm.ws.toolFilter = { mode: 'include', enabled: ['me_get_profile'] };
  assert.equal(await tr.resolve('http_m365__mail_send'), null);
});

test('disabled workspace: cached names stop resolving', async () => {
  const wm = makeWm();
  const tr = new ToolRegistry(wm);
  await tr.getTools();
  wm.ws.enabled = false;
  assert.equal(await tr.resolve('http_m365__me_get_profile'), null);
  assert.deepEqual(await tr.resolve('bifrost__list_workspaces'), { type: 'meta', toolName: 'bifrost__list_workspaces' });
});
