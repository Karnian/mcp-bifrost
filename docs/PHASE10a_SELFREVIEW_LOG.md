# Phase 10a Self-Review Log

**Author**: Athena (self-driving team orchestrator) + Claude implementer
**Plan**: `docs/OAUTH_CLIENT_ISOLATION_PLAN.md` (651 lines, Round 10 APPROVED baseline)
**Scope**: OAuth Client Isolation — workspace-scoped DCR + 401 fail-fast + Admin UI + migration

---

## Timeline

| Date | Event |
|------|-------|
| 2026-04-20 | Plan Round 1-9 (Codex APPROVED after R9) |
| 2026-04-21 | §12-1 Notion MCP DCR curl probe completed |
| 2026-04-21 | Prior Athena session produced inherited oauth-manager/workspace-manager deltas |
| 2026-04-21 | This session: validate inheritance, close remaining 10a-1b/2/4/5/6, add test suite §9 |
| 2026-04-21 | Codex Gate §4.10a-1 review (Round 1 REVISE → fixed → approved path cleared) |

---

## Inheritance audit (prior Athena session)

The prior session committed (via `ao-wip` auto-commit 5d610ef) a substantial delta
to `server/oauth-manager.js` (+367 lines) and `server/workspace-manager.js` (+11).
All of it matches the plan:

- `maskClientId(clientId)` (§6-OBS.1) with `${first4}***${last4}` format ✓
- `parseRetryAfterMs(header)` for 429 responses ✓
- `_refreshMutex` → `_identityMutex` rename + FIFO chain (§6.4 R8 blocker 1) ✓
  - Verified at `oauth-manager.js:783-794` that `_withIdentityMutex` is chain-pattern,
    NOT coalescing. Tests: `phase6c-refresh.test.js:89` (`maxConcurrent === 1, calls === 3`).
- `_issuerCache` → `_clientCache` + workspace-scoped `${wsId}::${issuer}::${authMethod}` (§4.10a-1) ✓
- Back-compat legacy bucket `__global__::...` ✓ (later hardened by R1 Codex feedback)
- `removeClient(wsId)` cascading purge + `oauth.cache_purge` audit ✓
- `registerClient({ workspaceId })` + DCR 3-way classification ✓
  - 429 → `DCR_RATE_LIMITED` + `retryAfterMs`
  - 4xx → `DCR_REJECTED` (no retry)
  - 5xx / network → `DCR_TRANSIENT`
- `oauth.client_registered` audit with `clientIdMasked` ✓
- `markAuthFailed(workspaceId, identity)` with byIdentity token nulling + oauthActionNeededBy write ✓
- `forceRefresh(wsId, identity)` public wrapper (§9) ✓

Baseline regression: 276 pass / 0 fail / 2 skipped after fixing 3 Phase-6/7 tests
to match plan-intended breaking changes.

---

## Checkpoint commit

`535ddaf` — `feat(phase10a): §4.10a-1 workspace-scoped DCR cache + §4.10a-3 DCR error classification + §6-OBS.1 mask (WIP from prior Athena session)`

Contents:
- 3 regression test fixes (DCR_FAILED→DCR_REJECTED, coalescing→FIFO chain, __global__ key)

---

## New implementation (this session)

### §4.10a-1b — `/api/oauth/discover` cachedClient removed
- `admin/routes.js:295-318`: `cachedClient` field dropped from response.
- Test: `phase10a-admin-api.test.js` §4.10a-1b.

### §4.10a-2 — Static client priority + DCR fallback + load-time migration
- `admin/routes.js:208-287`: OAuth init flow reads `ws.oauth.client.clientId` first,
  falls back to legacy flat `ws.oauth.clientId`, then calls `registerClient({ workspaceId })`.
  Writes both nested and flat fields (§3.4 mirror for 1 release).
- `workspace-manager.js:_migrateLegacy`: flat → nested migration at load time,
  with startup WARN on divergence.

### §4.10a-4 — 401 fail-fast + public diagnostics
- `providers/mcp-client.js`:
  - `_consecutive401Count` Map per identity
  - `_authFailThreshold` (env `BIFROST_AUTH_FAIL_THRESHOLD`, default 3)
  - `_streamState` state machine: idle|connecting|connected|reconnecting|stopped:auth_failed|stopped:unsupported|stopped:shutdown|not_applicable
  - `getStreamStatus()` public method
  - Stream 401 trip + `onAuthFailed` callback → permanent `stopped:auth_failed`
  - RPC 401 trip shares the same counter + callback
  - Short-circuit early return once `stopped:auth_failed`
- `workspace-manager.js:_createProvider`: wires `onAuthFailed` → `_oauth.markAuthFailed`.
- `workspace-manager.js:getOAuthClient(id)`: public diagnostic API returning
  masked client (clientSecret → `***`).
- `workspace-manager.js:deleteWorkspace(hard=true)`: calls `removeClient` (§4.10a-1).
- `workspace-manager.js:purgeExpiredWorkspaces({now?})`: purges cache on expire (§4.10a-1 Option Y).

### §4.10a-5 — Admin API + UI
- `admin/routes.js` new endpoints:
  - `POST /api/workspaces/:id/oauth/register` — re-register (DCR forceNew or manual), invalidates tokens
  - `PUT  /api/workspaces/:id/oauth/client`   — set static client, 400 on invalid
- `admin/public/app.js:renderOAuthPanel`: source badge (MANUAL/DCR/LEGACY), re-register + manual client buttons with confirmation flows.
- Tests: `phase10a-admin-api.test.js` (4 tests).

### §4.10a-6 — Migration script
- `scripts/migrate-oauth-clients.mjs` — `--dry-run` / `--apply` / `--restore`.
- Creates `workspaces.json.pre-10a.bak` (chmod 0o600 on POSIX).
- Disambiguates shared `(issuer, clientId)` groups — keeps first, flags rest for re-auth.
- Tests: `phase10a-migration.test.js` (4 tests).

### §9 Assertion suite — `tests/phase10a-oauth-isolation.test.js`
- 24 tests covering all §9 criteria:
  - Workspace-scoped cache key (2)
  - DCR error classification 429 / 4xx / 5xx (3)
  - markAuthFailed + action_needed (2)
  - Refresh early-return after markAuthFailed (1)
  - Concurrency markAuthFailed ↔ forceRefresh (1)
  - Static client priority / restart DCR=0 (2)
  - `getStreamStatus()` states incl. stopped:auth_failed (4)
  - `maskClientId` format + audit (2)
  - Isolation — two workspaces, distinct `accessTokenPrefix` (1)
  - Cache purge — hard delete + re-register DCR=1 (1)
  - Soft delete retention + expire purge (1)
  - `oauth.threshold_trip` details encoding (1)
  - Masked API `hasAccessToken` (1)
  - `__global__` reservation (1)
  - `getOAuthClient` masking (1)

---

## Codex review — Round 1 (2026-04-21)

**Verdict**: REVISE (2 items)

### 1. DCR transient retry mismatch (BLOCKER)
`maxAttempts = 3` in `registerClient` only slept on attempts 1,2 (backoffs 1s/2s) —
the `_dcrBackoffMs(3) = 4s` was dead code.

**Fix**: Changed to `maxAttempts = maxRetries + 1 = 4`. Now 1 initial + 3 retries,
with sleeps 1s/2s/4s between.

Verified: new assertion in `phase10a-oauth-isolation.test.js` checks
`calls === 4` and `sleepCalls === [1000, 2000, 4000]`.

### 2. `__global__` bucket not actually reserved (NON-BLOCKING)
`addWorkspace()` accepted arbitrary `data.id` / `data.alias`, so a workspace with
id or alias `__global__` would collide with the legacy cache bucket.

**Fix**: `workspace-manager.js:addWorkspace` now explicitly rejects both
`id === '__global__'` and `alias === '__global__'`.

Verified: new assertion `§4.10a-1: workspace id "__global__" is reserved`.

### Approved items (Q1/Q4/Q5)
- Q1 FIFO chain correctness — APPROVED (correct error propagation + race-safe cleanup)
- Q4 24h cache TTL — APPROVED (reasonable given durable persistence in ws.oauth.client)
- Q5 Audit masking — APPROVED (format matches, raw clientId absent)
- Q2 429 no-retry — APPROVED (surfacing retryAfterMs is correct)

---

## Final test results

```
$ npm test
# tests 310
# suites 69
# pass 308
# fail 0
# cancelled 0
# skipped 2
# todo 0
```

Phase 10a new tests: 23 (isolation) + 4 (admin-api) + 4 (migration) + 1 (workspace reservation) = 32.
Plus existing regression tests all green.

---

## §9 assertion-to-test mapping

| §9 assertion | Test file / it block |
|--------------|---------------------|
| `npm test` pass ≥ 286 | 308 pass ≥ 286 ✓ |
| Multi-Notion isolation (accessTokenPrefix) | `phase10a-oauth-isolation.test.js:§9 isolation` |
| Migration --dry-run | `phase10a-migration.test.js:§4.10a-6 --dry-run` |
| Migration --apply | `phase10a-migration.test.js:§4.10a-6 --apply` |
| Migration --restore | `phase10a-migration.test.js:§4.10a-6 --restore` |
| 401 fail-fast `getStreamStatus() === 'stopped:auth_failed'` | `phase10a-oauth-isolation.test.js:§4.10a-4: getStreamStatus() transitions` |
| DCR 429 `retryAfterMs` | `phase10a-oauth-isolation.test.js:§4.10a-3: DCR 429` |
| DCR 4xx no retry | `phase10a-oauth-isolation.test.js:§4.10a-3: DCR 4xx` |
| DCR 5xx 3 retries + exp backoff | `phase10a-oauth-isolation.test.js:§4.10a-3: DCR 5xx` |
| Restart DCR = 0 | `phase10a-oauth-isolation.test.js:§4.10a-2: restart` |
| non-default identity 401 path (hasAccessToken) | `phase10a-oauth-isolation.test.js:§4.10a-4: markAuthFailed for bot_ci` |
| Cache purge primary (hard delete + re-register = 1 DCR) | `phase10a-oauth-isolation.test.js:§9 cache purge` |
| Cache purge secondary (clientId !== old) | `phase10a-oauth-isolation.test.js:§9 cache purge` (assert.notEqual) |
| Soft delete | `phase10a-oauth-isolation.test.js:§9 soft delete retention` |
| Concurrency (markAuthFailed ↔ forceRefresh) | `phase10a-oauth-isolation.test.js:§4.10a-4: concurrency` |
| Refresh early-return | `phase10a-oauth-isolation.test.js:§4.10a-4: refresh early-return` |
| Audit masking (clientIdMasked format + no raw) | `phase10a-oauth-isolation.test.js:§6-OBS.1: registerClient success` |
| Observability encoding (correlationId + threshold + consecutiveCount) | `phase10a-oauth-isolation.test.js:§6-OBS: oauth.threshold_trip details` |
| FIFO chain (not coalescing) | `phase6c-refresh.test.js:concurrent refresh calls serialize via FIFO chain` |
| Masked API (hasAccessToken) | `phase10a-oauth-isolation.test.js:§9 masked API` |
| `__global__` reservation | `phase10a-oauth-isolation.test.js:§4.10a-1: workspace id __global__ is reserved` |
| DCR 5xx backoff 1s/2s/4s | `phase10a-oauth-isolation.test.js:§4.10a-3: DCR 5xx` (sleepCalls) |
| Admin POST /oauth/register | `phase10a-admin-api.test.js:§4.10a-5: POST` (DCR + manual) |
| Admin PUT /oauth/client | `phase10a-admin-api.test.js:§4.10a-5: PUT` |
| /api/oauth/discover no cachedClient | `phase10a-admin-api.test.js:§4.10a-1b` |

---

## Migration execution guide

```bash
# 1. Preview: inspect what would change
node scripts/migrate-oauth-clients.mjs --dry-run

# 2. Apply migration (creates workspaces.json.pre-10a.bak at 0o600)
node scripts/migrate-oauth-clients.mjs --apply

# 3. Re-authorize any disambiguated workspaces (Admin UI → Workspace Detail → Re-authorize)

# 4. Rollback if needed
node scripts/migrate-oauth-clients.mjs --restore
```

Expected report fields (from stdout JSON):
- `flatToNested`: workspaces migrated from flat `ws.oauth.clientId` to nested `ws.oauth.client`
- `sharedClients`: groups of workspaces sharing the same (issuer, clientId) — these caused the original 401 loop bug
- `disambiguated`: workspaces whose client was stripped (operator must re-authorize them)
- `alreadyMigrated`: workspaces already on the Phase 10a schema
- `nonOAuth`: workspaces without OAuth (native or non-oauth mcp-client)

---

## Follow-up (Phase 10a+ deferred)

Per plan §12:
- **§12-2** Admin wizard for "Static client" creation path (UX help for operators
  registering Notion integrations directly on mcp.notion.com).
- **§12-3** Notion MCP official recommendations — documentation clarification
  (confirmed via §12-1 curl probe that Notion MCP issues fresh clients per call).
- **`__global__` bucket deeper hardening** (Codex R1 non-blocking note) — could
  move to disjoint namespaces `global::` vs `ws::${wsId}::` in Phase 11 for
  stronger schema separation. Current reservation at `addWorkspace` level is
  sufficient for MVP.
- Flat field mirror removal in Phase 11 (deprecation WARN already in place).
- `server/oauth-metrics.js` counter-only recorder (plan §6-OBS.2) — deferred,
  audit log covers observability for Phase 10a.

---

## Files changed

| File | Lines |
|------|-------|
| `server/oauth-manager.js` | +5 / -3 (R1 retry count fix) |
| `server/workspace-manager.js` | +60 / -4 (migrate flat→nested, getOAuthClient, reservation, purge hooks) |
| `providers/mcp-client.js` | +90 / -30 (consecutive401Count, getStreamStatus, fail-fast) |
| `admin/routes.js` | +200 / -30 (POST /oauth/register, PUT /oauth/client, static-priority init, discover field drop) |
| `admin/public/app.js` | +55 / -4 (source badge, re-register + manual client buttons) |
| `scripts/migrate-oauth-clients.mjs` | +170 (new) |
| `tests/phase10a-oauth-isolation.test.js` | +750 (new, 24 tests) |
| `tests/phase10a-admin-api.test.js` | +230 (new, 4 tests) |
| `tests/phase10a-migration.test.js` | +210 (new, 4 tests) |
| `tests/phase6a-discovery.test.js` | +1 / -1 (DCR_FAILED→DCR_REJECTED per §4.10a-3) |
| `tests/phase6c-refresh.test.js` | +13 / -4 (FIFO chain semantics + _identityMutex rename) |
| `tests/phase7d-manual-dcr.test.js` | +3 / -1 (legacy __global__ bucket) |
| `docs/PHASE10a_SELFREVIEW_LOG.md` | +270 (new, this doc) |
