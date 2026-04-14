#!/usr/bin/env node
/**
 * Minimal stdio MCP server for testing.
 * Speaks MCP JSON-RPC via stdin/stdout.
 *
 * Supports:
 * - initialize
 * - tools/list (returns 2 mock tools: echo, add)
 * - tools/call (implements echo + add + fail_once + crash)
 * - ping
 *
 * Special tool names to trigger test scenarios:
 * - crash: exits process with code 1
 * - fail_once: fails on first call, succeeds after
 * - slow: sleeps 200ms before responding
 */

let callCount = {};

const tools = [
  {
    name: 'echo',
    description: 'Echo the input string back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'fail_once',
    description: 'Fails on first call, succeeds on retry',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crash',
    description: 'Crashes the server process',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Takes 200ms to respond',
    inputSchema: { type: 'object', properties: {} },
  },
];

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mock-mcp-server', version: '0.1.0' },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools });
    case 'tools/call': {
      const { name, arguments: args = {} } = params || {};
      callCount[name] = (callCount[name] || 0) + 1;
      switch (name) {
        case 'echo':
          return reply(id, { content: [{ type: 'text', text: String(args.message ?? '') }] });
        case 'add':
          return reply(id, { content: [{ type: 'text', text: String((args.a || 0) + (args.b || 0)) }] });
        case 'fail_once':
          if (callCount[name] === 1) {
            return reply(id, {
              content: [{ type: 'text', text: 'Transient failure' }],
              isError: true,
            });
          }
          return reply(id, { content: [{ type: 'text', text: 'ok' }] });
        case 'crash':
          process.exit(1);
          return;
        case 'slow':
          await new Promise((r) => setTimeout(r, 200));
          return reply(id, { content: [{ type: 'text', text: 'slow-ok' }] });
        default:
          return error(id, -32601, `Unknown tool: ${name}`);
      }
    }
    case 'notifications/initialized':
      return; // notification — no response
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line);
      handle(req).catch((err) => {
        if (req.id !== undefined) error(req.id, -32603, err.message);
      });
    } catch (err) {
      // parse error
    }
  }
});

process.stdin.on('end', () => process.exit(0));
