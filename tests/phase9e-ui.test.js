/**
 * Phase 9e — Admin UI 개선 테스트
 * tool dry-run API, dark mode CSS, audit filter API (already exists)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. Tool dry-run API route exists ───

describe('Tool dry-run API', () => {
  it('route pattern exists in routes.js', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../admin/routes.js', import.meta.url), 'utf-8');
    assert.ok(src.includes('/tools/'));
    assert.ok(src.includes('TOOL_NOT_FOUND'));
    assert.ok(src.includes('callTool'));
  });
});

// ─── 2. Dark mode CSS ───

describe('Dark mode CSS', () => {
  it('style.css has dark mode variables', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../admin/public/style.css', import.meta.url), 'utf-8');
    assert.ok(css.includes('prefers-color-scheme: dark'));
    assert.ok(css.includes('data-theme'));
    assert.ok(css.includes('#0f172a')); // dark bg
    assert.ok(css.includes('#1e293b')); // dark surface
  });
});

// ─── 3. Audit filter API (already exists from Phase 7g) ───

describe('Audit filter API', () => {
  it('/api/audit supports action, identity, workspace filters', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../admin/routes.js', import.meta.url), 'utf-8');
    assert.ok(src.includes("searchParams.get('action')"));
    assert.ok(src.includes("searchParams.get('identity')"));
    assert.ok(src.includes("searchParams.get('workspace')"));
  });
});

// ─── 4. Template search (9c, verify integration) ───

describe('Template search integration', () => {
  it('searchTemplates available for UI', async () => {
    const { searchTemplates, TEMPLATE_CATEGORIES } = await import('../admin/public/templates.js');
    assert.ok(typeof searchTemplates === 'function');
    assert.ok(TEMPLATE_CATEGORIES.length >= 5);
  });
});
