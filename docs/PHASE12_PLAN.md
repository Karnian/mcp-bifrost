# Phase 12 — Native Slack OAuth (Multi-Workspace)

**작성일**: 2026-04-29
**개정일**: 2026-04-29 (v5 — Codex round 4 P3 PARTIAL + helper 시그니처 잔재 정리)
**상태**: ✅ **Plan APPROVED (Codex round 5, 2026-04-29) — 12-1 부터 구현 가능**
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

### In-scope (10 sub-phases)

| Sub | 항목 | 성격 |
|-----|------|------|
| 12-1 | Workspace schema 확장 — `slackApp` + `slackOAuth` + `_maskSlackOAuth` masking 룰 + Zod batch 검증 | 필수 |
| 12-2 | Public origin resolver — `BIFROST_PUBLIC_URL` 환경변수 + canonical resolver (manifest/authorize/callback 공유) | 필수 |
| 12-3 | `server/slack-oauth-manager.js` 신규 — install / token exchange / refresh (PKCE 미사용, `client_secret_post`) | 필수 |
| 12-4 | `providers/slack.js` OAuth 모드 — user-token wiring (`_headers()` async), 기존 botToken 모드 공존 | 필수 |
| 12-5 | Admin REST endpoints — `/api/slack/app`, `/api/slack/install/*`, `/oauth/slack/callback`, install status polling | 필수 |
| 12-6 | Admin UI — Slack App 설정 페이지 + Wizard "Slack workspace 추가" + popup completion contract | 필수 |
| 12-7 | Refresh durable-save 원자성 + token rotation + `teamInstallMutex` + Slack error mapping | 필수 |
| 12-8 | Slack App manifest 템플릿 (`pkce_enabled: false`) + 운영 가이드 (`docs/SLACK_OAUTH_SETUP.md`) | 권장 |
| 12-9 | botToken → OAuth 마이그레이션 절차 (hard-delete 기반) + Enterprise Grid silent-break 방어 | 필수 |
| 12-10 | Tests + E2E checklist + Phase 12 self-review | 필수 |

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
      // Slack `oauth.v2.access` 응답의 `authed_user` 아래에서 추출
      // (root level 의 bot token 은 무시 — Phase 12 는 user-token only)
      "accessToken": "xoxe.xoxp-1-...",      // rotatable user-token (xoxe.xoxp- prefix)
      "refreshToken": "xoxe-1-...",
      "expiresAt": "2026-05-01T22:00:00.000Z",   // ISO 8601 string (기존 OAuthManager 와 통일)
      "tokenType": "user"                    // Phase 12 invariant: 'user' 만 허용
    },
    "status": "active",                      // 'active' | 'action_needed' (refresh 실패 / save 실패)
    "lastRefreshedAt": "2026-05-01T15:00:00Z",
    "issuedAt": "2026-05-01T10:00:00Z"
  }
}
```

기존 `credentials.botToken` 은 `authMode: 'token'` 일 때만 사용. OAuth 모드에선 `slackOAuth.tokens.accessToken` 을 사용.

**`oauth.v2.access` 응답 parsing 명세** (B2 — Codex 검증):
```
{
  "ok": true,
  "team": { "id": "T01...", "name": "ACME" },
  "authed_user": {
    "id": "U02...",
    "scope": "search:read,channels:history,...",
    "access_token": "xoxe.xoxp-1-...",       // ← Phase 12 가 저장
    "refresh_token": "xoxe-1-...",            // ← Phase 12 가 저장 (rotation 시)
    "token_type": "user",
    "expires_in": 43200                       // ← issuedAt + expires_in*1000 = expiresAt
  },
  "access_token": "xoxb-...",                 // bot token — Phase 12 는 무시
  "is_enterprise_install": false,             // true 면 reject (Enterprise Grid 비지원)
  "incoming_webhook": { ... }                 // 무시 (저장 금지)
}
```
Phase 12 는 **`is_enterprise_install: true` 응답을 명시적으로 reject** (REVISE — Enterprise Grid silent-break 방어).
**root `access_token` (bot token) 은 무시 + 저장 금지** (REVISE — schema invariant). authorize URL 은 `user_scope=` 사용 (`scope=` 아님).

**`expiresAt` 단위 통일 (v3, 신규 blocker close)**: 기존 `OAuthManager` 와 동일하게 **ISO 8601 string** 으로 저장 (`"2026-05-01T22:00:00.000Z"`). 변환:
- 응답에서 `expires_in` (seconds) 수신 → `new Date(Date.now() + expires_in * 1000).toISOString()`
- refresh 임박 판정: `Date.parse(expiresAt) - Date.now() < REFRESH_LEEWAY_MS` (ms 단위 비교)
- unix seconds / unix ms 혼용 금지. parsing/저장 모두 ISO 만 사용. `test/slack-time-units.test.js` 로 단위 일관성 단위 테스트 1건 추가.

### 3.3 Schema 확장 (`server/workspace-schema.js`)

```js
const slackOAuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),     // rotation 끄면 없을 수 있음
  expiresAt: z.string().datetime().optional(),    // ISO 8601 (v4 — number 와 혼용 금지)
  tokenType: z.literal('user'),                   // Phase 12 invariant — bot 은 12.1 후속
});

const slackOAuthSchema = z.object({
  team: z.object({ id: z.string(), name: z.string() }),
  authedUser: z.object({
    id: z.string(),
    scopesGranted: z.array(z.string()).optional(),
  }).optional(),
  tokens: slackOAuthTokensSchema,
  status: z.enum(['active', 'action_needed']).default('active'),
  lastRefreshedAt: z.string().optional(),
  issuedAt: z.string().optional(),
});

const nativeWorkspaceSchema = baseWorkspaceSchema.extend({
  kind: z.literal('native').optional(),
  provider: z.enum(['notion', 'slack']).optional(),
  authMode: z.enum(['token', 'oauth']).default('token').optional(),
  credentials: credentialsSchema,
  slackOAuth: slackOAuthSchema.optional(),
}).superRefine((data, ctx) => {
  // Batch validation: provider=slack && authMode=oauth → botToken 금지 + slackOAuth 필수
  if (data.provider === 'slack' && data.authMode === 'oauth') {
    if (data.credentials?.botToken) {
      ctx.addIssue({ code: 'custom', message: 'botToken not allowed when authMode=oauth' });
    }
    if (!data.slackOAuth) {
      ctx.addIssue({ code: 'custom', message: 'slackOAuth required when authMode=oauth' });
    }
  }
});

const slackAppSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tokenRotationEnabled: z.boolean().default(true),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
```

### 3.4 Masking 룰 (`server/workspace-manager.js`) — B5 신규 (v4 — 실제 시그니처 일치)

`workspace-manager.js:374` 의 `_maskSecrets(result, ws)` 가 현재 `credentials`, `env`, `headers`, `oauth` 만 마스킹 (result 를 mutate, ws 는 original 참조). **Phase 12 는 같은 함수에 `slackOAuth` 마스킹 추가 + top-level config 출력 시 `slackApp` 마스킹**:

```js
// server/workspace-manager.js:374 — 실제 시그니처 그대로
_maskSecrets(result, ws) {
  if (ws.credentials) result.credentials = maskCredentials(ws.credentials);
  if (ws.env) result.env = maskCredentials(ws.env);
  if (ws.headers) result.headers = maskCredentials(ws.headers);
  if (ws.oauth) result.oauth = maskOAuth(ws.oauth);
  if (ws.slackOAuth) result.slackOAuth = maskSlackOAuth(ws.slackOAuth);   // ← v3/v4 추가
}

// 별도 helper (oauth-sanitize.js 또는 workspace-manager.js 내부)
export function maskSlackOAuth(slackOAuth) {
  if (!slackOAuth?.tokens) return slackOAuth;
  const t = slackOAuth.tokens;
  return {
    ...slackOAuth,
    tokens: {
      accessToken: t.accessToken ? `${t.accessToken.slice(0, 12)}...` : null,
      refreshToken: t.refreshToken ? `${t.refreshToken.slice(0, 8)}...` : null,
      hasRefreshToken: !!t.refreshToken,
      expiresAt: t.expiresAt,           // ISO string — 마스킹 불필요
      tokenType: t.tokenType,
    },
  };
}

// top-level config 출력 (GET /api/config / GET /api/slack/app) 시 slackApp 도 mask
export function maskSlackApp(slackApp) {
  if (!slackApp) return null;
  return { /* §3.4 의 _maskSlackApp 본문과 동일 — sources 두 source 추적 포함 */ };
}
```

**12-1 단계 테스트 필수** (3건):
1. `_maskSecrets` 호출 후 result 객체에 `slackOAuth.tokens.accessToken` raw 가 없는지 — `GET /api/workspaces`, `GET /api/workspaces/:id` 양쪽
2. `getAllWorkspaces({ masked: true })` 와 `getRawWorkspace()` 의 차이가 token 본문에 한정되는지
3. `slackApp` 마스킹 결과의 `sources.clientId` / `sources.clientSecret` 두 source 가 정확히 `'env'` / `'file'` / `'none'` 중 하나인지

**`_maskSlackApp` 본문 명세 (v4 — sources 두 source 추적)**:

```js
export function maskSlackApp(slackApp) {
  if (!slackApp) return null;
  return {
    clientId: slackApp.clientId,    // 평문 OK (Slack App 식별용, secret 아님)
    hasSecret: !!slackApp.clientSecret,
    tokenRotationEnabled: slackApp.tokenRotationEnabled,
    sources: {
      clientId: process.env.BIFROST_SLACK_CLIENT_ID ? 'env' : (slackApp.clientId ? 'file' : 'none'),
      clientSecret: process.env.BIFROST_SLACK_CLIENT_SECRET ? 'env' : (slackApp.clientSecret ? 'file' : 'none'),
    },
    createdAt: slackApp.createdAt,
    updatedAt: slackApp.updatedAt,
  };
}
```

(v3 의 redundant `_maskSlackOAuth(ws)` / `_maskSlackApp(slackApp)` 예시 블록은 위 §3.4 의 `maskSlackOAuth(slackOAuth)` / `maskSlackApp(slackApp)` 으로 통합 — top-level export, 단일 시그니처.)

---

## 4. 컴포넌트 신규 / 변경

### 4.0 Public origin resolver — `BIFROST_PUBLIC_URL` (B3 신규)

Slack OAuth 의 redirect_uri 는 **HTTPS 필수 + authorize/exchange 단계에서 정확히 동일**해야 함.
Host header 기반 자동 치환은 spoofing + Cloudflare tunnel 동적 host mismatch 위험.

**도입**: `BIFROST_PUBLIC_URL` 환경변수 (예: `https://bifrost.example.com`) +
`server/public-origin.js` 의 canonical resolver. manifest 다운로드 / authorize / token exchange / `redirect_uri` 검증이 **모두 같은 resolver 를 통과**하도록 강제.

```js
// server/public-origin.js (신규)
export function getPublicOrigin() {
  const v = process.env.BIFROST_PUBLIC_URL;
  if (!v) throw new Error('BIFROST_PUBLIC_URL is required for Slack OAuth');
  const u = new URL(v);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
    throw new Error('BIFROST_PUBLIC_URL must be HTTPS (or localhost for dev)');
  }
  return u.origin;   // trailing slash strip
}

export function getSlackRedirectUri() {
  return `${getPublicOrigin()}/oauth/slack/callback`;
}

export function getSlackManifestRedirect() {
  return getSlackRedirectUri();   // single source of truth
}
```

개발 환경 (`localhost:3100`) 은 예외 — Slack 은 localhost redirect 를 받음. Cloudflare tunnel 은 fixed hostname 사용 권장 (random tunnel 미지원 명시).

### 4.1 `server/slack-oauth-manager.js` (신규)

Slack OAuth v2 전용 helper. `OAuthManager` 와 분리한 이유:
- Slack discovery 는 hardcoded (`https://slack.com/oauth/v2/authorize`, `https://slack.com/api/oauth.v2.access`)
- DCR 자체가 없음 (등록 메서드 불필요)
- scope 모델 다름 (`user_scope=` vs `scope=`)
- 응답 shape 다름 (`team`, `authed_user`, `enterprise` 필드)

**PKCE 정책 (B1 — Codex 검증)**: Phase 12 는 server 가 `client_secret` 을 보관하는 **confidential web app** 이므로 **PKCE 미사용**. Slack PKCE GA changelog (2026-03-30) 는 web redirect flow 에서 PKCE 가 optional 이며, **PKCE 모드에선 `client_secret` 을 보내지 않아야** 한다고 명시. 두 모드 섞으면 `invalid_request` 예상. → manifest 의 `oauth_config.pkce_enabled: false`, token endpoint auth method = `client_secret_post`.

공통 utility (state HMAC, sanitize, FIFO mutex 헬퍼) 는 작은 shared 모듈 (`server/oauth-shared.js`) 로 추출해 두 manager 가 공유.

```js
export class SlackOAuthManager {
  constructor(wm, { fetchImpl, refreshTimeoutMs, metrics }) { ... }

  // App credential 보관 (env 우선) — v3: clientId/secret 별도 source 추적
  async setAppCredentials({ clientId, clientSecret, tokenRotationEnabled }) { ... }
  async getAppCredentials() {
    const envClientId = process.env.BIFROST_SLACK_CLIENT_ID;
    const envClientSecret = process.env.BIFROST_SLACK_CLIENT_SECRET;
    return {
      clientId: envClientId || this._fileApp?.clientId,
      clientSecret: envClientSecret || this._fileApp?.clientSecret,
      tokenRotationEnabled: this._fileApp?.tokenRotationEnabled ?? true,
      sources: {
        clientId: envClientId ? 'env' : (this._fileApp?.clientId ? 'file' : 'none'),
        clientSecret: envClientSecret ? 'env' : (this._fileApp?.clientSecret ? 'file' : 'none'),
      },
    };
  }

  // Install flow — PKCE 미사용, state 만 사용
  async initializeInstall({ scopes, identityHint }) {
    // 1. state payload: { typ: 'slack-oauth', aud: '/oauth/slack/callback',
    //                      installId, iat, exp } (HMAC-signed, TTL 10min)
    // 2. authorize URL: https://slack.com/oauth/v2/authorize
    //    ?client_id=...&user_scope=<comma-joined>&redirect_uri=<canonical>&state=<signed>
    //    (NO code_challenge — confidential client mode)
    // 3. _installPending[installId] = { state, createdAt, status: 'pending' }
    // returns { installId, authorizationUrl }
  }

  // Callback completion — workspace 생성 직전까지 처리 (v3: B4 close — 순서 수정)
  async completeInstall({ code, state }) {
    // ── Phase A (mutex 진입 전) ────────────────────────────────────
    // 1. state 검증: HMAC + typ + aud + iat/exp bound
    //    실패 시 즉시 reject. mutex 진입 금지
    // 2. POST https://slack.com/api/oauth.v2.access
    //    Content-Type: application/x-www-form-urlencoded
    //    body: code, redirect_uri (canonical), client_id, client_secret  ← client_secret_post
    //    (PKCE 모드 아님 — code_verifier 없음)
    //    실패 시 reject + Slack error mapping
    // 3. 응답 parsing & 검증:
    //    - ok: true 검증
    //    - is_enterprise_install === true 면 reject (Enterprise Grid silent-break 방어)
    //    - authed_user 부재 또는 token_type !== 'user' 면 reject
    //    - team.id 또는 (Enterprise 의 경우 enterprise.id) 추출
    //    - 응답: { team, authed_user.{id, scope, access_token, refresh_token, expires_in} }
    //
    // ── Phase B (lock key 산출 후 mutex 진입) ──────────────────────
    // 4. lockKey = `slack-install::${enterprise?.id || team.id}` 산출 (응답 기반)
    // 5. _withTeamInstallMutex(lockKey, async () => {
    //      // mutex 안에서 duplicate detection — read after lock
    //      const existing = wm.findSlackWorkspaceByTeamId(team.id);
    //      if (existing) {
    //        // 기존 workspace 재인증 분기 — slackOAuth 갱신만
    //        await wm.updateSlackOAuthAtomic(existing.id, parsedTokens);
    //        return { workspaceId: existing.id, mode: 're-authorize', team };
    //      }
    //      // 신규 entry 생성
    //      const wsId = wm.generateSlackWorkspaceId(team);
    //      await wm.createSlackOAuthWorkspaceAtomic(wsId, { team, authedUser, tokens, ... });
    //      return { workspaceId: wsId, mode: 'create', team };
    //    });
    //
    // 6. save 실패 시: 새로 받은 access/refresh 를 즉시 auth.revoke 시도 (best-effort) + caller 에 503
    // returns { workspaceId, team, authedUser, mode }
  }

  // Refresh — durable save 원자성 (B6)
  async ensureValidAccessToken(workspaceId) {
    // const ws = this.wm._getRawWorkspace(workspaceId);
    // const exp = ws.slackOAuth?.tokens?.expiresAt;
    // if (exp && (Date.parse(exp) - Date.now()) < REFRESH_LEEWAY_MS) → _refreshWithMutex
    // 그 외 현재 access_token 반환 (R13 case ①: expiresAt 없음 + refreshToken 없음 = non-rotating active)
  }

  async _refreshWithMutex(workspaceId) {
    return this._withWorkspaceMutex(workspaceId, async () => {
      const ws = this.wm._getRawWorkspace(workspaceId);
      const oldRefresh = ws.slackOAuth?.tokens?.refreshToken;
      if (!oldRefresh) throw new Error('no_refresh_token');

      // ── Step 1: token endpoint 호출 ─────────────────────────────
      const resp = await this._tokenEndpoint('refresh', { refresh_token: oldRefresh });
      const newTokens = this._parseRotatedTokens(resp);  // local-only, raw config 미반영

      // ── Step 2: staged commit (B6 v3 — atomic 보장) ─────────────
      // wm.updateSlackOAuthAtomic 의 계약:
      //   1) raw config 의 *clone* 에 newTokens 적용
      //   2) clone 으로 _save() 디스크 쓰기 await
      //   3) _save() 성공 시에만 wm._config / provider in-memory 를 swap
      //   4) _save() 실패 시 clone 폐기 — wm._config / provider 는 이전 상태 유지
      // 이 순서를 어기면 in-memory 가 새 token, disk 가 옛 token 이 되어 crash 후 정합성 깨짐.
      try {
        await this.wm.updateSlackOAuthAtomic(workspaceId, {
          tokens: newTokens,
          status: 'active',
          lastRefreshedAt: new Date().toISOString(),
        });
      } catch (saveErr) {
        // raw config 와 in-memory 모두 변경 안 됐음 (clone-then-swap 보장)
        // 새 token 은 사용자에게 노출 금지, 다음 호출에서 만료된 옛 access_token 으로 401 → markAuthFailed
        await this.wm.markSlackActionNeeded(workspaceId, 'save_failed');
        throw saveErr;
      }

      return newTokens.accessToken;
    });
  }

  // Disconnect — auth.revoke 정책 (REVISE)
  async revoke(workspaceId, { revokeRefresh = true } = {}) {
    // 1. access token revoke (best-effort)
    // 2. revokeRefresh 이면 refresh token revoke (best-effort, 실패는 audit 만)
    // 3. 로컬 slackOAuth 삭제는 항상 (revoke 결과 무관)
  }

  // Mutex — install 시점엔 workspace 미생성 → teamInstallMutex 별도
  async _withWorkspaceMutex(workspaceId, fn) { ... }       // 기존 workspace 대상
  async _withTeamInstallMutex(teamLockKey, fn) { ... }     // 신규 install 시점
  // _identityMutex 제거 (user-token only, B4)
}
```

**state payload schema (REVISE)**:
```js
{
  typ: 'slack-oauth',                 // 다른 OAuth 와 구분 (oauth-shared.js 가 검증)
  aud: '/oauth/slack/callback',       // 의도한 callback path bind
  installId: 'inst_<random16>',       // popup 와 callback 매칭 + status polling
  iat: <unix ms>,                     // 발급 시각
  exp: <iat + 600_000>                // 10 분 TTL
}
```
검증: HMAC + `typ === 'slack-oauth'` + `aud === '/oauth/slack/callback'` + `Date.now() < exp` + `iat <= Date.now()`. 어느 하나라도 실패하면 `state_invalid` 반환.

**`installId` 기반 status polling (B9)**: callback 처리가 완료되면 `_installPending[installId].status = 'completed' | 'failed'` + `result/error` 갱신. Admin UI 의 popup 이 `GET /api/slack/install/status?installId=...` 로 polling (1.5s 간격, 5분 timeout). callback 페이지는 strict-origin `window.opener.postMessage({ type: 'bifrost-slack-install', installId, status })` 도 같이 전송 (둘 다 지원, postMessage 가 빠른 경로).

### 4.2 `providers/slack.js` 변경

`authMode` 분기 추가. **`_headers()` 가 async 가 되면 모든 호출자도 await 로 변경 필수** (REVISE):

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
    if (!this._tokenProvider) throw new Error('slack oauth provider not wired');
    token = await this._tokenProvider();   // SlackOAuthManager.ensureValidAccessToken
  } else {
    token = this.botToken;
  }
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };
}

async _fetch(method, params = {}) {
  const url = `${SLACK_API}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: await this._headers(),   // ← async 변경 필수
    body: JSON.stringify(params),
  });
  // 이하 기존 로직
}
```

`_tokenProvider` 는 `WorkspaceManager` 가 provider 인스턴스 생성 시 주입 (mcp-client 의 OAuth 토큰 주입과 동일한 패턴). user-token 으로도 기존 도구들 (`search.messages`, `conversations.history`, `conversations.list`) 모두 호출 가능.

**`auth.test` rate limit 보호 (REVISE)**: `capabilityCheck()` 가 매 refresh / 매 healthCheck 마다 호출되면 다수 Slack workspace 환경에서 rate pressure. `_lastCapabilityCheck` 타임스탬프 기반 cooldown 60s 도입.

`capabilityCheck()` 도 user-token 의 scope 셋을 인식하도록 작은 조정 (이미 `auth.test` 의 `x-oauth-scopes` 헤더 파싱 코드 있음 — 그대로 작동).

### 4.3 Admin REST endpoints (`admin/routes.js` 추가)

| Method | Path | 동작 |
|---|---|---|
| `GET` | `/api/slack/app` | 현재 등록된 Slack App credential 정보 반환 — `_maskSlackApp` 결과. 응답 schema: `{ clientId, hasSecret, tokenRotationEnabled, sources: { clientId: 'env'\|'file'\|'none', clientSecret: 'env'\|'file'\|'none' }, createdAt, updatedAt }`. UI 는 두 source 를 별도 배지로 표시 (예: clientId: file / clientSecret: **env (file ignored)**) |
| `POST` | `/api/slack/app` | client_id / client_secret 등록·업데이트. **검증은 형식 검증만** (정규표현식: `client_id` = `^\d+\.\d+$`, `client_secret` non-empty). cheap pre-validation API 없음 — 실 검증은 첫 install 시 수행 (B8) |
| `DELETE` | `/api/slack/app` | App credential 삭제. 단, OAuth 모드 workspace 가 남아있으면 기본 거부. `?force=true` 시 강제 삭제 + 의존 workspace 들의 `slackOAuth.status='action_needed'` 로 일괄 전환 |
| `POST` | `/api/slack/install/start` | install flow 시작. 응답: `{ installId, authorizationUrl }`. popup 으로 열어 Slack 의 workspace 선택 + 동의 |
| `GET` | `/api/slack/install/status` | `?installId=...` 쿼리 — popup polling 용. 응답: `{ status: 'pending'\|'completed'\|'failed', workspaceId?, error? }` |
| `GET` | `/oauth/slack/callback` | redirect URI. `code + state` 받아서 `completeInstall` 호출 → `_installPending[installId].status` 갱신 → popup 닫기 페이지 응답 (strict-origin postMessage + 사용자 안내) |
| `POST` | `/api/workspaces/:id/slack/refresh` | (운영용) 강제 refresh |
| `POST` | `/api/workspaces/:id/slack/disconnect` | `auth.revoke` (access + refresh, best-effort) + workspace entry 의 `slackOAuth` 제거. `?keepEntry=true` 면 entry 는 보존하고 `slackOAuth` 만 제거 (재인증 대비) |
| `GET` | `/api/slack/manifest.yaml` | Slack App 등록용 manifest 다운로드. `BIFROST_PUBLIC_URL` 의 redirect URI 가 동적 치환됨. **Admin token 보호** |

### 4.4 Admin UI 변경 (`admin/public/`)

**신규 페이지 `/admin/slack`** — Slack App credential 설정:
- "Slack App 만들기 가이드" 링크 + `GET /api/slack/manifest.yaml` 다운로드 버튼 (canonical `BIFROST_PUBLIC_URL` 기반 redirect URI 자동 치환)
- client_id / client_secret 입력 폼 (형식 검증만, 실 검증은 첫 install)
- token_rotation_enabled 체크박스 (Slack 측 manifest 와 일치해야 함을 명시)
- **두 source 별도 배지** (v4 — REVISE 보강): `sources.clientId === 'env'` 면 "Client ID: env override" 배지, `sources.clientSecret === 'env'` 면 "Client Secret: env override (file ignored)" 배지. 두 source 가 섞일 수 있으니 (예: clientId 만 file, secret 만 env) 각각 표시
- 첫 install 결과로 검증 — 실패 시 `bad_redirect_uri` / `invalid_client` 등 친절한 에러 매핑 (REVISE)

**Wizard 변경** — provider=`slack` 선택 시 새 분기:
- default = **OAuth** (12-D2). "정적 토큰 (legacy)" 는 옵트인 토글
- OAuth 선택 시 Slack App 설정 미완료면 `/admin/slack` 으로 redirect (안내 모달 + 자동 deep-link)
- "Connect Slack" 버튼 → popup window 열림 → Slack 의 workspace 선택 → 토큰 수신 → workspace entry 자동 생성
- alias / displayName / namespace 는 `team.name` 기반 자동 제안 (사용자 승인 후 저장)
- popup completion contract (B9):
  1. **Primary**: Slack callback 페이지가 `window.opener.postMessage({ type: 'bifrost-slack-install', installId, status, workspaceId? }, BIFROST_PUBLIC_URL)` 전송. opener 는 `BIFROST_PUBLIC_URL` 검증 후 처리
  2. **Fallback**: Wizard 가 `GET /api/slack/install/status?installId=...` polling (1.5s 간격, 5분 timeout) — popup blocked 또는 cross-origin postMessage 실패 시 안전망

**Workspace detail 페이지**:
- OAuth 모드인 경우 토큰 만료 D-time, 마지막 refresh 시각 표시
- `slackOAuth.status === 'action_needed'` 이면 적색 배너 + 원인 표시
- "Disconnect" 버튼 (`auth.revoke` + entry 제거 또는 `?keepEntry=true`)
- "Re-authorize" 버튼 (토큰 갱신 실패 / scope 추가 시 — 같은 team.id 로 install 재시도, completeInstall 의 duplicate detection 이 처리)

### 4.5 Refresh + 멀티 워크스페이스 격리

mutex 인프라:
- `_workspaceMutex(workspaceId)` — 기존 workspace 의 refresh ↔ revoke ↔ updateSlackOAuth 직렬화. Phase 10a 패턴 그대로
- **`_teamInstallMutex(teamLockKey)`** (B4) — install callback 시점엔 workspace 가 아직 없음. lock key = `slack-install::<enterprise.id || team.id>` 로 동일 team 동시 install 중복 entry 차단
- `_identityMutex` — **제거** (REVISE). user-token only 라 단일 mutex 로 충분. bot-token 추가 (Phase 12.1) 시 다시 도입

Slack 의 token rotation 1회용 refresh 특성 — durable save 원자성 (B6):
- refresh 성공 시 새 access + 새 refresh 모두 수신
- **token endpoint 성공 → save 실패 케이스**: 새 token 을 절대 caller 에 노출 금지 → `slackOAuth.status='action_needed'` 로 수렴 → 사용자 재인증 유도
- 정상 경로: workspace mutex 안에서 token endpoint 호출 → 응답 in-memory staging → `wm._save()` await → 성공 시 in-memory 토큰 갱신 → caller 반환
- save 실패 시: in-memory 도 갱신하지 않음 → 다음 호출에서 만료된 access_token 으로 401 → markAuthFailed → status='action_needed'
- 동시 refresh race: workspace mutex 로 직렬화, refresh 자체 재시도 안 함 (1회용 refresh 가 이미 사용된 경우 두 번째 시도는 항상 실패)

**Slack 에러 매핑** (REVISE): `oauth.v2.access` 의 `ok: false` 응답 + callback error 를 친절한 메시지로:
| Slack error | UX 메시지 | 처리 |
|---|---|---|
| `bad_redirect_uri` | "Slack App 의 Redirect URLs 에 `<canonical>/oauth/slack/callback` 등록되어 있는지 확인" | 사용자 액션 |
| `invalid_team_for_non_distributed_app` | "Slack App 의 Public Distribution 활성화 필요 (외부 워크스페이스 install)" | 사용자 액션 |
| `unapproved_scope` | "Slack workspace admin 의 scope 승인 대기 중" | 자동 재시도 X |
| `org_login_required` | "Enterprise Grid 환경 미지원 (Phase 12 비범위)" | reject |
| `invalid_client` / `invalid_client_id` | "client_id / client_secret 불일치 — `/admin/slack` 에서 재입력" | reject |
| `access_denied` | "사용자가 권한 동의를 거부함" | 안내 |

audit events 추가:
- `slack.app_credential_set` / `slack.app_credential_deleted`
- `slack.install_started` / `slack.install_completed` / `slack.install_failed`
- `slack.token_refreshed` / `slack.token_refresh_failed`
- `slack.token_save_failed` (durable save 실패 — 별도 추적)
- `slack.disconnect` / `slack.disconnect_revoke_failed`

audit field 정책: token prefix 만 (`xoxe.xoxp-1...`), `team.id` 평문 OK (Slack ID 는 식별자, 비밀 아님), `clientId` 평문 OK, `clientSecret` 절대 금지.

metrics counters (`OAuthMetrics` 패턴 재사용):
- `slack_install_total{result=success|failed,team=<masked>}`
- `slack_refresh_total{result=success|failed|save_failed|aborted}`
- `slack_workspace_count` (gauge)
- `slack_action_needed_count` (gauge — refresh 실패 누적 모니터링)

---

## 5. Slack App manifest 템플릿

`docs/SLACK_OAUTH_SETUP.md` 와 함께 `templates/slack-app-manifest.yaml` 제공. Admin UI 의 다운로드 버튼이 redirect URL 만 동적으로 채운 결과를 반환:

```yaml
display_information:
  name: Bifrost
  description: MCP Bifrost — multi-workspace MCP edge
  background_color: "#1d1d1f"
# Phase 12 — user-token only. bot_user 미포함 (Phase 12.1 후속).
oauth_config:
  redirect_urls:
    - https://your-bifrost-host/oauth/slack/callback   # canonical resolver 가 동적 치환
  pkce_enabled: false                                  # confidential web app — client_secret_post (B1)
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
    # bot scopes 비어있음 — Phase 12 는 root bot token 응답을 무시 (3.2 §invariant)
settings:
  token_rotation_enabled: true
  org_deploy_enabled: false                            # Enterprise Grid 비지원 (Phase 12 비범위)
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
| `clientSecret` 보관 | `0o600`, audit log 마스킹 (`hasSecret: bool` 만 노출), log sanitize. OS keychain 은 optional hardening (Phase 12 비범위) |
| `accessToken` / `refreshToken` 보관 | 기존 OAuth 토큰과 동일한 chmod / sanitize 룰. **`_maskSlackOAuth` (B5)** 가 `/api/workspaces` 응답에서 raw token 노출 차단 |
| state CSRF | HMAC-signed + payload schema (`typ`/`aud`/`installId`/`iat`/`exp`), TTL 10 분, pending store. `iat` ≤ `Date.now()` ≤ `exp` 검증 (REVISE) |
| redirect_uri 검증 | **canonical `BIFROST_PUBLIC_URL` 와 정확히 일치 (B3)**. Host header 자동 치환 금지. authorize / token-exchange 가 같은 resolver 사용 |
| Cloudflare random tunnel | 미지원 (host 가 매번 달라짐). 운영 가이드에 fixed hostname 권장 명시 |
| popup callback 페이지 XSS | 응답 HTML 은 `html-escape.js` 로 escape, inline script 최소화. postMessage targetOrigin = `BIFROST_PUBLIC_URL` (와일드카드 금지) |
| popup completion 보안 | opener 가 `event.origin === BIFROST_PUBLIC_URL` 검증 후 처리. 미일치는 silent drop |
| token rotation race | workspace 단위 mutex + 1회용 refresh 재시도 금지 + durable save 원자성 (B6) |
| Slack OAuth 응답 검증 | `ok: true` + `team.id` + `authed_user.id` + `authed_user.access_token` + `authed_user.token_type === 'user'` 모두 있어야 진행. `is_enterprise_install: true` reject (REVISE) |
| Slack 에러 매핑 | `bad_redirect_uri` / `invalid_team_for_non_distributed_app` / `unapproved_scope` / `org_login_required` / `invalid_client` / `access_denied` 친절한 UX 변환 (§4.5) |
| `auth.test` rate limit | `_lastCapabilityCheck` 60s cooldown (REVISE) — 다수 workspace 시 rate pressure 회피 |
| Disconnect 의 revoke 정책 | access + refresh 둘 다 best-effort revoke. 실패는 audit 만 남기고 로컬 토큰은 항상 삭제 (REVISE) |
| Enterprise Grid silent-break | `is_enterprise_install: true` 또는 `enterprise.id` 만 있고 `team` 없음 → 명시적 reject + UX 안내 (REVISE) |
| `incoming_webhook` 응답 | 받아도 무시. workspace 에 저장 금지 (NIT) |
| `slackApp` env override | `BIFROST_SLACK_CLIENT_ID` / `BIFROST_SLACK_CLIENT_SECRET` 가 각각 설정되어 있으면 해당 file 값 무시 + UI 가 두 source 를 별도 배지 표시. `_maskSlackApp.sources` 가 진실의 출처 (v4) |

---

## 7. 마이그레이션 (B7)

### 7.1 호환성 원칙
- `provider: 'slack'` + `credentials.botToken` workspace → `authMode: 'token'` 로 자동 인식 (default)
- `slackApp` top-level 필드는 신규 — 미존재가 default
- `slackOAuth` 필드는 신규 — 미존재가 default
- **강제 마이그레이션 없음**. 기존 botToken workspace 는 그대로 동작

### 7.2 botToken → OAuth 전환 절차 (B7 — Codex 검증)
**권장 = hard-delete 기반** (12-D9):

1. 기존 botToken workspace 의 alias / namespace 를 메모
2. Workspace detail 페이지에서 **Hard Delete** (soft-delete 아님 — namespace suffix 회피)
3. Wizard 에서 OAuth 모드로 새 workspace 추가 + Slack 의 같은 team install
4. alias / namespace 를 동일하게 입력 (tool name `slack_<namespace>__<tool>` 보존)

**왜 in-place conversion 안 하나**:
- `tool-registry.js:145` 의 `provider_namespace__tool` 결과가 `authMode` 변화에도 안정적이지 않음
- soft-delete 상태의 namespace 가 alias 기반 충돌 검사에 걸려 suffix 추가될 수 있음
- 도구 client 들이 캐시한 tool name 을 모두 invalidate 시키는 것보다 명시적 새 entry 생성이 안전

**자동화 도구 (선택)**: `scripts/migrate-slack-to-oauth.mjs` — `--dry-run` / `--apply`. 기존 botToken entry 의 alias/namespace 를 읽어 OAuth wizard 의 prefill 로 넘기는 helper. 강제 자동 마이그레이션은 안 함.

### 7.3 기존 마이그레이션 스크립트 영향
- Phase 10a 의 `migrate-oauth-clients.mjs` 는 mcp-client OAuth 만 다룸. Phase 12 와 직교 — 변경 없음
- 신규 1회성 스크립트 불필요 (스키마는 backward-compat 추가만)

### 7.4 `slackApp` credential 삭제 시 정책
- 의존하는 OAuth workspace 가 있으면 기본 거부
- `?force=true` → App credential 삭제 + 의존 workspace 들의 `slackOAuth.status='action_needed'` 일괄 전환 + audit `slack.app_credential_deleted_force`
- 사용자는 Workspace detail 의 "Re-authorize" 로 새 App credential 등록 후 재인증

---

## 8. 테스트 전략

### 8.1 Unit (`test/slack-oauth-manager.test.js` 신규)
- state HMAC 서명/검증 — `typ`/`aud`/`iat`/`exp` 모두 검증 (REVISE)
- state TTL 만료 — `iat` 미래 시각 / `exp` 초과 케이스
- `oauth.v2.access` 응답 파싱:
  - success (nested `authed_user`) — Phase 12 invariant 확인 (REVISE)
  - HTTP 200 + `{ ok: false, error }` 매핑 (REVISE — Slack 의 표준 에러 응답 패턴)
  - `is_enterprise_install: true` reject
  - root bot-token 만 있고 `authed_user` 없는 응답 reject
- refresh mutex — 동시 refresh 호출 시 단일 token endpoint 호출만 발생
- token rotation — 새 refresh_token 으로 atomic replace
- **durable save 실패 시 새 token 폐기 + status='action_needed'** (B6)
- `auth.revoke` failure 시에도 로컬 토큰 삭제

### 8.2 Provider (`test/slack-provider.test.js` 확장)
- `authMode: 'oauth'` 모드에서 `_tokenProvider` 호출 (`_headers()` async 검증)
- `botToken` 모드 backward-compat 보존
- user-token 으로 search/list/history 도구 동작
- `_tokenProvider` 미주입 시 즉시 throw

### 8.3 Schema + masking (`test/workspace-schema.test.js` 확장 + `test/slack-mask.test.js` 신규)
- `provider=slack && authMode=oauth && botToken` → reject (B5)
- `slackOAuth.tokens.tokenType !== 'user'` → reject
- `_maskSlackOAuth` 가 `/api/workspaces` 응답에서 raw `accessToken` / `refreshToken` 차단 (B5 핵심)
- `_maskSlackApp` 의 `sources.clientId` / `sources.clientSecret` 정확성 — 5 케이스 매트릭스 (env+env / env+file / file+env / file+file / none)

### 8.4 Public origin (`test/public-origin.test.js` 신규)
- `BIFROST_PUBLIC_URL` 미설정 → throw
- HTTP / non-localhost → reject (HTTPS 강제)
- trailing slash strip
- manifest 다운로드 / authorize / callback 가 같은 redirect_uri 생성

### 8.5 Integration (`test/slack-oauth-flow.test.js` 신규)
- mock Slack OAuth endpoint 띄우고 install start → callback → workspace entry 생성 검증
- 동일 Slack App 으로 두 번째 workspace install → 두 entry 가 격리된 토큰 보유 (multi-workspace 핵심)
- **같은 team.id 두 번째 install** → duplicate detection → 기존 entry 의 token 갱신 (REVISE)
- **`teamInstallMutex` 동시 install** — 같은 team 동시 callback 두 개 → 한 개만 entry 생성 (B4)
- 토큰 만료 임박 시 자동 refresh
- refresh 실패 401 → status='action_needed' → Admin UI 표시
- redirect_uri mismatch → 거부 + 친절한 에러
- `installId` polling — pending → completed 전이
- popup `postMessage` strict-origin 검증

### 8.6 Manual / E2E checklist (`docs/SLACK_OAUTH_E2E_CHECKLIST.md`)
- 실 Slack App 등록 → Bifrost `/admin/slack` 에 credential 등록 → manifest.yaml 다운로드 검증
- 두 workspace install → tools/list 호출 → 응답 격리 확인
- 12h 만료 후 refresh 실측 (또는 expires_in 인위 단축으로 시뮬레이션)
- Disconnect → revoke 검증 (Slack App "Authorized Users" 화면에서 사라짐)
- Public Distribution **미활성** 상태에서 install 시도 → 친절한 에러 표시 검증
- Enterprise Grid workspace install 시도 → 명시적 reject 메시지
- env override 동작 — 5 케이스 매트릭스에서 `/api/slack/app` 의 `sources.{clientId,clientSecret}` 값 + UI 배지 표시 검증:
  1. env+env (둘 다 환경변수)
  2. env+file (clientId env, secret file)
  3. file+env (clientId file, secret env)
  4. file+file (둘 다 file)
  5. none (둘 다 미설정 — `/admin/slack` 미사용 상태)
- Cloudflare tunnel fixed hostname 환경 검증, random tunnel 미지원 메시지

---

## 9. 구현 순서 (sub-phase 별 estimated effort) — Codex 견적 반영 (v2)

| Sub | 산출물 | 견적 |
|-----|--------|------|
| 12-1 | Workspace schema (`slackApp` + `slackOAuth`) + Zod batch + `_maskSlackOAuth` + masking 테스트 | 1d |
| 12-2 | `BIFROST_PUBLIC_URL` resolver + manifest dynamic redirect 통합 + 단위 테스트 | 0.5d |
| 12-3 | `slack-oauth-manager.js` 코어 (install / exchange / refresh / state / mutex / `oauth-shared.js`) | 3d |
| 12-4 | `providers/slack.js` OAuth 모드 + `_tokenProvider` 와이어업 + `_headers()` async 변환 + capability cooldown | 0.5d |
| 12-5 | Admin REST endpoints (`/api/slack/*`, `/oauth/slack/callback`, install status polling) + audit/metrics | 1.5d |
| 12-6 | Admin UI — `/admin/slack` 설정 페이지 + Wizard "Slack workspace 추가" + popup completion (postMessage + polling) | 2d |
| 12-7 | Refresh hardening (durable save 원자성, race test, error mapping) + token rotation crash recovery | 1.5d |
| 12-8 | Slack manifest 템플릿 (pkce_enabled: false) + `SLACK_OAUTH_SETUP.md` + 운영 가이드 | 0.5d |
| 12-9 | botToken → OAuth migration helper + Enterprise Grid silent-break reject | 1d |
| 12-10 | E2E checklist (`SLACK_OAUTH_E2E_CHECKLIST.md`) + Phase 12 self-review log + integration 통합 | 2d |

총 ~13.5일 (혼자 풀타임 기준). Codex 리뷰 3~5 rounds 포함 시 +25~35%. 운영 환경 차이 (Cloudflare fixed tunnel 셋업 등) 로 ±2일 변동 가능.

---

## 10. Risk / Open Questions (v2 — closed/추가)

| # | 질문 | 상태 | 해소 |
|---|------|------|------|
| ~~R1~~ | PKCE 강제 여부 | **CLOSED (B1)** | Slack PKCE GA changelog: web redirect flow 에선 optional. confidential web app → PKCE 미사용 + `client_secret_post`. manifest `pkce_enabled: false` |
| ~~R2~~ | Cloudflare tunnel 동적 host | **CLOSED (B3)** | `BIFROST_PUBLIC_URL` canonical resolver 강제. random tunnel 미지원, fixed tunnel 권장. 개발은 localhost redirect 추가 |
| R3 | unlisted distributed app install 한도 | OPEN | Slack docs 명시 없음. 운영 가이드에 "50+ install 시 Slack review 요청 가능" 경고 추가. 모니터링은 `slack_workspace_count` gauge |
| R4 | user-token 으로 hosted MCP 와 capability 동등 여부 | ACCEPTED | 동일 scope 면 Slack Web API 호출은 동등. hosted MCP 의 `assistant.search.context` 같은 wrapper 추가 utility 는 비지원 명시 |
| R5 | `auth.test` rate limit | **CLOSED (REVISE)** | `_lastCapabilityCheck` 60s cooldown. refresh 는 workspace mutex 로 직렬화 |
| R6 | botToken → OAuth 마이그레이션 도구 호환성 | **CLOSED (B7)** | hard-delete 기반 — alias / namespace 동일하게 입력 권장. soft-delete 충돌 회피 |
| R7 | Slack App `clientSecret` rotation | **CLOSED v3** | Slack 의 secret regeneration 후 **이전 secret 24h 유효** (https://docs.slack.dev/authentication/verifying-requests-from-slack/). `/admin/slack` 의 secret 업데이트 endpoint + 24h grace window 인지 명시 + `invalid_client` → `action_needed` 매핑 + rollback 절차 (env override 우선순위가 file 보다 높으므로 env 로 롤백). 테스트: 새 secret 설정 후 첫 refresh 가 invalid_client 반환 시 status='action_needed' 전이 검증 |
| **R8** | Slack 의 다양한 에러 응답 (`bad_redirect_uri`, `unapproved_scope`, ...) UX | **CLOSED (REVISE)** | `oauth.v2.access` 응답 + callback error 매핑표 (§4.5) — friendly UX 변환 |
| **R9** | Enterprise Grid silent-break | **CLOSED (REVISE)** | `is_enterprise_install: true` 명시적 reject + UX 안내. non-goal 로 두되 silent failure 차단 |
| **R10** | token rotation 도중 crash → 새 token 받았는데 save 못 함 | **CLOSED (B6)** | durable save 원자성 + status='action_needed' 수렴. caller 는 새 token 절대 사용 안 함 |
| **R11** | popup callback completion 신뢰성 (postMessage / opener 누락) | **CLOSED (B9)** | postMessage primary + `installId` polling fallback (1.5s × 5min) |
| **R12** | `slackOAuth` raw token 노출 | **CLOSED (B5)** | `_maskSlackOAuth` + 노출 차단 단위 테스트 |
| R13 | Slack 의 token rotation 끄고 싶은 (legacy) 사용자 케이스 | **CLOSED v3** | manifest `token_rotation_enabled: false` 시 `expires_in` / `refresh_token` 미응답. **분기표**: ① `expiresAt` 없음 + `refreshToken` 없음 = **non-rotating active** (long-lived user-token, refresh path 비호출, 정상 동작) — ② `expiresAt` 있음 + `refreshToken` 없음 = 비정상 응답 → `action_needed` (rotation 일관성 깨짐) — ③ 정상 rotating: 둘 다 존재. 운영 가이드에 token rotation 활성을 강력 권장하되 rotation off 도 동작 보장 |

---

## 11. 의존 / 사전 조건

- Phase 10a 의 `_workspaceMutex` / `_identityMutex` 패턴 (재사용)
- Phase 11-9 의 `static-client-guides.js` 패턴 (Slack App 가이드 추가 시 참고)
- Phase 6 의 `_signState` / `_loadPending` (state 서명, pending TTL)
- `oauth-sanitize.js` (token masking)
- `audit-logger.js` (audit events)
- `oauth-metrics.js` (metrics recorder 패턴)

---

## 12. 확정 사항 (2026-04-29 합의 완료, v2 추가)

| # | 결정 |
|---|------|
| 12-D1 | **Slack App credential 보관**: `config/workspaces.json` top-level `slackApp` 필드 + env override (`BIFROST_SLACK_CLIENT_ID` / `BIFROST_SLACK_CLIENT_SECRET`). env 우선, 없으면 file 사용. 기존 file watcher 인프라 그대로 재사용 |
| 12-D2 | **신규 Slack workspace default mode**: `oauth`. App credential 미등록 상태에서 wizard 진입 시 자동으로 `/admin/slack` setup 페이지로 redirect |
| 12-D3 | **Bot-token 발급**: Phase 12 는 **user-token only**. Bot-token 은 Phase 12.1 후속 (write 도구 추가 시 같이) |
| 12-D4 | **hosted MCP (`mcp.slack.com/mcp`) 경로 유지**: `mcp-client` kind 로 이미 동작. Phase 12 는 hosted MCP 와 직교한 신규 native 경로. 두 경로 공존, 사용자가 워크스페이스 생성 시 선택 |
| 12-D5 | **manifest 다운로드 endpoint 인증**: Admin 전용 (`BIFROST_ADMIN_TOKEN` 보호). Bifrost host URL 외부 노출 방지 |
| **12-D6** | **PKCE 미사용** (v2): Bifrost 가 server-side `client_secret` 보관 confidential web app 이므로. manifest `oauth_config.pkce_enabled: false`, token endpoint auth = `client_secret_post` |
| **12-D7** | **`BIFROST_PUBLIC_URL` 환경변수 신규** (v2): Slack OAuth 의 redirect_uri canonical 결정. HTTPS 강제 (localhost 예외). Cloudflare random tunnel 미지원, fixed hostname 권장 |
| **12-D8** | **Popup completion contract** (v2): postMessage primary (`type: 'bifrost-slack-install'`, targetOrigin = `BIFROST_PUBLIC_URL`) + `GET /api/slack/install/status?installId=...` polling fallback (1.5s, 5min) |
| **12-D9** | **botToken → OAuth 마이그레이션**: hard-delete 기반 권장. namespace suffix 회피, soft-delete 사용 안 함. 자동화 helper 는 prefill 만 제공, 강제 변환 없음 |
| **12-D10** | **state payload schema 강화**: `typ: 'slack-oauth'`, `aud: '/oauth/slack/callback'`, `installId`, `iat`, `exp` 모두 검증. HMAC + iat/exp bound 모두 통과 시에만 진행 |
| **12-D11** | **single mutex** (`_workspaceMutex` + 신규 `_teamInstallMutex`): user-token only 라 `_identityMutex` 미도입. bot-token 추가 시 (Phase 12.1) 재고 |
| **12-D12** | **Enterprise Grid 비지원**: `is_enterprise_install: true` 응답을 명시적 reject. silent-break 차단 |
| **12-D13** | **shared utility (`server/oauth-shared.js`)**: state HMAC, sanitize, FIFO mutex 헬퍼를 `OAuthManager` / `SlackOAuthManager` 가 공유 |

---

## 13. 진행 체크리스트

- [x] §12 결정 사항 합의 (2026-04-29)
- [x] Codex peer review v1 — 9 blockers + 13 revises 식별 (2026-04-29)
- [x] Plan v2 작성 — 모든 blockers + 주요 revises 반영 (2026-04-29)
- [x] Codex peer review v2 — 6 closed + 1 partial + 2 not closed + 신규 expiresAt blocker (2026-04-29)
- [x] Plan v3 작성 — B4 mutex 순서, B6 staged commit, expiresAt ISO, R7/R13 close, env source 추적 (2026-04-29)
- [x] Codex peer review v3 — 4 CLOSED + 3 PARTIAL (expiresAt schema, mask helper 시그니처, env source 일관성), 신규 blocker 없음 (2026-04-29)
- [x] Plan v4 작성 — 3 PARTIAL 수렴 (2026-04-29)
- [x] Codex peer review v4 — P1/P2 CLOSED, P3 PARTIAL (테스트 매트릭스 4 vs 5 mismatch + helper 시그니처 잔재) (2026-04-29)
- [x] Plan v5 작성 — 5 케이스 매트릭스 명시 + redundant helper 블록 통합 (2026-04-29)
- [x] **Codex peer review v5 — APPROVE** (2026-04-29). Phase 12 구현 착수 가능한 수준
- [x] 12-1 schema 확장 + Zod batch + masking 룰 + 단위 테스트 (2026-04-29, Codex round 2 APPROVE)
- [x] 12-2 `BIFROST_PUBLIC_URL` resolver + 단위 테스트 (2026-04-29, Codex round 2 APPROVE)
- [x] 12-3 `slack-oauth-manager.js` 코어 (PKCE 미사용, state schema) + 단위 테스트 (2026-04-30, Codex round 4 APPROVE)
- [x] 12-4 `providers/slack.js` OAuth 모드 + `_headers()` async + cooldown (2026-04-30, Codex round 4 APPROVE)
- [x] 12-5 Admin REST endpoints + install status polling (2026-04-30, Codex round 2 APPROVE)
- [x] 12-6 Admin UI + popup completion (postMessage + polling) (2026-04-30, Codex round 4 APPROVE)
- [x] 12-7 Refresh durable save + error mapping (2026-04-30, Codex round 2 APPROVE)
- [ ] 12-8 manifest 템플릿 + 운영 가이드
- [ ] 12-9 botToken → OAuth migration helper + Enterprise Grid reject
- [ ] 12-10 통합 테스트 + E2E checklist + self-review log
- [ ] Codex review (목표: 3~5 rounds)
- [ ] Phase 12 완료 보고 + CLAUDE.md "Phase 이력" 항목 추가

---

**다음 단계**: Codex peer review 완료 후 12-1 부터 순차 진행.
