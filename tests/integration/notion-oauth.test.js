/**
 * Real Notion OAuth integration test.
 *
 * SKIPPED unless `BIFROST_TEST_NOTION_OAUTH=1`.
 *
 * First run: requires manual authorize. Subsequent runs reuse
 * `BIFROST_TEST_NOTION_REFRESH_TOKEN` + `BIFROST_TEST_NOTION_CLIENT_ID` env
 * vars so CI can refresh access tokens without browser interaction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager } from '../../server/oauth-manager.js';

const ENABLED = process.env.BIFROST_TEST_NOTION_OAUTH === '1';
const NOTION_MCP_URL = process.env.BIFROST_TEST_NOTION_MCP_URL || 'https://mcp.notion.com/mcp';
const CLIENT_ID = process.env.BIFROST_TEST_NOTION_CLIENT_ID;
const REFRESH_TOKEN = process.env.BIFROST_TEST_NOTION_REFRESH_TOKEN;

function mockWm(workspaces = {}) {
  const map = new Map(Object.entries(workspaces));
  return {
    logAudit: () => {}, logError: () => {},
    _getRawWorkspace: (id) => map.get(id) || null,
    _save: async () => {},
    getServerConfig: () => ({ port: 3100 }),
  };
}

test('Notion discovery fetches real metadata', { skip: !ENABLED }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n-oauth-'));
  try {
    const mgr = new OAuthManager(mockWm(), { stateDir: dir });
    const disc = await mgr.discover(NOTION_MCP_URL);
    assert.ok(disc.issuer);
    assert.ok(disc.authServerMetadata.authorization_endpoint);
    assert.ok(disc.authServerMetadata.token_endpoint);
    assert.ok(disc.authServerMetadata.code_challenge_methods_supported?.includes('S256'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Notion refresh_token round-trips without user interaction', {
  skip: !ENABLED || !CLIENT_ID || !REFRESH_TOKEN,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n-oauth-'));
  try {
    const ws = {
      id: 'notion-real',
      oauth: {
        enabled: true,
        issuer: 'https://mcp.notion.com',
        clientId: CLIENT_ID,
        clientSecret: null,
        authMethod: 'none',
        resource: NOTION_MCP_URL,
        metadataCache: { token_endpoint: 'https://mcp.notion.com/token' },
        tokens: {
          accessToken: 'expired',
          refreshToken: REFRESH_TOKEN,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          tokenType: 'Bearer',
        },
      },
    };
    const mgr = new OAuthManager(mockWm({ 'notion-real': ws }), { stateDir: dir });
    const refreshed = await mgr.forceRefresh('notion-real');
    assert.ok(refreshed.accessToken);
    assert.notEqual(refreshed.accessToken, 'expired');

    // Use the new token to call /mcp
    const res = await fetch(NOTION_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${refreshed.accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bifrost-test', version: '0' },
      } }),
    });
    assert.ok(res.ok, `expected 2xx, got ${res.status}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
