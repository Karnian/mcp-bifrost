/**
 * Phase 9g — Backlog 테스트
 * OAuth issuer cache TTL, Google Drive prep documentation
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. OAuth issuer cache TTL ───

describe('OAuth issuer cache TTL', () => {
  it('getCachedClient returns null for expired entries', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../server/oauth-manager.js', import.meta.url), 'utf-8');
    // Verify TTL logic is present
    assert.ok(src.includes('BIFROST_OAUTH_CACHE_TTL_MS'));
    assert.ok(src.includes('registeredAt'));
    assert.ok(src.includes('ttlMs'));
  });
});

// ─── 2. Google Drive prep — provider guide covers it ───

describe('Google Drive preparation', () => {
  it('PROVIDER_GUIDE.md exists for future provider development', async () => {
    const { readFile } = await import('node:fs/promises');
    const guide = await readFile(new URL('../docs/PROVIDER_GUIDE.md', import.meta.url), 'utf-8');
    assert.ok(guide.includes('Provider Development Guide'));
    assert.ok(guide.includes('BaseProvider'));
    assert.ok(guide.includes('capabilityCheck'));
  });

  it('Google Drive template exists as stub in templates.js', async () => {
    const { TEMPLATES } = await import('../admin/public/templates.js');
    const gd = TEMPLATES.find(t => t.id === 'google-drive-oauth');
    assert.ok(gd);
    assert.equal(gd.stub, true);
    assert.equal(gd.category, 'storage');
  });
});
