/**
 * Phase 7f — Remote MCP template materialization tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, materializeTemplate } from '../admin/public/templates.js';

test('github-oauth template materializes to mcp-client/http payload with oauth.enabled', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'github-oauth');
  assert.ok(tmpl, 'github-oauth template must exist');
  assert.equal(tmpl.kind, 'mcp-client');
  assert.equal(tmpl.transport, 'http');
  assert.equal(tmpl.oauth, true);
  const payload = materializeTemplate(tmpl, { displayName: 'GH' });
  assert.equal(payload.kind, 'mcp-client');
  assert.equal(payload.transport, 'http');
  assert.equal(payload.url, 'https://api.githubcopilot.com/mcp/');
  assert.deepEqual(payload.oauth, { enabled: true });
});

test('linear-oauth template materializes with correct URL', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'linear-oauth');
  assert.ok(tmpl);
  const payload = materializeTemplate(tmpl, {});
  assert.equal(payload.url, 'https://mcp.linear.app/mcp');
  assert.deepEqual(payload.oauth, { enabled: true });
});

test('google-drive-oauth template is a stub — user-provided URL overrides', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'google-drive-oauth');
  assert.ok(tmpl);
  assert.equal(tmpl.stub, true);
  assert.equal(tmpl.url, '');
  const payload = materializeTemplate(tmpl, { url: 'https://drive.example/mcp' });
  assert.equal(payload.url, 'https://drive.example/mcp');
  assert.deepEqual(payload.oauth, { enabled: true });
});

test('notion-official-oauth still works (regression)', () => {
  const tmpl = TEMPLATES.find(t => t.id === 'notion-official-oauth');
  assert.ok(tmpl);
  const payload = materializeTemplate(tmpl, {});
  assert.equal(payload.url, 'https://mcp.notion.com/mcp');
  assert.deepEqual(payload.oauth, { enabled: true });
});

test('all remote-OAuth templates advertise transport=http + oauth=true', () => {
  const remote = TEMPLATES.filter(t => t.kind === 'mcp-client' && t.oauth);
  assert.ok(remote.length >= 4, `expected ≥4 remote OAuth templates, got ${remote.length}`);
  for (const t of remote) {
    assert.equal(t.transport, 'http', `${t.id} should be http transport`);
  }
});
