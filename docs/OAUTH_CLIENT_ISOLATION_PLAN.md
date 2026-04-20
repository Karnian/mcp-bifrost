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
      "authMethod": "none" | "client_secret_basic" | "client_secret_post",
      "source": "dcr" | "manual",     // manual = static pre-registered
      "registeredAt": "2026-04-20T..."
    },
    // byIdentity 는 Phase 7c 도입된 실제 토큰 저장 구조 (기존)
    "byIdentity": {
      "default": { "tokens": { "accessToken": "...", "refreshToken": "..." } },
      "bot_ci":  { "tokens": { "accessToken": "...", "refreshToken": "..." } }
    },
    // ws.oauth.tokens 는 default identity 의 legacy mirror (기존)
    "tokens": { /* ws.oauth.byIdentity.default.tokens 와 동일 */ }
  },
  // action_needed 플래그는 루트 필드 (Phase 7c-pre 원 위치 — 중첩 아님)
  // 실제 코드: oauth-manager.js:495-497, 651-653
  "oauthActionNeededBy": { "default": false, "bot_ci": false },
  "oauthActionNeeded": false
}
```

**Auth method 범위 한정** (Codex 리뷰 반영):
- 본 Phase 10a 는 `none` / `client_secret_basic` / `client_secret_post` 만 지원.
- `private_key_jwt` / `tls_client_auth` / `self_signed_tls_client_auth` 등 PKI 계열은
  추가 메타(`keyId`, `alg`, `jwks`, 인증서 경로 등)가 필요하므로 Phase 10+ 로 이관.
- `pickAuthMethod()` 에서 지원 외 메서드 선택 시 `Error('UNSUPPORTED_AUTH_METHOD')` 로
  명시 실패 (silent fallback 금지).

### 3.2 Cache Key 변경
```
현재:  `${issuer}::${authMethod}`
이후: `${workspaceId}::${issuer}::${authMethod}`  (workspace 단위로 분리)
```

### 3.3 신규/수정 파일
| 파일 | 변경 |
|------|------|
| `server/oauth-manager.js` | `registerClient(issuer, md, { workspaceId, authMethod, ... })` 시그니처 확장, cache key 변경, DCR 에러 분기, `_refreshWithMutex` 에서 `ws.oauth.client.*` 참조 (§3.4 마이그레이션 shim 포함), `markAuthFailed(workspaceId, identity)` 신규 |
| `server/workspace-manager.js` | `ws.oauth.client` 로드 우선 로직 (static → stored DCR → 신규 DCR), masking 및 POST/PUT input parsing 을 `ws.oauth.client.*` 로 전환, 기존 평면필드 legacy shim |
| `providers/mcp-client.js` | 401 루프 카운터 추가: 연속 N 회 refresh 실패 시 `oauth-manager.markAuthFailed(workspaceId, identity)` 호출 + 스트림 재연결 중단 |
| `admin/routes.js` | `/api/workspaces/:id/oauth/register` 수동 재등록 엔드포인트, POST/PUT workspace 입력 스키마 `oauth.client` 수용 |
| `admin/public/app.js` | 상세 화면에 "OAuth Client" 섹션 (clientId + source + 재등록 버튼) |
| `scripts/migrate-oauth-clients.mjs` | 기존 공유 clientId 를 workspace 별로 분리하는 일회성 스크립트 (dry-run / apply / rollback) |
| `tests/phase10a-oauth-isolation.test.js` | 신규 테스트 |

### 3.4 평면 필드 → `ws.oauth.client` 마이그레이션 shim (Codex Round 2+3 반영)

**현재 코드에서 평면 필드 직참조 위치** (grep 검증):
1. `server/oauth-manager.js:592-594` — `_refreshWithMutex` 가 `ws.oauth.clientId / clientSecret / authMethod` 읽음
2. `server/workspace-manager.js:46-49` — `maskOAuth()` 의 마스킹 로직
3. `server/workspace-manager.js:308-310` — POST/PUT workspace 입력 파싱

**마이그레이션 전략**:
- **읽기 경로**: 헬퍼 `getOAuthClient(ws)` 도입 → `ws.oauth.client?.clientId ?? ws.oauth.clientId` 순으로 fallback.
  기존 workspaces.json 의 평면 필드를 그대로 읽을 수 있도록 **양방향 호환**.
- **쓰기 경로**: DCR 성공 / `registerManual` / POST/PUT 입력 → `ws.oauth.client.*` 로 저장
  **+ 최소 1 릴리즈 동안은 평면 필드도 동시에 미러 기록** (backward-compat & rollback 대비).
  Phase 11 에서 미러 쓰기 제거.
- **Load-time 마이그레이션**: `workspace-manager.load()` 가 `ws.oauth.client` 부재 + 평면
  필드 존재 시 자동으로 `ws.oauth.client` 로 복사. Phase 7c-pre 의 `ws.oauth.tokens →
  byIdentity.default` 미러 패턴과 동일.
- **Startup validation**: load 시 `ws.oauth.client.clientId` 와 평면 `ws.oauth.clientId`
  가 **둘 다 존재하지만 값이 다르면** WARN 로그 + audit event 기록. 정책은 `client.*`
  우선.
- **롤백/Mixed-version 보호**:
  - 구 버전 인스턴스가 이 workspaces.json 을 읽어도 평면 필드로 작동 가능 (미러 덕)
  - 외부 스크립트 (`jq` 등) 가 여전히 `ws.oauth.clientId` 참조해도 동작
  - 관측 도구/백업 파이프라인에 전달 전 호환성 깨지지 않음
- **호환 제거 시점**: Phase 11 또는 2회 major release 뒤 — 제거 전 release note 에 1회
  명시 + startup 에 deprecation WARN 내보냄.

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
- [ ] **Soft delete 상호작용 정책 결정** (Codex Round 3 반영):
  - Option X: workspace `deleteWorkspace(id)` 즉시 purge — 복원 시 재인증 필요
  - Option Y: soft delete 기간 동안 cache 유지, `purgeExpiredWorkspaces()` 가 실제 삭제 시 purge
  - **결정: Option Y** — 30 일 내 복원 시 재인증 부담 제거. soft delete 는 MCP 에 노출 안 되므로 보안상 문제없음.
  - 구현: `workspace-manager.restoreWorkspace()` 에서 cache entry 확인만, purge 는
    `workspace-manager._purgeExpiredWorkspaces()` 에서만 수행
- [ ] 테스트: 같은 issuer 로 서로 다른 workspace 2개 등록 → 서로 다른 clientId 반환
- [ ] 테스트: soft delete → cache 유지, restore → 재인증 불필요; expire → cache purge

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

- [ ] `providers/mcp-client.js` 에 `_consecutive401Count` 상태 추가 (identity 별 Map)
- [ ] `_startNotificationStream()` 의 401 분기:
  - 첫 번째 401 → refresh 시도 (기존 동작)
  - refresh 이후 다시 401 이면 `_consecutive401Count[identity]++`
  - 3회 초과 (`BIFROST_AUTH_FAIL_THRESHOLD` 환경변수 조정 가능) → `oauth-manager.markAuthFailed(workspaceId, identity)` 호출 + 해당 identity 스트림 재연결 중단
- [ ] `OAuthManager.markAuthFailed(workspaceId, identity)` 신규 (byIdentity 모델 + 루트 플래그 정확 처리):
  ```js
  // _refreshMutex 와 동일 mutex 로 직렬화 — last-write-wins 경쟁 방지
  await this._withWorkspaceMutex(workspaceId, async () => {
    const ws = this.wm.getWorkspace(workspaceId);
    // by-identity 저장 구조 (Phase 7c 이후 표준)
    if (ws.oauth?.byIdentity?.[identity]?.tokens) {
      ws.oauth.byIdentity[identity].tokens.accessToken = null;
    }
    // default identity 는 legacy mirror 도 동기화
    if (identity === 'default' && ws.oauth?.tokens) {
      ws.oauth.tokens.accessToken = null;
    }
    // action_needed flag — 루트 필드 (ws.oauthActionNeededBy, NOT ws.oauth.oauthActionNeededBy)
    // 원 위치: oauth-manager.js:495-497, 651-653
    if (!ws.oauthActionNeededBy) ws.oauthActionNeededBy = {};
    ws.oauthActionNeededBy[identity] = true;
    if (identity === 'default') ws.oauthActionNeeded = true;
    await this.wm.save();
    // Observability: audit event + metric counter
    this.audit?.record({ action: 'oauth.threshold_trip', workspace: workspaceId, details: { identity, threshold: this._authFailThreshold } });
  });
  ```
  - 단순히 `tokens.accessToken = null` 만 하던 이전 설계안은 byIdentity 경로에서
    작동 안 함 (Codex Round 2 반영).
  - `_withWorkspaceMutex` 는 기존 `_refreshMutex` (workspace 단위) 재사용 — 새
    mutex 도입 불필요 (Codex Round 3 반영).
- [ ] `_rpc()` 의 HTTP 401 처리도 동일 카운터 공유 (스트림/RPC 통합)
- [ ] 테스트 시나리오:
  - default identity: 401 → refresh → 401 × 3 → markAuthFailed → `byIdentity.default.tokens.accessToken === null` + `oauthActionNeededBy.default === true` + `ws.oauth.tokens.accessToken === null`
  - bot_ci identity: 동일 패턴, **단 ws.oauth.tokens (legacy) 는 건드리지 않음** 확인
  - 성공 요청 1회 후 카운터 리셋 확인

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

## 5. 의존성 그래프 (Codex 리뷰 반영 — 재배열)

```
10a-1 (cache key) ★ Gate
  └─► 10a-2 (static 우선 + shim)
       ├─► 10a-3 (DCR 에러 분기) ┐
       ├─► 10a-4 (401 fail-fast) ★ Gate ─ (둘 병행 가능)
       │                           │
       │                           └─► 10a-6 (마이그레이션)
       │
       └─► 10a-5 (Admin UI) — 별도 병렬
```

**병행 가능성 (이전 버전의 선형 구조 → 병렬로 수정)**:
- 10a-4 는 **10a-3/5 와 독립**. 10a-2 직후 바로 착수 가능. 지금 당장 401 무한 루프
  방어가 가장 시급하므로 우선순위가 높음.
- 10a-5 (UI) 는 10a-3/4 어떤 것에도 의존하지 않음 — 백엔드 이미 완성되어 있을 때만
  붙이면 됨. 별도 트랙.
- 10a-6 (마이그레이션) 은 10a-2/4 완료 후 실행 가능 (10a-5 불필요).

**추천 실행 순서**: `10a-1 → 10a-2 → [10a-3 ∥ 10a-4] → 10a-6 → 10a-5`
(gate 10a-1/10a-4 는 각각 엄수)

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

### 6.4 동시성 제어 (Codex Round 3 반영)
- `markAuthFailed()` 와 `_refreshWithMutex()` 는 **같은 workspace-단위 mutex** 로 직렬화.
- 현재 `oauth-manager.js` 는 `_refreshMutex` Map 사용 → 재사용해서 `_withWorkspaceMutex(workspaceId, fn)` 헬퍼로 캡슐화.
- 경쟁 시나리오 방지:
  - 시나리오 1: refresh 진행 중 markAuthFailed 호출 → markAuthFailed 가 mutex 대기 → refresh 완료 후 action_needed 처리
  - 시나리오 2: markAuthFailed 중 다른 요청이 오는 refresh 트리거 → refresh 가 대기 → action_needed 플래그 확인 후 early-return
- save() 자체도 `_saving` 플래그 + chain 패턴이 이미 재진입 방어 중 (Phase 8b #6 완료 항목)

---

## 6-OBS. Observability (Codex Round 3 반영)

### 6-OBS.1 Audit events (`.ao/state/audit.jsonl`)
| Action | Payload | 발생 시점 |
|--------|---------|-----------|
| `oauth.client_registered` | `{workspace, issuer, source, clientId}` | DCR 성공 / manual 등록 완료 |
| `oauth.threshold_trip` | `{workspace, identity, threshold, consecutiveCount}` | 401 fail-fast 트리거 |
| `oauth.dcr_fallback` | `{workspace, issuer, from, to, reason}` | DCR → static 또는 역방향 fallback |
| `oauth.cache_purge` | `{workspace, issuer, cause: 'delete'\|'expire'}` | cache entry 제거 |
| `oauth.dcr_rate_limited` | `{workspace, issuer, retryAfterMs}` | 429 수신 |

### 6-OBS.2 Metric counters (UsageRecorder 확장)
- `oauth_threshold_trip_total{workspace,identity}` — 401 fail-fast 발생 수
- `oauth_dcr_total{workspace,issuer,status}` — DCR 호출 결과별
- `oauth_refresh_total{workspace,identity,status}` — refresh 시도 결과별
- `oauth_cache_hits_total / oauth_cache_misses_total`

### 6-OBS.3 로그 표준화
- 동일 workspace + identity 의 401 에는 같은 `correlationId` 부여 → 여러 줄의 관련 로그 연결 가능.
- `logger.warn` 대신 구조화 필드 사용: `{ wsId, identity, event: 'stream_401', attempt: N }`

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

## 9. 성공 기준 (assertion-style, Codex Round 3 반영)

각 항목은 검증 가능한 단정형으로. "정상 동작" 같은 주관적 표현 금지.

### 핵심
- [ ] **테스트 수**: `npm test` 결과 `# pass ≥ 286`, `# fail == 0`
- [ ] **다중 Notion isolation (수동 E2E)**:
  - Workspace A, B 두 개 등록 후 24시간 경과 시점에도
  - `.oauth.byIdentity.default.tokens.accessToken` 값이 A ≠ B (prefix 까지 다름)
  - `oauthActionNeededBy.default === false` 양쪽 모두
  - MCP tools/call 으로 Notion search 호출 시 둘 다 HTTP 200
- [ ] **마이그레이션 검증**: 마이그레이션 후 `ws.oauth.client.clientId` 필드 존재 +
  평면필드 `ws.oauth.clientId` 는 동일 값 (미러 유지) + 백업 파일 `workspaces.json.pre-10a.bak` 존재 + 권한 `0o600`
- [ ] **401 루프 fail-fast**: 테스트에서 401 응답 3회 주입 후 `_consecutive401Count === 0` (리셋됨) +
  `ws.oauthActionNeededBy.default === true` + `ws.oauthActionNeeded === true` + 스트림 reconnect 추가 시도 없음 (타이머 count 검증)
- [ ] **DCR 에러 분기**: 429 응답 → 에러 코드 `DCR_RATE_LIMITED` + `err.retryAfterMs` 세팅;
  400 응답 → `DCR_REJECTED` + 재시도 안 함; 503 응답 → `DCR_TRANSIENT` + 3회 retry 후 실패
- [ ] **Codex 교차 리뷰**: 판정 `APPROVE`

### 추가 검증 (Codex Round 2~3 반영)
- [ ] **재시작 시 DCR endpoint 호출 0회**: 테스트에서 fetch mock spy 로 첫 기동 시 DCR POST 1회 관찰 → 재시작 후 DCR POST 호출 count === 0 + workspace 는 여전히 tools/list 응답 성공
- [ ] **비 default identity 401 경로**: `bot_ci` 에서 401 × 3 후
  - `ws.oauth.byIdentity.bot_ci.tokens.accessToken === null`
  - `ws.oauthActionNeededBy.bot_ci === true`
  - `ws.oauth.byIdentity.default.tokens.accessToken` 변경 없음 (원값 유지)
  - `ws.oauth.tokens.accessToken` 변경 없음 (default legacy mirror 미영향)
  - `ws.oauthActionNeeded === false` (default 는 영향 없음)
- [ ] **Cache purge 대상 격리**: workspace A 영구 삭제 → `_clientCache[`${A.id}::*`]` 부재 검증
  + workspace B 의 `_clientCache[`${B.id}::*`]` 존재 유지 검증
- [ ] **Soft delete cache 정책**:
  - `softDelete(A)` 직후 → cache entry 유지
  - `restoreWorkspace(A)` → 재인증 없이 tools/list 성공
  - `_purgeExpiredWorkspaces()` 가 A 영구 삭제 → cache entry 제거
- [ ] **마이그레이션 3 경로**:
  - `--dry-run`: stdout 에 변경 내역 JSON 출력, config 파일 수정 0 bytes (mtime 동일)
  - `--apply`: `workspaces.json.pre-10a.bak` 생성 + chmod `0o600` + 새 포맷 저장 + startup 에 WARN 없음
  - `--restore`: `workspaces.json` 이 `.bak` 내용과 diff === 0
- [ ] **Concurrency 안전성**: `markAuthFailed` 와 `_refreshWithMutex` 를 동시에 트리거 하는
  테스트에서 최종 상태의 `oauthActionNeededBy[identity] === true` (역순 write 로 되돌아가지 않음)
- [ ] **Observability**: 401 fail-fast 발생 시 audit.jsonl 에 `action=oauth.threshold_trip`
  이벤트 1건 추가 확인

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

### Round 1 — 2026-04-20 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| 1 | "항상 신규 clientId 발급" 가정 금지, 등록 결과 **고정 저장** | §3.1 데이터 모델 + §4.10a-2 |
| 2 | DCR 에러를 429/4xx/5xx 로 분기 | §4.10a-3 |
| 3 | clientId 저장은 `workspaces.json` 내 인라인 | §3.1 |
| 4 | 재시작 시 재등록 금지, 기존 값 재사용 | §4.10a-2 단계 2번 |
| 5 | A 만으로 부족 — C (401 fail-fast) 동반 필수 | §4.10a-4 ★ Gate |
| 6 | 더 나은 대안: static client 우선, DCR fallback | §4.10a-2 단계 1번 |

### Round 2 — 2026-04-20 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| A | 평면 필드 (`ws.oauth.clientId/clientSecret/authMethod`) 직참조 범위 과소평가 | §3.4 신규 — 마이그레이션 shim + 읽기/쓰기 경로 분리 |
| B | `markAuthFailed` 가 byIdentity 모델과 어긋남, 비 default identity 처리 누락 | §4.10a-4 코드 블록 — `byIdentity[identity].tokens` 처리 + 조건부 legacy mirror |
| C | `auth_method` 스키마 포괄성 부족 (private_key_jwt 등) | §3.1 — 범위 `none/client_secret_basic/client_secret_post` 명시, Phase 10+ 이관 |
| D | 의존성 그래프가 과도하게 선형적, 병행 가능성 무시 | §5 — 재배열 + 병렬 트랙 표기 |
| 성공기준 | 재시작 DCR 미호출 / byIdentity 경로 / cache purge / 마이그레이션 3경로 누락 | §9 추가 검증 4건 |

### Round 3 — 2026-04-20 (REVISE → 반영 후 Round 4 검토 예정)

| # | 지적 | 반영 |
|---|------|------|
| B (부분재반영) | `oauthActionNeededBy` 는 **루트 필드** (`ws.oauthActionNeededBy`) — 중첩 아님 | §3.1 데이터 모델 + §4.10a-4 코드블록 주석으로 명시 |
| 경합 | `markAuthFailed` 와 `_refreshWithMutex`/`save` 동시성 last-write-wins | §6.4 동시성 제어 + §4.10a-4 `_withWorkspaceMutex` 직렬화 |
| 관측성 | threshold trip / DCR fallback / cache purge 의 audit + metric 미정의 | §6-OBS 신설 — 이벤트 5종 + counter 4종 + correlationId |
| 롤백/mixed-version | write-new-only 는 구 버전/외부 스크립트 호환 깨짐 | §3.4 — 최소 1 릴리즈 평면필드 미러 유지 + deprecation WARN |
| Soft delete 상호작용 | cache purge 정책 미결정 | §4.10a-1 — Option Y 채택 (soft delete 기간 유지, expire 시 purge) |
| 성공기준 느슨 | "정상 동작"/"network 모니터링" → assertion | §9 전체 재작성 (단정형 assertion) |

---

## 12. 미해결 질문 (Deep-Dive 전에 확인 필요)

1. **Notion MCP DCR 의 실제 동작** — `/register` 를 다른 `client_name` 으로 반복 호출 시 매번 새 client_id 반환하는지 curl 실측 필요
2. **Static client 발급 UX** — 운영자가 Notion integration 페이지에서 직접 받아야 하는데, Bifrost workspace 추가 wizard 에 안내 필요
3. **Notion MCP 공식 권장사항** — docs 가 "한 integration 당 여러 workspace" 를 권장하는지, 아니면 독립 integration 권장하는지 확인
