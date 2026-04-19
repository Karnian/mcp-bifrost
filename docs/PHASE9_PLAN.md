# Phase 9 — Feature Expansion & Production Readiness

**작성일**: 2026-04-19
**범위**: SPEC.md Phase 4 잔여 항목 + Phase 8 §11 후보 + 코드베이스 분석 신규 발굴
**주요 목표**: MCP 프로토콜 완성도 향상, 신규 provider 확장, 프로덕션 배포 준비

---

## 1. 배경과 동기

### Phase 8 이 완성한 것
Phase 1a~8e 전항목 완료 (205+ tests, 0 fail). 보안 5건, 안정성 8건, 코드 품질 10건 해소.
MCP Bifrost는 **로컬/개인 사용 수준에서 프로덕션 수준의 보안·안정성**에 도달.

### SPEC.md 로드맵 대비 현황
| Phase | 상태 | 미완료 |
|-------|------|--------|
| 1a MCP Core | ✅ 완료 | — |
| 1b 운영 품질 | ✅ 완료 | — |
| 1.5 Slack + Diagnostics | ✅ 완료 | — |
| 2 Auth & Connect Guide | ✅ 완료 | — |
| 3 Tunnel & Distribution | ✅ 완료 | — |
| 4 Advanced | ⚠️ 부분 완료 | 추가 provider, export/import, soft delete, Profile 엔드포인트 |

### Phase 9 의 방향
1. **MCP 프로토콜 완성** — prompts 엔드포인트, mcp-client HTTP/SSE transport
2. **Provider 확장** — MCP-client 기반 범용 연결 강화 (Google Drive 등)
3. **프로덕션 배포** — trust proxy, security headers, config 외부화
4. **운영 편의** — export/import, soft delete, 감사 로그 강화

### 비목표 (Out of Scope)
- Admin UI SSO (Google/Microsoft OAuth) — 별도 인증 인프라 필요, Phase 10+
- Admin UI SPA 프레임워크 전환 — 현재 vanilla JS로 충분, 기능 안정 후 고려
- Per-user 데이터 암호화 / OS keychain — 멀티유저 시나리오 미성숙
- Multi-process advisory file lock — 단일 프로세스 전제 유지 (PM2 cluster 등은 Phase 10+)
- WebSocket 실시간 tailing — SSE로 충분, 양방향 필요 시점 재검토

---

## 2. 스코프 요약

### In-scope (35건)

| 그룹 | 항목 수 | 성격 |
|------|---------|------|
| 9a MCP 프로토콜 완성 + 긴급 보안 | 5 | prompts 엔드포인트, mcp-client HTTP/SSE transport, resource size limit, env injection 방어 |
| 9b 프로덕션 보안/배포 | 5 | trust proxy, security headers, CORS, config 환경변수화, workspace schema validation |
| 9c Provider 확장 | 3 | provider 개발 가이드, BaseProvider prompts 인터페이스, template system 강화 |
| 9d 운영 기능 | 9 | export/import, soft delete, audit log 필터링+파일 rotation, usage 시계열, profile 엔드포인트, profile 입력 검증 |
| 9e Admin UI 개선 | 6 | identity 관리 UI, tool dry-run, wizard progress, dark mode, 감사 로그 필터 |
| 9f 테스트 인프라 | 4 | E2E 테스트 프레임워크, 네트워크 fault injection, 대규모 성능 벤치마크, coverage |
| 9g Backlog | 3 | async retry queue, OAuth issuer cache TTL, Google Drive provider 전체 구현 준비 |

---

## 3. 아키텍처 변경 개요

### 3.1 신규 파일
```
server/
  prompts-registry.js     — MCP prompts 저장/조회 (9a)
  security-headers.js     — 공통 보안 헤더 미들웨어 (9b)
  config-constants.js     — 하드코딩 상수 환경변수 외부화 (9b)
providers/
  google-drive.js         — Google Drive provider (9c, stub → 구현)
tests/
  e2e/                    — Playwright E2E 테스트 (9f)
  benchmarks/             — 성능 벤치마크 (9f)
docs/
  PROVIDER_GUIDE.md       — Provider 개발 가이드 (9c)
```

### 3.2 주요 수정 파일
| 파일 | 변경 |
|------|------|
| `server/mcp-handler.js` | prompts/list, prompts/get 구현 |
| `providers/mcp-client.js` | HTTP/SSE transport 구현 (TODO Phase 5c 해소) |
| `server/index.js` | trust proxy, security headers, CORS 적용 |
| `server/rate-limiter.js` | X-Forwarded-For 기반 IP 추출 |
| `admin/routes.js` | Zod schema validation, export/import API, soft delete |
| `server/workspace-manager.js` | soft delete (30일 보관), export/import |
| `server/oauth-manager.js` | issuer cache TTL |
| `admin/public/app.js` | identity 관리, audit 필터, dark mode, wizard progress |

---

## 4. 구현 단계

### 9a — MCP 프로토콜 완성 + 긴급 보안 (2.5일) ★ Gate

> **완료 기준**: `npm test` 전수 통과 (205 기준선 유지 + 신규). 9a 미통과 시 9b 착수 금지.

- [ ] **prompts/list + prompts/get 구현** (`server/mcp-handler.js`)
  - `server/prompts-registry.js` 신규: prompt 정의 저장소
  - 기본 내장 prompt: `bifrost__workspace_summary` (전체 워크스페이스 상태 요약)
  - Provider별 prompt 지원 (BaseProvider에 `getPrompts()` 인터페이스 추가)
  - prompts/get: arguments 바인딩 후 messages 배열 반환
  - 테스트: prompts/list → 내장 prompt 반환, prompts/get → messages 포함 응답

- [ ] **mcp-client HTTP transport** (`providers/mcp-client.js:11`)
  - TODO Phase 5c 해소: `transport: "http"` 설정 시 Streamable HTTP 연결
  - `fetch()` 기반 JSON-RPC over HTTP 구현
  - `Mcp-Session-Id` 헤더 관리
  - 테스트: mock HTTP 서버 → mcp-client HTTP transport 연결 + tool call

- [ ] **mcp-client SSE transport** (`providers/mcp-client.js:12`)
  - TODO Phase 5c 해소: `transport: "sse"` 설정 시 SSE 연결
  - `EventSource` 또는 `fetch()` + ReadableStream 기반
  - reconnect 로직 (exponential backoff)
  - 테스트: mock SSE 서버 → mcp-client SSE transport 연결 + event 수신

- [ ] **resource read size limit** (`server/mcp-handler.js`)
  - `MAX_RESOURCE_SIZE = 5 * 1024 * 1024` (5MB, 환경변수 `BIFROST_MAX_RESOURCE_SIZE`)
  - 초과 시 에러 응답 (OOM 방지)
  - 테스트: 초과 리소스 읽기 → 에러

- [ ] **env vars injection 방어** (`admin/routes.js`) ★ 보안 Gate
  - stdio mcp-client의 `env` 필드에 위험 변수 차단 (PATH, LD_PRELOAD, LD_LIBRARY_PATH 등)
  - 허용 목록 기반 (BIFROST_*, NODE_ENV, 사용자 정의)
  - 현재 이미 exploit 가능 (admin 권한으로 임의 env 주입) — gate 급 보안 조치
  - 테스트: 위험 env 포함 요청 → 400

### 9b — 프로덕션 보안/배포 (2일)

- [ ] **Trust proxy 설정** (`server/index.js`, `server/rate-limiter.js`)
  - `BIFROST_TRUST_PROXY=1` 환경변수로 활성화
  - 활성화 시 `X-Forwarded-For` 첫 번째 IP 사용 (CDN/reverse proxy 뒤 배포)
  - `rate-limiter.js`의 `getClientIp(req)` 헬퍼로 추출 로직 중앙화
  - 테스트: X-Forwarded-For 헤더 → 올바른 IP 추출

- [ ] **Security headers 미들웨어** (`server/security-headers.js`)
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Strict-Transport-Security: max-age=31536000` (BIFROST_TRUST_PROXY=1 시)
  - `X-XSS-Protection: 0` (CSP가 이미 있으므로 legacy 비활성화)
  - 모든 응답에 적용 (MCP + Admin)
  - 테스트: 응답 헤더 확인

- [ ] **CORS 설정** (`server/index.js`)
  - `BIFROST_CORS_ORIGIN` 환경변수로 허용 origin 지정
  - 미설정 시 same-origin 정책 유지 (현행과 동일)
  - preflight (OPTIONS) 핸들러 추가
  - 테스트: CORS 헤더 + OPTIONS 응답

- [ ] **Config 환경변수 외부화** (`server/config-constants.js`)
  - 하드코딩된 14개 상수를 환경변수 + 기본값 패턴으로 통합
  - `BIFROST_RATE_LIMIT_MAX`, `BIFROST_RATE_LIMIT_WINDOW_MS`
  - `BIFROST_SSE_KEEPALIVE_MS`, `BIFROST_HEALTH_CHECK_INTERVAL`
  - `BIFROST_OAUTH_PENDING_TTL_MS`, `BIFROST_AUDIT_RING_SIZE`
  - `BIFROST_SCRYPT_N`, `BIFROST_USAGE_RETENTION_MS`
  - 각 모듈에서 import하여 사용
  - 테스트: 환경변수 override 동작 확인

- [ ] **Workspace schema validation** (`admin/routes.js`)
  - Zod 스키마로 POST/PUT /api/workspaces 페이로드 검증
  - 자기참조 순환 방지 (mcp-client가 자기 자신을 endpoint로 지정)
  - 잘못된 glob 패턴 감지 (toolFilter, allowedWorkspaces)
  - provider별 필수 credential 필드 검증
  - 테스트: 유효/무효 페이로드 → 성공/400

### 9c — Provider 확장 (1.5일)

- [ ] **BaseProvider getPrompts() 인터페이스** (`providers/base.js`)
  - `getPrompts()` → `[]` 기본 반환 (optional override)
  - Notion provider: `notion_{ns}__summarize_workspace` prompt 예시 구현
  - 테스트: 기본 + Notion prompt 반환

- [ ] **Provider template system 강화** (`admin/public/templates.js`)
  - 템플릿 카테고리 필터 (productivity, communication, development)
  - 검색 기능 (이름, provider 타입)
  - OAuth 필요 여부 표시 아이콘
  - 테스트: 수동 E2E

- [ ] **Provider 개발 가이드** (`docs/PROVIDER_GUIDE.md`)
  - BaseProvider 인터페이스 설명
  - 새 provider 추가 체크리스트
  - capabilityCheck 구현 패턴
  - OAuth flow 연동 방법
  - 예시 코드 (minimal provider)

### 9d — 운영 기능 (2.5일)

- [ ] **설정 export/import** (`server/workspace-manager.js`, `admin/routes.js`)
  - `GET /api/config/export` → 워크스페이스 설정 JSON 다운로드 (토큰 제외)
  - `POST /api/config/import` → 설정 JSON 업로드 (충돌 해결: skip/overwrite/rename)
  - 버전 호환성 검증 (export 시 format version 포함)
  - 테스트: export → import → 동일 상태 복원

- [ ] **Soft delete** (`server/workspace-manager.js`)
  - DELETE 시 즉시 삭제 대신 `deletedAt` 타임스탬프 설정
  - 삭제된 워크스페이스는 MCP에 노출 안 됨, Admin에서 "휴지통" 표시
  - 30일 후 자동 영구 삭제 (healthCheck 주기에서 purge)
  - `POST /api/workspaces/:id/restore` → 복원
  - 테스트: 삭제 → MCP 미노출, 복원 → 정상 노출, 30일 후 → 영구 삭제

- [ ] **Audit log 강화** (`server/audit-logger.js`)
  - 파일 기반 로그 추가 (in-memory ring + 파일 append)
  - `BIFROST_AUDIT_FILE` 환경변수로 경로 지정 (기본: `config/audit.jsonl`)
  - 로그 항목: timestamp, action, actor (admin/mcp-token), target, details
  - 테스트: audit 이벤트 → 파일 기록 확인

- [ ] **Usage 시계열 데이터** (`server/usage-recorder.js`)
  - 시간별 집계 (hourly buckets)
  - `GET /api/usage/timeseries?range=24h|7d|30d` API
  - 응답: `[{ hour, callCount, errorCount, avgLatency }]`
  - 테스트: 시계열 집계 + API 응답 확인

- [ ] **Profile 기반 엔드포인트** (`server/mcp-handler.js`, `server/index.js`)
  - SPEC Phase 4: `/mcp?profile=read-only`
  - Profile 정의: `config/profiles.json` (워크스페이스 glob + toolFilter)
  - MCP 토큰별 기본 profile 바인딩 가능
  - 테스트: profile 파라미터 → 필터링된 tools/list

- [ ] **MCP 토큰 스코프** (`server/mcp-token-manager.js`)
  - 토큰 발급 시 workspace glob + tool glob 지정
  - 기존 토큰은 전체 접근 (하위 호환)
  - tools/list, tools/call 시 스코프 필터링
  - 테스트: 스코프 제한 토큰 → 허용된 도구만 노출

- [ ] **Audit log 파일 rotation** (`server/audit-logger.js`)
  - `BIFROST_AUDIT_MAX_BYTES` 환경변수 (기본: 10MB)
  - 초과 시 `.1` 로 rotate (최대 3세대 보관)
  - 쓰기 전 크기 확인 → rotate 판정
  - 테스트: 제한 초과 → rotate 발생 확인

- [ ] **profiles.json 입력 검증** (`server/mcp-handler.js`)
  - Profile 정의 로드 시 Zod 스키마 검증
  - glob 패턴 ReDoS 방지: 패턴 길이 제한 (256자) + 중첩 quantifier 거부
  - 잘못된 profile → 서버 시작 시 경고 + 해당 profile 비활성화 (서버 중단 방지)
  - 테스트: ReDoS 패턴 → 거부, 유효 패턴 → 통과

- [ ] **다중 MCP 토큰 관리 UI** (`admin/public/app.js`)
  - 토큰별 이름, 스코프, 생성일, 마지막 사용일 표시
  - 토큰 발급/폐기/갱신 UI (Phase 8e 모달 기반 확장)
  - 테스트: 수동 E2E

### 9e — Admin UI 개선 (2일)

- [ ] **Identity 관리 UI** (`admin/public/app.js`)
  - 워크스페이스별 identity 목록 표시
  - Per-identity 토큰 상태 (만료일, 마지막 갱신)
  - Identity별 토큰 폐기 UI
  - 테스트: 수동 E2E

- [ ] **Tool dry-run** (`admin/public/app.js`, `admin/routes.js`)
  - 도구 상세 뷰에서 "Test" 버튼
  - `POST /api/workspaces/:id/tools/:name/test` → 기본 파라미터로 실행
  - inputSchema 시각화 (JSON Schema → 폼)
  - 결과 표시 (성공/실패 + 응답 프리뷰)
  - 테스트: API 엔드포인트 + mock tool call

- [ ] **Wizard progress indicator** (`admin/public/app.js`)
  - Step 1~4 진행 표시줄 (현재 단계 강조)
  - 각 단계 클릭으로 자유 이동 (SPEC UX 원칙)
  - 테스트: 수동 E2E

- [ ] **Dark mode** (`admin/public/`)
  - `prefers-color-scheme` 미디어 쿼리 기반 자동 전환
  - 수동 토글 버튼 (localStorage에 preference 저장)
  - CSS 변수 기반 테마 시스템
  - 테스트: 수동 E2E

- [ ] **Audit log 필터/검색** (`admin/public/app.js`)
  - 날짜 범위 필터
  - 액션 타입 필터 (workspace.create, token.issue, tool.call 등)
  - 텍스트 검색
  - 테스트: 수동 E2E

- [ ] **Usage 시계열 차트** (`admin/public/app.js`)
  - 9d 의 timeseries API 활용
  - 간단한 bar/line chart (외부 라이브러리 없이 SVG 또는 Canvas)
  - 기간 선택 (24h, 7d, 30d)
  - 테스트: 수동 E2E

### 9f — 테스트 인프라 (1.5일)

- [ ] **Playwright E2E 테스트 셋업** (`tests/e2e/`)
  - `npm run test:e2e` 스크립트 추가
  - 기본 시나리오: 로그인 → 대시보드 → 워크스페이스 추가 → 연결 테스트
  - OAuth flow는 mock (실계정 불필요)
  - 테스트: CI에서 headless 실행 가능

- [ ] **네트워크 fault injection 테스트** (`tests/`)
  - Provider HTTP timeout 시뮬레이션
  - Rate limit 연쇄 시나리오
  - SSE 연결 끊김 + 재연결
  - 테스트: 각 시나리오별 graceful 처리 확인

- [ ] **대규모 성능 벤치마크** (`tests/benchmarks/`)
  - 100개 워크스페이스 + 1000개 도구 → tools/list 응답 시간
  - 10000건 audit 항목 → 조회 성능
  - 동시 50개 MCP 세션 → 메모리/CPU 프로파일
  - 테스트: 벤치마크 결과 기록 (regression 감지용)

- [ ] **테스트 coverage 리포트**
  - `c8` 또는 `node --experimental-test-coverage` 활용
  - `npm run test:coverage` 스크립트 추가
  - 최소 coverage 목표: 80% statement, 70% branch
  - 테스트: coverage 리포트 생성 확인

### 9g — Backlog (1일, 선택)

> 9a~9f 완료 후 여유 시 진행. 각 항목 독립.

- [ ] **Async retry queue** (`server/mcp-handler.js`)
  - 현재: 동기 retry로 최대 ~11초 점유 (Phase 8 문서화 완료)
  - 변경: 비동기 큐로 분리, 즉시 "처리 중" 응답 + 완료 시 SSE 알림
  - 복잡도 높음 — MCP 프로토콜이 비동기 응답을 기본 지원하지 않아 클라이언트 호환성 확인 필요
  - 테스트: async tool call → SSE 알림 수신

- [ ] **OAuth issuer cache TTL** (`server/oauth-manager.js`)
  - 현재: issuer metadata 무기한 캐시
  - 변경: 24시간 TTL, 만료 시 재조회
  - 테스트: TTL 초과 → 재조회 확인

- [ ] **Google Drive provider 전체 구현 준비** (Phase 10 선행)
  - Google Cloud Console OAuth 2.0 설정 가이드 작성
  - Drive API scope 매핑 (readonly vs full)
  - 9c의 PROVIDER_GUIDE.md 기반으로 Google Drive 구현 설계서 작성
  - 구현 자체는 Phase 10 (Google API 의존성 + OAuth 복잡도)

---

## 5. 의존성 그래프

```
9a (MCP 프로토콜 완성 + 긴급 보안) ★ Gate
  │
  ├─► 9b (프로덕션 보안/배포) — 독립
  │     └── Zod schema ─┐
  │                      │ (hard dependency)
  ├─► 9c (Provider 확장) — 9a prompts 인터페이스 의존
  │                      │
  ├─► 9d (운영 기능) ◄───┘ soft delete + token scope는 Zod schema 확장 필수
  │     ├── profile 엔드포인트는 독립
  │     ├── token 스코프 → profile과 연계
  │     └── export/import ↔ soft delete 상호작용 (R9)
  │
  ├─► 9e (Admin UI 개선) — 9d API 완료 후 진행
  │
  ├─► 9f (테스트 인프라) — 독립 (언제든 착수 가능)
  │
  └─► 9g (backlog, 선택)
```

권장 실행 순서: **9a → 9b → 9c → 9d → 9e → 9f → 9g**

- 9a gate: env injection 방어 포함 — 현재 이미 exploit 가능한 보안 이슈
- 9a gate 이후 9b (보안) 먼저 — 프로덕션 배포 기반 확보
- 9f (테스트 인프라)는 독립이므로 9b와 병렬 가능
- 9c (Provider 확장)는 9a의 prompts 인터페이스 필요
- 9b Zod schema → 9d soft delete/token scope: **hard dependency** (Zod 스키마에 deletedAt, scope 필드 추가 필수)
- 9d 내부: export/import와 soft delete는 ID 예약 상호작용 주의 (R9)
- 9d/9e는 API → UI 순서

---

## 6. 보안 설계

### 6.1 Trust Proxy (9b)
- `BIFROST_TRUST_PROXY=1` 활성화 시에만 X-Forwarded-For 파싱
- 미활성화 시 직접 연결 IP 사용 (현행과 동일)
- 다중 proxy 체인: **rightmost untrusted IP** 사용 (첫 번째 IP는 클라이언트가 스푸핑 가능)
  - `BIFROST_TRUSTED_PROXIES` 환경변수로 신뢰 proxy IP/CIDR 지정
  - X-Forwarded-For를 오른쪽부터 순회, 신뢰 proxy가 아닌 첫 IP를 클라이언트 IP로 판정
  - 신뢰 proxy 미지정 시 rightmost IP 사용 (단일 proxy 환경 기본 가정)
- proxy 없이 X-Forwarded-For 스푸핑 시 → trust proxy 비활성화 상태에서 무시

### 6.2 Security Headers (9b)
- CSP는 Phase 8c에서 OAuth callback에 적용 완료 → Admin UI 전체로 확대
- HSTS는 HTTPS 환경에서만 의미 → trust proxy 활성화 시 자동 적용

### 6.3 Workspace Schema Validation (9b)
- Zod는 node_modules에 이미 존재 (MCP SDK 의존성) → package.json에 명시 추가
- 순환 참조 감지: mcp-client endpoint가 자기 서버 주소인지 검사
- env injection: 허용 목록 기반 (BIFROST_*, NODE_ENV 등)

### 6.4 MCP Token Scope (9d)
- 기존 토큰은 전체 접근 (하위 호환)
- 신규 토큰 발급 시 scope 지정: `{ workspaces: "notion_*", tools: "*__search_*" }`
- tools/list: 스코프 내 도구만 반환
- tools/call: 스코프 외 도구 호출 시 403

---

## 7. 테스트 전략

### 7.1 단위 (목표 +36 tests, 최종 ≥ 241)

| Phase | 신규 테스트 수 | 주요 검증 |
|-------|---------------|----------|
| 9a | 10 | prompts/list+get, HTTP transport, SSE transport, resource size limit, env injection 방어 |
| 9b | 7 | trust proxy (rightmost untrusted IP), security headers, CORS, config constants, schema validation |
| 9c | 3 | getPrompts, template filter, provider guide 예시 검증 |
| 9d | 10 | export/import, soft delete/restore/ID 예약, audit file+rotation, timeseries, profile, token scope, profiles.json 검증 |
| 9e | 4 | tool dry-run API, identity API, audit query API, token scope API |
| 9f | — | (테스트 인프라 자체) |
| 9g | 2 | async queue, OAuth cache TTL |

### 7.2 E2E (신규)
- Playwright 기반 Admin UI E2E: 로그인, 워크스페이스 CRUD, wizard flow
- 목표: 핵심 user journey 5개 자동화

### 7.3 회귀
- Phase 8 테스트 205건 전수 통과 유지
- 9a gate: 모든 기존 테스트 + 9a 신규 통과 필수

### 7.4 벤치마크
- 100 워크스페이스, 1000 도구, 50 동시 세션 — 응답 시간 < 500ms

---

## 8. 리스크 & 완화

| ID | 리스크 | 영향 | 대응 |
|----|--------|------|------|
| R1 | mcp-client HTTP/SSE transport가 upstream MCP 서버 호환성 문제 | High | MCP SDK의 StreamableHTTPClientTransport 활용 검토 (자체 구현 대신) |
| R2 | Google Drive OAuth가 Google Cloud Console 설정 필요 | Medium | provider 가이드에 단계별 안내 포함, template에 setup URL 링크 |
| R3 | Profile 엔드포인트가 기존 MCP 클라이언트와 충돌 | Medium | query param 방식 (?profile=X) → 미지정 시 전체 노출 (하위 호환) |
| R4 | Soft delete가 workspace ID 재사용 충돌 | Low | 삭제된 workspace ID는 예약 → 동일 ID 재생성 차단 |
| R5 | Zod 스키마 검증이 기존 유효 요청을 거부 | Medium | 기존 workspaces.json 로드 시 validation skip (write-time only) |
| R6 | Playwright E2E가 CI 환경에서 불안정 | Low | headless 모드 + retry 3회 + 스크린샷 캡처 |
| R7 | config-constants.js 도입이 기존 모듈 import 경로 대량 변경 | Medium | 점진적 마이그레이션 (phase별로 모듈 단위 교체) |
| R8 | async retry queue가 MCP 프로토콜 동기 응답 계약 위반 | High | 9g로 분류 — MCP spec 비동기 지원 확인 후 진행 |
| R9 | soft delete ID 예약 + export/import 상호작용 충돌 | Medium | export 전 삭제 → import 시 예약 ID 충돌. import 로직에 "soft-deleted ID는 overwrite 시 restore" 규칙 추가 |

---

## 9. 성공 기준

- [ ] `npm test` ≥ 241 PASS (기준선 205 + 36 신규)
- [ ] prompts/list, prompts/get 정상 동작
- [ ] mcp-client HTTP transport로 원격 MCP 서버 연결 성공
- [ ] trust proxy 활성화 시 X-Forwarded-For 기반 rate limiting 동작
- [ ] 전체 응답에 security headers 포함
- [ ] workspace 설정 export → 다른 환경 import → 동일 상태 복원
- [ ] soft delete → 30일 보관 → restore 가능
- [ ] profile 파라미터로 tools/list 필터링 동작
- [ ] Playwright E2E 기본 시나리오 5건 통과
- [ ] Phase 8 테스트 205건 회귀 0
- [ ] Codex 교차 리뷰 PASS (phase 단위)

---

## 10. 일정

| Phase | 내용 | 소요 | 누적 |
|-------|------|------|------|
| 9a | MCP 프로토콜 완성 + 긴급 보안 ★ Gate | 2.5일 | 2.5일 |
| 9b | 프로덕션 보안/배포 | 2일 | 4.5일 |
| 9c | Provider 확장 (stub 강화 + 가이드) | 1일 | 5.5일 |
| 9d | 운영 기능 | 3일 | 8.5일 |
| 9e | Admin UI 개선 | 2일 | 10.5일 |
| 9f | 테스트 인프라 | 1.5일 | 12일 |
| 9g | Backlog (선택) | 1일 | 13일 |
| 회귀 + E2E | 통합 검증 | 0.5일 | 13.5일 |
| **총** | | **13.5일** | |

---

## 11. Phase 10 후보 (기록용)

Phase 9에서 의도적으로 제외하거나, 실행 중 발견될 수 있는 후보:
- Google Drive provider 전체 구현 (OAuth 2.0 + Cloud Console 연동 — 9c에서 stub+가이드만 진행)
- Admin UI SSO (Google/Microsoft OIDC)
- Admin UI SPA 프레임워크 전환 (Lit/Preact)
- Per-user 데이터 암호화 (OS keychain)
- Multi-process advisory file lock (PM2 cluster 대응)
- WebSocket 실시간 tool tailing
- 추가 provider (GitHub, Linear, Jira, Confluence)
- MCP Sampling 지원 (LLM 역호출)
- i18n 프레임워크 (다국어 UI)
- CLI 도구 (bifrost-cli: 터미널에서 workspace 관리)
- Docker 이미지 배포 + docker-compose
- Rate limiting 정책 강제 (hard quota + 차단)

---

## 12. SPEC.md Phase 4 항목 매핑

| SPEC Phase 4 항목 | Phase 9 위치 | 상태 |
|-------------------|-------------|------|
| 추가 provider (Google Drive, ...) | 9c | ✅ 포함 |
| 토큰 자동 갱신 (OAuth refresh) | — | Phase 7 완료 |
| 설정 export/import | 9d | ✅ 포함 |
| 워크스페이스 삭제 undo (soft delete) | 9d | ✅ 포함 |
| 사용량 대시보드 / 상세 audit trail | 9d + 9e | ✅ 포함 |
| Profile 기반 엔드포인트 | 9d | ✅ 포함 |
| 다중 MCP 토큰 | 9d | ✅ 포함 (스코프 강화) |

---

## 13. 교차 리뷰 결과

### 리뷰어: Claude Code-Reviewer Agent (Codex rate limited, Gemini API key 미설정)
### 일시: 2026-04-19

| # | 영역 | 판정 | 지적 | 반영 |
|---|------|------|------|------|
| 1 | §4 우선순위 | REVISE | env injection 방어를 9b→9a gate로 승격 (현재 exploit 가능) | ✅ 9a에 gate 항목으로 이동 |
| 2 | §4 누락 | ADD | profiles.json 입력 검증 (ReDoS 방지) | ✅ 9d에 추가 |
| 3 | §4 누락 | ADD | audit log 파일 rotation/size cap | ✅ 9d에 추가 |
| 4 | §4 오버스코핑 | REVISE | Google Drive 전체 구현 → Phase 10 이관 | ✅ 9c에서 제거, 9g 준비 + Phase 10 후보 |
| 5 | §8 리스크 | ADD | R9: soft delete ID 예약 + export/import 충돌 | ✅ R9 추가 |
| 6 | §5 의존성 | REVISE | 9b Zod → 9d soft delete/scope hard dependency | ✅ 의존성 그래프 수정 |
| 7 | §6.1 보안 | REVISE | trust proxy "첫 번째 IP" → rightmost untrusted IP | ✅ §6.1 수정 + TRUSTED_PROXIES 환경변수 |
| 8 | §7.1 테스트 | REVISE | +30 부족 → +36 (9e 백엔드 4건 + 버퍼 2건) | ✅ 목표 241로 상향 |
