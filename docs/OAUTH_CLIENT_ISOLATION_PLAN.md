# OAuth Client Isolation Plan — Phase 10a

**작성일**: 2026-04-20
**범위**: 같은 OAuth issuer(예: Notion MCP)에 여러 Bifrost workspace를 연결할 때 refresh-token supersede 로 인한 401 무한 루프 해소
**주요 목표**: Workspace 단위 OAuth client 격리 + 401 루프 감지 fail-fast + static client 우선 설계

---

## 1. 배경과 문제 현상

### 관측
- Workspace A (`http-notion-aiproduct1`) OAuth 발급 성공
- 50초 뒤 같은 Notion 계정으로 Workspace B (`http-notion-aiopstf`) OAuth 발급
- 결과: **A 가 즉시 `Action Needed` + 401 무한 루프**, B 는 정상
- 저장된 토큰 확인:
  - 둘 다 `clientId = GN6tDPJbB40wd_ei` (DCR 발급, 동일)
  - accessToken / refreshToken prefix 동일 (`95c47e82-a88d-4b86-8dd1-b6153a…`)

### 근본 원인
`server/oauth-manager.js:211-233` 의 DCR 결과 캐시 키가 `${issuer}::${authMethod}` 뿐.
같은 issuer → **모든 workspace 가 하나의 clientId 공유** → Notion MCP 의 refresh-token
rotation (grant 당 동시 유효 refresh 2개 제한) 이 workspace 간섭을 일으킴:
B 발급 시 A 의 refresh-token 을 supersede.

### RFC 6749 관점 (Codex 검증)
- `refresh_token` 은 `client_id` 에 바인딩되는 것이 표준.
- 동일 subject + redirect_uri 로 복수 client 등록 자체는 금지 아님.
- 즉 **workspace별 별도 client_id** 를 쓰면 grant family 가 분리되어 간섭 없음.
- 단 "항상 새 client_id 발급" 은 RFC 7591 이 보장하지 않음 → **등록 결과를 workspace 단위로 고정 저장** 해야 함.

---

## 2. 스코프 요약 (6 items)

| # | 항목 | 성격 |
|---|------|------|
| 1 | Workspace-scoped DCR cache key | 필수 |
| 2 | Static client 우선, DCR fallback 플로우 | 필수 |
| 3 | DCR 에러 분기 (429 / 4xx / 5xx) | 필수 |
| 4 | 401 루프 감지 + refresh 포기 (Option C) | 필수 |
| 5 | Admin UI — workspace 별 OAuth client 표시 + 수동 재등록 | 권장 |
| 6 | 마이그레이션 스크립트 (기존 공유 clientId 분리) | 권장 |

### Non-goals
- Issuer 레벨 레이트 리밋 대응 (공급자 측 정책 변경이 필요)
- 다중 인스턴스 간 client 공유 (단일 프로세스 전제 유지)
- Static client 자동 발급 (여전히 운영자가 Notion integration 직접 생성)

---

## 3. 아키텍처 변경 개요

### 3.1 데이터 모델
```jsonc
// config/workspaces.json 의 workspace entry (변경 영역만)
{
  "id": "http-notion-aiproduct1",
  "kind": "mcp-client",
  "oauth": {
    "issuer": "https://mcp.notion.com",
    // NEW: workspace-scoped client (static 우선, DCR 결과 저장)
    "client": {
      "clientId": "abc123...",
      "clientSecret": null,
      "authMethod": "none",
      "source": "dcr" | "manual",     // manual = static pre-registered
      "registeredAt": "2026-04-20T..."
    },
    "tokens": { /* 기존 그대로 */ },
    "oauthActionNeededBy": { /* 기존 그대로 */ }
  }
}
```

### 3.2 Cache Key 변경
```
현재:  `${issuer}::${authMethod}`
이후: `${workspaceId}::${issuer}::${authMethod}`  (workspace 단위로 분리)
```

### 3.3 신규/수정 파일
| 파일 | 변경 |
|------|------|
| `server/oauth-manager.js` | `registerClient(issuer, md, { workspaceId, authMethod, ... })` 시그니처 확장, cache key 변경, DCR 에러 분기 |
| `server/workspace-manager.js` | `ws.oauth.client` 로드 우선 로직 (static → stored DCR → 신규 DCR) |
| `providers/mcp-client.js` | 401 루프 카운터 추가: 연속 N 회 refresh 실패 시 `action_needed` fail-fast |
| `admin/routes.js` | `/api/workspaces/:id/oauth/register` 수동 재등록 엔드포인트 |
| `admin/public/app.js` | 상세 화면에 "OAuth Client" 섹션 (clientId + source + 재등록 버튼) |
| `scripts/migrate-oauth-clients.mjs` | 기존 공유 clientId 를 workspace 별로 분리하는 일회성 스크립트 |
| `tests/phase10a-oauth-isolation.test.js` | 신규 테스트 |

---

## 4. 구현 단계

### 10a-1 — Workspace-scoped DCR cache (0.5 일) ★ Gate

> 이 단계만으로도 신규 workspace 는 공유 충돌 없음.

- [ ] `OAuthManager.registerClient` 시그니처 확장
  - `registerClient(issuer, md, { workspaceId, authMethod, forceNew, reuse })`
  - `workspaceId` 필수 (기존 호출처 전부 전달하도록 수정)
- [ ] `_cacheKey(workspaceId, issuer, authMethod)` — 3-tuple
- [ ] `_issuerCache` → `_clientCache` 로 rename (의미 변경 반영)
- [ ] 기존 호출 2곳 업데이트: `initializeAuthorization` / `registerManual`
- [ ] 테스트: 같은 issuer 로 서로 다른 workspace 2개 등록 → 서로 다른 clientId 반환

### 10a-2 — Static client 우선 + DCR fallback (0.5 일)

- [ ] `workspace-manager.js` 에서 OAuth 초기화 시 우선순위:
  1. `ws.oauth.client.clientId` (source=manual, 사전등록) 가 있으면 즉시 사용
  2. 없고 저장된 DCR client 가 있으면 재사용
  3. 위 모두 없으면 신규 DCR 호출 후 `ws.oauth.client` 에 저장
- [ ] `registerManual()` 도 workspace 단위 저장으로 변경
- [ ] 테스트: static clientId 명시 시 DCR endpoint 호출 안 됨 확인

### 10a-3 — DCR 에러 분기 + backoff (0.5 일)

- [ ] 현재 `DCR_FAILED` 하나로 뭉뚱그려진 에러를 분기:
  - 429 `Too Many Requests` → `DCR_RATE_LIMITED` + Retry-After 헤더 존중 backoff
  - 4xx (400/401/403/409) → `DCR_REJECTED` + 재시도 금지 + Admin UI 에 manual fallback 유도
  - 5xx → `DCR_TRANSIENT` + 지수 backoff 3회까지
- [ ] `server/index.js` 에 DCR 에러 핸들링 공통 로직 추가
- [ ] 테스트: 각 status code 시나리오별 분기 동작

### 10a-4 — 401 루프 감지 + fail-fast (Option C, 0.5 일) ★ Gate

> refresh 가 실패하는 데도 반복하는 현재 문제 차단.

- [ ] `providers/mcp-client.js` 에 `_consecutive401Count` 상태 추가
- [ ] `_startNotificationStream()` 의 401 분기:
  - 첫 번째 401 → refresh 시도 (기존 동작)
  - refresh 이후 다시 401 이면 `_consecutive401Count++`
  - 3회 초과 → `_onAuthFailed(identity)` 호출 + 스트림 재연결 중단
  - `oauth-manager` 에 `markAuthFailed(workspaceId, identity)` 추가: `oauthActionNeededBy[identity] = true` + `tokens.accessToken = null` (다음 요청이 토큰 없다고 즉시 action_needed 응답)
- [ ] `_rpc()` 의 HTTP 401 처리도 동일 카운터 공유 (동시 경로 통합)
- [ ] 테스트: 401 → refresh → 401 시퀀스 3회 후 스트림 재연결 중단 확인

### 10a-5 — Admin UI (0.5 일)

- [ ] Workspace 상세 화면에 "OAuth Client" 섹션 추가
  - `clientId` 표시 (마스킹: 앞 4자 + 뒤 4자)
  - `source` 배지 (manual / dcr)
  - "Re-register" 버튼 (DCR 재발급) + "Use Manual" 버튼 (clientId 직접 입력)
- [ ] `POST /api/workspaces/:id/oauth/register` 엔드포인트 (재등록)
- [ ] `PUT /api/workspaces/:id/oauth/client` 엔드포인트 (manual 설정)
- [ ] 테스트: API 엔드포인트 응답 검증

### 10a-6 — 마이그레이션 (0.5 일)

- [ ] `scripts/migrate-oauth-clients.mjs`
  - 기존 `_issuerCache` 의 shared client 를 각 workspace 의 `ws.oauth.client` 로 복사
  - 공유가 감지된 workspace (같은 issuer 에 여러 workspace + 같은 clientId) → 첫 번째만 기존 client 유지, 나머지는 `ws.oauth.client = null` + `oauthActionNeeded = true` 로 재인증 유도
  - dry-run 모드 기본, `--apply` 플래그 있을 때만 실제 쓰기
- [ ] README 에 마이그레이션 실행 가이드
- [ ] `workspace-manager.js` 가 load 시 기존 포맷 자동 변환 (write-time only, 읽기만 할 땐 안전)

---

## 5. 의존성 그래프

```
10a-1 (cache key) ★ Gate
  └─► 10a-2 (static 우선) — cache key 변경 전제
       └─► 10a-3 (에러 분기) — DCR 경로 신뢰성 강화
            └─► 10a-4 (401 루프 감지) ★ Gate — 근본 결함 방어
                 └─► 10a-5 (Admin UI) — 운영 편의
                      └─► 10a-6 (마이그레이션) — 배포 시점에 1회 실행
```

권장 실행 순서: **10a-1 → 10a-2 → 10a-3 → 10a-4 → 10a-5 → 10a-6**

10a-1 + 10a-4 는 동시 gate. 둘 다 통과하지 못하면 다음 단계 진행 금지.

---

## 6. 보안 설계

### 6.1 Client Secret 저장
- DCR 결과에 `client_secret` 이 포함될 수 있음 (confidential client)
- 이미 `workspaces.json` 은 chmod 0o600 적용 중 — 새 필드도 동일 경로에 저장되므로 추가 보호 불필요
- Admin UI 표시 시 클라이언트로 전송 금지 (마스킹만)

### 6.2 Cache key 확장의 무결성
- `workspaceId` 를 키에 포함하므로 workspace 삭제 시 cache entry도 purge 필요
- `workspace-manager.deleteWorkspace()` 에서 `oauth-manager.removeClient(workspaceId)` 호출

### 6.3 401 fail-fast 의 DoS 회피
- `_consecutive401Count` 는 mcp-client 인스턴스 단위, workspace 단위가 아님
- reload/reconnect 시 카운터 리셋 — 일시적 서버 오류와 영구 토큰 문제를 구별 가능
- 3회 임계치는 `BIFROST_AUTH_FAIL_THRESHOLD` 환경변수로 조정 가능

---

## 7. 테스트 전략

### 7.1 단위 테스트 (목표 +8 건)

| 항목 | 검증 |
|------|------|
| workspace-scoped cache | 같은 issuer, 서로 다른 workspace → 서로 다른 clientId |
| static client 우선 | `ws.oauth.client.clientId` 명시 시 DCR 호출 안 함 |
| DCR 429 분기 | Retry-After 헤더 기반 backoff |
| DCR 4xx 분기 | 재시도 금지 + manual fallback 필요 플래그 |
| DCR 5xx 분기 | 3회 retry 후 실패 전파 |
| 401 fail-fast | refresh → 401 → refresh → 401 → 3회 후 action_needed |
| admin re-register | POST /api/workspaces/:id/oauth/register 동작 |
| 마이그레이션 | shared clientId 분리 + action_needed 설정 |

### 7.2 회귀 테스트
- 기존 278 건 전수 통과 유지
- phase6a-discovery / phase6b-pkce-state / phase6c-refresh / phase6e-e2e-mock / phase7c-byidentity / phase7c-pre-migration — OAuth 경로 전수 재실행

### 7.3 수동 E2E
- Notion 계정 1개로 Bifrost workspace 2개 추가 → 둘 다 정상 동작 확인 (Action Needed 안 뜨고 tools 호출 성공)
- 1개 삭제 → 다른 1개 영향 없음 확인

---

## 8. 리스크 & 완화

| ID | 리스크 | 영향 | 대응 |
|----|--------|------|------|
| R1 | Notion MCP DCR 이 같은 redirect_uri 중복 등록 거부 | High | static client 우선 플로우가 fallback — 운영자에게 수동 등록 안내 |
| R2 | DCR rate limit | Medium | 10a-3 의 backoff + Admin UI 에 명확한 에러 메시지 |
| R3 | 마이그레이션 중 데이터 손상 | High | dry-run 기본 + 백업 파일 생성 (`workspaces.json.pre-10a.bak`) |
| R4 | 401 fail-fast 가 일시적 네트워크 에러를 오인 | Medium | 카운터는 401 응답 받은 경우만 증가, 네트워크 에러는 별도 경로 |
| R5 | 기존 workspace 의 OAuth 재사용 불가 | Medium | 10a-6 마이그레이션이 1회 재인증 요구 — 사용자 공지 필요 |
| R6 | confidential client secret 유출 | High | Admin UI 응답에서 secret 제외 (마스킹만 전달) |

---

## 9. 성공 기준

- [ ] `npm test` ≥ 286 PASS (278 기준선 + 8 신규)
- [ ] 같은 Notion 계정으로 2개 이상 workspace 등록 시 상호 간섭 없음 (수동 E2E)
- [ ] 기존 workspaces.json 마이그레이션 성공 + 재인증 1회 후 정상
- [ ] 401 루프 3회 후 자동 stream 재연결 중단 확인
- [ ] DCR 429 / 4xx / 5xx 각각 올바른 에러 분기
- [ ] Codex 교차 리뷰 PASS

---

## 10. 일정

| 단계 | 내용 | 소요 | 누적 |
|------|------|------|------|
| 10a-1 | Workspace-scoped cache ★ Gate | 0.5 일 | 0.5 일 |
| 10a-2 | Static 우선 + DCR fallback | 0.5 일 | 1.0 일 |
| 10a-3 | DCR 에러 분기 | 0.5 일 | 1.5 일 |
| 10a-4 | 401 fail-fast ★ Gate | 0.5 일 | 2.0 일 |
| 10a-5 | Admin UI | 0.5 일 | 2.5 일 |
| 10a-6 | 마이그레이션 | 0.5 일 | 3.0 일 |
| 회귀 + E2E + Codex 리뷰 | 통합 검증 | 0.5 일 | 3.5 일 |
| **총** | | **3.5 일** | |

---

## 11. Codex 리뷰 결과 반영 이력

**일시**: 2026-04-20 / 리뷰어: Codex (async)
**판정**: **REVISE** → 아래 반영

| # | 지적 | 반영 |
|---|------|------|
| 1 | "항상 신규 clientId 발급" 가정 금지, 등록 결과 **고정 저장** | §3.1 데이터 모델 + §4.10a-2 |
| 2 | DCR 에러를 429/4xx/5xx 로 분기 | §4.10a-3 |
| 3 | clientId 저장은 `workspaces.json` 내 인라인 | §3.1 |
| 4 | 재시작 시 재등록 금지, 기존 값 재사용 | §4.10a-2 단계 2번 |
| 5 | A 만으로 부족 — C (401 fail-fast) 동반 필수 | §4.10a-4 ★ Gate |
| 6 | 더 나은 대안: static client 우선, DCR fallback | §4.10a-2 단계 1번 |

---

## 12. 미해결 질문 (Deep-Dive 전에 확인 필요)

1. **Notion MCP DCR 의 실제 동작** — `/register` 를 다른 `client_name` 으로 반복 호출 시 매번 새 client_id 반환하는지 curl 실측 필요
2. **Static client 발급 UX** — 운영자가 Notion integration 페이지에서 직접 받아야 하는데, Bifrost workspace 추가 wizard 에 안내 필요
3. **Notion MCP 공식 권장사항** — docs 가 "한 integration 당 여러 workspace" 를 권장하는지, 아니면 독립 integration 권장하는지 확인
