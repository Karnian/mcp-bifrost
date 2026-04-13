#!/usr/bin/env node

/**
 * Cloudflare Tunnel integration for Bifrost.
 * Exposes MCP and SSE endpoints via public HTTPS URL.
 * Usage: node scripts/tunnel.js [--fixed-domain <domain>]
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'workspaces.json');

async function getConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { server: { port: 3100 }, tunnel: {} };
  }
}

async function generateMcpJson(tunnelUrl) {
  const mcpJson = {
    mcpServers: {
      bifrost: {
        url: `${tunnelUrl}/mcp`,
      },
    },
  };

  // Add auth header if MCP token is configured
  if (process.env.BIFROST_MCP_TOKEN) {
    mcpJson.mcpServers.bifrost.headers = {
      Authorization: `Bearer ${process.env.BIFROST_MCP_TOKEN}`,
    };
  }

  const outPath = join(__dirname, '..', '.mcp.json');
  await writeFile(outPath, JSON.stringify(mcpJson, null, 2), 'utf-8');
  console.log(`[Tunnel] Generated .mcp.json at ${outPath}`);
  return mcpJson;
}

async function main() {
  const config = await getConfig();
  const port = config.server?.port || 3100;
  const fixedDomain = config.tunnel?.fixedDomain
    || process.argv.find((a, i) => process.argv[i - 1] === '--fixed-domain')
    || '';

  const args = ['tunnel', '--url', `http://localhost:${port}`];
  if (fixedDomain) {
    args.push('--hostname', fixedDomain);
  }

  console.log(`[Tunnel] Starting Cloudflare Tunnel for localhost:${port}...`);
  if (fixedDomain) {
    console.log(`[Tunnel] Fixed domain: ${fixedDomain}`);
  }

  // Check if cloudflared is available
  const cloudflared = spawn('cloudflared', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tunnelUrl = '';

  cloudflared.stderr.on('data', (data) => {
    const line = data.toString();
    process.stderr.write(line);

    // Extract tunnel URL from cloudflared output
    const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (urlMatch && !tunnelUrl) {
      tunnelUrl = urlMatch[0];
      console.log(`\n[Tunnel] Public URL: ${tunnelUrl}`);
      console.log(`[Tunnel] MCP endpoint: ${tunnelUrl}/mcp`);
      console.log(`[Tunnel] SSE endpoint: ${tunnelUrl}/sse`);
      console.log(`[Tunnel] Admin UI is NOT exposed (localhost only)`);
      console.log('');

      // Generate .mcp.json
      generateMcpJson(tunnelUrl).catch(console.error);
    }
  });

  cloudflared.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  cloudflared.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('[Tunnel] cloudflared not found. Install it:');
      console.error('  brew install cloudflare/cloudflare/cloudflared');
      console.error('  or: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation');
      process.exit(1);
    }
    console.error('[Tunnel] Error:', err.message);
    process.exit(1);
  });

  cloudflared.on('close', (code) => {
    console.log(`[Tunnel] cloudflared exited with code ${code}`);
    process.exit(code || 0);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Tunnel] Shutting down...');
    cloudflared.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    cloudflared.kill('SIGTERM');
  });
}

main().catch((err) => {
  console.error('[Tunnel] Fatal error:', err);
  process.exit(1);
});
