/**
 * Workspace configuration schema validation (Zod).
 * Applied at write-time (POST/PUT) only — existing configs load without validation
 * to avoid breaking on upgrade.
 */
import { z } from 'zod';

// Namespace must be lowercase alphanumeric + hyphens (no underscores to prevent
// tool/prompt naming collisions between workspaces)
const namespacePattern = /^[a-z0-9][a-z0-9-]*$/;

const credentialsSchema = z.record(z.string()).optional();

const baseWorkspaceSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  alias: z.string().max(100).optional(),
  namespace: z.string().regex(namespacePattern, 'Namespace must be lowercase alphanumeric + hyphens only').max(50).optional(),
  enabled: z.boolean().optional(),
  toolFilter: z.array(z.string().max(256)).optional(),
});

const nativeWorkspaceSchema = baseWorkspaceSchema.extend({
  kind: z.literal('native').optional(),
  provider: z.enum(['notion', 'slack']).optional(),
  credentials: credentialsSchema,
});

const mcpClientWorkspaceSchema = baseWorkspaceSchema.extend({
  kind: z.literal('mcp-client'),
  transport: z.enum(['stdio', 'http', 'sse']),
  // stdio fields
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(1000)).optional(),
  env: z.record(z.string()).optional(),
  // http/sse fields
  url: z.string().url().max(2000).optional(),
  headers: z.record(z.string()).optional(),
});

/**
 * Validate a workspace creation/update payload.
 * @param {object} body - the request body
 * @param {object} [options]
 * @param {string} [options.serverUrl] - this server's URL to detect self-reference
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validateWorkspacePayload(body, options = {}) {
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be an object'] };
  }

  const errors = [];

  // Schema validation
  const schema = body.kind === 'mcp-client' ? mcpClientWorkspaceSchema : nativeWorkspaceSchema;
  const result = schema.safeParse(body);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  // Self-reference check for mcp-client
  if (body.kind === 'mcp-client' && body.url && options.serverUrl) {
    const bodyUrl = body.url.replace(/\/$/, '');
    const selfUrl = options.serverUrl.replace(/\/$/, '');
    if (bodyUrl === selfUrl || bodyUrl.startsWith(selfUrl + '/')) {
      errors.push('url: mcp-client cannot point to this Bifrost server (circular reference)');
    }
  }

  // Glob pattern length check (toolFilter)
  if (Array.isArray(body.toolFilter)) {
    for (const pattern of body.toolFilter) {
      if (typeof pattern === 'string' && pattern.length > 256) {
        errors.push(`toolFilter: pattern exceeds 256 characters`);
      }
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
}
