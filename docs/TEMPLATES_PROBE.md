# Remote MCP Templates — Probe Log

This file records results from `scripts/probe-templates.mjs`. Re-run after
any template URL change and paste the output below with a timestamp.

## Why

Phase 7f added `github-oauth`, `linear-oauth`, and `google-drive-oauth`
templates with hardcoded URLs. Hosts may change, so before a release we
probe each endpoint and confirm:

1. It is reachable (not 404/5xx).
2. Unauthenticated POST returns 401 with an RFC 6750 `WWW-Authenticate`
   header carrying an RFC 9728 `resource_metadata=` parameter — this is
   what `OAuthManager.discover()` uses.
3. Content-type is JSON when possible; `text/plain` is tolerated when
   only the header matters (GitHub returns plain-text error bodies but
   still carries a valid `WWW-Authenticate` header).

If any probe fails, either the template URL needs updating or the host
is temporarily down; record both cases below.

## Current Templates

| id | URL | Source |
|----|-----|--------|
| github-oauth | `https://api.githubcopilot.com/mcp/` | GitHub Copilot MCP public preview (2025) |
| linear-oauth | `https://mcp.linear.app/mcp` | Linear official docs |
| google-drive-oauth | `(stub — user provides)` | URL not yet public |
| notion-official-oauth | `https://mcp.notion.com/mcp` | Phase 6-pre (already probed, see NOTION_MCP_PROBE.md) |

## Last Probe

Run `node scripts/probe-templates.mjs` and paste output below.

### 2026-04-15 (Phase 7f — actual probe run)

`node scripts/probe-templates.mjs` output:

```
--- github-oauth (https://api.githubcopilot.com/mcp/) ---
status: 401
content-type: text/plain; charset=utf-8
www-authenticate: Bearer error="invalid_request",
  error_description="No access token was provided in this request",
  resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"
body: bad request: missing required Authorization header

--- linear-oauth (https://mcp.linear.app/mcp) ---
status: 401
content-type: application/json
www-authenticate: Bearer realm="OAuth",
  resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource",
  error="invalid_token", error_description="Missing or invalid access token"
body: {"error":"invalid_token","error_description":"Missing or invalid access token"}

--- notion-official-oauth (https://mcp.notion.com/mcp) ---
status: 401
content-type: application/json
www-authenticate: Bearer realm="OAuth",
  resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
  error="invalid_token", error_description="Missing or invalid access token"
body: {"error":"invalid_token","error_description":"Missing or invalid access token"}
```

Analysis:
- All three reachable hosts return `401 + WWW-Authenticate: Bearer` with
  a valid `resource_metadata=` URL (RFC 9728). `OAuthManager.discover()`
  will follow these correctly.
- `github-oauth` returns `text/plain` body (not JSON) for the error; our
  client only uses the header, not the body, so this is harmless.
- `google-drive-oauth` is stub (URL blank) and intentionally not probed.

Re-run this probe before any release and replace the block above. If a
host returns non-401 or drops `resource_metadata`, open an issue and
update `admin/public/templates.js`.
