# Phase 12 — Self-Review Log

> 12 sub-phases × Codex peer review 누적 기록.
> 형식은 `docs/PHASE11_SELFREVIEW_LOG.md` 참고.

---

## 12-1 — Workspace schema 확장 + Slack masking (2026-04-29)

### 산출물
- `server/workspace-schema.js` — `slackOAuthSchema` / `slackOAuthTokensSchema` / `slackAppSchema` + `validateSlackAppPayload` helper, `nativeWorkspaceSchema` 에 `authMode` + batch validation (`provider=slack && authMode=oauth` ↔ botToken 금지 ↔ slackOAuth 필수, authMode=oauth 는 slack 만 허용).
- `server/workspace-manager.js` — `maskSlackOAuth` / `maskSlackApp` helpers export, `_maskSecrets` 에 slackOAuth 라우팅, `getSlackApp(Raw)` / `setSlackApp` / `deleteSlackApp` 신규 (env override + dependent guard with force), `getDeletedWorkspaces` 가 `_maskSecrets` 통과, `addWorkspace` / `updateWorkspace` 가 `authMode` + `slackOAuth` 영속화.
- `tests/phase12-1-schema-mask.test.js` — 26 건 (schema 9건, masking 8건, _maskSecrets 통합 2건, slackApp manager 4건, addWorkspace/updateWorkspace/getDeletedWorkspaces/setSlackApp 회귀 4건 신규).

### Codex review
- **Round 1**: REJECT — 2 BLOCKER + 1 REVISE
  - [BLOCKER] `getDeletedWorkspaces` 가 `slackOAuth` 토큰 누출 (`/api/workspaces/deleted`)
  - [BLOCKER] `addWorkspace` / `updateWorkspace` 가 `authMode` / `slackOAuth` 영속화 안 함 — silent downgrade 가능
  - [REVISE] `setSlackApp` 이 `validateSlackAppPayload` 우회
- **Round 2**: APPROVE
  - 3건 모두 닫힘. `restoreWorkspace` / diagnostics / `/api/workspaces` 변형 surfaces 도 추가 검증됨.
  - NIT (deferred): `updateWorkspace` 의 masked-token 판정이 `endsWith('...')` sentinel 의존 — 형태 변경 시 fragile. Phase 12 끝에 batch 처리.

### 견적 vs 실제
- 견적 1d, 실제 ~0.5d (round 2 만에 수렴). 추가 BLOCKER 2건 처리 포함.

### 누적 테스트
- 기존 phase 11 까지 428 → 12-1 추가 +26 = 474 (실측 448 — 일부 phase11 후속 추가가 brief 작성 후 합산됨, 결과적으로 0 fail).

---

## 12-2 — `BIFROST_PUBLIC_URL` canonical resolver (2026-04-29)

### 산출물
- `server/public-origin.js` (신규) — `getPublicOrigin` / `getPublicOriginOrNull` / `describePublicOrigin` / `getSlackRedirectUri` / `getSlackManifestRedirect`. HTTPS 강제 + loopback HTTP 예외, `URL.origin` canonicalization, path/query/fragment reject. `PUBLIC_ORIGIN_ENV_VAR` / `SLACK_OAUTH_CALLBACK_PATH` constants.
- `tests/phase12-2-public-origin.test.js` (신규, 24 건) — missing/empty env, HTTP non-loopback, HTTPS, trailing slash, loopback (3종 + ftp/ws reject 회귀 3건), path/query/fragment, malformed URL, OrNull, single source of truth, describe* 진단.

### Codex review
- **Round 1**: REVISE — 1 BLOCKER + 1 NIT
  - [BLOCKER] loopback 에서 HTTP 외 다른 protocol (ftp, ws) 도 통과 — manifest 가 잘못된 URI 광고할 수 있음
  - [NIT] query+fragment 같은 reason — phase 끝 batch 처리 (deferred)
- **Round 2**: APPROVE — 조건 `(https) OR (http+loopback)` 로 좁힘 + 회귀 3건 추가.

### 견적 vs 실제
- 견적 0.5d, 실제 ~0.3d (round 2 만에 수렴).

---

## 12-3 — `SlackOAuthManager` 코어 (2026-04-30)

### 산출물
- `server/slack-oauth-manager.js` (신규, 약 600 라인) — install / token exchange / refresh / state HMAC / mutex (workspace + teamInstall) / parseTokenResponse / parseRefreshResponse / Slack error mapping / revoke / purgeStaleInstalls / aliasForTeam.
- `server/workspace-manager.js` — `updateSlackOAuthAtomic(workspaceId, mergeFn)` 신규 (clone-then-swap atomic save). `_saveSnapshot(snapshot)` + `_saveImpl(getConfig)` helpers (R10 atomic 보장).
- `tests/phase12-3-slack-oauth-manager.test.js` (신규, 48 건) — state HMAC 9, parseTokenResponse 9, parseRefreshResponse 5, completeInstall 9, ensureValidAccessToken 5, refresh paths 5, atomic save 3 (disk fail / in-flight reader / concurrent mutation 보존), markActionNeeded 1, revoke 1, aliasForTeam / describeSlackError / purgeStaleInstalls 3.

### Codex review
- **Round 1**: REVISE — 3 BLOCKER + 3 REVISE
  - [BLOCKER] Durable save 원자성 미구현
  - [BLOCKER] Refresh response shape (top-level vs authed_user nested)
  - [BLOCKER] half-state (refresh 만 있는 케이스) 통과
  - [REVISE] state schema 약함 / parse-failure cleanup 일부 누락 / token_type missing 통과
- **Round 2**: REVISE — 1 BLOCKER (R10 atomic 의 `this.config` 즉시 swap → in-flight 노출)
  - → `_saveSnapshot` 분리 + swap-after-disk-write 적용
- **Round 3**: REVISE — 1 BLOCKER (whole-config swap 이 concurrent mutation 덮어씀)
  - → in-place slackOAuth commit (다른 필드는 건드리지 않음)
- **Round 4**: APPROVE — 모든 invariant 검증됨. `deleteWorkspace` 동시 실행은 R10 범위 밖으로 합의.

### 견적 vs 실제
- 견적 3d, 실제 ~1.5d (round 4 만에 수렴, 7 issues closed).

---

## 12-4 — `providers/slack.js` OAuth 모드 + `_headers()` async + cooldown (2026-04-30)

### 산출물
- `providers/slack.js` — `authMode` 분기, `_headers()` async (oauth → `_tokenProvider` await, token → botToken), `_fetch()` 도 await. `capabilityCheck()` 60s cooldown (success / failure 양쪽 캐시).
- `server/workspace-manager.js` — `_createProvider` 가 OAuth Slack workspace 의 `slackOAuth` / `credentials` 분리 + `_tokenProvider` closure 주입. `setSlackOAuthManager` 신규.
- `server/oauth-manager.js` — `_getServerSecret` cold-boot race coalescing (in-flight promise guard).
- `server/index.js` — production `SlackOAuthManager` wiring (`metrics` 공유 + `serverSecretProvider` 로 OAuthManager secret 재사용). `configDir` param 추가 (testability).
- `tests/phase12-4-slack-provider.test.js` (신규, 15 건).

### Codex review
- **Round 1**: REVISE — 1 REVISE + 2 NIT
  - [REVISE] OAuth provider config 가 raw token 보유 (`BaseProvider.this.config`)
  - [NIT] cooldown 실패 path / callTool 3개 도구 OAuth 검증 missing
- **Round 2**: REVISE — 1 finding (production startup 에서 SlackOAuthManager attach 안 됨)
- **Round 3**: REVISE — 1 finding (`_getServerSecret` cold-boot race)
- **Round 4**: APPROVE — secret race coalescing + 모든 invariant 통과.

### 견적 vs 실제
- 견적 0.5d, 실제 ~0.5d (round 4 만에 수렴, 1 REVISE + 2 NIT + 2 cross-cutting issues closed).
