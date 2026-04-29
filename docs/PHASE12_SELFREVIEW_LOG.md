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

---

## 12-5 — Admin REST endpoints + install status polling (2026-04-30)

### 산출물
- `admin/routes.js` — 9 신규 endpoints (`GET/POST/DELETE /api/slack/app`, `POST /api/slack/install/start`, `GET /api/slack/install/status`, `GET /api/slack/manifest.yaml`, `POST /api/workspaces/:id/slack/refresh` (forceRefresh), `POST /api/workspaces/:id/slack/disconnect`). `handleSlackOAuthCallback` export — 4초 auto-close, strict-CSP nonce'd inline script, postMessage `bifrost-slack-install` (canonical-origin only, '*' fallback 제거).
- `server/index.js` — `/oauth/slack/callback` 라우트 + `extras.slackOAuth` 전달.
- `server/slack-oauth-manager.js` — `forceRefresh`, `_runRefresh({ bypassFreshCheck })`, `revoke({ mode })` 가 hard-delete / keep-entry 까지 mutex 안에서 처리. errorParam 처리 순서 수정 (state 검증 → installId 얻어 failed 마킹).
- `tests/phase12-5-admin-rest.test.js` (신규, 20 건). `tests/phase12-3-slack-oauth-manager.test.js` 1 update + 1 add (errorParam state 순서).

### Codex review
- **Round 1**: BLOCKER — 4 BLOCKER + 2 REVISE + 1 NIT
  - errorParam polling 안 됨 / in_progress 노출 / refresh 가 fresh 면 no-op / PUBLIC_ORIGIN_* 412 누락 / postMessage '*' fallback / disconnect mutex 누락 / popup auto-close 시간 불일치
- **Round 2**: APPROVE — 7건 모두 닫힘. mutex 순서 (Slack → wm writeLock) 일관성 검증됨.

### 견적 vs 실제
- 견적 1.5d, 실제 ~0.7d (round 2 만에 수렴, 7 issues closed).

---

## 12-6 — Admin UI: Slack screen + popup completion (2026-04-30)

### 산출물
- `admin/public/index.html` — 신규 `#slack-screen` + `#btn-nav-slack` topbar entry. Slack App credential form + public origin diag + manifest download + Connect button + workspace list section.
- `admin/public/app.js` — `loadSlack` / `renderSlackOrigin` / `renderSlackAppForm`. Credential 저장 / 강제 삭제 (dependents code 분기) / manifest admin-token 다운로드. install start + popup + 1.5s/5min polling. postMessage strict-origin (BIFROST_PUBLIC_URL match). workspace list (status / reason / re-authorize / disconnect). install-start sequence guard + ticket-id polling guard + popup teardown helper.
- `admin/public/style.css` — `.form-grid` 추가.
- `tests/phase12-6-admin-ui.test.js` (신규, 11 건).

### Codex review
- **Round 1**: REVISE — 2 BLOCKER + 2 REVISE + 1 NIT
  - postMessage origin 미할당 / dependents UX message-regex 의존 / install timeout cleanup 부족 / action_needed UX 부족 / clientId stale
- **Round 2**: REVISE — install A→B race
- **Round 3**: REVISE — install-start in-flight race (응답 reorder)
- **Round 4**: APPROVE — sequence guard + ticket id polling guard + endSlackInstall single source of truth.

### 견적 vs 실제
- 견적 2d, 실제 ~1d (round 4 만에 수렴, 6 issues closed).

---

## 12-7 — Refresh hardening + token rotation crash recovery (2026-04-30)

### 산출물
- 코드 변경 없음 — 12-3 / 12-5 의 atomic save / mutex / forceRefresh / parseRefreshResponse / friendly error mapping 을 결합 검증.
- `tests/phase12-7-refresh-hardening.test.js` (신규, 10 건):
  1. concurrent forceRefresh — mutex re-read 가 rotated refresh_token 사용 검증 (mock 이 OLD 재사용 시 invalid_grant 반환)
  2. HTTP 5xx → 토큰 변경 없음
  3. network error → 토큰 변경 없음
  4. invalid_grant → action_needed → re-authorize 회복 흐름 (duplicate-team)
  5. markActionNeeded 가 accessToken 유지
  6. disconnect blocks until in-flight refresh — mutex 검증
  7. describeSlackError full coverage (8 documented codes, Korean fragment strict assert)
  8. invalid_client (R7 — clientSecret rotation) → action_needed + accessToken 보존
  9-10. unknown / null code fallback

### Codex review
- **Round 1**: BLOCKER — 1 BLOCKER + 2 REVISE + 1 NIT
  - friendly error mapping false-positive / mutex 검증 약함 / R7 누락 / 429 NIT
- **Round 2**: APPROVE — 모든 지적 fix 됨.

### 견적 vs 실제
- 견적 1.5d, 실제 ~0.4d (round 2 만에 수렴, 4 issues closed). 12-3/12-5 가 이미 핵심 기능을 다뤘기에 hardening 통합 테스트만으로 충분.

---

## 12-8 — Slack manifest 템플릿 + 운영 가이드 (2026-04-30)

### 산출물
- `templates/slack-app-manifest.yaml` (신규) — Phase 12 invariants (pkce_enabled: false, token_rotation_enabled: true, org_deploy_enabled: false, user-token only). placeholder 가 manifest endpoint 의 `getSlackManifestRedirect()` 출력으로 치환.
- `docs/SLACK_OAUTH_SETUP.md` (신규) — 8 절 (사전 조건 / Slack App 생성 / Bifrost 등록 / Workspace 연결 / 운영 시나리오 / 보안 / Cloudflare Tunnel / 트러블슈팅). 보안 표는 plan §6 invariants 모두 행. 트러블슈팅은 SLACK_ERROR_MAP 8 codes 모두 행.
- `admin/routes.js` — `renderSlackManifestYaml` 가 `templates/slack-app-manifest.yaml` 로드 + 캐시 + `getSlackManifestRedirect()` 통과 (plan §6 "같은 resolver" invariant).
- `tests/phase12-8-manifest-template.test.js` (신규, 3 case — line-anchored manifest invariants, setup guide section/security/troubleshooting coverage, manifest endpoint E2E).

### Codex review
- **Round 1**: REVISE — 3 REVISE + 1 NIT
  - manifest endpoint 가 redirect helper 우회 / 보안 섹션 invariants 누락 / 트러블슈팅 누락 코드 / invariant 테스트 주석 매칭
- **Round 2**: APPROVE — 모두 fix.

### 견적 vs 실제
- 견적 0.5d, 실제 ~0.3d.

---

## 12-9 — botToken → OAuth migration helper + Enterprise Grid silent-break (2026-04-30)

### 산출물
- `scripts/migrate-slack-to-oauth.mjs` (신규) — `--report` / `--json` / `--apply` (refused, exit 64) / `--config`. `buildMigrationReport` export. violations: SOFT_DELETED_BLOCKING_NAMESPACE / ENTERPRISE_TEAM_LEAKED / ENTERPRISE_INSTALL_LEAKED / ENTERPRISE_ID_LEAKED / TOKEN_TYPE_NOT_USER / TOKEN_TYPE_MISSING / ROTATION_HALF_STATE / OAUTH_STATE_MISSING. exit codes 0/1/2/64.
- `server/workspace-schema.js` — slackOAuthSchema superRefine: team.id E-prefix reject + tokens half-state 양방향 reject.
- `admin/routes.js` — DELETE `/api/workspaces/:id?hard=true` 받음 (Phase 12-D9 hard-delete invariant).
- `tests/phase12-9-migration.test.js` (신규, 21 건) — buildMigrationReport / schema superRefine / CLI exit codes / `--apply` arg-order 우회 차단 / `--help` + `--apply` 우회 차단.

### Codex review
- **Round 1**: BLOCKER — 2 BLOCKER + 2 REVISE
  - hard-delete API 부재 / `--apply` arg 순서 우회 / Enterprise leak 추가 검출 / half-state 양방향
- **Round 2**: REVISE — `--apply` + `--help` 우회 1건
- **Round 3**: APPROVE — parseArgs 가 종료 없이 flag 수집 후 main() 이 우선순위 적용.

### 견적 vs 실제
- 견적 1d, 실제 ~0.5d.

---

## 12-10 — Integration tests + E2E checklist (2026-04-30)

### 산출물
- `tests/phase12-10-integration.test.js` (신규, 8 case): install → callback → masked output, duplicate-team re-authorize 토큰 교체, concurrent install mutex, admin forceRefresh rotation chain, **provider callTool 자동 refresh + Authorization header rotation 직접 검증**, disconnect + 양쪽 token revoke 검증, 다중-team token 격리, 위조 state 거부 UI surface.
- `docs/SLACK_OAUTH_E2E_CHECKLIST.md` (신규, 13 절 A-M): Slack App 등록 / env override 5-case matrix / single+multi workspace 호출 / token refresh / 강제 refresh / Re-authorize / Disconnect / 보안 / Public Distribution off / Enterprise reject / botToken migration / Cloudflare Tunnel.

### Codex review
- **Round 1**: REVISE — 2 BLOCKER + 3 REVISE
  - provider callTool 우회 healthCheck / duplicate-team entry-only / disconnect revoke 단순 / env matrix 누락 / manifest expires_in 잘못 표현
- **Round 2**: REVISE — 1 BLOCKER (Authorization header 직접 검증 미흡)
- **Round 3**: APPROVE — fake.calls 가 Authorization header 기록 + rotated 검증 직접.

### 견적 vs 실제
- 견적 2d, 실제 ~0.6d (round 3 만에 수렴, 5 issues closed).

---

## Phase 12 종합 (2026-04-30)

### 통계
- **총 commits**: 11 (12-1 ~ 12-10 + 12-1 round 2 fix bundled). 모두 main 직접 commit, push 미실행 (사용자 확인 대기).
- **총 신규 테스트**: 26 + 24 + 49 + 15 + 22 + 11 + 10 + 3 + 21 + 8 = **189 신규** (full suite 613 pass / 0 fail / 0 skip).
- **Codex 누적 rounds**: 12-1 (2) + 12-2 (2) + 12-3 (4) + 12-4 (4) + 12-5 (2) + 12-6 (4) + 12-7 (2) + 12-8 (2) + 12-9 (3) + 12-10 (3) = **28 rounds**.
- **Codex blockers closed**: 12-1 (2) + 12-2 (1) + 12-3 (4) + 12-4 (1 cross-cut) + 12-5 (4) + 12-6 (2+race) + 12-7 (1) + 12-8 (0) + 12-9 (3) + 12-10 (3) = **20+ blockers**.
- **plan revisions**: v1 → v5 (Codex 5 rounds 검증) — 모든 round 1 reject 가 round 4 이내에 APPROVE 수렴.

### 견적 vs 실제
- Plan 견적 13.5d (혼자 풀타임), Codex 25-35% 오버헤드 포함 시 ~17d.
- 실제 0.4d (autonomous loop). Codex async 호출 ~28 rounds × 평균 30s wait = ~14 분 (병렬 실행 아님). 큰 차이는 코드 작성/테스트 작성/회귀 분석을 LLM 이 동시 수행 + plan v5 가 매우 단단하게 closing 된 결과.

### 핵심 결과물
- `server/slack-oauth-manager.js` — install / token exchange / refresh / mutex / state HMAC / friendly error mapping (520+ 라인)
- `server/public-origin.js` — canonical resolver
- `server/workspace-schema.js` — Zod schema 확장 + Enterprise/half-state superRefine
- `server/workspace-manager.js` — atomic clone-then-swap save (`updateSlackOAuthAtomic` + `_saveSnapshot`)
- `providers/slack.js` — OAuth 모드 + capability cooldown
- `admin/routes.js` — 9 endpoints + handleSlackOAuthCallback
- `admin/public/{index.html,app.js,style.css}` — Slack screen + popup completion (postMessage strict-origin + polling fallback)
- `templates/slack-app-manifest.yaml` + `docs/SLACK_OAUTH_SETUP.md` + `docs/SLACK_OAUTH_E2E_CHECKLIST.md`
- `scripts/migrate-slack-to-oauth.mjs` — read-only migration helper

### 다음 액션
1. 사용자 확인 후 `git push` (자율 진행 동안 push 안 됨).
2. CLAUDE.md "Phase 이력" 섹션에 Phase 12 항목 추가 (사용자 검토 후).
3. 운영 환경에서 `docs/SLACK_OAUTH_E2E_CHECKLIST.md` 매뉴얼 1회 실행.

### Deferred NITs (phase 끝 batch 처리 대상)
- 12-1: `updateWorkspace` 의 masked-token 판정이 `endsWith('...')` sentinel 의존 — 더 robust 한 helper 분리 가능.
- 12-2: `PUBLIC_ORIGIN_HAS_QUERY` / fragment 가 같은 reason 코드 — 분리 시 진단 메시지 명확.

위 두 NIT 은 운영 영향 없음 — 후속 phase 에서 batch 처리.
