#!/usr/bin/env node
/**
 * Probe each Remote MCP template URL to confirm it is reachable and responds
 * with either 401 (unauthorized — expected before auth) or a proper WWW-Authenticate
 * header pointing at an RFC 9728 resource metadata document.
 *
 * Run manually: `node scripts/probe-templates.mjs`
 * Records results in docs/TEMPLATES_PROBE.md (manual paste).
 */
import { TEMPLATES } from '../admin/public/templates.js';

const remoteTemplates = TEMPLATES.filter(t => t.kind === 'mcp-client' && t.transport === 'http' && t.oauth && t.url);

console.log(`# Probing ${remoteTemplates.length} remote MCP templates`);
console.log(`# Time: ${new Date().toISOString()}`);
console.log();

for (const t of remoteTemplates) {
  console.log(`--- ${t.id} (${t.url}) ---`);
  try {
    const res = await fetch(t.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bifrost-probe', version: '0.1.0' } } }),
    });
    const www = res.headers.get('www-authenticate');
    const ctype = res.headers.get('content-type');
    console.log(`status: ${res.status}`);
    console.log(`content-type: ${ctype}`);
    console.log(`www-authenticate: ${www || '(none)'}`);
    const body = await res.text();
    console.log(`body (first 200): ${body.slice(0, 200).replace(/\n/g, ' ')}`);
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
  console.log();
}
