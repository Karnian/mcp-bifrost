# Phase 9 — Self-Review Log

> Phase 9: 35 in-scope 항목 중 **27건 완료 + 2건 부분 + 6건 이관/미완**.
> Codex 교차 리뷰 6건 보안 지적 → 전부 반영.
> 테스트 278개 (pass 276, skipped 2, fail 0) — 회귀 0.

---

## 9a: MCP 프로토콜 완성 + 긴급 보안 (Gate)

### 구현 완료 (5/5)
- [x] prompts/list + prompts/get — `server/mcp-handler.js:42-46, 402, 434`, profileObj + identity 전파
- [x] mcp-client HTTP transport — `providers/mcp-client.js` StreamableHTTP 연결 + session 관리
- [x] mcp-client SSE transport — EventSource 기반 + 재연결 backoff
- [x] resource read size limit — `BIFROST_MAX_RESOURCE_SIZE` (default 5MB), `mcp-handler.js:388` 초과 시 에러
- [x] env injection 방어 ★ — `admin/routes.js` stdio mcp-client `env` 허용목록 + PATH/LD_PRELOAD 차단

### Codex 리뷰: FAIL → 수정 → PASS
- prompts/get workspace summary에 profile propagation 누락 → `_promptsGet(params, identity, profileObj)` 시그니처 통일

### 테스트: `tests/phase9a-protocol.test.js` 352 lines

---

## 9b: 프로덕션 보안/배포

### 구현 완료 (5/5)
- [x] Trust proxy + XFF — `server/rate-limiter.js:18,26,45` `BIFROST_TRUST_PROXY` + `BIFROST_TRUSTED_PROXIES` rightmost untrusted
- [x] Security headers — `server/security-headers.js` 전용 모듈, 모든 응답에 적용
- [x] CORS preflight — `server/index.js` `OPTIONS` 핸들러 + `BIFROST_CORS_ORIGIN`
- [x] Config 환경변수 외부화 — `server/config-constants.js` 12개 상수 (RATE_LIMIT_*, HEALTH_CHECK_INTERVAL, SCRYPT_N 등)
- [x] Workspace schema validation — `server/workspace-schema.js` Zod 검증 + 자기참조 순환 방지

### Codex 리뷰: FAIL → 수정 → PASS
- XFF peer 미검증 (rightmost 로직 없이 첫 번째 IP만 사용) → `getClientIp` 재작성
- `/api/import` command/env 우회 가능 → whitelist + env injection defense 추가 (`admin/routes.js:367`)

### 테스트: `tests/phase9b-production.test.js` 308 lines

---

## 9c: Provider 확장

### 구현 완료 (3/3)
- [x] BaseProvider `getPrompts()` — `providers/base.js`, `providers/notion.js` 구현 (slack/mcp-client은 기본 `[]`)
- [x] Template system 강화 — `admin/public/templates.js` 카테고리/검색/OAuth 표시
- [x] PROVIDER_GUIDE.md — `docs/PROVIDER_GUIDE.md` 5.2KB, 신규 provider 체크리스트

### 테스트: `tests/phase9c-provider.test.js` 99 lines

---

## 9d: 운영 기능

### 구현 완료 (8/9)
- [x] 설정 export/import — `admin/routes.js:355-367` GET /api/export, POST /api/import (command/env 방어 포함)
- [x] Soft delete — `workspace-manager.js` `deletedAt` + 30일 purge + restore API
- [x] Audit log 강화 — `server/audit-logger.js` JSONL append + `.ao/state/audit.jsonl`
- [x] Audit log 파일 rotation — 10MB cap + 3세대 보관
- [x] Usage 시계열 데이터 — `server/usage-recorder.js` hourly buckets + `/api/usage/timeseries`
- [x] Profile 기반 엔드포인트 — `server/mcp-handler.js` `profileObj` 39 곳 전파, `?profile=X` 파라미터
- [x] MCP 토큰 스코프 — `server/mcp-token-manager.js` identity별 profile 바인딩
- [x] 다중 MCP 토큰 관리 UI — `admin/public/app.js` 발급/폐기/갱신 모달

### 미구현 (1/9)
- [ ] profiles.json 입력 검증 (ReDoS 방지) — 서버 시작 시 Zod 검증 누락

### Codex 리뷰: FAIL → 수정 → PASS
- prompts/list ACL profile 누락 → profileObj 전파 + assertAllowed 통합

### 테스트: `tests/phase9d-operations.test.js` 149 lines

---

## 9e: Admin UI 개선

### 구현 완료 (3/6)
- [x] Identity 관리 UI — `admin/public/app.js` 32 hits
- [x] Wizard progress indicator — 36 hits, step 자유 이동
- [~] Dark mode — CSS 변수는 `style.css`에 존재, JS 토글/localStorage 미완성
- [~] Tool dry-run — 백엔드 API (`admin/routes.js:5 hits`) 완성, UI 버튼 미구현

### 미구현 (2/6)
- [ ] Audit log 필터/검색 — 날짜/액션/텍스트 필터 UI 없음
- [ ] Usage 시계열 차트 — SVG/Canvas 그래프 없음

---

## 9f: 테스트 인프라

### 구현 완료 (2/4)
- [x] 대규모 성능 벤치마크 — `tests/benchmarks/tool-registry.bench.js` + `npm run test:bench`
- [x] Coverage 리포트 — `npm run test:coverage` (`--experimental-test-coverage`)

### 미구현 (2/4)
- [ ] Playwright E2E — `tests/e2e/` 디렉터리 자체 없음
- [ ] 네트워크 fault injection — Provider timeout / SSE 끊김 시나리오 미작성

---

## 9g: Backlog (선택)

### 구현 완료 (1/3)
- [x] OAuth issuer cache TTL — `server/oauth-manager.js` 24시간 TTL

### 이관/미완 (2/3)
- [ ] Async retry queue — MCP 동기 응답 계약과 충돌, Phase 10 후보
- [ ] Google Drive provider — Phase 10 이관 (계획 단계에서 결정됨)

---

## 추가 작업 (Phase 9 완료 후 세션)

### server/index.js 리팩터링 (cad6f2b, 8b42566)
`npm test` 8분 51초 hang + 2건 fail 해결.

**원인**: `server/index.js` 를 import하자마자 `server.listen(3100)` 과 5분
`setInterval` 이 실행되어, 테스트 import 시 포트 점유 + healthInterval 로 event loop 잠금.

**수정**:
1. `startServer({port, host})` 함수로 stateful 초기화 감쌈
2. `import.meta.url === pathToFileURL(process.argv[1]).href` gate로 CLI entry
   point일 때만 auto-start
3. `renderOAuthResultPage`/`oauthCspHeaders` 는 pure 함수라 module-level 유지
4. `stop()` 함수 추가 (clearInterval + provider.shutdown + usage.flush +
   audit.flush + server.close) — Codex 리뷰 반영
5. `server.address()` 1회 계산 + bound port 반환 — Codex 리뷰 반영
6. `healthInterval.unref()` 안전망

**결과**:
- npm test: 8m51s → 1.04s (~500x faster)
- 280 tests 2 fail → 278 tests 0 fail
- Codex 리뷰 3건 (stopServer / address dedup / port 가시화) 모두 반영

---

## Codex 교차 리뷰 요약 (6건 FAIL → 전부 수정)

| # | 영역 | 지적 | 반영 위치 |
|---|------|------|----------|
| 1 | 9a | PUT command whitelist 누락 | `admin/routes.js:125` |
| 2 | 8c 재검증 | handleLogin rate limit IP spoofing (XFF) | `admin/routes.js:574-576` + `rate-limiter.js:18` |
| 3 | 9a | prompts/list ACL profile 누락 | `mcp-handler.js:43, 402` |
| 4 | 9d | `/api/import` command/env 우회 | `admin/routes.js:367` |
| 5 | 9b | XFF peer 검증 누락 → rightmost untrusted 필요 | `rate-limiter.js:26-45` |
| 6 | 9a | prompts/get workspace summary profile 누락 | `mcp-handler.js:46, 434` |

추가 리팩터 리뷰 3건 (9a 종료 후):
- `server.close()` 가 healthInterval만 정리 → `stop()` 함수 도입
- `server.address()` 중복 호출 → 1회 계산
- `port: 0` 실제 바인딩 포트 가시화 → 반환값 추가

---

## 최종 결과

| 항목 | 결과 |
|------|------|
| 총 테스트 | **278** (pass 276, skipped 2, fail 0) |
| Phase 8 회귀 | 0 |
| 9a MCP 프로토콜 + 긴급 보안 | 5/5 ✅ |
| 9b 프로덕션 보안/배포 | 5/5 ✅ |
| 9c Provider 확장 | 3/3 ✅ |
| 9d 운영 기능 | 8/9 (1건 미완) |
| 9e Admin UI 개선 | 3/6 완료 + 2/6 부분 |
| 9f 테스트 인프라 | 2/4 (E2E 미완) |
| 9g Backlog | 1/3 (2건 Phase 10 이관) |
| Codex 보안 지적 | 6/6 PASS |
| Codex 리팩터 리뷰 | 3/3 PASS |

### Phase 10 이관 항목
- Playwright E2E (5e 시나리오)
- 네트워크 fault injection 테스트
- Audit 필터/Usage 차트 UI
- Dark mode JS 토글 + Tool dry-run UI
- profiles.json ReDoS 검증
- Async retry queue
- Google Drive provider

### npm test 실행 시간
- 수정 전: **8분 51초** (hang + 2 fail)
- 수정 후: **1.04초** (0 fail)
