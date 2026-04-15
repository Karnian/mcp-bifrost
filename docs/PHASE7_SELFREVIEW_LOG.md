# Phase 7 Self-Review Log

Codex 사용은 가능하지만 (`pong` 테스트 정상), 실제 리뷰 프롬프트 실행 시 `auth_failed: Codex process failed` 로 exit. 브리프 §1.3 fallback 에 따라 critical self-review 모드로 전환.

---

## 7e-pre (2026-04-15) — PASS (self-review)

**산출물**: `docs/NOTION_STREAM_PROBE.md` (신규)

**체크리스트 대비** (브리프 §2 7e-pre):
- [x] `GET https://mcp.notion.com/mcp` with `Accept: text/event-stream` 수행 → 응답 헤더/바디 raw 기록
- [x] `Mcp-Session-Id` 관련: 401 단계에서 미발급 명시, 인증 후 재검증은 E2E 로 이관 기록
- [x] content-type 확인: 401 응답은 `application/json` (인증 후 stream 은 `text/event-stream` 가정은 spec §3.3 참조로 기록)
- [x] Spec 과 어긋나는 분기 없음 — Phase 7e 체크리스트 업데이트 불필요

**자체검증 포인트**:
1. **Spec 준수성**: WWW-Authenticate 포맷 (RFC 6750 + RFC 9728 resource_metadata) 이 Phase 6-pre 결과와 동일. GET/POST 응답 구조가 대칭 → `providers/mcp-client.js` 의 기존 `_buildHeaders` 재사용 가능하며 분기 불필요.
2. **CORS**: OPTIONS 204 + `access-control-allow-methods: *` + `Authorization` 헤더 허용 → 브라우저 기반 클라이언트도 동일 경로 가능. Phase 7e 는 서버사이드 proxy 만 구현하므로 영향 없음.
3. **미확인 영역 문서화**: `Mcp-Session-Id` 수명/재사용, stream idle timeout, notification TTL 은 실제 access_token 이후에만 확인 가능 → NOTION_STREAM_PROBE.md §2 에 "E2E 재검증 필요" 로 명시 + Phase 7 E2E 체크리스트 (#E2E-6) 에 등재 예정.
4. **설계 반영**: §3 에 stream open 조건 (tokens 존재 시만, warm-up 차단 재사용), 헤더 구성, 파싱 규칙, 재연결 backoff, 401 경로 5개 결정사항 확정.

**테스트**: 코드 변경 없음. 95 tests pass (기준선 유지).

**판정**: PASS. Phase 7e 구현 시 예외 분기/사전조사가 추가로 필요하지 않음.

---

## 진행 상태 스냅샷 (2026-04-15 세션 종료 시점) — 초기

**완료**: 7e-pre (probe 문서)

**진행 중/미착수**: 7b, 7a, 7d, 7f, 7c-pre, 7c, 7e, 7g, 통합/회귀/E2E

---

## Phase 7 전체 완료 기록 (2026-04-15 후속 세션, Codex PASS 경로)

이전 세션 종료 이후 Codex 어댑터를 `web_search = "live"` 로 교정한 직후 이어
자율 실행. 각 phase 는 Codex async 리뷰 → REVISE 반영 → 재리뷰 → PASS 사이클을
엄수했습니다.

### 7b — 다중 MCP 토큰 + ACL (commit `f73fa3f`)
- REVISE 3건: (1) PHASE7_PLAN 문서가 bcrypt 잔재 → scrypt 로 수정, (2) Admin UI
  Tokens 탭 미구현 → topbar 버튼 + screen + issue/rotate/revoke 핸들러 추가,
  (3) `/api/connect-info` 가 `wm.getMcpToken()` 만 확인 → `tokenManager.
  isConfigured()` + `hasLegacyToken`/`persistedTokenCount` 로 확장.
- 최종: 115 tests (+20). Codex PASS.

### 7a — Profile endpoint (commit `cd4a652`)
- 1회만에 PASS. `config/profiles.json` 외부화는 생략 (§2 승인 기본값 준수:
  `config/workspaces.json > server.profiles`). JSON editor + preview 5-tool
  샘플. matchPattern 이 originalName + namespaced 이름 양쪽 매칭.
- 최종: 121 tests (+6). Codex PASS.

### 7d + 7f — 수동 DCR UI + Remote 템플릿 (commit `23d9dc0`)
- REVISE 2건: (1) 7d 테스트가 UI → /authorize HTTP 경로를 직접 검증하지 않아
  실제 fallback 회귀를 못 잡음 → `http.createServer + createAdminRoutes` 로
  라이브 라우터 기동 후 body `{}` → 422, `{ manual }` → 200 검증 추가.
  (2) 7f 템플릿 URL 이 probe 없이 상수 비교만 → 실제 `node scripts/probe-
  templates.mjs` 실행, github/linear/notion 모두 `401 + WWW-Authenticate +
  resource_metadata` 정상 확인 후 docs/TEMPLATES_PROBE.md 에 raw 기록.
- 최종: 129 tests (+8). Codex PASS.

### 7c-pre — byIdentity migration shim (commit `340b790`)
- **Gate**: Phase 6 baseline 95 건 전수 통과 확인 후 진행.
- REVISE 3건: (1) `_persistTokens` 의 `existing` fallback 이 non-default
  identity 에도 legacy `ws.oauth.tokens` 를 참조 → default refresh_token 이
  non-default 로 누수 가능. `identity === 'default'` 일 때만 fallback.
  (2) `providers/mcp-client.js` 의 tokenProvider/onUnauthorized 가 아직 0-arg
  호출만 → constructor 에 identity default + `_buildHeaders(identity)` +
  `_rpcHttp({...identity})` 로 전파. (3) `workspace-manager.maskOAuth` 가
  `byIdentity[*].tokens` 를 마스킹하지 않아 Admin API GET /workspaces 응답에
  실제 access/refresh 토큰이 노출됨 → `maskTokenEntry` helper 로 두 구조 모두
  마스킹.
- 최종: 139 tests (+10). Codex PASS after 3-round REVISE.

### 7c — byIdentity OAuth 격리 (commit `81cd635`)
- REVISE 2건: (1) `/authorize` 의 identity 검증이 discover/register/_save 뒤에
  있어 invalid identity 가 부수효과 남긴 후 400. 검증을 진입 초반으로 이동.
  (2) `body?.identity || 'default'` 패턴이 explicit empty string 도 'default'
  로 coerce → `undefined/null` 만 기본값, `""` 는 regex 에서 탈락.
- 최종: 143 tests (+4). Codex PASS.

### 7e — HTTP/SSE notification subscription (commit `1d7f0fc`)
- REVISE 2건: (1) `_rpcHttp` 가 `_pending` 에 요청을 등록하지 않아 stream 경유
  JSON-RPC 응답 매칭이 실질적으로 unreachable → POST 전 `_pending.set` + 202/
  204 시 stream promise 대기, 성공/실패 cleanup 보장. (2) SSE 파서가 `\n\n`만
  처리하고 `\r\n\r\n` (RFC 준수 CRLF) 는 미지원 → 두 경계 모두 지원, 이벤트
  내부도 `/\r?\n/` split.
- 최종: 152 tests (+9). Codex PASS.

### 7g — Usage + Audit (commit `2003913`)
- REVISE 1건: `audit.jsonl` 의 `identity` 필드가 항상 null. `WorkspaceManager.
  logAudit(action, workspace, details)` 가 3-arg 만 받고 OAuthManager 가
  identity 를 JSON 문자열에만 넣음 → 4번째 positional arg identity 추가, 4개
  oauth.* 경로 모두 전달. 주석도 정정.
- 최종: 160 tests (+8). Codex PASS after 2 REVISE rounds (마지막은 주석 명확
  성만).

---

## 최종 카운트

- Baseline: 95 tests (Phase 6 종료 시점)
- Phase 7 증가: +65 tests
- **최종: 160 tests / 158 pass / 2 skipped / 0 fail** (skipped 2 건은 Phase 6
  integration 의 env-gated live Notion 테스트 유지)

## 주요 발견 및 학습

1. **Codex 샌드박스는 `listen EPERM`** 으로 HTTP integration tests 를 자체
   실행 못 함. 로컬 `npm test` 에서는 모두 PASS. 리뷰 요청 시 이 점을 명시해
   Codex 가 코드 판단에 집중하도록 유도했음.
2. **Masking coverage 누락 패턴**: 새 데이터 구조 (byIdentity) 도입 시 UI
   노출 경로 (masked=true) 를 함께 업데이트해야 함. Codex 가 7c-pre 3회차
   리뷰에서 잡아줌.
3. **Identity 전파의 실제 경로**: audit log 의 identity 필드가 비어 있을
   위험. `logAudit` 시그니처를 조용히 3-arg 유지하지 말고, identity 를
   positional 로 명시하는 것이 sane default.
4. **flush 재귀 체이닝**: UsageRecorder 의 flush 가 "진행 중이면 기존 Promise
   반환" 패턴이었으나 그 동안 enqueue 된 이벤트는 flush 안 됨. `.then(() =>
   this.flush())` 로 체이닝해 drain 보장.
5. **Pre-registration pattern for streamable HTTP**: `_rpcHttp` 가 기존엔
   self-contained (POST 응답만) 였으나 2025-06-18 streamable HTTP spec 의
   202-Accepted + stream-delivered response 를 지원하려면 `_pending` 등록이
   필수.

## 산출물 체크리스트

- [x] `docs/NOTION_STREAM_PROBE.md` (7e-pre, 기존)
- [x] `docs/PHASE7_SELFREVIEW_LOG.md` (이 파일, 누적 업데이트)
- [x] `docs/PHASE7_E2E_CHECKLIST.md` (14항목)
- [x] `docs/TOKEN_RECOVERY.md`
- [x] `docs/TEMPLATES_PROBE.md`
- [x] README Single-User 경고 → 선택사항 전환 (Phase 7 multi-tenant 안내 추가)
- [x] `npm test` ≥ 135 (실제 160)
- [x] Phase 별 commit (각 "codex PASS" 명시)

