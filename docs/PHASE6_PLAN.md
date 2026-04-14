# Phase 6 — OAuth for Remote MCP Servers

**작성일**: 2026-04-14
**범위**: Bifrost에 MCP 2025-06-18 spec 기반 OAuth 2.0 Authorization Code + PKCE flow 추가
**주요 목표**: Notion 공식 hosted MCP (`https://mcp.notion.com/mcp`) 같은 OAuth-only 원격 MCP 서버를 사용자별 권한으로 등록/관리

---

## 1. 배경과 동기

### 문제
현재 Bifrost의 HTTP transport는 **정적 Bearer 토큰**만 지원:
```json
{ "headers": { "Authorization": "Bearer xxx" } }
```

하지만 공식 MCP 서버들의 실제 인증 방식은 **OAuth 2.0** (MCP spec 2025-06-18):
- Notion: `mcp.notion.com/mcp` → OAuth only
- 앞으로 GitHub/Linear/Asana 등도 같은 방향

정적 토큰을 쓰려면 Internal Integration 방식이지만, 이건 Notion 기준 **Workspace Owner 권한 필요** → Member-only 사용자는 접근 불가.

### 해결
Bifrost가 **OAuth 2.0 Authorization Code + PKCE** flow를 자체 수행해서 access_token 획득 및 관리.
- Member 권한으로도 본인이 접근 가능한 페이지만 authorize 가능 (Owner 권한 불필요)
- 여러 워크스페이스(회사/개인) 를 각각 authorize 해서 Bifrost에 모음 → **Bifrost 의 원래 가치 제공**

### 전제 (Single-User)
Bifrost 는 Phase 6 기준 **단일 사용자 시나리오** 를 전제로 설계됩니다.
- OAuth 로 획득한 access_token 은 Bifrost 서버 전체가 공유 사용
- 여러 사용자가 같은 Bifrost 를 MCP 엔드포인트로 사용하면, **A 사용자 권한으로 authorize 된 Notion 페이지를 B 사용자도 조회 가능** → 정보 누설 위험
- 공유 서버 운영 시: **별도 Bifrost 인스턴스를 사용자별로 분리** 권장, 또는 Phase 6.5+ 의 multi-MCP-token + per-token OAuth 격리 대기
- README / USAGE.md 에 경고 문구 추가

### 비목표 (Out of Scope)
- Bifrost 자체가 **OAuth 서버**가 되는 것 (Bifrost → 클라이언트 간 인증은 기존 Bearer 유지)
- User-to-User 위임 플로우 (한 사용자가 다른 사용자 대신 authorize)
- **Notifications subscription (tools/list_changed over SSE)** — HTTP/SSE stream 구독은 Phase 6.5 로 연기
- **OS keychain 통합 토큰 암호화** — Phase 7 고려 (현재는 평문 + chmod 600 + 마스킹)

### 반영: Self-Review 후 변경점 (v1 → v2 → v3)
**v1 → v2 (10개 FAIL 반영)**
- DCR fallback 을 Phase 6a 에 포함 (원안: 6.5 로 연기)
- 사전 검증 단계 (6-pre) 추가: Notion 실제 응답 형식 확인
- 일정 5일 → 7.5일
- Refresh token rotation + per-workspace mutex 명시
- Pending state 영속화 (메모리 → `.ao/state/`)

**v2 → v3 (10개 추가 FAIL 반영)**
- §1 에 **Single-User 전제** 명시 (FAIL G)
- 6a: Public/Confidential client 분기 (FAIL A), issuer cache key 에 auth_method 포함 (FAIL B), Windows chmod 경고 (FAIL E)
- 6b: pending state 파일 chmod + startup purge (FAIL C)
- 6c: Refresh mutex timeout 30s (FAIL I), OAuth audit 이벤트 (FAIL J)
- 6d: Remote Admin UI 공식 지원 축소, SSH tunnel 가이드로 대체 (FAIL D)
- 6-pre: 결과물 `docs/NOTION_MCP_PROBE.md` 에 문서화 (FAIL F)
- 6e: 실제 Notion 통합 테스트 env 플래그 자동화 (FAIL H)
- 일정 7.5일 → **8.5일**

---

## 2. MCP OAuth 명세 요약 (2025-06-18)

### 역할 분담
- **MCP Server** (Notion) = Resource Server
- **Authorization Server** (Notion OAuth) = 보통 같은 조직이 운영, 분리될 수도 있음
- **MCP Client** (Bifrost) = OAuth Public Client (PKCE 사용)

### 발견 (Discovery) 순서
1. **Resource Metadata** (RFC 9728): `GET https://mcp.notion.com/.well-known/oauth-protected-resource`
   ```json
   { "authorization_servers": ["https://auth.notion.com"], "resource": "https://mcp.notion.com" }
   ```
2. **Authorization Server Metadata** (RFC 8414): `GET https://auth.notion.com/.well-known/oauth-authorization-server`
   ```json
   {
     "issuer": "https://auth.notion.com",
     "authorization_endpoint": "https://...",
     "token_endpoint": "https://...",
     "registration_endpoint": "https://...",
     "code_challenge_methods_supported": ["S256"],
     "grant_types_supported": ["authorization_code", "refresh_token"],
     ...
   }
   ```
3. **Dynamic Client Registration** (RFC 7591): `POST registration_endpoint` with `redirect_uris`, `token_endpoint_auth_method: "none"` (public client)
   ```json
   → { "client_id": "abc123", "client_id_issued_at": ... }
   ```

### Authorization 수행
1. Bifrost가 `code_verifier` 랜덤 생성 → `code_challenge = SHA256(code_verifier)` (S256)
2. 브라우저를 authorization_endpoint로 리다이렉트:
   ```
   https://auth.notion.com/authorize?
     response_type=code&
     client_id=abc123&
     redirect_uri=http://localhost:3100/oauth/callback&
     state=RANDOM&
     code_challenge=SHA256_BASE64URL&
     code_challenge_method=S256&
     scope=...&
     resource=https://mcp.notion.com
   ```
3. 사용자가 Notion에서 승인 → 브라우저가 `http://localhost:3100/oauth/callback?code=XXX&state=RANDOM` 으로 리다이렉트
4. Bifrost가 `token_endpoint` 로 교환:
   ```
   POST https://auth.notion.com/token
   grant_type=authorization_code
   code=XXX
   redirect_uri=http://localhost:3100/oauth/callback
   client_id=abc123
   code_verifier=ORIGINAL
   ```
5. 응답: `{ "access_token": "...", "refresh_token": "...", "expires_in": 3600, "token_type": "Bearer" }`

### Token 사용
MCP 요청마다:
```
POST https://mcp.notion.com/mcp
Authorization: Bearer <access_token>
Content-Type: application/json
...
```

### Token 갱신
access_token 만료 시 (또는 401 받으면):
```
POST token_endpoint
grant_type=refresh_token
refresh_token=...
client_id=abc123
```

---

## 3. 아키텍처 설계

### 신규 파일
```
server/
  oauth-manager.js        — OAuth flow 전체 관리 (discovery, PKCE, 토큰 교환/갱신)
```

### 수정 파일
| 파일 | 변경 내용 |
|------|----------|
| `server/workspace-manager.js` | `oauth` 필드 지원, refresh 트리거 |
| `server/index.js` | `/oauth/callback` 라우트 추가 |
| `providers/mcp-client.js` | `oauth` 있으면 access_token 자동 주입, 401 시 refresh 후 재시도 |
| `admin/routes.js` | `POST /api/workspaces/:id/authorize` (URL 반환), `GET /oauth/callback` 처리 |
| `admin/public/app.js` | Wizard OAuth 모드, Detail "Re-authorize" 버튼 |
| `admin/public/templates.js` | `notion-official-oauth` 템플릿 (URL 프리셋) |

### 스키마 확장

`workspaces.json` 의 mcp-client 항목에 `oauth` 필드 추가:
```json
{
  "id": "notion-oauth-work",
  "kind": "mcp-client",
  "transport": "http",
  "url": "https://mcp.notion.com/mcp",
  "oauth": {
    "enabled": true,
    "issuer": "https://auth.notion.com",
    "clientId": "dyn_registered_client_id",
    "tokens": {
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": "2026-04-14T15:00:00Z",
      "tokenType": "Bearer"
    },
    "metadataCache": { "authorization_endpoint": "...", ... }
  }
}
```

`tokens`, `clientId` (public client라 secret 없음), `metadataCache` — credentials 와 동일하게 API 응답에서 마스킹.

### OAuth Manager 인터페이스

```js
class OAuthManager {
  // 1. Discovery + Dynamic registration → 저장
  async initialize(workspaceId, mcpUrl): Promise<{ authorizationUrl: string, state: string }>
  
  // 2. Callback 처리 (code → tokens)
  async completeAuthorization(state, code): Promise<tokens>
  
  // 3. access_token 만료 체크 및 refresh
  async getValidAccessToken(workspaceId): Promise<string>
  
  // 4. 강제 refresh (401 응답 후)
  async forceRefresh(workspaceId): Promise<tokens>
  
  // pending state (state → workspaceId + pkce 저장소, 10분 TTL)
}
```

---

## 4. 구현 단계

### 6-pre — 사전 검증 (0.5일) ★ 신규
**Self-review v1 FAIL 8 + v2 FAIL F 반영**: Notion MCP 의 실제 응답 형식 확인 없이 착수 불가.
- [ ] `curl` 로 `POST https://mcp.notion.com/mcp` 직접 요청 → 응답이 JSON 인지 SSE stream 인지 확인
- [ ] 응답에 `Mcp-Session-Id` 헤더 사용 여부 확인 (Streamable HTTP spec)
- [ ] WWW-Authenticate 헤더 포맷 확인
- [ ] `.well-known/oauth-protected-resource` 실제 응답 받아 형식 검증
- [ ] **`.well-known/oauth-authorization-server` 응답에서 `token_endpoint_auth_methods_supported`, `registration_endpoint` 존재 여부 확인** (DCR 지원 여부, Public vs Confidential 결정)
- [ ] **검증 결과 `docs/NOTION_MCP_PROBE.md` 에 기록** (실제 응답 원문, 파싱된 필드, 결정 사항)
- [ ] 검증 결과에 따라 영향받는 섹션 업데이트 (예: SSE stream 이면 6c 체크리스트에 stream 파싱 추가)
- [ ] **Gate**: SSE stream 응답이면 `_rpcHttp` 확장 작업 추가 (반일~1일)

### 6a — 발견 & 등록 (2.5일) ★ 확장
**Self-review v1 FAIL 1/2/5/10 + v2 FAIL A/B/E 반영**
- [ ] `.well-known/oauth-protected-resource` fetch (RFC 9728)
- [ ] `.well-known/oauth-authorization-server` fetch + cache (RFC 8414)
- [ ] Dynamic Client Registration 요청 (RFC 7591)
- [ ] **DCR 미지원 fallback (v2 FAIL A)**: registration_endpoint 없거나 4xx 응답 시 Admin UI 에 **Public / Confidential 토글 + Client ID (필수) + Client Secret (Confidential 시)** 입력 폼
  - `token_endpoint_auth_method`: `none` (public) / `client_secret_basic` (confidential)
  - auth server metadata 의 `token_endpoint_auth_methods_supported` 로 기본값 자동 선택
- [ ] **Issuer 단위 client 재사용 (v2 FAIL B)**: cache key = `(issuer, auth_method)` 튜플
  - `.ao/state/oauth-issuer-cache.json` 에 저장, chmod 0o600
  - 기존 cache 항목이 있으면 Wizard 에서 **"기존 client 재사용 vs. 새로 등록"** 선택 버튼 노출
- [ ] workspaces.json 에 `oauth.issuer`, `clientId`, `clientSecret`(있을 때), `authMethod`, `metadataCache` 저장
- [ ] **chmod 0o600 강제 (v2 FAIL E)**: `_save()` 에서 `fs.chmod(CONFIG_PATH, 0o600)` + backup 파일도 동일
  - Windows (`process.platform === 'win32'`) 는 chmod 건너뛰고 **Admin UI 상단에 경고 배너** 노출: "Windows: 파일 권한 보호가 제한적입니다. 공유 PC 사용 자제."
- [ ] **로그 sanitization**: `logError()` 가 기록하는 message 에서 `access_token=...`, `refresh_token=...`, `code=...`, `client_secret=...`, `Authorization: Bearer ...` 패턴 정규식으로 `***` 치환. 공통 `sanitize(str)` 유틸 도입
- [ ] **MCP spec 체크리스트**: `Mcp-Session-Id`, `resource=` parameter (RFC 8707), token audience 오류 처리
- [ ] 에러 케이스: resource metadata 없음, auth server 404, registration 거부, 잘못된 audience
- [ ] 테스트: mock auth server fixture 로 단위 테스트 (DCR + DCR 미지원 + Public/Confidential 양쪽)

### 6b — Authorization Code + PKCE flow (1.5일)
**Self-review v1 FAIL 4 + v2 FAIL C 반영**
- [ ] PKCE code_verifier/challenge 생성 (32 bytes random → base64url)
- [ ] state 생성 (HMAC 서명된 random → CSRF + 위조 방지)
  - server secret 은 첫 기동 시 `.ao/state/server-secret` 에 랜덤 생성 (chmod 0o600)
- [ ] **Pending state 영속화 (v2 FAIL C 강화)**:
  - `.ao/state/oauth-pending.json` 에 state + verifier + workspaceId + TTL(10분) 저장
  - **파일 저장 시 chmod 0o600 강제** (workspaces.json 과 동일)
  - **기동 시 `expiresAt < now` 항목 purge** (stale cleanup)
  - flow 완료 시 해당 state 항목 즉시 삭제 (try-finally 보장)
  - 서버 재시작/hot reload 에도 진행 중 flow 생존
- [ ] `POST /api/workspaces/:id/authorize` → authorization URL 반환
- [ ] `GET /oauth/callback?code&state` 처리:
  - state 검증 (pending store lookup + HMAC 서명 검증) + TTL 확인
  - `POST token_endpoint` 으로 exchange (verifier 포함, auth_method 에 따라 Basic/POST body)
  - tokens 저장 (chmod 포함)
  - pending state 즉시 삭제 (1회용)
  - 브라우저에 "성공" 페이지 반환 (창 닫기 안내)
- [ ] Admin UI: "Authorize" 버튼 클릭 → 새 탭/팝업으로 authorization URL 열기
- [ ] 테스트: end-to-end mock flow + 재시작 생존 테스트 + stale cleanup 테스트 + state 위조 시도 거부

### 6c — Token 사용 & 갱신 (1.5일) ★ 확장
**Self-review v1 FAIL 6 + v2 FAIL I/J 반영**
- [ ] `McpClientProvider._connectHttp()` 에서 `oauth.enabled` 이면 access_token 주입
- [ ] `_rpcHttp` 에서 401 응답 시 `forceRefresh` → 한 번 재시도 (exponential backoff 기존 로직과 충돌 안 하게 분리)
- [ ] `getValidAccessToken()`: 만료 시간(`expiresAt` - 60초 여유) 체크 후 자동 refresh
- [ ] **Per-workspace refresh mutex (v1 FAIL 6)**: 동일 워크스페이스의 동시 refresh 요청 직렬화 (Promise 공유)
- [ ] **Refresh mutex timeout (v2 FAIL I)**: 공유 Promise 에 30초 timeout 래퍼. 타임아웃 시 mutex 해제, 에러 전파, 다음 호출은 새 시도 허용
- [ ] **Refresh token rotation (v1 FAIL 6)**: 응답의 `refresh_token` 이 있으면 교체 저장
- [ ] refresh 실패(예: refresh_token 만료/revoke) 시 워크스페이스 상태 `action_needed`로 전환 + Dashboard 배너
- [ ] **OAuth audit 이벤트 (v2 FAIL J)**: `oauth.authorize_start`, `oauth.authorize_complete`, `oauth.authorize_fail`, `oauth.refresh_success`, `oauth.refresh_fail`, `oauth.reauthorize` 를 audit log 에 기록. token value 는 기록 안 함, 메타데이터만
- [ ] **logError 시 token value 제외** — sanitize 유틸 사용
- [ ] 테스트: 만료 토큰 시뮬레이션, rotation 확인, 동시 refresh race condition, mutex timeout 시 복구, audit 이벤트 발생 확인

### 6d — UI / UX (1일) ★ 축소
**Self-review v1 FAIL 3 + v2 FAIL D 반영**
- [ ] Wizard 에 "HTTP (OAuth)" 트랜스포트 옵션
  - URL 입력 → "다음" 누르면 즉시 discovery + registration
  - DCR 실패 시 수동 client_id/secret 입력 폼 fallback (Public/Confidential 토글 포함)
  - "Authorize" 버튼 표시, 클릭 시 팝업
  - 팝업 닫힌 후 callback 도착하면 자동으로 완료 화면 진입
- [ ] **Remote Admin UI 사용 가이드 (v2 FAIL D 조정)**:
  - OAuth 는 **localhost 브라우저 + localhost Admin UI** 조합에서만 공식 지원
  - Remote Admin UI 사용자 대상으로는 **USAGE.md 에 "SSH tunnel (`ssh -L 3100:localhost:3100 user@host`) 사용 후 localhost 로 접속하세요"** 가이드 추가
  - 완전한 out-of-band flow (브라우저 → 외부 Bifrost 직접 접근 불가) 는 Phase 6.5 로 연기 (복잡도 대비 수요 낮음)
- [ ] Windows 감지 시 Admin UI 상단 경고 배너 표시
- [ ] Detail 화면:
  - OAuth 워크스페이스는 credentials 편집 대신 **"Re-authorize"** 버튼
  - 토큰 만료 시간 표시 ("access_token 만료까지 45분", "refresh 마지막 18분 전")
  - 만료 임박 시 Dashboard 의 Needs Attention 영역에 표시
- [ ] `notion-official-oauth` 템플릿 추가 (URL 프리셋 `https://mcp.notion.com/mcp`, `oauth.enabled = true`)
- [ ] 에러 UI: "Authorization 실패 (reason)", "Refresh token 만료 — 재인증 필요"

### 6e — 테스트 & 문서 (1일) ★ 확장
**Self-review v2 FAIL H 반영**
- [ ] Mock OAuth server fixture (`tests/fixtures/mock-oauth-server.js`)
  - discovery endpoints + DCR + DCR-미지원 모드 스위치 env
  - authorize (자동 승인 옵션)
  - token exchange + refresh + rotation (rotation on/off 모드)
  - /mcp Bearer 검증
  - `MOCK_EXPIRES_IN` env 로 토큰 짧은 TTL 설정 (10초) → refresh flow 빠른 검증
- [ ] 단위 테스트 (15+):
  - discovery 파싱, DCR 성공/실패/Public/Confidential
  - PKCE/state 생성/검증/TTL/HMAC 위조 거부
  - pending state 파일 chmod + startup purge
  - token 교환, refresh, rotation (교체/무교체 양쪽)
  - 401 → refresh → 재시도 flow
  - 동시 refresh mutex + timeout 복구
  - audit 이벤트 기록 확인
  - 토큰 마스킹 (API 응답, 로그 sanitize)
  - Windows chmod skip 경로 (mock `process.platform`)
- [ ] **실제 Notion 통합 테스트 (환경변수 기반)**:
  - `BIFROST_TEST_NOTION_OAUTH=1` 이면 `tests/integration/notion-oauth.test.js` 활성화
  - 수동 한 번 실행 → refresh_token 을 env 로 재사용 → 자동화
  - CI 에서는 skip 기본
- [ ] USAGE.md 에 OAuth 등록 섹션 + SSH tunnel 가이드 추가
- [ ] README 에 **Single-User 전제** 경고 추가
- [ ] Notion OAuth 연결 시나리오 수동 검증 (체크리스트)

### 총 예상 시간: **8.5일** (5일 → 7.5일 → 8.5일)
**Self-review v2 반영**: DCR fallback (Public/Confidential 분기), pending state 보안/cleanup, mutex timeout, audit 이벤트, Windows 대응, 실제 Notion 통합 테스트 자동화 — 추가로 1일.

---

## 5. UI/UX 세부

### Wizard Step 2 (HTTP OAuth 모드)

```
┌─────────────────────────────────────────┐
│ Notion (공식 MCP via OAuth)              │
├─────────────────────────────────────────┤
│ 표시 이름                                 │
│ [회사 Notion                          ]  │
│                                          │
│ Alias (선택)                             │
│ [자동 생성                            ]  │
│                                          │
│ MCP 서버 URL                             │
│ [https://mcp.notion.com/mcp          ]  │
│                                          │
│ ℹ️  이 서버는 OAuth 인증이 필요합니다.    │
│     "Authorize" 버튼을 누르면 Notion      │
│     로그인 창이 열리고, 사용할 페이지를   │
│     선택해서 승인할 수 있습니다.          │
│                                          │
│ [Authorize with Notion]                 │
└─────────────────────────────────────────┘
```

### Authorize 진행 중

```
┌─────────────────────────────────────────┐
│ Notion 승인 대기 중...                    │
│                                          │
│ 브라우저 창에서 다음을 진행하세요:        │
│  1. Notion 계정 로그인                   │
│  2. 워크스페이스 선택                     │
│  3. 공유할 페이지 체크                    │
│  4. "Accept" 클릭                        │
│                                          │
│ 팝업이 안 보이면 [여기를 클릭]            │
│                                          │
│ (창이 닫히면 자동으로 진행됩니다)         │
└─────────────────────────────────────────┘
```

### 완료 후

```
┌─────────────────────────────────────────┐
│ ✓ 인증 완료                               │
│                                          │
│ 액세스 토큰 발급 성공                     │
│ 13개 도구 발견: search, query_database,  │
│ get_page, ...                           │
│                                          │
│ [Dashboard 로 이동]                      │
└─────────────────────────────────────────┘
```

### Detail — OAuth 워크스페이스

```
┌─────────────────────────────────────────┐
│ 회사 Notion                    ● Healthy │
├─────────────────────────────────────────┤
│ Namespace: notion-work (불변)            │
│ Display Name: [회사 Notion            ] │
│ Alias: [notion-work                  ] │
│                                          │
│ Authentication: OAuth 2.0                │
│ Issuer: https://auth.notion.com          │
│ Client ID: dyn_abc***789 (자동 등록)     │
│ Access Token 만료: 42분 후               │
│ Last Refresh: 18분 전                    │
│                                          │
│ [Re-authorize]  ← 권한 변경/토큰 만료 시 │
└─────────────────────────────────────────┘
```

---

## 6. 보안 설계

### 1. PKCE 필수
- OAuth public client (client_secret 없음) → PKCE S256 필수
- code_verifier: `crypto.randomBytes(32)` → base64url
- code_challenge: `SHA256(verifier)` → base64url

### 2. State 파라미터
- CSRF 방지 + workspace 식별
- **서버 측 영속 store**: `.ao/state/oauth-pending.json` 에 `{ state → { workspaceId, pkceVerifier, expiresAt } }` 저장
- state 값은 `HMAC(server_secret, random_bytes)` 서명된 문자열 → 서버 외부에서 위조 불가
- 10분 TTL, 사용 후 즉시 삭제, 서버 재시작/hot reload 에도 생존

### 3. Redirect URI 제한
- **항상 `http://localhost:3100/oauth/callback` 또는 127.0.0.1**
- Bifrost가 `0.0.0.0` 바인딩되어도 callback은 localhost 한정
- Dynamic registration 시 이 URI로 등록

### 4. Token 저장
- `workspaces.json` 에 평문 저장 (기존 credentials 과 동일 정책)
- **`_save()` 에서 `fs.chmod(CONFIG_PATH, 0o600)` 강제** (backup 파일 포함)
- Admin API 응답에서 **마스킹** (`eyJhbGci***XYZ`)
- **로그 sanitization**: `logError()`/audit log 에 `Authorization: Bearer ...`, `refresh_token=...`, `code=...` 패턴 정규식으로 `***` 치환
- **Phase 6에서는 암호화 안 함** — OS keychain 통합은 Phase 7 고려

### 5. Refresh token 관리
- refresh token 은 더 장기 유효 → 유출 시 피해 큼
- API 응답에서는 `expiresAt`, `lastRefresh` 만 노출, 토큰 값 자체는 마스킹
- **Refresh token rotation 지원**: token 응답의 `refresh_token` 이 있으면 교체 저장 (OAuth 2.1 권장)
- **Per-workspace refresh mutex**: 동시 refresh 요청 race condition 방지 (Promise 공유로 직렬화)
- 서버 재시작해도 refresh 가능해야 함 (파일 저장)

### 6. 클라이언트 측 보안
- Admin UI 는 여전히 localhost 전용 권장 (`BIFROST_ADMIN_EXPOSE=1` 없으면 차단)
- OAuth 초기화/완료도 Admin API 경유 → Admin 토큰 검증 받음

### 7. callback 엔드포인트 인증
- `/oauth/callback` 은 **Admin token 인증 없이 접근** 필요 (브라우저 리다이렉트)
- 하지만 `state` 검증이 있고, state 는 Admin 이 생성한 세션에서만 생성됨 → 공격자가 임의로 callback 호출해도 state 매치 안 됨
- 추가 안전장치: state 에 HMAC signature 포함 가능

---

## 7. 리스크 & 미해결 이슈

### R1. Notion OAuth의 실제 동작 불확실성
- Dynamic Client Registration 지원 여부 (MCP spec 권장이지만 필수 아님)
- 만약 미지원이면 Bifrost 운영자가 수동으로 Notion 에 client_id 등록해야 함 → Phase 6.5 로 확장
- **완화**: 초기 discovery 단계에서 `registration_endpoint` 있으면 자동, 없으면 UI 에 "Client ID/Secret 을 수동 입력하세요" 폼

### R2. Refresh token 만료
- Notion 의 refresh_token 만료 정책 미문서화
- 만료 시 사용자에게 "Re-authorize" 요구 → `action_needed` 상태
- **완화**: Dashboard 의 Needs Attention 영역에 "재인증 필요" 표시

### R3. 여러 워크스페이스 동시 authorize
- 2개 이상 동시 진행 시 state 충돌은 random string 으로 회피
- 하지만 브라우저에서 여러 팝업 뜨면 혼란 → UI 에서 직렬화

### R4. 서버 재시작 시 진행 중 flow
- authorize 진행 중 Bifrost 재시작되면 pending state 잃어버림 → 사용자가 다시 클릭해야 함
- **타협**: pending state 는 메모리 보관 (디스크 저장 안 함) + UI 에 "창 닫지 말고 완료하세요" 안내

### R5. callback hijacking
- localhost 는 MAC 의 다른 프로세스가 가로챌 수 있음 (드물지만 가능)
- **완화**: state 가 HMAC 서명되어 있어 위조 불가 + code 는 1회용

### R6. Notion API spec 변경
- MCP 2025-06 vs 실제 Notion 구현 사이 갭 가능
- **대응**: 실제 트래픽 로깅 (DEBUG 모드) + 초기에 수동 검증

---

## 8. 테스트 전략

### 단위 테스트 (자동화)
`tests/phase6.test.js`:
- [ ] PKCE code_verifier/challenge 생성 검증
- [ ] state 생성/검증/만료
- [ ] Discovery 파싱 (mock fixture)
- [ ] Dynamic registration 파싱
- [ ] Token 응답 파싱 (access+refresh+expires_in)
- [ ] Refresh flow (만료 시뮬레이션)
- [ ] 401 → refresh → 재시도 flow

### Mock 서버 fixture
`tests/fixtures/mock-oauth-server.js`:
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/register` (RFC 7591)
- `/authorize` (즉시 redirect with code — 브라우저 대신 가짜 승인)
- `/token` (code → access_token, refresh_token → new access_token)
- `/mcp` (Bearer 검증 + tools/list, tools/call 프록시)

### 수동 End-to-End (Notion 실제)
1. Bifrost 실행
2. Wizard → Notion Official (OAuth) 선택
3. URL `https://mcp.notion.com/mcp` 입력
4. Authorize 클릭 → 브라우저 팝업 → Notion 로그인 → 페이지 선택 → Accept
5. Bifrost Dashboard 에서 Healthy 확인
6. Tools 탭에서 Notion MCP 도구들 노출 확인
7. `curl` 로 `tools/call` 실행 → 응답 정상
8. 1시간 대기 (토큰 만료) → 다시 호출 → 자동 refresh 확인
9. 두 번째 Notion 워크스페이스 (다른 계정) 추가 → 네임스페이스 충돌 없이 동작 확인

---

## 9. 성공 기준

- ✅ Notion hosted MCP (`mcp.notion.com/mcp`) 에 Member 권한 사용자가 연결 성공
- ✅ 여러 Notion 워크스페이스(개인 + 회사) 가 Bifrost 에 각각 등록되어 단일 엔드포인트로 노출
- ✅ access_token 만료 시 자동 refresh — 사용자 개입 없이 끊김 없음
- ✅ Refresh token rotation 지원 (새 refresh_token 저장)
- ✅ 동시 refresh race condition 없음 (mutex)
- ✅ refresh_token 만료/revoke 시 `action_needed` 상태 + "Re-authorize" 안내
- ✅ DCR 미지원 서버도 수동 client_id 입력으로 등록 가능
- ✅ 서버 재시작 중에 진행되던 OAuth flow 복구 (pending state 영속)
- ✅ 같은 issuer 의 여러 워크스페이스가 client 1개 공유
- ✅ 60+ 기존 테스트 + 15+ Phase 6 단위 테스트 모두 PASS
- ✅ Admin UI / 로그 / diagnostics 에서 토큰 평문 노출 없음
- ✅ `workspaces.json` 권한 `0600` 확인
- ✅ Remote Admin UI 환경에서도 수동 fallback 으로 OAuth 가능

## 10. 후속 / 확장 (Phase 6.5+)

- ~~**Pre-configured client (DCR 미지원 서버)**~~ → **Phase 6a 에 포함**
- ~~**Multi-account OAuth caching**~~ → **Phase 6a 에 포함** (issuer 단위 client 재사용)
- **Notifications subscription**: MCP `notifications/tools/list_changed` 를 HTTP/SSE stream 으로 구독 (현재는 stdio 만 지원)
- **Device code flow**: 브라우저 없는 환경 (SSH 서버 등)
- **Token 암호화 저장** (Phase 7): OS keychain 통합 (macOS Keychain, Linux secret-service, Windows Credential Manager)
- **OAuth for MCP-over-SSE**: Streamable HTTP 외 SSE transport 에서도 같은 flow
- **Per-user OAuth isolation**: Bifrost 멀티 테넌트 모드 (multi MCP token) 시 각 MCP 클라이언트 사용자별로 OAuth 분리

---

## 진행 확인

이 계획서 기준으로 Phase 6 착수 가능. 피드백 항목:
1. 구현 범위 줄이거나 늘릴 부분?
2. 토큰 암호화 저장을 Phase 6에 포함할지 (현재 평문 + 마스킹)
3. Pre-configured client (DCR 미지원) 대응을 6a에 포함할지
4. 5일 추정이 타당한지

승인 후 Phase 6a (발견 & 등록) 부터 시작합니다.
