# 다음 세션 핸드오프

**마지막 세션 완료일**: 2026-04-22 (Phase 11 전체 후보 소진)
**마지막 완료 Phase**: 11-9 — Admin Wizard Static client UX (Codex R1 APPROVE)
**이번 세션 추가 Phase**: 11-6 (metrics cardinality) · 11-7 (cache key schema) · 11-8 (watcher atomic-replace) · 11-9 (static client wizard)
**이전 완료 Phase**: 11-5 (refresh timeout AbortController) · 11-4 (OAuthMetrics recorder) · 11-1/2/3 · 10a

---

## 현재 상태 (새 세션 시작 시점)

### 코드베이스
- **브랜치**: `master`
- **마지막 커밋**: `1fbd1ff docs(phase10a): R11 APPROVE — Phase 10a production-ready`
- **working tree**: 거의 깨끗 (`.ao/state/*` 런타임 파일만 untracked — 무시해도 됨)
- **테스트**: `npm test` → 327 tests / 325 pass / 0 fail / 2 skipped

### 완료된 최근 작업 요약
Phase 10a — 같은 OAuth issuer 에 여러 workspace 연결 시 refresh-token supersede 로 발생하던 401 무한 루프를 해소. 11 rounds Codex 리뷰를 거쳐 17 blockers 전부 close, APPROVE 받음.

핵심 산출물:
- `server/oauth-manager.js` — workspace-scoped DCR cache, `_workspaceMutex` + `_identityMutex` FIFO chain, DCR 에러 분류
- `server/workspace-manager.js` — nested `ws.oauth.client.*` 구조 + 평면필드 mirror (Phase 11 deprecation 예정)
- `providers/mcp-client.js` — `getStreamStatus()` 8-state enum
- `admin/routes.js`, `admin/public/app.js` — workspace 별 OAuth client 관리 UI
- `scripts/migrate-oauth-clients.mjs` — `--dry-run | --apply | --restore`
- `tests/phase10a-*.test.js` — 47 신규 tests
- `docs/OAUTH_CLIENT_ISOLATION_PLAN.md` — 플랜 (Codex R10 APPROVED baseline)
- `docs/PHASE10a_SELFREVIEW_LOG.md` — 전체 리뷰 이력

---

## 환경 주의사항

### ⚠️ 반드시 확인
1. **`config/workspaces.json` 은 gitignored** — 토큰 포함, 절대 커밋 금지. 새 세션 시작 시 편집은 OK, 커밋은 NO.
2. **Node 버전** — 프로젝트는 Node 20.x 기준 (이전 세션에서 20.19.6 확인됨). Node 25+ 는 `node --test` 인자 해석 달라지니 주의.
3. **Gemini CLI** — 설치되어 있지만 **`GEMINI_API_KEY` 미설정** 상태. `/ask gemini` 호출 시 auth error. `/ask codex` 는 정상 동작. 필요 시 `agent-olympus:setup-gemini-auth` 또는 `GEMINI_API_KEY` 환경변수 설정.
4. **Codex async 은 5~10분 소요** — `node --test ...` 를 sandbox 에서 돌리려다 `listen EPERM` 으로 adapter `auth_failed` 분류 버그 발생 가능. 실제 turn 은 정상 완료될 수 있으니 artifact 의 `agent_message` 최종 라인을 직접 확인.

### 마이그레이션 실행 (Phase 10a 프로덕션 배포 시)
```bash
# 1. 검토 (쓰기 없음)
node scripts/migrate-oauth-clients.mjs --dry-run

# 2. 적용 (workspaces.json.pre-10a.bak 자동 생성, 0o600)
node scripts/migrate-oauth-clients.mjs --apply

# 3. (선택) 롤백
node scripts/migrate-oauth-clients.mjs --restore
```

공유 clientId 를 쓰던 workspace 가 있으면 **강제 재인증** 요구됨. 운영자에게 사전 공지 필요.

---

## Phase 11 후보 (우선순위 순)

### ~~1. R10 regression test 강화 (Codex R11 non-blocking 권고)~~ ✅ **완료 2026-04-22**
**커밋**: `34a9c81` — 2 새 테스트 (rotateClientUnderMutex / completeAuthorization 모두 instrumented acquisition order 검증)
**Codex**: R1 APPROVE (1 round). non-blocking 권고 2 건 (shared helper 추출, specific identity assertion) 모두 반영.

### ~~2. Rotate-client helper 통합 (Codex R4 제안)~~ ✅ **완료 2026-04-22**
**커밋**: `85dd3a7` (초안) + `f326be3` (Codex R1 blocker fix — pending purge inside _workspaceMutex)
**Codex**: R1 CONDITIONAL (same-client manual rotation stale-callback window) → R2 APPROVE (pending purge moved inside mutex). 2 rounds.
**산출물**: `admin/routes.js._rotateClientAndInvalidate` 헬퍼 — 3개 경로 전부 consolidated. 2 새 consistency 테스트 + 1 R1 regression 테스트.

### ~~3. Flat-field mirror 제거 (Phase 10a 의 deprecation 완료)~~ ✅ **완료 2026-04-22**
**커밋**: `1664049` (초안) + `278fceb` (Codex R1 NEEDS_WORK fixes) + `<HEAD>` (Codex R2 CONDITIONAL fixes)
**Codex**: R1 NEEDS_WORK (hot-reload bypass + in-memory-only startup migration + client===null+flat-null 누락) → R2 CONDITIONAL (silent _save failure + admin UI flat fallback + watcher atomic-replace gap) → R3 expected APPROVE. 3 rounds.
**산출물**:
- `server/oauth-manager.js._persistTokens`, `admin/routes.js._rotateClientAndInvalidate` — nested-only write + 평면필드 적극 scrub
- `server/workspace-manager.js._migrateLegacy` — boolean `mutated` 반환, 3가지 케이스(flat-only, nested+flat drift, client===null+flat-null) 모두 scrub
- `server/workspace-manager.js.load` — startup 시 migration 결과 persist (failure 로깅)
- `server/workspace-manager.js._startFileWatcher` — hot-reload 경로에도 _migrateLegacy 적용
- `scripts/migrate-oauth-clients.mjs` — `report.flatScrubbed: [{id}]` 추가
- `admin/public/app.js` — flat-field fallback 제거
- 5 새 테스트 (flat scrub, mutated flag, null case)

### ~~4. `server/oauth-metrics.js` 본격 구현 (§6-OBS.2 플랜 deferred)~~ ✅ **완료 2026-04-22**
**커밋**: `<HEAD>` — OAuthMetrics 클래스 + 4개 counter + admin endpoint + 29개 테스트
**Codex**: R1 CONDITIONAL (refresh timeout 시 late-success 가 `ok` 이중 카운트하는 race) → R2 APPROVE (outer try 블록으로 `ok` 이동, admin snapshot try/catch, regression test 3건 추가). 2 rounds.
**산출물**:
- `server/oauth-metrics.js` — `OAuthMetrics` class (stable label 직렬화, defensive snapshot) + `dcrStatusBucket` helper
- `server/oauth-manager.js` — constructor 에 `metrics` 옵션, `_metric()` private helper, cache hit/miss/expire + DCR 4-bucket + refresh ok/fail_4xx/fail_net + threshold_trip instrumentation
- `server/index.js` — `new OAuthMetrics()` 생성 → OAuthManager + admin routes 양쪽 주입
- `admin/routes.js` — `GET /api/oauth/metrics` endpoint (broken recorder 시 `wm.logError('oauth.metrics', ...)` 후 빈 배열 degrade)
- `tests/phase11-4-oauth-metrics.test.js` — 29 tests (unit + integration + admin API + late-success regression + NO_REFRESH_TOKEN/TOKEN_ENDPOINT_UNKNOWN + action_needed contract)

### ~~5. §12-2 Admin Wizard — Static client 발급 UX~~ ✅ **완료 2026-04-22 (Phase 11-9)**
**커밋**: `<HEAD>` — `GET /api/oauth/redirect-uri` 엔드포인트 + `bifrostModal({ bodyHtml })` 옵션 + `STATIC_CLIENT_GUIDES` (Notion/GitHub) + copyable redirect URI + CSS 가이드 스타일 + 3 tests
**Codex**: R1 APPROVE (blocker 없음). 2 non-blocking 반영 — clipboard fallback `selectAllChildren` / admin API 실패 시 Promise.all graceful degrade.

### ~~6. `__global__` namespace 강화~~ ✅ **완료 2026-04-22 (Phase 11-7)**
**커밋**: `<HEAD>` — `_cacheKey` schema 갱신 + `_migrateLegacyCacheKeys` 추가 + `removeClient` prefix 갱신 + hardcoded test 갱신 + 15 tests
**Codex**: R1 CONDITIONAL (IPv6 literal + RFC 8414 path issuer migration miss) → R2 APPROVE. 2 rounds.
**산출물**: 신규 key schema `ws::${wsId}::${issuer}::${authMethod}` / `global::${issuer}::${authMethod}`. first/last delimiter 기반 parser 로 issuer 에 `::` 포함 OK. `KNOWN_AUTH_METHODS` set 으로 pass-through 보수적 처리.

### ~~7. Watcher atomic-replace gap~~ ✅ **완료 2026-04-22 (Phase 11-8)**
**커밋**: `<HEAD>` — `_startFileWatcher` 가 `rename` 도 처리 + watcher rebind (new inode) + `configDir` DI + 50ms grace + 5 tests
**Codex**: R1 CONDITIONAL (mutated hot-reload 시 `_save()` 와 rebind 경합 → watcher stale 가능성) → fix (rebind 를 `savePromise.finally(...)` 로 sequencing) → regression test 재현.
**산출물**: `WorkspaceManager({ configDir })` DI, rename 이벤트 수용, mutated migration save 완료 후 rebind.

### ~~8. Refresh timeout + AbortController~~ ✅ **완료 2026-04-22 (Phase 11-5)**
**커밋**: `<HEAD>` — `_tokenRequest(…, { signal })` optional arg + `_runRefresh` 에 `AbortController` 통합 + post-fetch guard + 7 신규 tests
**Codex**: R1 APPROVE (1 round, blocker 없음). 반영 권장 2건 모두 수용 — (a) scenario 1 deterministic refactor (`setImmediate` → abort-observed promise), (b) quiesced state revive 방지 테스트 (timeout → markAuthFailed → late resolve) 명시적 추가.
**산출물**:
- `server/oauth-manager.js._tokenRequest` — 4번째 `{ signal }` optional arg, `fetchInit.signal` forward. authorize 경로 호환.
- `server/oauth-manager.js._runRefresh` — `AbortController` 생성 → `_tokenRequest({ signal })` + timeout `setTimeout` 에서 `controller.abort()` 를 `reject` 전에 호출 + post-fetch `if (controller.signal.aborted) throw REFRESH_ABORTED` guard (signal-ignoring stub 커버).
- `tests/phase11-5-refresh-abort.test.js` — 7 tests (standards fetch / stub fetch / signal passthrough / backwards compat / happy path ok 유지 / phase6c 호환 / quiesced state revive 방지).

### ~~9. OAuthMetrics cardinality cap / workspace-delete cleanup~~ ✅ **완료 2026-04-22 (Phase 11-6)**
**커밋**: `<HEAD>` — `OAuthMetrics.pruneWorkspace(wsId)` + soft cap (default 10_000, insertion-order evict) + `size()` + `OAuthManager.removeClient` 에서 prune 호출 + 12 tests
**Codex**: R1 APPROVE (blocker 없음, non-blocking 없음).

---

## Phase 11 전체 완료 — 남은 후속 후보 (모두 non-blocking/선택적)

- **Admin `size()` saturation 엔드포인트** — Phase 11-6 Codex R1 non-blocking. `/api/oauth/metrics/status` 같은 경로에서 `{ entries, maxEntries, capped, evictionsTotal }` 반환.
- **`STATIC_CLIENT_GUIDES` hostname 기반 매칭** — Phase 11-9 Codex R1 non-blocking. 현재 substring match → `new URL(url).hostname` 로 전환 (false positive 방지).
- **unknown-authMethod legacy key `removeClient` overmatch** — Phase 11-7 Codex R2 non-blocking. 현재 `ws::` prefix 만 purge → legacy pass-through 형태는 잔존. `private_key_jwt` 같은 미래 enum 추가 시 coordination 필요.
- **Watcher rename 후 re-migration loop 회피** — Phase 11-8 후속 hardening 후보. 현재 save-before-rebind sequencing 으로 기본 race 는 닫음.
- **Frontend unit test (`guideFor`, `renderStaticClientBody`)** — Phase 11-9 Codex R1 nice-to-have.

---

## 바로 시작하려면

### 새 세션에서 컨텍스트 빠르게 파악하기
```bash
# 1. 프로젝트 상태
git -C /Users/K/Desktop/sub_project/mcp-bifrost log --oneline -15
git -C /Users/K/Desktop/sub_project/mcp-bifrost status

# 2. 최근 Phase 로그
cat docs/PHASE10a_SELFREVIEW_LOG.md | head -100

# 3. 플랜 문서 (완료 상태 확인)
head -20 docs/OAUTH_CLIENT_ISOLATION_PLAN.md

# 4. 테스트 baseline
npm test 2>&1 | tail -10
```

### Codex async 리뷰 사용법 (새 세션에서도 동일)
```bash
# Fire
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3/scripts/ask.mjs async codex <<'EOF'
<질문>
EOF

# 수집 (5~10분 wait)
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3/scripts/ask.mjs collect <jobId> --wait --timeout 900

# 실패 상태로 나와도 artifact 확인
grep -n "agent_message" .ao/artifacts/ask/<jobId>.jsonl | tail -1
```

---

## 주요 참고 문서 (새 세션용)

| 문서 | 내용 |
|------|------|
| `CLAUDE.md` | 프로젝트 기본 가이드 (명령어, 아키텍처, 보안, Phase 이력) |
| `README.md` | 사용자 관점 README (Status 섹션 최신) |
| `docs/SPEC.md` | 전체 기획 (Phase 1~4 완료 상태, 5+ 는 각 PLAN 문서 참조) |
| `docs/OAUTH_CLIENT_ISOLATION_PLAN.md` | Phase 10a 플랜 (완료 마크 포함, 651 lines) |
| `docs/PHASE10a_SELFREVIEW_LOG.md` | Phase 10a 리뷰 이력 (11 rounds, 17 blockers close) |
| `docs/PHASE9_PLAN.md` / `PHASE9_SELFREVIEW_LOG.md` | Phase 9 참고 |
| `docs/PROVIDER_GUIDE.md` | 새 provider 추가 가이드 |
| `docs/USAGE.md` | 운영 가이드 |

---

## 기타 메타

- **Gemini 인증 설정** 필요하면: `gemini /auth` 에서 Google OAuth 로그인 또는 `export GEMINI_API_KEY=...`
- **Node v25+ 사용 시**: `package.json` 의 `"test": "node --test tests/"` 가 거부될 수 있음. 해결: `node --test tests/*.test.js` 로 전환하거나 Node 20 LTS 고정 (`.nvmrc` 추가 고려).
- **ao auto-wip 커밋 훅** 이 편집 단위로 자동 commit. 의도적 descriptive commit 이 필요하면 수동으로 `feat:`, `fix:` prefix 로 별도 커밋 권장 (Phase 10a 커밋들처럼).

---

**새 세션에서 바로 시작 가능.** Phase 11 후보 중 **1번 (R10 regression test 강화)** 이 가장 작고 독립적이라 아이스브레이커로 적합.
