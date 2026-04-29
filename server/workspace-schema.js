/**
 * Workspace configuration schema validation (Zod).
 * Applied at write-time (POST/PUT) only — existing configs load without validation
 * to avoid breaking on upgrade.
 */
import { z } from 'zod';

// Namespace must be lowercase alphanumeric + hyphens (no underscores to prevent
// tool/prompt naming collisions between workspaces)
const namespacePattern = /^[a-z0-9][a-z0-9-]*$/;

const credentialsSchema = z.record(z.string(), z.string()).optional();

const baseWorkspaceSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  alias: z.string().max(100).optional(),
  namespace: z.string().regex(namespacePattern, 'Namespace must be lowercase alphanumeric + hyphens only').max(50).optional(),
  enabled: z.boolean().optional(),
  toolFilter: z.array(z.string().max(256)).optional(),
});

// Phase 12 §3.3 — slackOAuth nested schema (provider=slack && authMode=oauth).
// expiresAt is ISO 8601 string (matches OAuthManager invariant — never a number).
const slackOAuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
  tokenType: z.literal('user'),
});

const slackOAuthSchema = z.object({
  team: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  authedUser: z.object({
    id: z.string().min(1),
    scopesGranted: z.array(z.string()).optional(),
  }).optional(),
  tokens: slackOAuthTokensSchema,
  status: z.enum(['active', 'action_needed']).default('active').optional(),
  lastRefreshedAt: z.string().optional(),
  issuedAt: z.string().optional(),
});

const nativeWorkspaceSchema = baseWorkspaceSchema.extend({
  kind: z.literal('native').optional(),
  provider: z.enum(['notion', 'slack']).optional(),
  authMode: z.enum(['token', 'oauth']).optional(),
  credentials: credentialsSchema,
  slackOAuth: slackOAuthSchema.optional(),
}).superRefine((data, ctx) => {
  // Phase 12 §3.3 — provider=slack && authMode=oauth → botToken is forbidden
  // and slackOAuth is required (batch validation per plan v5).
  if (data.provider === 'slack' && data.authMode === 'oauth') {
    if (data.credentials && data.credentials.botToken) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentials', 'botToken'],
        message: 'botToken not allowed when authMode=oauth',
      });
    }
    if (!data.slackOAuth) {
      ctx.addIssue({
        code: 'custom',
        path: ['slackOAuth'],
        message: 'slackOAuth required when authMode=oauth',
      });
    }
  }
  // authMode=oauth is only meaningful for slack in Phase 12.
  if (data.authMode === 'oauth' && data.provider !== 'slack') {
    ctx.addIssue({
      code: 'custom',
      path: ['authMode'],
      message: 'authMode=oauth only supported for provider=slack in Phase 12',
    });
  }
});

const mcpClientWorkspaceSchema = baseWorkspaceSchema.extend({
  kind: z.literal('mcp-client'),
  transport: z.enum(['stdio', 'http', 'sse']),
  // stdio fields
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(1000)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // http/sse fields
  url: z.string().url().max(2000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

// Phase 12 §3.1 — server-level slackApp schema (top-level, sibling to workspaces[]).
export const slackAppSchema = z.object({
  clientId: z.string().min(1).regex(/^\d+\.\d+$/, 'clientId must match Slack format <digits>.<digits>'),
  clientSecret: z.string().min(1),
  tokenRotationEnabled: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
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
  try {
    const result = schema.safeParse(body);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${issue.path.join('.')}: ${issue.message}`);
      }
    }
  } catch {
    // Zod internal error — treat as validation failure rather than crash
    errors.push('Schema validation failed (internal error)');
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

/**
 * Phase 12 §3.1 — validate a top-level slackApp credential payload.
 * @param {object} body
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validateSlackAppPayload(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be an object'] };
  }
  const result = slackAppSchema.safeParse(body);
  if (result.success) return { valid: true };
  return {
    valid: false,
    errors: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
  };
}
