# Phase 8 — Hardening, Security Fixes & Code Quality

**작성일**: 2026-04-19
**범위**: Phase 7 코드 리뷰 25건 + Codex 교차 검증 결과에서 도출된 보안·안정성·품질 개선
**주요 목표**: Phase 7 에서 구현된 다중 테넌트 기능을 **프로덕션 수준의 보안/안정성** 으로 끌어올리고, 코드 품질 부채를 체계적으로 해소

---

## 1. 배경과 동기

### Phase 7 이 남긴 공백
Phase 7 에서 멀티 테넌트 MCP 허브를 성공적으로 구현 (167 tests, 0 fail) 했지만, 코드 리뷰 + Codex 교차 검증에서 **보안 취약점 4건** (path traversal, XSS, body limit, timing) + **안정성 이슈 7건** + **코드 품질 부채 9건** 이 식별됨.

### 리뷰 출처
- Claude 코드 리뷰: 25건 (P0×4, P1×6, P2×8, P3×7)
- Codex 교차 검증: 오탐 7건 강등, 추가 지적 3건
- **양쪽 합의된 즉시 수정**: 5건 (path traversal, body limit, XSS, file watcher race, callTool retry)

### 비목표 (Out of Scope)
- Admin UI SSO / Google/Microsoft 로그인
- Rate limiting 강제 (차단) — Phase 8c 에서 기초만 도입
- Per-user 데이터 암호화 / OS keychain 연동
- Multi-process advisory lock
- UI 프레임워크 도입 / SPA 전환

---

## 2. 스코프 요약

### In-scope (29건)
| 그룹 | 항목 수 | 성격 |
|------|---------|------|
| 8a 긴급 보안 | 5 | path traversal, body limit, XSS, slowloris timeout, callTool retry |
| 8b 안정성/성능 | 8 | watcher guard, flush 재진입, writeLock 에러, scrypt O(n), provider cooldown, SSE write, JSON-RPC spec, graceful shutdown |
| 8c 보안 보강 | 4 | timingSafeEqual ×2, rate limit, CSP |
| 8d 코드 품질 | 5 | logger, readBody DRY, oauth helper, public API, guard 중복 |
| 8e Backlog | 7+α | aggregate O(n), retry 큐, dynamic import, Date 비교 등 |

### Out-of-scope
- Phase 7 E2E 잔여 5항목 (실계정 브라우저 필요 — 수동 검증)
- Admin UI UX 대규모 개편 (모달 등)
- 신규 provider 추가

---

## 3. 아키텍처 변경 개요

### 3.1 신규 파일
```
server/
  html-escape.js        — HTML entity escape 유틸 (XSS 방지)
  rate-limiter.js       — 슬라이딩 윈도우 IP 기반 rate limiter (8c)
```

### 3.2 수정 파일
| 파일 | 변경 |
|------|------|
| `admin/routes.js` | path traversal 방어, exposure guard 통합 |
| `admin/auth.js` | `timingSafeEqual` 교체, rate limit 적용 |
| `server/index.js` | readBody 크기 제한, OAuth callback HTML escape, request timeout, healthCheck interval 보관 |
| `server/workspace-manager.js` | file watcher self-save guard, _writeLock 에러 전파 |
| `server/mcp-handler.js` | _errorResponse id nullish, retry backoff 문서화 |
| `server/mcp-token-manager.js` | prefix-based lookup 최적화 |
| `server/oauth-manager.js` | HMAC `timingSafeEqual`, _storeTokens 헬퍼 추출 |
| `server/tool-registry.js` | cold provider cooldown |
| `server/usage-recorder.js` | flush 재진입 방지 |
| `server/sse-manager.js` | keepAlive write try/catch |
| `server/logger.js` | 인스턴스화 또는 cleanup 패턴 |
| `providers/mcp-client.js` | callTool throw 복원 (transient 에러) |

---

## 4. 구현 단계

### 8a — 긴급 보안 + 안정성 패치 (1.5일) ★ Gate

> **완료 기준**: `npm test` 전수 통과 (167 기준선 유지 + 신규). 8a 미통과 시 8b 착수 금지.

- [ ] **#2 — path traversal 방어** (`admin/routes.js:472`)
  - `fs.realpath(path.resolve(PUBLIC_DIR, filePath))` 후 `path.relative(PUBLIC_DIR, realPath)` 가 `..` 로 시작하면 403
  - symlink escape + `/base` vs `/base-evil` 오매칭 방어 (`startsWith` 단독 불충분 — Codex REVISE 반영)
  - 실패 시 403 응답
  - 테스트: `../../config/workspaces.json` 요청 → 403, 정상 경로 → 200

- [ ] **#3 — readBody 크기 제한** (`server/index.js:55`)
  - `MAX_BODY_BYTES = 1 * 1024 * 1024` (1MB)
  - 초과 시 `res.writeHead(413)` + 조기 종료
  - `admin/auth.js` 의 readBody 도 동일 적용 (또는 공통화 — 8d 에서 DRY)
  - 테스트: 1MB 초과 payload → 413

- [ ] **#4 — OAuth callback HTML escape** (`server/index.js:269`)
  - `server/html-escape.js` 신규: `<`, `>`, `&`, `"`, `'` → entity 변환
  - OAuth callback 에러 메시지/파라미터 출력 전 escape 적용
  - 테스트: `<script>alert(1)</script>` 포함 error 파라미터 → escaped 출력 확인

- [ ] **Slowloris 방어** (Codex REVISE: 외부 노출 서버면 gate 급 — 8c 에서 승격)
  - `server.headersTimeout = 20_000`, `server.requestTimeout = 30_000`
  - `server/index.js` 에 서버 생성 직후 설정
  - 테스트: 설정값 확인

- [ ] **#18 — callTool throw 복원** (`providers/mcp-client.js:541`)
  - upstream HTTP 에러 (4xx/5xx) 는 throw → mcp-handler retry 작동
  - upstream 비즈니스 에러 (tool 결과의 `isError: true`) 는 반환 (기존)
  - 429 응답 시 `err.retryAfter` 헤더 파싱 → handler backoff 에 전달
  - 테스트: mock 429 → retry 2회 후 성공, mock 500 → retry 후 실패

### 8b — 안정성/성능 Sprint (2일)

- [ ] **#8 — file watcher self-save guard** (`workspace-manager.js:509`)
  - `_saving` 플래그 도입: `_save()` 진입 시 true, 완료 시 false
  - watcher 콜백에서 `_saving === true` 면 이벤트 무시
  - debounce 도 유지 (기존 로직)
  - 테스트: `_save()` 호출 중 watcher 이벤트 → reload 미발생

- [ ] **#6 — flush 재진입 방지** (`usage-recorder.js:86`)
  - `_pendingFlush = false` 플래그
  - flush 진행 중 호출 → `_pendingFlush = true` 만 세팅
  - flush 완료 후 `_pendingFlush === true` 면 1회 재실행
  - 테스트: concurrent flush 10회 → 실제 I/O 2회 이하

- [ ] **#9 — _writeLock 에러 전파** (`workspace-manager.js:196`)
  - `.then(async () => {...}).catch(err => { logger.error(...); throw err; })` → 에러 로깅 + 후속 체인 실패 가시화
  - 테스트: write 실패 시뮬레이션 → 에러 throw 확인

- [ ] **#11 — scrypt prefix lookup** (`mcp-token-manager.js:190`)
  - 토큰 발급 시 plaintext 의 처음 8바이트를 `prefix` 필드로 저장
  - `resolve()` 에서 prefix 매칭 → 후보 1개로 좁힌 후 scrypt 검증
  - 기존 prefix 없는 토큰은 fallback 으로 순차 스캔 (하위 호환)
  - 테스트: 10개 토큰 → resolve 시 scrypt 호출 1회

- [ ] **#13 — getTools cold provider cooldown** (`tool-registry.js:38`)
  - `_lastWarmupAttempt: Map<wsId, timestamp>`
  - 마지막 시도로부터 60초 이내면 재시도 skip
  - 테스트: 2초 간격 getTools 2회 → upstream 호출 1회

- [ ] **#17 — SSE keepAlive write try/catch** (`sse-manager.js:31`)
  - `res.write(':keepalive\n\n')` 를 try/catch 로 감싸기
  - 실패 시 해당 session 제거 + clearInterval
  - 테스트: destroyed response 에 keepAlive → session 정리 확인

- [ ] **#19 — _errorResponse id nullish** (`mcp-handler.js:405`)
  - `id: id ?? null` (JSON-RPC 2.0 spec: error response 에 id 는 null 이어야 함)
  - 테스트: id 없는 요청의 에러 응답에 `id: null` 포함

- [ ] **#25 — healthCheck interval graceful shutdown** (`server/index.js:38`)
  - `const healthInterval = setInterval(...)` 보관
  - `server.close()` 콜백에서 `clearInterval(healthInterval)`
  - 테스트: server close 후 interval 정리 확인

### 8c — 보안 보강 (1일)

- [ ] **#1 — Admin 토큰 timingSafeEqual** (`admin/auth.js:34`)
  - `crypto.timingSafeEqual(Buffer.from(input), Buffer.from(expected))` 교체
  - 길이 불일치 시 사전 reject (길이 자체는 non-secret)
  - 테스트: 올바른 토큰 → 인증 통과, 오류 토큰 → 401

- [ ] **#5 — OAuth HMAC state timingSafeEqual** (`oauth-manager.js:309`)
  - `crypto.timingSafeEqual(Buffer.from(sig, 'base64url'), Buffer.from(expected, 'base64url'))` 교체
  - 테스트: 유효 state → 통과, 변조 state → reject

- [ ] **Admin auth rate limit** (Codex 추가)
  - `server/rate-limiter.js` 신규: 슬라이딩 윈도우 (IP 기반, Map)
  - 기본: 10회/분/IP. 초과 시 429 + `Retry-After` 헤더
  - Admin login + token API 에 적용
  - 메모리 기반 (단일 프로세스 전제), 1시간 이상 미사용 IP 자동 정리
  - 테스트: 11회 연속 요청 → 11번째 429

- [ ] **OAuth callback CSP/nonce** (Codex 추가)
  - OAuth callback HTML 응답에 `Content-Security-Policy: default-src 'none'; script-src 'nonce-<random>'` 헤더
  - inline script 에 `nonce` attribute 부여
  - 테스트: callback 응답 헤더에 CSP 포함 확인

### 8d — 코드 품질 (1일)

- [ ] **#22 — logger 테스트 cleanup 패턴**
  - `logger._setLevel` 호출 시 `afterEach` 에서 자동 복원 권장 → 테스트 유틸 `withLogLevel(level, fn)` 헬퍼 추가
  - 기존 테스트를 `withLogLevel` 으로 리팩터
  - 테스트: 기존 4개 유지, 헬퍼 동작 확인 1건

- [ ] **#14 — readBody 중복 제거 (DRY)**
  - `server/index.js` 의 `readBody` 를 `server/http-utils.js` 로 추출
  - `admin/auth.js` 에서 import 로 교체
  - 크기 제한 로직도 여기에 통합 (8a 의 #3 과 연계)
  - 테스트: import 경로 변경 확인 (기존 테스트 통과)

- [ ] **#16 — _storeTokens 공통 헬퍼** (`oauth-manager.js`)
  - `_persistTokens` 와 `_refreshWithMutex` 의 토큰 저장 로직 추출
  - `_storeTokens(ws, identity, tokenResponse)` — byIdentity 저장 + legacy mirror + oauthActionNeededBy 업데이트 + _save()
  - 테스트: 기존 OAuth 테스트 전수 통과 (리팩터 회귀 0)

- [ ] **#15 — _getRawWorkspace public API**
  - `WorkspaceManager.getRawWorkspace(id)` public 메서드 추가
  - `admin/routes.js` 에서 `_getRawWorkspace` → `getRawWorkspace` 교체
  - 테스트: public API 호출 확인

- [ ] **#10 — admin exposure guard 통합**
  - `admin/auth.js:authenticateAdmin` 에 exposure check 통합
  - `admin/routes.js` 의 중복 체크 제거
  - 테스트: 기존 admin auth 테스트 통과

### 8e — Backlog / nice-to-have (2일, 선택)

> 8a~8d 완료 후 여유 시 진행. 각 항목 독립 — 순서 무관.

- [ ] **#7 — _updateAggregate O(n) → 증분 관리**
  - per-key count 를 Map 으로 증분 유지, trim 시에만 recount
  - 테스트: 1만 건 record 후 집계 성능 < 10ms

- [ ] **#12 — retry backoff 문서화**
  - 현재 동작 (최대 ~11초 점유) 를 CLAUDE.md / 코드 주석에 명시
  - 비동기 큐 분리는 Phase 9 후보로 기록

- [ ] **#20 — routes.js dynamic import → static**
  - `GET /api/profiles` 의 `await import(...)` → top-level import
  - 테스트: 기존 통과

- [ ] **#21 — ISO 문자열 비교 → Date 비교**
  - `workspace-manager.js:410` 의 `<` 비교를 `new Date()` 비교로 교체
  - 테스트: 기존 통과

- [ ] **#23 — in-memory audit ring 확대**
  - 10 → 50 으로 변경
  - 테스트: 50건 삽입 후 전부 조회

- [ ] **#24 — matchPattern RegExp LRU 캐시**
  - `Map<string, RegExp>` (최대 100개)
  - 테스트: 동일 패턴 2회 호출 → RegExp 재사용 확인

- [ ] **Phase 7 잔여: meta tool usage 기록 정책화**
  - `_handleMetaTool` 에도 `_usage.record` 호출 추가 (flag 로 on/off)
  - 기본 off (운영 노이즈 방지), `BIFROST_META_USAGE=1` 로 활성화
  - 테스트: flag on 시 meta tool 호출 → usage 기록

- [ ] **console.* → logger 점진 마이그레이션**
  - `server/index.js`, `server/workspace-manager.js` 의 console.* 를 logger 교체
  - 부팅 메시지는 `logger.info`, 에러는 `logger.error`
  - 테스트: 기존 통과

- [ ] **Admin UI prompt() → confirm 다이얼로그**
  - token issue/revoke/rotate 의 `window.prompt()` → HTML 모달
  - 순수 HTML/CSS/JS (외부 lib 없음)
  - 테스트: 수동 E2E

---

## 5. 의존성 그래프

```
8a (긴급 보안 + slowloris) ★ Gate
  │
  ├─► 8c (보안 보강 — timingSafeEqual, rate limit, CSP)
  │
  ├─► 8b (안정성/성능 — watcher guard, flush, scrypt 등)
  │     └─► 8d (코드 품질) ─── #14 readBody DRY 는 8a #3 완료 후
  │
  └─► 8e (backlog, 선택)
```

권장 실행 순서: **8a → 8c → 8b → 8d → 8e** (Codex REVISE 반영: 보안 먼저)

- 8a gate 이후 8c (보안 보강) 를 먼저 — 보안 표면을 조기에 닫음
- 8b (안정성) 는 8c 이후 — watcher guard, flush 등 안정성은 보안 위에 쌓임
- 8d 의 `#14 readBody DRY` 는 8a `#3 body limit` 완료 후 진행
- 8e 는 전부 독립 — cherry-pick 가능

---

## 6. 보안 설계

### 6.1 Path Traversal 방어 (8a #2)
- `fs.realpath(path.resolve(PUBLIC_DIR, filePath))` + `path.relative(PUBLIC_DIR, realPath)` 가 `..` 시작이면 403
- `startsWith` 단독 불충분 (`/base` vs `/base-evil` 오매칭, symlink escape) — Codex REVISE 반영
- 실패 시 403 (404 가 아닌 이유: 파일 존재 여부 자체를 노출하지 않음)

### 6.2 XSS 방어 (8a #4)
- 서버사이드 HTML escape: 5문자 (`<>&"'`) entity 변환
- OAuth callback 의 모든 동적 값에 적용
- CSP `default-src 'none'` + nonce (8c) 로 이중 방어

### 6.3 Timing Attack 완화 (8c #1, #5)
- Codex 판정: 원격 timing 현실성 낮음 (P1 강등) 이지만, defense-in-depth 원칙으로 수정
- `crypto.timingSafeEqual` 사용 시 길이 맞춤: 짧은 쪽을 hash 하거나 길이 사전 비교

### 6.4 Rate Limiting (8c Codex 추가)
- 메모리 기반 슬라이딩 윈도우 (IP → { count, windowStart })
- Admin API 만 적용 (MCP 엔드포인트는 토큰 인증이 1차 방어)
- DDoS 방어가 아닌 brute-force 방어 목적 — 프록시/CDN 환경에서는 `X-Forwarded-For` 파싱 필요 (Phase 9 에서 trust proxy 설정)

### 6.5 Slowloris 방어 (8a — Codex REVISE 로 gate 승격)
- Node.js 내장 `server.headersTimeout` + `server.requestTimeout` 활용
- 추가 외부 의존성 0
- 외부 노출 서버에서 열린 연결 무한 점유 방지 → gate 급 보안 조치

---

## 7. 테스트 전략

### 7.1 단위 (목표 +25 tests, 최종 ≥ 192)

| Phase | 신규 테스트 수 | 주요 검증 |
|-------|---------------|----------|
| 8a | 7 | path traversal 403, body limit 413, XSS escape, slowloris timeout, callTool retry/429 |
| 8b | 9 | watcher guard, flush 재진입, writeLock 에러, prefix lookup, cooldown, SSE write, id null, shutdown |
| 8c | 4 | timingSafeEqual 2건, rate limit 429, CSP 헤더 |
| 8d | 3 | withLogLevel 헬퍼, readBody import, _storeTokens 회귀 |
| 8e | 6+ | aggregate 성능, audit ring, RegExp 캐시, meta usage 등 |

### 7.2 회귀
- Phase 7 테스트 167건 전수 통과 유지
- 8a gate: 모든 기존 테스트 + 8a 신규 통과 필수

### 7.3 수동 E2E
- Phase 7 E2E 체크리스트 (`docs/PHASE7_E2E_CHECKLIST.md`) 재검증
- 8c rate limit: `curl` 반복 호출로 429 확인

---

## 8. 리스크 & 완화

| ID | 리스크 | 영향 | 대응 |
|----|--------|------|------|
| R1 | path traversal 방어가 Windows 경로 구분자(`\`)를 놓침 | High | `path.resolve()` 가 OS-aware 이므로 자동 처리. 테스트에 Windows 스타일 경로 포함 |
| R2 | readBody 1MB 제한이 대용량 tool arguments 차단 | Medium | MCP 도구 arguments 는 통상 수 KB. 필요 시 `BIFROST_MAX_BODY` env 로 조정 가능하게 |
| R3 | callTool throw 변경이 기존 에러 핸들링 경로 깨뜨림 | High | 비즈니스 에러 (isError) 는 기존처럼 반환, HTTP 에러만 throw. Phase 7 테스트 전수 통과가 gate |
| R4 | rate limiter 의 Map 이 메모리 누수 | Low | 1시간 미사용 IP 자동 정리 (timer 주기 10분). 단일 프로세스 전제 |
| R5 | prefix lookup 이 해시 충돌 시 잘못된 토큰 매칭 | Low | prefix 는 후보 좁히기만 (scrypt 전 검증은 유지). 충돌 시 순차 fallback |
| R6 | oauth-manager _storeTokens 리팩터 시 byIdentity 로직 미묘한 회귀 | Medium | Phase 7c/7c-pre 테스트 23건이 gate. 리팩터 전후 diff 최소화 |
| R7 | CSP nonce 가 inline script 와 충돌 | Low | OAuth callback 페이지는 간단한 `window.close()` 스크립트만 — nonce 1개면 충분 |

---

## 9. 성공 기준

- [ ] `npm test` ≥ 192 PASS (기준선 167 + 25 신규)
- [ ] P0 보안 이슈 4건 전부 해소 (path traversal, body limit, XSS, timing)
- [ ] `curl /admin/../../config/workspaces.json` → 403 (path traversal 방어 실증)
- [ ] OAuth callback `?error=<script>` → escaped HTML 반환 (XSS 방어 실증)
- [ ] Admin auth 11회 연속 실패 → 429 (rate limit 실증)
- [ ] MCP endpoint 에 2MB body → 413 (body limit 실증)
- [ ] 10개 토큰 등록 → resolve 시 scrypt 호출 1회 (prefix lookup 실증)
- [ ] server.close() 후 healthCheck interval 정리됨
- [ ] Phase 7 테스트 167건 회귀 0
- [ ] Codex 교차 리뷰 PASS (phase 단위)

---

## 10. 일정

| Phase | 내용 | 소요 | 누적 |
|-------|------|------|------|
| 8a | 긴급 보안 + 안정성 ★ Gate | 1.5일 | 1.5일 |
| 8b | 안정성/성능 Sprint | 2일 | 3.5일 |
| 8c | 보안 보강 | 1일 | 4.5일 |
| 8d | 코드 품질 | 1일 | 5.5일 |
| 8e | Backlog (선택) | 2일 | 7.5일 |
| 회귀 + E2E | 통합 검증 | 0.5일 | 8일 |
| **총** | | **8일** | |

---

## 11. Phase 9 후보 (기록용)

Phase 8 에서 의도적으로 제외하거나, 실행 중 발견될 수 있는 후보:
- Admin UI SSO (Google/Microsoft)
- Rate limiting 정책 강제 (차단 + quota)
- Trust proxy 설정 (`X-Forwarded-For` 기반 IP 추출)
- MCP resources/prompts 서브스크립션
- Per-user 데이터 암호화 (OS keychain)
- Multi-process advisory file lock
- 실시간 tool 호출 tailing (WebSocket)
- retry backoff 비동기 큐 분리 (#12)
- Admin UI SPA 프레임워크 전환
