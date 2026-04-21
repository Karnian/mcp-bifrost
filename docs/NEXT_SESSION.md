# 다음 세션 핸드오프

**마지막 세션 완료일**: 2026-04-22
**마지막 완료 Phase**: 10a — OAuth Client Isolation (Codex R11 APPROVE)

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

### 1. R10 regression test 강화 (Codex R11 non-blocking 권고)
**파일**: `tests/phase10a-oauth-isolation.test.js:1037` (§4.10a-5 Codex R10 blocker 1 regression)
**현재**: rotation 이 `_workspaceMutex` 에 의해 gate 됨만 검증
**개선**: 실제 acquisition 순서 instrumentation 으로 `workspace → identity` 확정. 예: `_withIdentityMutex` wrapper 를 일시 instrumentation 해서 순서 기록 후 assertion.
**규모**: 소 (30분)

### 2. Rotate-client helper 통합 (Codex R4 제안)
**위치**: `admin/routes.js` 의 3개 rotation path (`POST /api/workspaces/:id/oauth/register`, `PUT /api/workspaces/:id/oauth/client`, `POST /api/workspaces/:id/oauth/authorize`)
**현재**: 각 path 가 거의 동일한 rotation 로직 반복 (cache purge + pending purge + token invalidation + action_needed + provider recreate)
**개선**: 단일 `_rotateClientAndInvalidate(wsId, newClient, reason)` helper 로 추출. Drift 방지.
**규모**: 중 (2~3시간). 테스트 추가 + Codex 리뷰 1~2 rounds 예상

### 3. Flat-field mirror 제거 (Phase 10a 의 deprecation 완료)
**위치**: `server/oauth-manager.js` 의 `_persistTokens` (line ~840) — 현재 `ws.oauth.client.*` + `ws.oauth.{clientId,clientSecret,authMethod}` 평면필드 이중 기록
**현재**: `§3.4 Phase 10a 플랜` — 최소 1 릴리즈 호환 유지 후 제거 예정
**필요 작업**:
- 모든 read 경로가 nested `client.*` 만 참조하는지 확인
- `workspaces.example.json` 에서 평면필드 제거
- 마이그레이션: nested only 로 저장 + Phase 11 버전 경고 추가
- 테스트: phase6/7c 의 legacy 평면필드 기대 테스트 삭제/갱신
**규모**: 중 (반일)

### 4. `server/oauth-metrics.js` 본격 구현 (§6-OBS.2 플랜 deferred)
**현재**: audit event 는 기록되지만 counter 집계 없음
**필요 작업**: `OAuthMetrics` 클래스 구현 — lightweight in-memory Map 으로 `oauth_threshold_trip_total`, `oauth_dcr_total{status}`, `oauth_refresh_total{status}`, `oauth_cache_hit_total / miss_total` 집계. Admin UI `/api/oauth/metrics` 엔드포인트 노출.
**규모**: 중 (반일)

### 5. §12-2 Admin Wizard — Static client 발급 UX
**목적**: 운영자가 Notion integration 페이지에서 static client 직접 발급하는 과정을 Admin UI 에서 안내
**현재**: `POST /api/workspaces/:id/oauth/register` API 는 이미 존재. UI wizard 만 없음.
**필요 작업**: `admin/public/app.js` 에 "Add workspace" 플로우 확장 — Step 2b 에 Notion integration 생성 안내 + 복사 가능한 redirect URI + client_id/secret 입력 폼
**규모**: 소 (1일 미만, 백엔드 변경 없음)

### 6. `__global__` namespace 강화 (Codex R1 non-blocking)
**위치**: `server/oauth-manager.js:_cacheKey` — 현재 `__global__::${issuer}::${authMethod}` legacy 호환
**개선**: `ws::` / `global::` prefix 로 더 엄격한 schema 분리. 테스트/legacy 경계 명확화.
**규모**: 소 (2~3시간)

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
