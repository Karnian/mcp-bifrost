# Phase 11 Self-Review Log

**Author**: Claude implementer + Codex cross-reviewer
**Predecessor**: Phase 10a (`docs/PHASE10a_SELFREVIEW_LOG.md`, Codex R11 APPROVE)
**Scope**: Phase 10a follow-ups + OAuth observability hardening + multi-workspace Admin UX
**Outcome**: 10 sub-phases shipped, 15 Codex review rounds, **0 blockers open**, `428 / 426 pass / 2 skip` baseline.

---

## Timeline

| Date       | Event |
|------------|-------|
| 2026-04-22 | 11-1 (§4.10a-5 regression instrumentation) — 1 round APPROVE |
| 2026-04-22 | 11-2 (rotate helper consolidation) — R1 CONDITIONAL → R2 APPROVE (2 rounds) |
| 2026-04-22 | 11-3 (flat-field mirror removal) — R1 NEEDS_WORK → R2 CONDITIONAL → R3 APPROVE (3 rounds) |
| 2026-04-22 | 11-4 (OAuthMetrics recorder, §6-OBS.2) — R1 CONDITIONAL → R2 APPROVE (2 rounds) |
| 2026-04-22 | 11-5 (refresh AbortController) — 1 round APPROVE |
| 2026-04-22 | 11-6 (metrics cardinality cap + prune) — 1 round APPROVE |
| 2026-04-22 | 11-7 (cache key `ws::/global::` schema) — R1 CONDITIONAL → R2 APPROVE (2 rounds) |
| 2026-04-22 | 11-8 (watcher atomic-replace) — R1 CONDITIONAL → fix verified |
| 2026-04-22 | 11-9 (Admin wizard static-client UX) — 1 round APPROVE |
| 2026-04-22 | 11-10 (non-blocking cleanup batch) — 1 round APPROVE |
| 2026-04-23 | Production migration `--apply` dry-run → clean apply (no shared-clientId workspace on this instance) |

---

## Commit ledger (chronological)

| Commit  | Sub-phase | Summary |
|---------|-----------|---------|
| `34a9c81` | 11-1 | test(phase11-1): instrumented mutex acquisition order §4.10a-5 |
| `85dd3a7` | 11-2 | refactor(phase11-2): consolidate rotation into `_rotateClientAndInvalidate` |
| `f326be3` | 11-2 | fix(phase11-2): purge pending INSIDE workspace mutex (R1 blocker) |
| `1664049` | 11-3 | refactor(phase11-3): remove flat OAuth client-field mirror |
| `278fceb` | 11-3 | fix(phase11-3): close flat-scrub gaps (R1 NEEDS_WORK) |
| `dae7c3a` | 11-3 | fix(phase11-3): address R2 CONDITIONAL + Phase 11 docs update |
| `1adea9c` | 11-4 | feat(phase11-4): OAuthMetrics recorder (§6-OBS.2) |
| `490b0e3` | 11-5 | feat(phase11-5): refresh timeout + AbortController |
| `5649374` | 11-6/7 | feat(phase11-6,7): cardinality cap + cache-key schema |
| `e4625e7` | 11-8/9 | fix(phase11-8,9): Codex R1 findings on watcher + wizard |
| `20a2404` | 11-10 | chore(phase11-10): non-blocking cleanup batch (APPROVE) |

Total: **11 descriptive commits** over Phase 11 (plus ao-wip interleaved auto-commits).

---

## Sub-phase detail

### Phase 11-1 — R10 regression instrumentation (APPROVE, 1 round)

**Motivation**: Phase 10a Codex R11 non-blocking — add an instrumented assertion that
`rotateClientUnderMutex` takes the workspace lock **before** any identity lock, and
that `completeAuthorization` does the same. The prior §4.10a-5 test only verified
end-to-end result, not the acquisition order itself.

**Changes**:
- `tests/phase10a-oauth-isolation.test.js` (+2 tests) — hook `_withWorkspaceMutex` /
  `_withIdentityMutex` with a per-test acquisition tracer. Assert the tracer emits
  `workspace` before `identity` for both rotation and callback paths.

**Codex**: R1 APPROVE. Non-blocking suggestions (shared helper extract + specific
identity assertion) absorbed.

---

### Phase 11-2 — Rotate helper consolidation (R1 CONDITIONAL → R2 APPROVE)

**Motivation**: Three admin routes duplicated the same rotation logic
(POST `/oauth/register`, PUT `/oauth/client`, POST `/oauth/authorize` rotate path).
DRY + a single place to serialize mutation against refresh/callback.

**Changes**:
- `admin/routes.js._rotateClientAndInvalidate(wsId, mutator, { reason })` — wraps
  `oauth.rotateClientUnderMutex` + nested client replace + token nullification +
  provider recreate + pending purge + audit.
- 3 call sites consolidated.

**Codex**:
- **R1 CONDITIONAL**: same-client manual rotation left a stale-callback window —
  pending purge ran *outside* `_workspaceMutex`, so a callback racing with
  rotation could still land.
- **Fix**: `purgePendingForWorkspace` moved *inside* the mutex critical section
  (commit `f326be3`).
- **R2 APPROVE**.

**Added tests**: 2 rotation-consistency tests + 1 R1 regression guarding the
pending-purge-inside-mutex invariant.

---

### Phase 11-3 — Flat-field mirror removal (R1 NEEDS_WORK → R2 CONDITIONAL → R3 APPROVE)

**Motivation**: Phase 10a §3.4 preserved a flat `ws.oauth.{clientId,clientSecret,
authMethod}` mirror "for 1 release" to ease migration. Deprecation window closed;
nested `ws.oauth.client.*` is now the single source of truth.

**Changes**:
- `server/oauth-manager.js._persistTokens` — nested-only write, actively scrub
  any lingering flat fields.
- `admin/routes.js._rotateClientAndInvalidate` — same scrub on rotation.
- `server/workspace-manager.js._migrateLegacy` — boolean `mutated` return;
  handles 3 cases (flat-only / nested+flat drift / `client===null`+flat-null).
- `server/workspace-manager.js.load` — persist migration result on startup
  (logged on failure).
- `server/workspace-manager.js._startFileWatcher` — hot-reload path also runs
  `_migrateLegacy`.
- `scripts/migrate-oauth-clients.mjs` — `report.flatScrubbed: [{id}]` added.
- `admin/public/app.js` — flat-field fallback removed.
- 5 new tests.

**Codex**:
- **R1 NEEDS_WORK** (3 blockers): (1) hot-reload bypassed `_migrateLegacy`;
  (2) startup migration wasn't persisted; (3) `client===null` + flat-null case
  missed.
- **R2 CONDITIONAL** (3 issues): (1) silent `_save` failure; (2) admin UI still
  had flat fallback; (3) watcher atomic-replace gap (deferred to 11-8).
- **R3 APPROVE**.

---

### Phase 11-4 — OAuthMetrics recorder (§6-OBS.2) (R1 CONDITIONAL → R2 APPROVE)

**Motivation**: Phase 10a §6-OBS.2 deferred the counter recorder. Without it, audit
events were emitted but no aggregate was visible for operators.

**Changes**:
- `server/oauth-metrics.js` — new `OAuthMetrics` class (in-memory Map, stable
  label serialization, defensive snapshot) + `dcrStatusBucket` helper.
- `server/oauth-manager.js` — `metrics` constructor option, `_metric(name,labels)`
  private helper (guarded + swallow-on-throw). Instrumentation:
  - `getCachedClient` hit / miss / TTL-expire (miss).
  - `registerClient` DCR 200 / 429 / 4xx / 5xx-or-network per attempt.
  - `markAuthFailed` → threshold_trip.
  - `_runRefresh` → ok / fail_4xx / fail_net.
- `server/index.js` — `new OAuthMetrics()` wired into OAuthManager + admin routes.
- `admin/routes.js` — `GET /api/oauth/metrics`.
- `tests/phase11-4-oauth-metrics.test.js` — 29 tests.

**Codex**:
- **R1 CONDITIONAL** (1 blocker): refresh timeout → background task late-resolves
  → `status:'ok'` double-counted after the caller already observed `fail_net`.
- **Fix**: move `ok` metric emission out of the inner task, into the outer
  `await wrapped` success branch.
- **R2 APPROVE**. Non-blocking items absorbed: admin `snapshot()` wrapped in
  try/catch, NO_REFRESH_TOKEN / TOKEN_ENDPOINT_UNKNOWN classified as `fail_net`
  with `oauthActionNeeded` contract pinned by test.

---

### Phase 11-5 — Refresh timeout + AbortController (APPROVE, 1 round)

**Motivation**: Phase 11-4 closed the metrics double-count on refresh timeout,
but state/audit convergence was still off — a timed-out refresh whose background
fetch later resolved could (a) overwrite `ws.oauth.byIdentity[identity].tokens`,
(b) emit a contradicting `oauth.refresh_success` audit, (c) in rare races resurrect
a `markAuthFailed`-quiesced identity.

**Changes**:
- `server/oauth-manager.js._tokenRequest(..., { signal })` — optional 4th arg,
  forwarded into `fetch` init. Backwards-compatible with authorize path.
- `server/oauth-manager.js._runRefresh` — `AbortController` created per refresh.
  On timeout, `controller.abort()` fires **before** `reject`. A post-fetch guard
  (`if (controller.signal.aborted) throw REFRESH_ABORTED`) covers stubs that
  ignore `signal` and resolve late.
- `tests/phase11-5-refresh-abort.test.js` — 7 tests (standards fetch / stub fetch /
  signal passthrough / backwards compat / happy-path ok / phase6c compat /
  quiesced state revive prevention).

**Codex**: R1 APPROVE. Non-blocking suggestions absorbed — deterministic
abort-observed promise replaces `setImmediate` in test 1; explicit "quiesced
state revive" regression (scenario 6b) pins `markAuthFailed` + late-resolve
invariants.

---

### Phase 11-6 — OAuthMetrics cardinality cap + prune (APPROVE, 1 round)

**Motivation**: Phase 11-4 Codex R2 non-blocking flagged monotonic growth of the
counter Map — deleted workspace / identity tuples never aged out.

**Changes**:
- `OAuthMetrics` constructor option `maxEntries` (default 10_000). Insertion-order
  eviction in `inc()` when the cap is exceeded.
- `pruneWorkspace(wsId)` — drop every counter whose `workspace` label matches.
- `size()` — resident entry count.
- `OAuthManager.removeClient(wsId)` calls `metrics.pruneWorkspace(wsId)` outside
  the `removed > 0` gate so metrics lifecycle follows the workspace lifecycle
  regardless of whether a cache entry existed.
- `tests/phase11-6-metrics-cardinality.test.js` — 12 tests.

**Codex**: R1 APPROVE (no blockers, no non-blocking).

---

### Phase 11-7 — Cache-key schema separation (R1 CONDITIONAL → R2 APPROVE)

**Motivation**: Phase 10a Codex R1 non-blocking — replace `__global__` sentinel
and bare-scoped keys with explicit `global::` / `ws::` prefixes so the two
buckets are structurally distinguishable.

**Changes**:
- `server/oauth-manager.js._cacheKey` — new schema:
  - 2-arg: `global::${issuer}::${authMethod}`
  - 3-arg: `ws::${wsId}::${issuer}::${authMethod}`
- `_loadIssuerCache` — new `_migrateLegacyCacheKeys` upgrades pre-11-7 caches
  in-place; persisted on first load; unknown/hand-edited keys pass through.
- `removeClient` prefix updated to `ws::${wsId}::`.
- Hardcoded test keys in `phase7d-manual-dcr` + `phase10a-oauth-isolation` updated.
- `tests/phase11-7-cache-key-schema.test.js` — 15 tests.

**Codex**:
- **R1 CONDITIONAL** (1 blocker): `_migrateLegacyCacheKeys` used
  `split('::').length === 3` to detect legacy bare-scoped keys, which breaks on
  RFC 3986 IPv6-literal issuers (`https://[2001:db8::1]`) and RFC 8414 path-
  segmented issuers that themselves contain `::`.
- **Fix**: parse by **first-and-last delimiter**; validate the trailing
  authMethod against a `KNOWN_AUTH_METHODS` set so experimental hand-edited
  keys stay as pass-through rather than silent rewrite. Logging added on
  persist failure.
- **R2 APPROVE**. Non-blocking residual (comment/test wording drift, unknown-
  method `removeClient` overmatch) documented + fixed in 11-10.

---

### Phase 11-8 — Watcher atomic-replace gap (R1 CONDITIONAL → fix)

**Motivation**: Phase 11-3 Codex R2 low — `_startFileWatcher` only handled
`eventType === 'change'`. Editors that save atomically (VSCode, vim, `sed -i`,
and Bifrost's own `_save()`) publish `rename` because the inode flips. Those
writes silently bypassed hot-reload.

**Changes**:
- `WorkspaceManager({ configDir })` DI so tests can exercise the watcher against
  a tmpdir.
- `_configPath` / `_backupPath` / `_tmpPath` instance fields replace the module-
  level constants at all call sites.
- `_startFileWatcher` accepts `rename`; gives a 50ms grace when the file is
  transiently missing; closes the old watcher + rebinds on the new inode via
  `setImmediate`.
- `tests/phase11-8-watcher-rename.test.js` — 4 + 1 regression tests.

**Codex**:
- **R1 CONDITIONAL** (1 blocker): when `_migrateLegacy()` returned mutated=true,
  the handler fire-and-forgot `this._save()` while scheduling rebind with
  `setImmediate`. The new watcher could arm on the **old** inode, and `_save`'s
  own atomic rename got skipped by the `_saving` guard — leaving the new watcher
  stale and missing subsequent external writes.
- **Fix**: capture the migration save promise; defer the rebind until it resolves
  (`savePromise.finally(() => setImmediate(rebind))`). A regression test plants a
  legacy flat-field config, waits for migration + save, then issues a second
  external rename and asserts it's still hot-reloaded.

---

### Phase 11-9 — Admin wizard static-client UX (APPROVE, 1 round)

**Motivation**: `POST /api/workspaces/:id/oauth/register` had existed since
Phase 10a, but the admin experience for providers without DCR (notably Notion)
was a bare 3-field prompt. Operators had to dig through provider docs.

**Changes**:
- `admin/routes.js` — `GET /api/oauth/redirect-uri` (returns
  `oauth.getRedirectUri()` so the wizard can tell the operator what to paste
  into the provider console).
- `admin/public/app.js`:
  - `bifrostModal({ bodyHtml })` — optional guidance block above the form.
    Wired up copy-to-clipboard buttons (`data-copy-target="#selector"`).
  - `STATIC_CLIENT_GUIDES` map (Notion, GitHub) with per-provider steps.
  - `guideFor(url)` + `renderStaticClientBody({ redirectUri, guide })`.
  - `promptManualClientCreds(ctx)` — `ctx.workspaceUrl` / `ctx.redirectUri`
    drives the guide + copyable redirect URI.
  - `runOAuthFlow` on DCR_UNSUPPORTED calls `/api/workspaces/:id` +
    `/api/oauth/redirect-uri` in parallel and passes them into the prompt.
- `admin/public/style.css` — `.bifrost-modal-body`, `.bifrost-modal-steps`,
  `.bifrost-modal-copyrow`, `.bifrost-modal-copybox`, `.btn-copy`.
- `tests/phase11-9-admin-wizard.test.js` — 3 backend contract tests.

**Codex**: R1 APPROVE. Non-blocking absorbed:
- Clipboard fallback: `<code>` has no `.select()`; switched to
  `window.getSelection().selectAllChildren(target)`.
- DCR_UNSUPPORTED path: `Promise.all` now individually `.catch(() => null)` so
  a failing UX-enrichment fetch doesn't abort the manual prompt.

---

### Phase 11-10 — Non-blocking cleanup batch (APPROVE, 1 round)

**Motivation**: Sweep the five non-blocking items Phase 11-4/6/7/8/9 Codex
reviews deferred. No blockers, no functional regressions — just hardening.

**Changes (5 items)**:
1. **OAuthMetrics saturation telemetry** — `_evictionsTotal` counter +
   `stats()` → `{entries, maxEntries, capped, evictionsTotal, saturation}`.
   Admin `GET /api/oauth/metrics/status` exposes it with the same
   degrade-on-recorder-fault pattern as `/api/oauth/metrics`.
2. **Hostname-based guide matching** — extracted `STATIC_CLIENT_GUIDES` /
   `guideFor` / `renderStaticClientBody` into
   `admin/public/static-client-guides.js`. New matching rule:
   `host === needle || host.endsWith('.' + needle)` via `new URL(url).hostname`
   — rejects attacker-like `user-notion.com.attacker.tld`.
3. **`removeClient` legacy overmatch fix** — purges both the new-schema
   `ws::${wsId}::` prefix AND pre-migration bare `${wsId}::` keys, guarded
   against overmatching existing `ws::…` / `global::…` keys. Future
   auth-method enum additions won't resurrect stale caches for reused
   workspace ids.
4. **Watcher rename re-migration** — already covered by Phase 11-8 sequencing;
   documented, no code change.
5. **Frontend helper unit tests** — 9 Node tests covering exact + suffix
   hostnames, attacker-host rejection, `notion.so` alias, guide-less /
   redirect-less rendering, HTML escape sanity.

`tests/phase11-10-cleanup.test.js` — 19 tests total.

**Codex**: R1 APPROVE (no blockers, no non-blocking).

---

## Production migration (2026-04-23)

`scripts/migrate-oauth-clients.mjs` dry-run → apply against this instance.

```json
{
  "ok": true,
  "action": "apply",
  "backup": "config/workspaces.json.pre-10a.bak",
  "backupMode": "0o600",
  "pendingPurged": 0,
  "report": {
    "workspacesScanned": 1,
    "flatToNested": [],
    "sharedClients": [],
    "alreadyMigrated": [],
    "nonOAuth": [{ "id": "recent-ws" }],
    "conflicts": [],
    "disambiguated": [],
    "flatScrubbed": []
  }
}
```

Outcome: 1 workspace scanned, none OAuth-enabled, no shared-clientId group,
no flat-field residue. Apply was effectively a no-op + backup generation.
Other deployments with shared clientId under the same issuer will surface
`sharedClients[...]` and require operator-side re-auth communication.

---

## Aggregate metrics

| Axis | Start of Phase 11 | End of Phase 11-10 | Delta |
|------|--------------------|--------------------|-------|
| `npm test` pass | 325 | 426 | **+101** |
| Test suites | 61 | 69 | +8 |
| Descriptive commits | — | 11 | 11 |
| Codex review rounds | — | 15 | 15 |
| Codex blockers closed | — | 6 | 6 |
| Open follow-ups | 5 | 0 | −5 |

New test suites introduced:
- `tests/phase11-4-oauth-metrics.test.js` (29)
- `tests/phase11-5-refresh-abort.test.js` (7)
- `tests/phase11-6-metrics-cardinality.test.js` (12)
- `tests/phase11-7-cache-key-schema.test.js` (15)
- `tests/phase11-8-watcher-rename.test.js` (5)
- `tests/phase11-9-admin-wizard.test.js` (3)
- `tests/phase11-10-cleanup.test.js` (19)
- plus strengthened `phase10a-oauth-isolation.test.js` and others.

---

## Residual (none)

No open blockers. No tracked non-blocking follow-ups remaining in `NEXT_SESSION.md`
as of 2026-04-23. Future work is roadmap-driven (new providers, usage dashboard,
profile-based endpoints, Phase 12 scoping) rather than Phase 10a/11 hardening.

---

## Review methodology

Every sub-phase followed the same cadence:

1. **Implement** — narrow scope, plan-aligned code + tests locally green.
2. **Stage + extract diff** — `git add -u <touched>` + `git diff --cached > /tmp/…diff`.
3. **Fire Codex R1** — async prompt with context, diff, self-identified review
   angles, explicit "blocker + non-blocking" ask.
4. **Collect artifact** — even when the adapter returned `auth_failed` (sandbox
   EPERM from Codex trying to run `node --test`), the `agent_message` payload
   inside `.ao/artifacts/ask/*.jsonl` carried the actual review.
5. **Triage** — absorb blockers immediately; absorb obvious non-blocking;
   defer the rest into `NEXT_SESSION.md` with provenance.
6. **Fire Codex R2 / R3** — only when blockers existed. APPROVE outcomes shipped
   in one round.
7. **Commit with descriptive message** — referenced Codex verdict + round count +
   non-blocking disposition.
8. **Update `NEXT_SESSION.md`** — move the sub-phase to "completed", push any
   new follow-up candidates to the pending list.

The same loop closed Phase 11-10's five deferred items in one batch, reducing the
follow-up queue to zero before shipping this log.
