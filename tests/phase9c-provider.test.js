/**
 * Phase 9c — Provider 확장 테스트
 * template categories, searchTemplates, Notion getPrompts, provider guide
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. Template categories and search ───

describe('Template system', () => {
  it('all templates have a category field', async () => {
    const { TEMPLATES } = await import('../admin/public/templates.js');
    for (const t of TEMPLATES) {
      assert.ok(t.category, `Template "${t.id}" missing category`);
    }
  });

  it('TEMPLATE_CATEGORIES includes all used categories', async () => {
    const { TEMPLATES, TEMPLATE_CATEGORIES } = await import('../admin/public/templates.js');
    const categoryIds = new Set(TEMPLATE_CATEGORIES.map(c => c.id));
    for (const t of TEMPLATES) {
      assert.ok(categoryIds.has(t.category), `Category "${t.category}" from template "${t.id}" not in TEMPLATE_CATEGORIES`);
    }
  });

  it('searchTemplates filters by category', async () => {
    const { searchTemplates } = await import('../admin/public/templates.js');
    const devTemplates = searchTemplates('', 'development');
    assert.ok(devTemplates.length > 0);
    assert.ok(devTemplates.every(t => t.category === 'development'));
  });

  it('searchTemplates filters by query string', async () => {
    const { searchTemplates } = await import('../admin/public/templates.js');
    const results = searchTemplates('notion');
    assert.ok(results.length > 0);
    assert.ok(results.every(t =>
      t.name.toLowerCase().includes('notion') ||
      t.description.toLowerCase().includes('notion') ||
      t.id.toLowerCase().includes('notion')
    ));
  });

  it('searchTemplates with category=all returns all templates', async () => {
    const { TEMPLATES, searchTemplates } = await import('../admin/public/templates.js');
    const results = searchTemplates('', 'all');
    assert.equal(results.length, TEMPLATES.length);
  });
});

// ─── 2. Notion provider getPrompts ───

describe('NotionProvider getPrompts', () => {
  it('returns search_and_summarize prompt', async () => {
    const { NotionProvider } = await import('../providers/notion.js');
    const p = new NotionProvider({
      id: 'notion-test',
      provider: 'notion',
      namespace: 'test',
      displayName: 'Test Notion',
      credentials: { token: 'ntn_test' },
    });
    const prompts = p.getPrompts();
    assert.ok(prompts.length > 0);
    assert.equal(prompts[0].name, 'search_and_summarize');
    assert.ok(prompts[0].arguments.length > 0);
  });

  it('getPromptMessages returns user message with query', async () => {
    const { NotionProvider } = await import('../providers/notion.js');
    const p = new NotionProvider({
      id: 'notion-test',
      provider: 'notion',
      namespace: 'test',
      displayName: 'Test Notion',
      credentials: { token: 'ntn_test' },
    });
    const messages = await p.getPromptMessages('search_and_summarize', { query: '회의록' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.ok(messages[0].content.text.includes('회의록'));
  });
});

// ─── 3. Provider guide exists ───

describe('Provider development guide', () => {
  it('docs/PROVIDER_GUIDE.md exists and has key sections', async () => {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(new URL('../docs/PROVIDER_GUIDE.md', import.meta.url), 'utf-8');
    assert.ok(content.includes('BaseProvider'));
    assert.ok(content.includes('getTools'));
    assert.ok(content.includes('callTool'));
    assert.ok(content.includes('healthCheck'));
    assert.ok(content.includes('capabilityCheck'));
    assert.ok(content.includes('getPrompts'));
    assert.ok(content.includes('Namespace'));
  });
});
