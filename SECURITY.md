# Security Policy

## Supported Versions

`mcp-bifrost` is a single-track project — only the latest commit on `main`
receives security fixes. Pin to a specific commit SHA for reproducible
deployments.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security reports.** Instead:

1. Open a private security advisory at
   <https://github.com/Karnian/mcp-bifrost/security/advisories/new>, or
2. Email **khh9201@naver.com** with the subject prefix `[security] mcp-bifrost`.

Include:

- Affected commit SHA / branch
- Reproduction steps or proof of concept
- Suggested remediation (optional)

You should expect an acknowledgement within **72 hours** and an initial
assessment within **7 days**. Coordinated disclosure timelines are arranged
case-by-case based on severity.

## Scope

In-scope (please report):

- Token / OAuth credential disclosure (logs, audit, masking bypass)
- Privilege escalation between MCP tokens / identities / profiles
- SSRF / RCE through provider config or admin endpoints
- Path traversal in `admin/` or `scripts/`
- Authentication bypass on `/admin/*`, `/api/*`, `/mcp`, `/sse`
- OAuth state / PKCE / DCR replay or downgrade attacks
- CI / release workflow compromise of this repository
- Dependency / package-lock integrity issues introduced by this repo
  (supply-chain — wrong override pin, tampered fixture, etc.)

Out of scope:

- Issues that require physical access to the operator's machine
- Issues only reproducible against unsupported Node versions (< 22)
- DoS via local resource exhaustion (process/thread limits, disk full)
- Anything in third-party MCP servers Bifrost merely proxies to —
  please report those upstream

## Hardening Checklist (Operators)

If you are running `mcp-bifrost` in production:

- Set `BIFROST_MCP_TOKEN` and `BIFROST_ADMIN_TOKEN` (never run anonymous)
- Keep `config/workspaces.json` at `chmod 0600` (POSIX) — Bifrost will warn
  via `GET /api/oauth/security` if it cannot enforce this
- Do not expose the admin UI publicly; `BIFROST_ADMIN_EXPOSE` is opt-in only
- Rotate provider tokens via the Admin UI Detail panel rather than editing
  the JSON directly
- Subscribe to repository releases / security advisories on GitHub
