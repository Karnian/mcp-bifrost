# Phase 12 — Native Slack OAuth (Multi-Workspace)

**작성일**: 2026-04-29
**상태**: 📋 **계획 — 미실행**
**범위**: `providers/slack.js` 에 Slack OAuth v2 install flow 신규 구현 + 한 Slack App 으로 다수 Slack workspace 등록 지원
**주요 목표**: Bifrost self-host 환경에서 사용자가 여러 외부 Slack workspace 를 OAuth 클릭 흐름으로 연결 가능하게 한다 (Slack hosted MCP 정책 제약 우회)

---

## 1. 배경과 동기

### 발단
Phase 11 까지 Slack 연결은 두 가지뿐:

1. **Native `providers/slack.js`** — `botToken` 정적 문자열 직접 입력 (OAuth 없음)
2. **`mcp-client` + `https://mcp.slack.com/mcp`** — Slack hosted MCP server 사용 (OAuth 가능)

### Slack hosted MCP 의 정책 제약 (2026-04-29 Codex 검증)
공식 문서 `https://docs.slack.dev/ai/slack-mcp-server/` + discovery metadata 직접 호출 결과:

| Slack App distribution | hosted MCP 사용 |
|---|---|
| Internal-only / undistributed (한 organization 내) | ✅ |
| Marketplace listed (심사 통과) | ✅ |
| **Unlisted distributed (Public Distribution 켰지만 Marketplace 미등재)** | ❌ **금지** |

추가 사실:
- Slack OAuth 는 **RFC 7591 DCR 미지원** (`registration_endpoint` 노출 안 됨)
- `oauth_anthropic_creds` 와 같은 broker 인프라는 Anthropic 이 Slack 과 partnership 으로 발급받은 first-party credential — third-party self-host 도구 (Bifrost) 는 같은 자리에 있을 수 없음
- Claude Desktop 의 "Custom Connector" 도 결국 사용자 client_id/secret 입력 모델 — Bifrost 의 static-client UX 와 같은 패턴

### 사용자 시나리오 (2026-04-29 합의)
대상 사용자는 **외부 다수 워크스페이스** (개인 + 회사 + 친구 organization) 를 한 Bifrost 인스턴스에 묶어 쓰려 한다. 이 경우:

- Internal-only Slack App → 한 organization 내부 workspace 만 install 가능 → ❌
- Marketplace listed → 심사 통과 비현실 → ❌
- **Unlisted distributed Slack App + hosted MCP 우회 + Slack Web API 직접** → ✅ 유일한 현실 경로

### Phase 12 의 답
`providers/slack.js` 를 OAuth 모드로 확장. Slack OAuth v2 install flow (`https://slack.com/oauth/v2/authorize` + `oauth.v2.access`) 를 Bifrost 에 직접 구현하고, Slack Web API 를 직접 호출해서 hosted MCP 를 우회. Slack App 한 개 (사용자 본인 등록) 의 client_id/secret 을 N 개 Bifrost workspace entry 에서 재사용.

### 핵심 가치
1. 사용자가 Slack App 을 **한 번만** 만들면 워크스페이스 추가는 클릭으로 끝
2. Phase 10a 의 workspace-scoped 격리 인프라를 그대로 재사용 → 동일한 안정성
3. Token rotation (`xoxe.xoxp-...`, 12h 만료) 자동 처리
4. 기존 `botToken` 정적 모드와 공존 — 마이그레이션 강제 없음

---

## 2. 스코프 요약

### In-scope (8 sub-phases)

| Sub | 항목 | 성격 |
|-----|------|------|
| 12-1 | Workspace schema 확장 — `slackOAuth` 필드 + Zod 검증 | 필수 |
| 12-2 | `server/slack-oauth-manager.js` 신규 — install / token exchange / refresh | 필수 |
| 12-3 | `providers/slack.js` OAuth 모드 — user-token wiring, 기존 botToken 모드 공존 | 필수 |
| 12-4 | Admin REST endpoints — `/api/slack/setup`, `/api/slack/authorize`, `/oauth/slack/callback` | 필수 |
| 12-5 | Admin UI — Slack App 설정 페이지 + Wizard 의 "Slack workspace 추가" 흐름 | 필수 |
| 12-6 | Refresh + token rotation + 멀티 워크스페이스 mutex (Phase 10a 패턴 재사용) | 필수 |
| 12-7 | Slack App manifest 템플릿 + 운영 가이드 (`docs/SLACK_OAUTH_SETUP.md`) | 권장 |
| 12-8 | Tests + migration + Phase 12 self-review | 필수 |

### Non-goals
- **Slack Marketplace 게재** — self-host 도구의 범위를 벗어남
- **Slack hosted MCP (`mcp.slack.com/mcp`) 지원** — 이미 `mcp-client` 경로로 가능 (Internal-only Slack App 환경에서)
- **Bot-token OAuth flow** — Phase 12 는 user-token only (Slack hosted MCP 와 동일한 권한 모델). Bot 은 별도 phase 후보
- **Slack Enterprise Grid org-wide install** — 일반 workspace install 만 우선. Org-wide 는 후속 phase
- **Slack `assistant.*` API 통합** — 도구 surface 는 기존 search/read/list 위주 유지
- **Slack realtime events (Events API / Socket Mode)** — webhook 인프라 별도

---

## 3. 데이터 모델

### 3.1 Server-level — Slack App credential
한 Slack App 의 client_id / client_secret 은 여러 workspace entry 에서 공유. workspace 안에 박지 않고 server-level 로 분리:

```jsonc
// config/workspaces.json — top-level (workspaces array 와 동등)
{
  "slackApp": {
    "clientId": "1234567890.1234567890",
    "clientSecret": "abcdef123456...",
    "tokenRotationEnabled": true,           // Slack manifest 와 일치
    "createdAt": "2026-05-01T10:00:00Z",
    "updatedAt": "2026-05-01T10:00:00Z"
  },
  "workspaces": [ ... ]
}
```

또는 환경변수 폴백:
- `BIFROST_SLACK_CLIENT_ID`
- `BIFROST_SLACK_CLIENT_SECRET`
- env 우선, 없으면 file 사용

`clientSecret` 은 `0o600` 으로 보호 (Phase 6 의 `chmod0600` 재사용). audit log 에는 항상 `maskClientId` 로 마스킹.

### 3.2 Workspace-level — per-workspace tokens

```jsonc
// workspaces[].slackOAuth (provider === 'slack' && authMode === 'oauth' 일 때만 존재)
{
  "id": "slack-acme",
  "kind": "native",
  "provider": "slack",
  "authMode": "oauth",                       // NEW — 'oauth' | 'token' (default: 'token')
  "displayName": "ACME Slack",
  "namespace": "acme",
  "slackOAuth": {
    "team": {
      "id": "T01ABCDEF",                     // 토큰이 묶인 Slack team_id
      "name": "ACME"                         // OAuth 응답에서 받은 team name
    },
    "authedUser": {
      "id": "U02GHIJKL",                     // 인증한 사용자 (감사용)
      "scopesGranted": ["search:read", ...]
    },
    "tokens": {
      // 기존 oauth.byIdentity 와 유사한 형태로 통일
      "accessToken": "xoxe.xoxp-1-...",      // rotatable user-token
      "refreshToken": "xoxe-1-...",
      "expiresAt": 1717000000,               // unix seconds
      "tokenType": "user"
    },
    "lastRefreshedAt": "2026-05-01T15:00:00Z",
    "issuedAt": "2026-05-01T10:00:00Z"
  }
}
```

기존 `credentials.botToken` 은 `authMode: 'token'` 일 때만 사용. OAuth 모드에선 `slackOAuth.tokens.accessToken` 을 사용.

### 3.3 Schema 확장 (`server/workspace-schema.js`)

```js
const slackOAuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),     // rotation 끄면 없을 수 있음
  expiresAt: z.number().int().nonnegative().optional(),
  tokenType: z.enum(['user', 'bot']).default('user'),
});

const slackOAuthSchema = z.object({
  team: z.object({ id: z.string(), name: z.string() }),
  authedUser: z.object({
    id: z.string(),
    scopesGranted: z.array(z.string()).optional(),
  }).optional(),
  tokens: slackOAuthTokensSchema,
  lastRefreshedAt: z.string().optional(),
  issuedAt: z.string().optional(),
});

const nativeWorkspaceSchema = baseWorkspaceSchema.extend({
  kind: z.literal('native').optional(),
  provider: z.enum(['notion', 'slack']).optional(),
  authMode: z.enum(['token', 'oauth']).default('token').optional(),
  credentials: credentialsSchema,
  slackOAuth: slackOAuthSchema.optional(),
});

const slackAppSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tokenRotationEnabled: z.boolean().default(true),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
```

배치 검증: `provider === 'slack'` && `authMode === 'oauth'` 면 `slackOAuth` 필수. 그 외에는 옵션.

---

## 4. 컴포넌트 신규 / 변경

### 4.1 `server/slack-oauth-manager.js` (신규)

Slack OAuth v2 전용 helper. `OAuthManager` 와 분리한 이유:
- Slack discovery 는 hardcoded (`https://slack.com/oauth/v2/authorize`, `https://slack.com/api/oauth.v2.access`)
- DCR 자체가 없음 (등록 메서드 불필요)
- scope 모델 다름 (`user_scope=` vs `scope=`)
- 응답 shape 다름 (`team`, `authed_user`, `enterprise` 필드)

공통 코드는 `oauth-sanitize.js` 를 재사용. mutex 인프라는 Phase 10a 와 같은 패턴을 그대로 답습:

```js
export class SlackOAuthManager {
  constructor(wm, { fetchImpl, redirectPort, refreshTimeoutMs, metrics }) { ... }

  // App credential 보관
  async setAppCredentials({ clientId, clientSecret, tokenRotationEnabled }) { ... }
  async getAppCredentials() { ... }   // env 우선

  // Install flow
  async initializeInstall({ workspaceIdHint, scopes }) {
    // PKCE + state (HMAC-signed) — Phase 6 의 _signState 패턴 재사용
    // returns { authorizationUrl, state }
  }

  async completeInstall({ code, state }) {
    // oauth.v2.access 호출, team/authed_user/tokens 반환
    // workspace entry 신규 생성 트리거 (Admin route 가 처리)
  }

  // Refresh
  async _refreshWithMutex(workspaceId) { ... }
  async ensureValidAccessToken(workspaceId) {
    // expiresAt 만료 임박 시 refresh, 60s leeway
  }

  // Disconnect
  async revoke(workspaceId) {
    // auth.revoke 호출 후 slackOAuth 삭제
  }

  // Phase 10a 패턴 재사용
  async _withWorkspaceMutex(workspaceId, fn) { ... }
}
```

state HMAC 서명은 기존 `OAuthManager._signState` 와 같은 server-secret 을 공유 (한 인스턴스에서 두 매니저가 같은 secret 으로 서명). 또는 분리하고 prefix 로 식별.

### 4.2 `providers/slack.js` 변경

`authMode` 분기 추가:

```js
constructor(workspaceConfig) {
  super(workspaceConfig);
  this.authMode = workspaceConfig.authMode || 'token';
  if (this.authMode === 'token') {
    this.botToken = workspaceConfig.credentials?.botToken;
  }
  // OAuth 모드는 _headers() 시점에 token 을 동적으로 가져옴
  this._tokenProvider = workspaceConfig._tokenProvider || null;
}

async _headers() {
  let token;
  if (this.authMode === 'oauth') {
    token = await this._tokenProvider();   // SlackOAuthManager.ensureValidAccessToken
  } else {
    token = this.botToken;
  }
  return { 'Authorization': `Bearer ${token}`, ... };
}
```

`_tokenProvider` 는 `WorkspaceManager` 가 provider 인스턴스 생성 시 주입 (mcp-client 의 OAuth 토큰 주입과 동일한 패턴). user-token 으로도 기존 도구들 (`search.messages`, `conversations.history`, `conversations.list`) 모두 호출 가능.

`capabilityCheck()` 도 user-token 의 scope 셋을 인식하도록 작은 조정 (이미 `auth.test` 의 `x-oauth-scopes` 헤더 파싱 코드 있음 — 그대로 작동).

### 4.3 Admin REST endpoints (`admin/routes.js` 추가)

| Method | Path | 동작 |
|---|---|---|
| `GET` | `/api/slack/app` | 현재 등록된 Slack App credential 정보 반환 (clientId 마스킹, hasSecret bool) |
| `POST` | `/api/slack/app` | client_id / client_secret 등록·업데이트. 검증: Slack `apps.connections.open` 같은 cheap call 로 secret 유효성 확인 (또는 install 시 검증) |
| `DELETE` | `/api/slack/app` | App credential 삭제. 단, OAuth 모드 workspace 가 남아있으면 거부 (force flag 옵션) |
| `POST` | `/api/slack/install/start` | install flow 시작. 응답: `{ authorizationUrl, state }`. 사용자가 popup 으로 열어 Slack 의 workspace 선택 + 동의 |
| `GET` | `/oauth/slack/callback` | redirect URI. `code + state` 받아서 `oauth.v2.access` 호출, workspace entry 신규 생성, popup 닫기 페이지 응답 |
| `POST` | `/api/workspaces/:id/slack/refresh` | (운영용) 강제 refresh |
| `POST` | `/api/workspaces/:id/slack/disconnect` | `auth.revoke` + workspace entry 의 `slackOAuth` 제거 |

### 4.4 Admin UI 변경 (`admin/public/`)

**신규 페이지 `/admin/slack`** — Slack App credential 설정:
- "Slack App 만들기 가이드" 링크 + manifest.yaml 다운로드 버튼 (현재 host 기반 redirect URI 자동 박힘)
- client_id / client_secret 입력 폼
- token_rotation_enabled 체크박스 (Slack 측 manifest 와 일치해야 함을 명시)
- 검증 결과 (등록 후 `apps.connections.open` 또는 첫 install 결과로 검증)

**Wizard 변경** — provider=`slack` 선택 시 새 분기:
- "OAuth (권장)" vs "정적 토큰 (기존)" 토글
- OAuth 선택 시 Slack App 설정 미완료면 `/admin/slack` 으로 redirect
- "Connect Slack" 버튼 → popup → 사용자가 Slack 에서 workspace 선택 → 토큰 수신 → workspace entry 자동 생성 (alias / displayName / namespace 는 team.name 기반 제안)

**Workspace detail 페이지**:
- OAuth 모드인 경우 토큰 만료 D-time, 마지막 refresh 시각 표시
- "Disconnect" 버튼 (`auth.revoke` + entry 제거)
- "Re-authorize" 버튼 (토큰 갱신 실패 / scope 추가 시)

### 4.5 Refresh + 멀티 워크스페이스 격리

Phase 10a 의 워크스페이스 단위 mutex 패턴을 그대로:

- `_workspaceMutex` (rotation ↔ install 직렬화) — 같은 workspace 의 install/refresh 동시 발생 차단
- `_identityMutex` — Slack 은 단일 user-token per workspace 라 사실상 불필요. 단 향후 bot-token 추가 시 식별자별 분리 필요할 수 있어 인터페이스만 남겨둠

Slack 의 token rotation 1회용 refresh 특성:
- refresh 성공 시 새 access + 새 refresh 모두 수신 → atomic 저장 필수
- 동시 refresh race → 한 쪽 401 → markAuthFailed 진입 가능
- 해결: workspace 단위 mutex 안에서 refresh, 실패 시 재시도 1회 (exp backoff 1s)

audit events 추가:
- `slack.app_credential_set` / `slack.app_credential_deleted`
- `slack.install_started` / `slack.install_completed` / `slack.install_failed`
- `slack.token_refreshed` / `slack.token_refresh_failed`
- `slack.disconnect`

metrics counters (`OAuthMetrics` 패턴 재사용 또는 별도 `SlackOAuthMetrics`):
- `slack_install_total{result=success|failed}`
- `slack_refresh_total{result=success|failed|aborted}`
- `slack_workspace_count` (gauge)

---

## 5. Slack App manifest 템플릿

`docs/SLACK_OAUTH_SETUP.md` 와 함께 `templates/slack-app-manifest.yaml` 제공. Admin UI 의 다운로드 버튼이 redirect URL 만 동적으로 채운 결과를 반환:

```yaml
display_information:
  name: Bifrost
  description: MCP Bifrost — multi-workspace MCP edge
  background_color: "#1d1d1f"
features:
  bot_user:
    display_name: Bifrost
    always_online: false
oauth_config:
  redirect_urls:
    - https://your-bifrost-host/oauth/slack/callback   # 동적 치환
  scopes:
    user:
      - search:read
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - users:read
      - users:read.email
settings:
  token_rotation_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: false
```

운영 가이드는:
1. https://api.slack.com/apps → "Create New App" → "From manifest"
2. 위 yaml 붙여넣기 → Create
3. Distribution → Public Distribution → "Activate Public Distribution" (외부 워크스페이스 install 받기 위함, Marketplace 등재는 안 함)
4. Basic Information → Client ID / Client Secret 복사
5. Bifrost `/admin/slack` 에 입력
6. 워크스페이스 추가 화면에서 "Connect Slack" 클릭

---

## 6. 보안 고려사항

| 항목 | 처리 |
|---|---|
| `clientSecret` 보관 | `0o600`, audit log 마스킹, log sanitize |
| `accessToken` / `refreshToken` 보관 | 기존 OAuth 토큰과 동일한 chmod / sanitize 룰 |
| state CSRF | HMAC-signed state (Phase 6 패턴), TTL 10 분, pending store |
| redirect_uri 검증 | server config 의 등록 호스트와 정확히 일치해야 함 (substring 매칭 금지) |
| popup 의 callback 페이지 XSS | 응답 HTML 은 `html-escape.js` 로 escape, inline script 최소화 |
| token rotation race | workspace 단위 mutex |
| Slack OAuth 응답 검증 | `team.id` / `authed_user.id` 가 OAuth 응답에 모두 있어야만 진행 |
| Disconnect 의 revoke 보장 | `auth.revoke` 실패해도 로컬 토큰은 항상 삭제 (best-effort) |

---

## 7. 마이그레이션

기존 데이터 영향 분석:
- `provider: 'slack'` + `credentials.botToken` workspace → `authMode: 'token'` 로 자동 인식 (default)
- `slackApp` top-level 필드는 신규 — 미존재가 default
- `slackOAuth` 필드는 신규 — 미존재가 default

**호환성**: 강제 마이그레이션 없음. 기존 botToken workspace 는 그대로 동작. OAuth 로 전환하려면 사용자가 신규 workspace 를 OAuth 모드로 추가 (botToken workspace 는 삭제 또는 공존).

**테스트 마이그레이션**: Phase 10a 의 `migrate-oauth-clients.mjs` 와 같은 1회성 스크립트는 불필요 (스키마 추가만 있음).

---

## 8. 테스트 전략

### 8.1 Unit (`test/slack-oauth-manager.test.js` 신규)
- state HMAC 서명/검증
- pending store TTL 만료
- `oauth.v2.access` 응답 파싱 (success / error 케이스)
- refresh mutex — 동시 refresh 호출 시 단일 token endpoint 호출만 발생
- token rotation — 새 refresh_token 으로 atomic replace
- `auth.revoke` failure 시에도 로컬 토큰 삭제

### 8.2 Provider (`test/slack-provider.test.js` 확장)
- `authMode: 'oauth'` 모드에서 `_tokenProvider` 호출
- `botToken` 모드 backward-compat 보존
- user-token 으로 search/list/history 도구 동작

### 8.3 Integration (`test/slack-oauth-flow.test.js` 신규)
- mock Slack OAuth endpoint 띄우고 install start → callback → workspace entry 생성 검증
- 동일 Slack App 으로 두 번째 workspace install → 두 entry 가 격리된 토큰 보유
- 토큰 만료 임박 시 자동 refresh
- refresh 실패 401 → markAuthFailed → Admin UI 의 "Action Needed"

### 8.4 Manual / E2E checklist (`docs/SLACK_OAUTH_E2E_CHECKLIST.md`)
- 실 Slack App 등록 → Bifrost 등록 → 두 workspace install → tools/list 호출
- 12h 만료 후 refresh 실측 (또는 expires_in 인위 단축으로 시뮬레이션)
- Disconnect → revoke 검증 (Slack App "Authorized Users" 화면에서 사라짐)
- Public Distribution **미활성** 상태에서 install 시도 → Slack 측 거부 메시지 확인

---

## 9. 구현 순서 (sub-phase 별 estimated effort)

| Sub | 산출물 | 견적 |
|-----|--------|------|
| 12-1 | schema 확장 + Zod 검증 + workspaces.json 마이그레이션 가드 | 0.5d |
| 12-2 | `slack-oauth-manager.js` 코어 (install / exchange / refresh / mutex / state) | 2d |
| 12-3 | `providers/slack.js` OAuth 모드 + `_tokenProvider` 와이어업 | 0.5d |
| 12-4 | Admin REST endpoints + redirect URI 검증 + audit/metrics | 1d |
| 12-5 | Admin UI — Slack 설정 페이지 + Wizard 분기 + Workspace detail | 1.5d |
| 12-6 | Refresh hardening + race test + Phase 10a 패턴 적용 | 1d |
| 12-7 | manifest 템플릿 + `SLACK_OAUTH_SETUP.md` + manifest 다운로드 endpoint | 0.5d |
| 12-8 | Tests (unit/provider/integration) + self-review log + E2E checklist | 1.5d |

총 ~8.5일 (혼자 풀타임 기준). Codex 리뷰 라운드 포함 시 +30%.

---

## 10. Risk / Open Questions

| # | 질문 | 영향 | 해소 방안 |
|---|------|------|----------|
| R1 | Slack OAuth v2 가 PKCE 를 강제하는가? | install 흐름 설계 | 첫 spike 단계에서 `code_challenge` 동봉 호출 → Slack 응답 확인. 강제면 그대로, 무시되면 보안 차원에서 동봉만 유지 |
| R2 | redirect URI 가 Cloudflare tunnel 의 동적 host 와 호환되는가? | 개발/배포 흐름 | Slack App 의 redirect URLs 에 정적 production host 만 넣고, 개발은 `localhost:3100` 별도 redirect 추가 (multiple redirect URLs 허용됨) |
| R3 | unlisted distributed app 의 install 한도가 있는가? | 사용자 다수 워크스페이스 시나리오 | Slack docs 명시 없음. install 50+ 단위에서 Slack 이 자동으로 review 요청할 가능성 — 운영 가이드에 경고 추가 |
| R4 | user-token 으로 모든 hosted MCP 와 동등한 capability 인가? | 도구 surface | hosted MCP 는 Slack Web API wrapper 이므로 동일 user scopes 라면 동등. 단 `mcp.slack.com` 이 별도 추가한 utility (e.g. `assistant.search.context`) 는 본 phase 비지원 |
| R5 | `auth.test` / `oauth.v2.access` rate limit | install 폭주 | install 자체는 사용자 수동 클릭이라 폭주 가능성 낮음. refresh 는 workspace 단위 mutex 로 직렬화 |
| R6 | 기존 `botToken` 모드 사용자가 OAuth 로 마이그레이션 시 토큰/도구 호환성 | 운영 부담 | 마이그레이션 가이드에 "OAuth 모드 신규 entry 생성 후 기존 botToken entry 삭제" 패턴 명시. 도구 namespace 변경 가능 (사용자가 alias 동일하게 주면 영향 없음) |
| R7 | Slack App 의 `clientSecret` rotation (Slack 측에서 secret 재발급 시) | 운영 | `/admin/slack` 의 secret 업데이트 endpoint 로 처리. 기존 access/refresh token 은 영향 없음 (secret 은 token endpoint 호출에만 사용) |

---

## 11. 의존 / 사전 조건

- Phase 10a 의 `_workspaceMutex` / `_identityMutex` 패턴 (재사용)
- Phase 11-9 의 `static-client-guides.js` 패턴 (Slack App 가이드 추가 시 참고)
- Phase 6 의 `_signState` / `_loadPending` (state 서명, pending TTL)
- `oauth-sanitize.js` (token masking)
- `audit-logger.js` (audit events)
- `oauth-metrics.js` (metrics recorder 패턴)

---

## 12. 합의해야 할 결정 사항 (실행 전)

1. **Slack App credential 위치** — `config/workspaces.json` top-level vs 별도 `config/slack-app.json` vs env-only
   - 추천: `workspaces.json` top-level 의 `slackApp` 필드 + env override (단순, 기존 watcher 인프라 재사용)
2. **OAuth 모드 default** — 신규 Slack workspace 생성 시 default 가 OAuth 인가 token 인가
   - 추천: OAuth (Slack App 미등록이면 wizard 가 자동으로 setup 페이지로 안내)
3. **Bot-token 동시 발급 옵션** — user-token 위주이지만 일부 도구 (Slack 에 messages 보내기 등) 는 bot-token 이 자연스러움. Phase 12 에서 같이 받을지 후속으로 분리할지
   - 추천: Phase 12 는 user-token only, bot-token 은 Phase 12.1 후속 (write 도구가 추가될 때 같이)
4. **Slack hosted MCP 경로 (`mcp.slack.com/mcp`)** 은 Internal-only Slack App 사용자 위한 별도 흐름으로 유지할지
   - 추천: 유지. mcp-client kind 로 이미 동작 가능. Phase 12 는 hosted MCP 와 직교하는 신규 native 경로
5. **Slack manifest 다운로드 endpoint 의 인증** — 누구나 다운로드 vs Admin 전용
   - 추천: Admin 전용 (Bifrost host URL 노출 방지)

---

## 13. 진행 체크리스트

- [ ] §12 결정 사항 합의
- [ ] 12-1 schema 확장 + 단위 테스트
- [ ] 12-2 `slack-oauth-manager.js` 코어 + 단위 테스트
- [ ] 12-3 `providers/slack.js` OAuth 모드
- [ ] 12-4 Admin REST endpoints
- [ ] 12-5 Admin UI (Slack 설정 페이지 + Wizard + detail)
- [ ] 12-6 Refresh hardening
- [ ] 12-7 manifest 템플릿 + 운영 가이드
- [ ] 12-8 통합 테스트 + E2E checklist + self-review log
- [ ] Codex review (목표: 3 rounds 이내)
- [ ] Phase 12 완료 보고 + CLAUDE.md "Phase 이력" 항목 추가

---

**다음 단계**: §12 의 5 가지 결정 사항부터 합의 후 12-1 부터 순차 진행.
