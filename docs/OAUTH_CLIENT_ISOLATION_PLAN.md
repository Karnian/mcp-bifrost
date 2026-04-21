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

**현재 코드에서 평면 필드 직참조 위치** (grep 검증 — Round 6 에서 2곳 추가):
1. `server/oauth-manager.js:592-594` — `_refreshWithMutex` 가 `ws.oauth.clientId / clientSecret / authMethod` 읽음
2. `server/oauth-manager.js:527-529` — `_persistTokens` 가 refresh 성공 후 `ws.oauth.{clientId,clientSecret,authMethod}` 쓰기
3. `server/workspace-manager.js:46-49` — `maskOAuth()` 의 마스킹 로직
4. `server/workspace-manager.js:308-310` — POST/PUT workspace 입력 파싱
5. `admin/routes.js:222-247` — OAuth authorization init (POST /api/workspaces/:id/oauth/authorize)
   — `ws.oauth?.clientId/authMethod/clientSecret` **읽기 + 쓰기 둘 다**
6. `admin/routes.js:271` — diagnostics 응답에 `cached.clientId` 노출 (메타 표시용)

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
    `workspace-manager.purgeExpiredWorkspaces()` 에서만 수행
- [ ] 테스트: 같은 issuer 로 서로 다른 workspace 2개 등록 → 서로 다른 clientId 반환
- [ ] 테스트: soft delete → cache 유지, restore → 재인증 불필요; expire → cache purge

### 10a-1b — `/api/oauth/discover` 정책 결정 (0.1 일, 10a-1 과 번들)

**배경**: 현재 `admin/routes.js:257-277` 의 POST `/api/oauth/discover` 는 Wizard
preview 단계에서 호출되며 `oauth.getCachedClient(issuer, authMethod)` 를 조회해서
`cachedClient` 필드를 반환. workspace-scoped cache 로 전환하면 이 API 는
workspaceId 맥락이 없음 (preview 시점엔 workspace 미생성).

**결정**: **Option Y 채택 — 응답에서 `cachedClient` 필드 제거**.
- 이유: Wizard preview 는 "이 issuer 가 DCR 지원하는지 + auth method 뭐가 있는지"
  만 알면 충분. cachedClient 유무는 workspace 생성 이후 의미.
- 변경 범위: admin/routes.js:271 의 `cachedClient` 필드 제거, 응답 스키마 업데이트.
  Admin UI (`admin/public/app.js`) 에서 해당 필드 참조 있으면 같이 제거.
- 테스트: discover 응답에 `cachedClient` 키 부재 검증.

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

- [ ] **신규 공개 진단 API** (Round 5 반영 — 현재 미존재):
  - `provider.getStreamStatus()` in `providers/mcp-client.js`
    - 반환 enum (Round 6 반영 — 전체 상태 완전성):
      - `'idle'` — transport=http/sse 이지만 아직 `_startNotificationStream()` 호출 전
      - `'connecting'` — stream open 시도 중
      - `'connected'` — SSE read 루프 진행 중
      - `'reconnecting'` — 일시 끊김 + backoff 재연결 대기
      - `'stopped:auth_failed'` — 401 × N 초과 → markAuthFailed 발동 후 영구 중단
      - `'stopped:unsupported'` — 405/404 받음 (서버가 GET stream 미지원 → 조용히 중단)
      - `'stopped:shutdown'` — `shutdown()` 호출 후
      - `'not_applicable'` — transport=stdio (notification stream 개념 없음)
    - 내부 상태 (`_streamConnected`, `_streamStopping`, `_streamAbort`, `_consecutive401Count`) 를 외부 enum 으로 매핑
    - 테스트 검증 + Admin UI 표시 둘 다 사용
  - `wm.getOAuthClient(workspaceId)` in `server/workspace-manager.js`
    - 반환: `ws.oauth.client ?? null` (load-time migration 후엔 항상 nested 반환)
    - 테스트 검증 + cache purge 확인 용도
- [ ] `providers/mcp-client.js` 에 `_consecutive401Count` 상태 추가 (identity 별 Map)
- [ ] `_startNotificationStream()` 의 401 분기:
  - 첫 번째 401 → refresh 시도 (기존 동작)
  - refresh 이후 다시 401 이면 `_consecutive401Count[identity]++`
  - 3회 초과 (`BIFROST_AUTH_FAIL_THRESHOLD` 환경변수 조정 가능) → `oauth-manager.markAuthFailed(workspaceId, identity)` 호출 + 해당 identity 스트림 재연결 중단
- [ ] `OAuthManager.markAuthFailed(workspaceId, identity)` 신규 (byIdentity 모델 + 루트 플래그 정확 처리):
  ```js
  // (workspaceId, identity) 튜플 mutex — identity 간 병렬성 유지 (Round 5 반영)
  await this._withIdentityMutex(workspaceId, identity, async () => {
    // _getRawWorkspace() 는 mutation 가능한 raw 참조 반환 (getWorkspace() 는 masked clone).
    // _save() 가 실제 저장. 기존 _markActionNeeded() 패턴과 동일 (oauth-manager.js:651-653).
    const ws = this.wm?._getRawWorkspace?.(workspaceId);
    if (!ws) return;
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
    // _save() 는 private 이지만 `oauth-manager.js:499` 이미 사용 중인 패턴
    if (this.wm?._save) await this.wm._save();
    // Observability: audit event + metric counter
    this.audit?.record({ action: 'oauth.threshold_trip', workspace: workspaceId, details: { identity, threshold: this._authFailThreshold } });
  });
  ```
  - 단순히 `tokens.accessToken = null` 만 하던 이전 설계안은 byIdentity 경로에서
    작동 안 함 (Codex Round 2 반영).
  - `_withIdentityMutex` 는 **(wsId, identity) 튜플 키 + FIFO chain 패턴** — §6.4 참고.
    기존 `_refreshMutex` 의 coalescing 패턴을 **버리고** chain 으로 대체 (Round 8 blocker 1 반영).
    workspace-단위 격상은 identity 병렬 refresh 계약 (oauth-manager.js:575-580 +
    phase7c-pre-migration.test.js:148-160) 을 깨뜨리므로 금지 (Round 5 반영).
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

### 6.4 동시성 제어 (Codex Round 3+5+6+8 반영)
- `markAuthFailed()` 와 `_refreshWithMutex()` 는 **`(workspaceId, identity)` 튜플 단위 mutex** 로 직렬화.
- 현재 `oauth-manager.js:575-580` 은 이미 identity 별 병렬 refresh 를 보장하고 있음
  (`tests/phase7c-pre-migration.test.js:148-160` 에서 default/bot_ci 병렬 refresh 검증).
  **workspace-단위로 격상하면 기존 계약 깨짐** → 튜플 키로 유지.
- ⚠️ **Semantics 전환 — coalescing ❌ → FIFO chain ✅** (Codex Round 8 blocker 1):
  - 현재 `_refreshMutex` 는 **coalescing** 패턴 (`if (existing) return existing` — `oauth-manager.js:579-580`).
    같은 identity 재진입 refresh 가 in-flight promise 에 piggyback → refresh 중복 호출 방지에는 적합.
  - 그러나 `markAuthFailed ↔ refresh` 상호배제는 coalescing 만으로 **성립 불가** — refresh 진행 중
    markAuthFailed 가 호출되면 coalescing 은 "같은 refresh promise 반환" 이므로 **action_needed 처리가
    refresh 뒤로 chain 되지 않고 refresh 결과로 대체됨**.
  - 해결: `_withIdentityMutex(wsId, identity, fn)` 는 **FIFO chain 패턴**. 내부 `Map<key, Promise>` 에
    마지막 꼬리를 저장, 각 호출은 그 꼬리에 `.then(fn)` 으로 체이닝 후 꼬리를 자기 것으로 교체. 즉
    **모든 호출이 순차 실행** (coalescing 아님).
  - 결과적으로 refresh coalescing 효과는 **사라짐** (같은 identity 병렬 refresh 2건 이 순차 실행됨).
    단, refresh 는 일반적으로 동일 identity 가 동시에 쏟아지지 않으므로 실용 영향 미미. coalescing 이
    필요한 경로가 있다면 `_withIdentityMutex` 내부에서 "최근 N ms 내 refresh 결과 캐시" 로 별도 처리.
- 구현 요약:
  - **`_refreshMutex` → `_identityMutex` rename** + coalescing 코드 (`if (existing) return existing`) **제거**
  - `_withIdentityMutex(wsId, identity, fn)` 헬퍼 신규:
    ```js
    _withIdentityMutex(wsId, identity, fn) {
      const key = `${wsId}::${identity}`;
      const prev = this._identityMutex.get(key) || Promise.resolve();
      const next = prev.catch(() => {}).then(() => fn());
      this._identityMutex.set(key, next);
      // 꼬리가 완료되면 Map entry 제거 (메모리 누수 방지)
      next.finally(() => {
        if (this._identityMutex.get(key) === next) this._identityMutex.delete(key);
      });
      return next;
    }
    ```
  - `_refreshWithMutex()` 와 `markAuthFailed()` 둘 다 위 헬퍼로 감싸 **동일 Map 공유**
    (Codex Round 6 — 서로 다른 Map 쓰면 상호배제 안 됨).
- 경쟁 시나리오 방지 (chain 패턴 기준):
  - 시나리오 1: refresh 진행 중 markAuthFailed(동일 identity) 호출 → markAuthFailed 는 refresh tail 에
    chain → refresh 완료 후 순차 실행 (action_needed 처리 보장)
  - 시나리오 2: markAuthFailed 중 동일 identity refresh 트리거 → refresh 는 markAuthFailed tail 에
    chain → 실행 시점에 action_needed 플래그 관찰 → early-return (`{ skipped: true, reason: 'action_needed' }`)
  - 시나리오 3: default 가 markAuthFailed 중 bot_ci 는 독립적으로 refresh 가능 (튜플 키가 달라 다른 chain)
- save() 자체도 `_saving` 플래그 + chain 패턴이 이미 재진입 방어 중 (Phase 8b #6 완료 항목)

---

## 6-OBS. Observability (Codex Round 3+4 반영)

### 6-OBS.1 Audit events (`.ao/state/audit.jsonl`)

현재 `AuditLogger.record({ action, identity, workspace, details })` 만 제공 + `details` 는
자유 문자열. **Phase 10a 는 새로운 스키마 변경 없이 현 계약에 맞춘 인코딩 규약을 고정한다.**

| Action | `identity` | `workspace` | `details` (JSON.stringify 전 객체) | 발생 시점 |
|--------|------------|-------------|------------------------------------|-----------|
| `oauth.client_registered` | 없음 | `wsId` | `{issuer, source: 'dcr'\|'manual', clientIdMasked, authMethod}` | DCR 성공 / manual 등록 |
| `oauth.threshold_trip` | `identity` | `wsId` | `{threshold, consecutiveCount, correlationId}` | 401 fail-fast 트리거 |
| `oauth.dcr_fallback` | 없음 | `wsId` | `{issuer, from, to, reason, correlationId}` | DCR → static 또는 역방향 fallback |
| `oauth.cache_purge` | 없음 | `wsId` | `{issuer, cause: 'delete'\|'expire', correlationId}` | cache entry 제거 |
| `oauth.dcr_rate_limited` | 없음 | `wsId` | `{issuer, retryAfterMs, correlationId}` | 429 수신 |

**인코딩 규약**:
- `details` 는 JSON 직렬화 가능한 단일 객체. 필드 순서는 고정 아님 (reader 가 key 기반 파싱).
- `correlationId` 는 `details` 내부 key 로 포함 (별도 1급 필드 승격 없음).
- **`clientId` 는 raw 저장 금지** — `maskClientId(clientId)` 로 `abcd***wxyz` 포맷 고정.
  이유: audit.jsonl 이 backup/외부 도구로 유출될 때 토큰 발급 요청 재구성 위험 감소.

### 6-OBS.2 Metrics — 별도 Recorder (UsageRecorder 와 분리)

현재 `UsageRecorder` 는 tool-call 집계기라 Phase 10a counter 를 직접 담기 불가.
**신규 `server/oauth-metrics.js` 도입** (lightweight, in-memory Map):

```js
export class OAuthMetrics {
  constructor() { this._counters = new Map(); }
  inc(name, labels = {}, delta = 1) { /* key = name + JSON(labels) */ }
  snapshot() { return [...this._counters]; }  // Admin UI /api/oauth/metrics
}
```

| Counter | Labels | 의미 |
|---------|--------|------|
| `oauth_threshold_trip_total` | `{workspace, identity}` | 401 fail-fast 발생 |
| `oauth_dcr_total` | `{workspace, issuer, status: 200\|4xx\|5xx\|429}` | DCR 호출 결과별 |
| `oauth_refresh_total` | `{workspace, identity, status: ok\|fail_4xx\|fail_net}` | refresh 시도 결과별 |
| `oauth_cache_hit_total / oauth_cache_miss_total` | `{workspace}` | cache 이력 |

Metric 은 **process-memory only** (Phase 10a 범위). 영구 저장/Prometheus export 는 Phase 11+.

### 6-OBS.3 로그 표준화
- 동일 workspace + identity 의 401 시퀀스에는 같은 `correlationId` (randomUUID) 부여.
  → audit.jsonl 과 logger 두 경로에서 동일 id 로 상관 가능.
- logger 호출도 구조화 형식: `logger.warn('[oauth]', { wsId, identity, event: 'stream_401', attempt: N, correlationId })`
- `correlationId` 는 `_consecutive401Count` 가 0 → 1 될 때 새로 생성, fail-fast 발동 또는 성공 후 리셋.

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

## 9. 성공 기준 (assertion-style, Codex Round 3+4+8 반영)

모든 항목은 자동화 테스트로 검증 가능한 단정형. 외부 리뷰/수동 E2E 기준 제거.
내부 구현 symbol (cache key 문자열 등) 대신 **공개 API / 파일 상태** 기준.

### 핵심
- [ ] **테스트 수**: `npm test` 결과 `# pass ≥ 286`, `# fail == 0`
- [ ] **다중 Notion isolation (자동 테스트, 모의 시계)** (Round 8 — API 정합화):
  - 2개 workspace 등록 + 첫 token 저장
  - `node:test` 의 `mock.timers.tick(24 * 60 * 60 * 1000)` 로 24h 경과 시뮬레이션 + `forceRefresh(id, 'default')` 트리거 (Round 5 반영)
  - 검증 (masked API — `workspace-manager.js:236` 기본 `masked=true` 고려):
    `wm.getWorkspace(A).oauth.byIdentity.default.tokens.accessTokenPrefix`
    !== `wm.getWorkspace(B).oauth.byIdentity.default.tokens.accessTokenPrefix`
    (prefix 포맷 `${first4}***${last4}` — 서로 다른 token 이면 prefix 도 달라짐)
  - 또는 raw 비교가 필요한 경우: `wm.getWorkspace(A, { masked: false }).oauth.byIdentity.default.tokens.accessToken`
  - 검증: 양쪽 `wm.getDiagnostics().workspaces[i].status === 'healthy'`
  - **수동 E2E 제거** (자동화로 동일 검증)
- [ ] **마이그레이션 파일 상태**:
  - `workspaces.json` → `ws.oauth.client.clientId === ws.oauth.clientId` (미러 일치)
  - `workspaces.json.pre-10a.bak` 파일 존재 + `mode & 0o777 === 0o600`
  - `ws.oauth.client.source ∈ {'dcr', 'manual'}`
- [ ] **401 루프 fail-fast (공개 상태 기준)**:
  - 테스트: 401 주입 3회 → `wm.getWorkspace(id).oauthActionNeededBy.default === true`
  - `wm.getWorkspace(id).oauthActionNeeded === true`
  - `provider.getStreamStatus()` (신규 공개 메서드) === `'stopped:auth_failed'`
  - `setTimeout` spy 로 backoff timer 예약 count === 0 (추가 reconnect 없음)
- [ ] **DCR 에러 분기**:
  - 429 응답 → throw `err.code === 'DCR_RATE_LIMITED'` + `typeof err.retryAfterMs === 'number'`
  - 400 응답 → throw `err.code === 'DCR_REJECTED'` + fetch spy call count === 1 (재시도 없음)
  - 503 응답 → throw `err.code === 'DCR_TRANSIENT'` + fetch spy call count === 3 (3회 retry)

### 추가 검증
- [ ] **재시작 시 DCR 0회**: 테스트 (fetch spy) — 첫 OAuth 사이클 DCR POST 1회,
  서버 재시작 (OAuthManager 재생성) 후 `tools/list` 호출 시 추가 DCR POST 0회 + tools/list 응답 성공
- [ ] **비 default identity 401 경로** (Round 8 — masked API 기준으로 교체):
  - `wm.getWorkspace(id).oauth.byIdentity.bot_ci.tokens.hasAccessToken === false`
  - `wm.getWorkspace(id).oauthActionNeededBy.bot_ci === true`
  - `wm.getWorkspace(id).oauth.byIdentity.default.tokens.hasAccessToken === true` (원값 유지)
  - `wm.getWorkspace(id).oauth.tokens.hasAccessToken === true` (legacy mirror 미변경)
  - `wm.getWorkspace(id).oauthActionNeeded === false` (root 플래그는 default 전용)
  - 참고: `hasAccessToken` 은 `workspace-manager.js:33` 의 `maskTokenEntry()` 가 반환하는 boolean — raw token 노출 없이 존재 여부만 확인.
- [ ] **Cache purge 대상 격리 (공개 API + behavior 검증)** (Round 8 — 보강):
  - workspace A hard delete 후 → `wm.getOAuthClient(A)` === null
  - workspace B 의 `wm.getOAuthClient(B)` → 여전히 이전 값 (격리 유지)
  - **Behavior 검증 — primary** (Round 9 반영, purge proof 는 fetch count 에 위임):
    - A 를 동일 id 로 재등록 + OAuth authorize 트리거 시 **DCR endpoint fetch spy call count === 1**
      (cache 에 남아있었다면 재사용돼서 0 이 나와야 정상이지만, purge 됐으므로 새로 호출돼야 함)
    - ★ 이 assertion 하나로 `_clientCache` purge 가 증명됨 (getter null + fetch=1).
  - **Optional / conditional** (§12 미해결 가정에 의존 — Round 9 조정):
    - 재등록 후 `wm.getOAuthClient(A).clientId !== `이전 A 의 clientId
    - 단, "Notion MCP DCR 을 다른 `client_name` 으로 반복 호출 시 매번 새 client_id 반환" 가정 (§12-1)
      이 curl 실측으로 확인된 경우에만 적용. 확인 안 되면 skip — primary assertion 만으로 충분.
- [ ] **Soft delete cache 정책**:
  - `softDelete(A)` 직후 → `wm.getOAuthClient(A)` 이전 값 유지 (DCR fetch spy call count === 0)
  - `restoreWorkspace(A)` + `tools/list` → HTTP 200 (재인증 요구 없음, DCR 0회)
  - `purgeExpiredWorkspaces()` 실행 후 → `wm.getOAuthClient(A)` === null
  - purge 후 동일 id 재등록 + authorize → DCR fetch spy call count === 1 (새 등록)
- [ ] **마이그레이션 3 경로**:
  - `--dry-run`: stdout JSON 출력 0 ≠ empty, `stat(workspaces.json).mtime` 변경 없음
  - `--apply`: `.bak` 존재 + `0o600` + 원본 변경됨 + process 종료 후 WARN 로그 0건
  - `--restore`: `diff workspaces.json workspaces.json.pre-10a.bak === ''`
- [ ] **Concurrency 안전성** (Round 8 — 공개 API `forceRefresh` 사용):
  - `Promise.all([om.markAuthFailed(A,'default'), om.forceRefresh(A,'default')])` 후
    최종 `wm.getWorkspace(A).oauthActionNeededBy.default === true` (어떤 순서든)
  - chain 패턴이므로 `forceRefresh` 가 markAuthFailed 뒤에 실행돼도 action_needed 관찰 → early-return
- [ ] **Refresh early-return 검증** (Codex Round 4 신규, Round 8 API 수정):
  - `om.markAuthFailed(A, 'default')` 호출 후 `om.forceRefresh(A, 'default')` 호출
    (`forceRefresh` 는 `oauth-manager.js:570-572` 의 공개 래퍼 — 내부에서 `_refreshWithMutex` 호출)
  - fetch spy → token endpoint POST call count === 0 (refresh 시도하지 않음)
  - 반환값에 `{ skipped: true, reason: 'action_needed' }`
- [ ] **Audit clientId 마스킹** (Codex Round 4 신규):
  - audit.jsonl 의 `oauth.client_registered` 이벤트 `details` 파싱 결과
  - `clientIdMasked` 필드 존재 + 포맷 `^[a-zA-Z0-9_-]{4}\*{3}[a-zA-Z0-9_-]{4}$`
    (Notion clientId 는 `_`, `-` 포함 가능 — 예: `GN6tDPJbB40wd_ei`)
  - `clientId` 필드 부재 (raw 저장 금지)
- [ ] **Observability 인코딩**:
  - 401 × 3 주입 후 audit.jsonl 에 `action === 'oauth.threshold_trip'` 이벤트 1건
  - `JSON.parse(event.details)` 결과에 `correlationId` (string) + `threshold` (number) + `consecutiveCount` (number) 포함

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

### Round 3 — 2026-04-20 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| B (부분재반영) | `oauthActionNeededBy` 는 **루트 필드** (`ws.oauthActionNeededBy`) — 중첩 아님 | §3.1 데이터 모델 + §4.10a-4 코드블록 주석으로 명시 |
| 경합 | `markAuthFailed` 와 `_refreshWithMutex`/`save` 동시성 last-write-wins | §6.4 동시성 제어 + §4.10a-4 `_withIdentityMutex` 직렬화 |
| 관측성 | threshold trip / DCR fallback / cache purge 의 audit + metric 미정의 | §6-OBS 신설 — 이벤트 5종 + counter 4종 + correlationId |
| 롤백/mixed-version | write-new-only 는 구 버전/외부 스크립트 호환 깨짐 | §3.4 — 최소 1 릴리즈 평면필드 미러 유지 + deprecation WARN |
| Soft delete 상호작용 | cache purge 정책 미결정 | §4.10a-1 — Option Y 채택 (soft delete 기간 유지, expire 시 purge) |
| 성공기준 느슨 | "정상 동작"/"network 모니터링" → assertion | §9 전체 재작성 (단정형 assertion) |

### Round 4 — 2026-04-20 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| Obs 접합 | `AuditLogger.record()` 계약과 불일치, `UsageRecorder` 는 tool-call 집계기 | §6-OBS.1 — 현 계약에 맞춘 `details` JSON 인코딩 규약 + correlationId 를 details 내부 key 로. §6-OBS.2 — `server/oauth-metrics.js` 별도 Recorder 도입 |
| Raw clientId 노출 | audit.jsonl 에 raw clientId → 유출면 증가 | §6-OBS.1 — `maskClientId(clientId)` 저장 원칙 고정. §9 에 마스킹 포맷 assertion 추가 |
| §9 assertion 비결정성 | 24h 수동 E2E / Codex APPROVE / 내부 캐시 키 직접 검증 | §9 — 모의 시계 (`clock.tick`) + 외부 리뷰 항목 제거 + 공개 API (`wm.getOAuthClient(id)`, `provider.getStreamStatus()`) 기준 |
| Refresh early-return 보장 검증 포인트 | "action_needed 보고 중단" 이 설명뿐 | §9 신규 assertion — `markAuthFailed` 후 refresh 호출 시 fetch POST 0회 + `{ skipped, reason }` 반환 |

### Round 5 — 2026-04-20 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| Mask regex | `_/-` 미포함 → Notion clientId (`GN6tDPJbB40wd_ei`) 에 충돌 | §9 — regex 에 `_-` 추가 |
| Mutex 격상 | workspace-단위 mutex 가 기존 identity별 병렬 refresh 계약 (`oauth-manager.js:575-580`, `phase7c-pre-migration.test.js:148-160`) 을 깨뜨림 | §6.4 + §4.10a-4 — `(wsId, identity)` 튜플 mutex 로 수정 (`_withIdentityMutex`) |
| 공개 API 미존재 | `provider.getStreamStatus()`, `wm.getOAuthClient()` 가 가상 API | §4.10a-4 — 신규 공개 진단 API 명시적 추가 작업 항목 |
| 함수명 불일치 | `_purgeExpiredWorkspaces()` vs 실제 `purgeExpiredWorkspaces()` | 전역 치환 |
| `clock.tick` 추상 | 구체 구현 모호 | §9 — `node:test` `mock.timers.tick` 로 명시 |

### Round 6 — 2026-04-20 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| Mutex 공유 누락 | `markAuthFailed` 만 `_withIdentityMutex` 쓰고 `_refreshWithMutex` 는 다른 Map 이면 상호배제 실패 | §6.4 — 기존 `_refreshMutex` 를 `_identityMutex` 로 rename, 헬퍼 통해 **같은 Map 공유** 명시 |
| `getStreamStatus()` enum 불완전 | `idle` / `stopped:shutdown` / `not_applicable` (stdio) 누락 | §4.10a-4 — enum 8개 상태로 확장 |
| 평면필드 참조 위치 2곳 추가 발견 | `admin/routes.js:222-247` (init 엔드포인트), `server/oauth-manager.js:527-529` (`_persistTokens`) | §3.4 — 참조 위치 목록 3→6 확장 |
| §11 문서 불일치 | Round 3 이력에 `_withWorkspaceMutex` 잔존 | 전역 치환으로 통일 |

### Round 7 — 2026-04-20 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| `markAuthFailed()` 저장경로 오류 | `getWorkspace()` masked clone + `save()` 미존재 | §4.10a-4 코드블록 — `_getRawWorkspace()` + `_save()` 로 수정 (기존 `oauth-manager.js:499, 503, 651-653` 패턴 일치) |
| `/api/oauth/discover` cachedClient 의미 충돌 | workspace-aware 전환 후 workspaceId 없는 맥락에서 조회 의미 희박 | §4.10a-1b 신규 단계 — cachedClient 필드 제거 (Option Y) |

### Round 8 — 2026-04-21 (REVISE)

| # | 지적 | 반영 |
|---|------|------|
| Mutex semantics 오인 유도 | `_identityMutex` 를 "기존 `_refreshMutex` 와 동일 구조" 로 기술 → 실제 `oauth-manager.js:579-580` 는 **coalescing** 패턴이라 그대로 구현하면 `markAuthFailed ↔ refresh` 상호배제 실패 | §6.4 전면 재작성 — **FIFO chain 패턴** 명시 + coalescing 제거 + `_withIdentityMutex` 헬퍼 코드 블록 추가 |
| §9 masked API 불일치 | `wm.getWorkspace(id).oauth.byIdentity.*.tokens.accessToken` 검증은 기본 `masked=true` (`workspace-manager.js:236-243`) 에서 raw token 못 봄 | §9 — `accessTokenPrefix` 비교 또는 `hasAccessToken` boolean 사용으로 교체. raw 필요 시 `{ masked: false }` 명시 |
| §9 비공개 API 참조 | `refreshWithMutex` 는 내부 `_refreshWithMutex` 로 공개 API 아님 | §9 — 공개 래퍼 `forceRefresh(wsId, identity)` (`oauth-manager.js:570-572`) 로 교체 |
| Cache purge 검증 약함 | `wm.getOAuthClient()` null 만으로는 `_clientCache` 내부 purge 증명 불가 | §9 Cache purge — 재등록 시 DCR fetch spy call count === 1 + 새 clientId 발급 behavior assertion 추가 |

### Round 9 — 2026-04-21 (REVISE → 1건만)

| # | 지적 | 반영 |
|---|------|------|
| Cache purge 과잉 assertion | "재등록 후 clientId !== 이전 clientId" 는 §12-1 (Notion MCP DCR 이 매번 새 client_id 반환하는지) 미확인 가정에 의존 — 이 가정이 깨지면 위양성 | §9 Cache purge — primary 는 DCR fetch call count === 1 에 위임, clientId 비교는 **optional/conditional** 로 강등 (§12-1 curl 실측 확인 시에만 적용) |
| (그 외 전부 승인) | R8 blocker 3건 + 보강 방향성 OK — §6.4 FIFO chain / accessTokenPrefix / hasAccessToken / forceRefresh 자동화 가능 확인 | — |

---

## 12. 미해결 질문 (Deep-Dive 전에 확인 필요)

1. **Notion MCP DCR 의 실제 동작** — `/register` 를 다른 `client_name` 으로 반복 호출 시 매번 새 client_id 반환하는지 curl 실측 필요
2. **Static client 발급 UX** — 운영자가 Notion integration 페이지에서 직접 받아야 하는데, Bifrost workspace 추가 wizard 에 안내 필요
3. **Notion MCP 공식 권장사항** — docs 가 "한 integration 당 여러 workspace" 를 권장하는지, 아니면 독립 integration 권장하는지 확인
