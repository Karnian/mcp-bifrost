# Phase 7 — Multi-Tenant MCP + Observability + Provider Expansion

**작성일**: 2026-04-15
**범위**: Phase 4 잔여(Profile 엔드포인트 + 다중 MCP 토큰 + 추가 provider + 사용량 대시보드) + Phase 6.5(multi-user OAuth 격리 + DCR 수동 UI + MCP notifications 구독)
**주요 목표**: Bifrost 를 **단일 사용자 도구** 에서 **다중 사용자/다중 클라이언트 공유 허브** 로 확장하면서, OAuth 토큰 격리 / 사용량 관측 / provider 다양성을 동시에 제공

---

## 1. 배경과 동기

### Phase 6 가 남긴 공백
Phase 6 에서 **Bifrost 자체가 OAuth 클라이언트로 동작**하게 되어 Notion 같은 hosted MCP 를 연결할 수 있게 됐지만, 다음 한계가 남아 있음:

1. **Single-User 전제** — 하나의 Bifrost 인스턴스는 모든 MCP 클라이언트가 동일한 access_token 을 공유 (A 사용자의 Notion 페이지를 B 사용자도 조회 가능)
2. **클라이언트 단위 제어 부재** — 모든 MCP 클라이언트가 모든 도구를 볼 수 있음. 읽기 전용 클라이언트 / 에이전트별 권한 분리 불가
3. **관측 불가** — 어떤 도구가 얼마나 호출됐는지, 어떤 클라이언트가 문제를 일으키는지 로그 없음
4. **Remote MCP provider 다양성 부족** — Notion 만 템플릿 정리됨. GitHub/Linear/Google Drive 의 remote OAuth 템플릿이 없어 매번 수동 등록 필요
5. **DCR 미지원 서버 대응이 API-only** — Wizard UI 에서 수동 client_id 입력이 불가
6. **MCP notifications 누락** — 상위 MCP 서버가 `tools/list_changed` 를 보내도 HTTP/SSE transport 에서는 구독 불가 (stdio 만 지원)

### Phase 7 의 해결
아래 7 개 축을 하나의 phase 로 묶어 **배포 가능한 다중 테넌트 엣지** 로 승격:

| 축 | 목표 |
|----|------|
| 7a | Profile 엔드포인트 (가벼운 클라이언트별 도구셋 제한) |
| 7b | 다중 MCP 토큰 + 토큰→워크스페이스 ACL (멀티테넌시 기반) |
| 7c-pre | **ws.oauth 스키마 + tokenProvider 시그니처 migration** (backward-compat shim) |
| 7c | 토큰별 OAuth 격리 (Phase 6.5 핵심, multi-user 해소) |
| 7d | DCR 미지원 수동 client_id Wizard UI |
| 7e | 상위 MCP HTTP/SSE `notifications/tools/list_changed` 구독 |
| 7f | Remote MCP 템플릿 확장 (GitHub / Linear / Google Drive) |
| 7g | 사용량 대시보드 + 상세 audit trail |

### 전제 (Multi-Tenant)
- Phase 7 완료 후 Bifrost 는 **여러 사용자/클라이언트가 같은 엔드포인트를 안전하게 공유** 가능
- 관리자는 "회사 Notion 은 read-only 프로필만 노출", "CI 봇은 notion-work 만 접근 가능" 식의 정책을 Admin UI 로 구성
- 다만 Admin UI 자체는 계속 localhost / Admin 토큰 보호 기반 (Phase 8 에서 Admin OAuth/SSO 검토)

### 비목표 (Out of Scope)
- **SSO (Google/Microsoft Workspaces)** → Phase 8
- **Rate limiting / quota 강제** → 관측만 제공, 차단은 Phase 8
- **MCP resources/list, prompts/*** 서브스크립션 구독 (Phase 7e 는 tools 만)
- **Per-user 데이터 암호화** → Phase 7 은 chmod 0600 유지, OS keychain 은 Phase 8
- **API gateway 수준의 도구 호출 변환/프록시 규칙** → 별도 "tool shaping" phase

---

## 2. 스코프 요약

### In-scope
1. `profile` 쿼리파라미터 + server config 에 정의된 도구셋 화이트리스트
2. `BIFROST_MCP_TOKENS` (복수형) 환경변수 + Admin UI 의 MCP 토큰 관리 + 토큰→`allowedWorkspaces` 맵핑
3. 토큰별 OAuth 토큰 격리: 같은 워크스페이스라도 토큰 A 가 호출하면 A 의 Notion access_token 사용, 토큰 B 는 B 의 것 사용
4. Wizard Step 3 에 "DCR 실패" 분기 — 수동 client_id/secret/auth_method 입력 폼
5. `providers/mcp-client.js` 에 GET stream 구독 + `notifications/tools/list_changed` 처리 → `tr.bumpVersion()` + SSE broadcast
6. `admin/public/templates.js` 에 `github-oauth`, `linear-oauth`, `google-drive-oauth` 추가 (URL 프리셋 + OAuth flag)
7. **In-memory call counter** + `.ao/state/usage.jsonl` 누적 + Admin UI "Usage" 탭 (per-workspace / per-token / per-tool, 최근 24h/7d 집계)
8. `audit.jsonl` 파일 기반 로그 (기존 메모리 ring buffer 보완)

### Out-of-scope
- Token-rotation for MCP tokens (발급된 토큰의 유효기간/재발급) → 운영자가 수동 회전
- Admin UI 의 SSO 로그인
- Multi-region / sharding
- Web UI 에서 실시간 tool 호출 tailing (Phase 8 후보)

---

## 3. 아키텍처 변경 개요

### 3.1 신규 파일
```
server/
  mcp-token-manager.js   — MCP 토큰 등록/조회, 토큰→allowedWorkspaces ACL
  usage-recorder.js      — 호출 카운터 + 주기적 flush to .ao/state/usage.jsonl
  audit-logger.js        — 파일 기반 audit trail (JSONL append)
providers/
  mcp-client.js          — (수정) GET stream 구독, notifications 파싱
config/
  profiles.json          — (신규, optional) { "read-only": { toolsInclude: ["*search*"] } }
```

### 3.2 수정 파일
| 파일 | 변경 |
|------|------|
| `server/index.js` | 요청 처리 시 토큰→identity 해석 후 mcp-handler 에 넘김, `?profile` 파싱 |
| `server/mcp-handler.js` | `callContext = { identity, profile }` 를 tool call 에 전파, tools/list 필터링 |
| `server/tool-registry.js` | `getTools({ identity, profile })` — ACL + profile filter |
| `server/workspace-manager.js` | `getProvider(id, { identity })` — 토큰별 OAuth lookup |
| `server/oauth-manager.js` | `identity` 파라미터 지원 — `ws.oauth.byIdentity[<tokenId>].tokens` |
| `providers/mcp-client.js` | GET stream 구독 (6.5 SSE notifications), Authorization 동적 주입에 identity 힌트 |
| `admin/routes.js` | `/api/tokens` CRUD, `/api/profiles` CRUD, `/api/usage`, `/api/audit`, `/api/workspaces/:id/authorize` 에 `identity` |
| `admin/public/*` | Tokens 탭, Profiles 탭, Usage 탭, Wizard manual DCR 폼 |

### 3.3 스키마 확장

#### `config/workspaces.json` — oauth 필드 확장 (backwards-compat)
```jsonc
{
  "oauth": {
    "enabled": true,
    "issuer": "https://mcp.notion.com",
    "clientId": "...",
    "authMethod": "none",
    "metadataCache": { ... },

    // Phase 7c 신설 — 토큰별 격리
    "byIdentity": {
      "default": {              // 기존 단일 사용자 migration key
        "tokens": { "accessToken": "...", ... }
      },
      "tok_ci_bot": {           // multi-token 등록된 identity
        "tokens": { ... }
      }
    }

    // ⚠️ 기존 `oauth.tokens` 는 유지 → `byIdentity.default.tokens` 로 자동 복제 후 5xx 안전 read
  }
}
```

#### `config/workspaces.json` — server 섹션
```jsonc
{
  "server": {
    "port": 3100,
    "mcpTokens": [                      // Phase 7b 신설
      {
        "id": "tok_ci_bot",
        "description": "CI 봇 (Linear 전용 read)",
        "token": "<hashed>",             // bcrypt(원본) — 원본은 발급 시 1회만 노출
        "allowedWorkspaces": ["linear-work"],
        "allowedProfiles": ["read-only"],
        "createdAt": "...",
        "lastUsedAt": "..."
      }
    ],
    "profiles": {                        // Phase 7a 신설 (config/profiles.json 외부화 가능)
      "read-only": { "toolsInclude": ["*search*", "*_get_*", "*list*"] },
      "notion-only": { "workspacesInclude": ["notion-*"] }
    }
  }
}
```

#### `.ao/state/usage.jsonl` (Phase 7g)
append-only, 라인당 1 이벤트:
```jsonc
{ "t": "2026-04-15T09:00:00Z", "identity": "tok_ci_bot", "ws": "linear-work", "tool": "linear__search_issues", "durationMs": 230, "ok": true }
```

#### `.ao/state/audit.jsonl` (Phase 7g)
기존 in-memory ring buffer 와 **병행** (호환 유지):
```jsonc
{ "t": "...", "action": "workspace.add", "identity": "admin", "workspace": "notion-work", "details": "..." }
{ "t": "...", "action": "oauth.refresh_success", "identity": "tok_ci_bot", "workspace": "notion-work", "details": "{...}" }
```

### 3.4 흐름 — 요청 경로 (Phase 7 완료 후)

```
MCP 클라이언트
  │ Authorization: Bearer tok_ci_bot
  ▼
server/index.js
  ├─ parseBearer → tokenManager.resolve(tok_ci_bot) → identity { id: "tok_ci_bot", allowedWorkspaces, allowedProfiles }
  └─ parseProfile(?profile=read-only) → profile
     ▼
mcp-handler.handle(body, { identity, profile })
  ├─ tools/list → tool-registry.getTools({ identity, profile })
  │                  ↳ ACL: allowedWorkspaces ∩ profile.workspacesInclude
  │                  ↳ profile.toolsInclude 매칭
  └─ tools/call → ws = toolRegistry.reverseLookup(name)
                  ├─ ACL check
                  ├─ provider = wm.getProvider(ws.id, { identity })   ← 토큰별 oauth
                  ├─ usage-recorder.record({ identity, ws, tool, start })
                  └─ provider.callTool(...)
```

---

## 4. 구현 단계

### 7a — Profile 기반 엔드포인트 (1일) ★ 단순
- [ ] `config/profiles.json` 로더 + hot reload
- [ ] `server/tool-registry.js` — `getTools({ profile })` 확장: `profile.toolsInclude` glob 매칭 (`*search*` → `search`, `search_pages` 등)
- [ ] `server/index.js` — `/mcp?profile=...`, `/sse?profile=...` 파싱 후 mcp-handler 에 전달
- [ ] Admin UI: "Profiles" 탭 (정의된 프로필 목록 + glob 에디터 + 프리뷰: 매칭되는 도구)
- [ ] 테스트: 프로필 매칭 glob, 존재하지 않는 프로필 요청 시 에러, 빈 결과 집합

### 7b — 다중 MCP 토큰 + ACL (1.5일)
- [ ] `server/mcp-token-manager.js`:
  - `add({ description, allowedWorkspaces, allowedProfiles })` → returns `{ id, plaintext }` (plaintext 는 1회만 반환)
  - `resolve(bearer)` → identity or null
  - `list()` → 마스킹된 목록 (`token` 필드 제외)
  - `revoke(id)`
- [ ] 저장: `config/workspaces.json` 의 `server.mcpTokens` 배열. `token` 필드는 `bcrypt` 해시 (cost 10)
- [ ] `BIFROST_MCP_TOKEN` (단수) 은 legacy — 여전히 동작하되 identity = `"legacy"`
- [ ] `BIFROST_MCP_TOKENS` 환경변수 지원: `id1:plaintext1,id2:plaintext2` 형식으로 런타임 등록 (파일에 쓰지 않음)
- [ ] Admin UI: "Tokens" 탭 — 토큰 발급 시 plaintext 를 한 번만 크게 표시 + 복사 버튼 + "이후로는 해시만 저장됨" 안내
- [ ] `server/index.js`: `authenticateMcp` 가 token-manager 에 위임, identity 를 req 에 부착
- [ ] `tool-registry.getTools({ identity })` — `allowedWorkspaces` 기준 필터
- [ ] 테스트: 토큰 없음/잘못된 토큰/유효 토큰 + ACL 필터링 + 해시 검증 + 로테이션(재발급)

### 7c-pre — 스키마 + 시그니처 migration (1일) ★ 신규 (Codex REVISE 반영)
**Rationale**: 현재 `server/workspace-manager.js:139`, `server/oauth-manager.js:506`, `providers/mcp-client.js:127` 가 전부 단일 `oauth.tokens` + no-arg `tokenProvider()` 전제. 7c 직행 시 호환층 없이 회귀 위험.
- [ ] `ws.oauth.byIdentity` 스키마 도입 — 기존 `ws.oauth.tokens` 는 **보조 미러**로 유지 (`byIdentity.default.tokens` 와 동기화)
- [ ] 부팅 시 atomic migration: `_save()` 원자적 쓰기 패턴 재사용, 실패 시 backup rollback
- [ ] `OAuthManager` 의 tokens read/write 경로 전부 `byIdentity[identity || 'default']` 경유로 통일, 상위 호출부는 아직 identity 를 안 넘겨도 동작
- [ ] `McpClientProvider` 의 `tokenProvider` 시그니처를 `(identity?) => Promise<string|null>` 로 확장 — 기본값 `undefined` 로 default identity lookup
- [ ] `_computeStatus` 의 `oauthActionNeeded` 를 **per-identity map** (`oauthActionNeededBy: { [identity]: true }`) 로 전환. 단일 bool 은 deprecated 로 유지. Dashboard 는 "any true → action_needed"
- [ ] Phase 6 테스트 95건 전수 통과 (회귀 0)
- [ ] 신규 테스트: (a) migration forward (단일→byIdentity), (b) migration backward-compat read (legacy `ws.oauth.tokens` 만 있는 config 로드), (c) tokenProvider 두 시그니처 모두 동작, (d) per-identity action_needed 플래그 독립성

### 7c — 토큰별 OAuth 격리 (2일) ★ Phase 6.5 핵심
- [ ] 7c-pre 의 shim 위에서 authorize/refresh/callback 전 경로에 identity 전파 (pending state, mutex 키 등)
- [ ] `OAuthManager.initializeAuthorization(workspaceId, { identity, ... })` — pending state 에 identity 포함, completeAuthorization 가 `byIdentity[identity]` 에 저장
- [ ] `OAuthManager.getValidAccessToken(workspaceId, identity)` — 해당 identity 의 tokens 참조. 없으면 `action_needed` (해당 identity 만)
- [ ] `forceRefresh(workspaceId, identity)` — per-identity mutex (`Map<"${wsId}::${identity}", Promise>`) — **mutex 키 포맷 변경이 Phase 6 test 96, 98, 101 (per-ws mutex) 와 충돌하지 않도록 default identity 는 `wsId::default` 로 통일**
- [ ] `providers/mcp-client.js` — `tokenProvider` 가 callContext 의 identity 받도록 시그니처 확장 (`tokenProvider(identity)`) — 7c-pre 에서 이미 shim 완료
- [ ] **per-workspace, per-identity warm-up 차단** — tokens 없으면 health=unknown, warmup 호출 안 함 (Phase 6 의 warmup→action_needed 오검출 재발 방지)
- [ ] Admin UI Detail: OAuth 패널을 `byIdentity` 탭으로 확장, 토큰 추가 버튼 → identity 선택 + authorize flow, per-identity 상태/Re-authorize 버튼
- [ ] `/api/workspaces/:id/authorize` body 에 `{ identity }` 파라미터 추가 (기본 `"default"`)
- [ ] 테스트: 같은 ws 에 2 identity authorize, 각각 독립 refresh, identity 해제 후 해당 tokens 만 purge, cross-identity 접근 거부, concurrent refresh 시 identity-A 와 identity-B 의 mutex 독립

### 7d — DCR 미지원 수동 client_id Wizard UI (0.5일)
- [ ] Wizard Step 3 에서 `/api/oauth/discover` 응답의 `dcrSupported=false` 면 "수동 Client 입력" 폼 노출:
  - Client ID (required)
  - Client Secret (optional, 빈칸이면 public client)
  - Auth method select: `none` / `client_secret_basic` / `client_secret_post` (auth server metadata 의 지원 method 로 필터링)
- [ ] 폼 제출 → `/api/workspaces/:id/authorize` 에 `{ manual: { clientId, clientSecret, authMethod } }` 전달
- [ ] 성공 시 나머지 flow 동일 (OAuth 팝업)
- [ ] 테스트: e2e mock server 에 `dcrEnabled=false` 모드로 테스트

### 7e — MCP notifications over HTTP/SSE 구독 (2일) ★ 기술적 리스크 중간
- [ ] `providers/mcp-client.js`: transport=http/sse 일 때 backoff 포함 `GET /mcp` (또는 `/sse`) 로 long-lived SSE stream 오픈
- [ ] `Mcp-Session-Id` 헤더 주고받기 (spec 2025-06-18)
- [ ] `data:` 라인 파싱 후 JSON-RPC 응답/알림 구분
  - 응답: 기존 `_handleMessage` 경로 (pending id 매칭)
  - 알림 `notifications/tools/list_changed` → `this._toolsCache = null; this._onToolsChanged()`
- [ ] stream 연결 끊기면 exponential backoff 재연결 (30s → 5min)
- [ ] 401 → `onUnauthorized()` 경유 refresh + 재연결
- [ ] Admin UI 의 Tools 탭 refresh 시 workspace 의 stream 상태 (connected/disconnected) 배지 표시
- [ ] 테스트: mock server 에 `/stream` 엔드포인트 추가, upstream 이 notification 보내면 클라이언트가 cache invalidation 수행 확인, 재연결 검증

### 7f — Remote MCP 템플릿 확장 (0.5일)
- [ ] `admin/public/templates.js` 에 추가:
  ```js
  { id: 'github-oauth', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', oauth: true, ... }
  { id: 'linear-oauth', transport: 'http', url: 'https://mcp.linear.app/mcp', oauth: true, ... }
  ```
- [ ] Google Drive / Asana / Intercom 은 MCP endpoint URL 이 아직 public 아님 → stub 으로 두고 사용자가 URL 입력하도록 README 안내
- [ ] 각 템플릿의 실제 URL 검증은 **template probe** 스크립트 작성 (`scripts/probe-templates.mjs`) — CI 가 아닌 수동 실행, 결과를 `docs/TEMPLATES_PROBE.md` 에 기록 (Phase 6 의 NOTION_MCP_PROBE.md 패턴 재사용)
- [ ] 테스트: 단위 — template → materialize → 올바른 payload

### 7g — 사용량 대시보드 + audit trail (2일)
- [ ] `server/usage-recorder.js`:
  - `record({ identity, workspaceId, tool, durationMs, ok })` — 비동기 배치 flush (1s)
  - `.ao/state/usage.jsonl` append. chmod 0600
  - 크기 > 10MB 시 일자별 rotation (`usage-20260415.jsonl`), 30일 보관 후 purge
  - in-memory aggregator: 최근 24h/7d rolling window per (identity, ws, tool)
- [ ] `server/mcp-handler.js`: `tools/call` 전후로 record 호출
- [ ] `server/audit-logger.js`: 기존 `wm.logAudit` 이 동시에 `.ao/state/audit.jsonl` 에도 append (chmod 0600, rotation 동일)
- [ ] `/api/usage?since=24h&by=workspace|token|tool` — 집계 결과 (JSON)
- [ ] `/api/audit?limit=100&action=oauth.*` — JSONL 에서 tail + 필터
- [ ] Admin UI "Usage" 탭:
  - Top 10 도구 (호출 횟수 + avg latency + error rate)
  - Top 5 토큰 (호출량 + 마지막 사용)
  - Per-workspace 히트 차트 (ASCII bar, 외부 차트 lib 없이)
- [ ] Admin UI "Audit" 탭:
  - 검색창 (action prefix, identity, workspace)
  - 페이지네이션
- [ ] 테스트: record 동시성, rotation, 집계 정확성, audit tail 역순

---

## 5. 의존성 그래프

```
7a ─┐
    │
7b ─┼──► 7c-pre ──► 7c ──► 7e
    │    (migration     (identity 경유로
    │     shim, 회귀 0)   stream 도 격리)
    │
    ├──► 7g (per-identity 집계)
    │
7d ─┘  (7b 에 독립 — Admin UI 에만 영향)

7f 독립 (템플릿만)
```

권장 실행 순서: **7b → 7a, 7d, 7f (병렬) → 7c-pre → 7c → 7e → 7g**.

- `7c-pre` 독립 단계 분리 (Codex REVISE 반영) — shim 완성 후 `npm test` 95건 전수 통과를 gate 로 삼아 7c 착수. 회귀 위험 최소화.
- `7c` 는 `7b` 의 identity 개념 + `7c-pre` 의 shim 이 자리잡은 후 진행.
- `7e` 는 `7c` 이후 진행해야 stream 도 토큰별 분리 가능.

---

## 6. 보안 설계

### 6.1 MCP 토큰 (7b)
- 파일 저장 값은 **`crypto.scrypt` 해시** (Codex REVISE 반영) — Node 내장, 외부 의존성 0, MCP 토큰 검증은 요청당 1회로 저빈도이므로 파라미터 튜닝 여지 충분 (N=2^15, r=8, p=1 기준)
- 런타임 lookup 은 scrypt + `crypto.timingSafeEqual` (constant-time)
- 원본은 발급 시 UI 에서 1회만 노출, 다시 볼 수 없음
- **Plaintext 분실 시 복구 경로**: "Revoke + Re-issue" 원클릭 + 이전 토큰을 사용하던 MCP 클라이언트 재설정 체크리스트 문서화 (`docs/TOKEN_RECOVERY.md`). plaintext 복구는 불가함을 UI 에 명시
- Token rotation: Admin UI 에 "Revoke + Issue New" 원클릭
- 환경변수 `BIFROST_MCP_TOKENS` 는 해시 없이 직접 등록 가능 (운영자 편의) — Admin UI 에 "⚠ 환경변수 기반 토큰은 해시되지 않음" 배지
- **Legacy `BIFROST_MCP_TOKEN` (단수)**: identity = `"legacy"` 로 resolve. `allowedWorkspaces` 는 **모든 워크스페이스**, `allowedProfiles` 는 `["*"]` (전체 허용) 을 기본값으로 — 기존 배포의 기대값 유지. Admin UI 에 "legacy 토큰이 활성 상태입니다. 새 토큰으로 이관 권장" 배너

### 6.2 ACL 이중강제 (Codex REVISE 반영 — 실제 코드 경로 명시)
현재 `server/mcp-handler.js:74` 의 `tools/call` 경로에는 **ACL 재검증이 없음**. 이 한 지점이 계획 전체의 보안 기반이라 명시적으로 구현:
- **1차 필터**: `tool-registry.getTools({ identity, profile })` — tools/list 응답에서 제외 (노출 차단)
- **2차 검증** (필수): `mcp-handler.handleToolsCall({ identity, toolName })` 에서:
  ```
  const entry = toolRegistry.reverseLookup(toolName);
  if (!entry) return error -32601;
  if (!identity.allowedWorkspaces.includes(entry.workspaceId)) return error -32600 (Unauthorized);
  if (profile && !profile.matches(toolName)) return error -32600;
  ```
  — tools/list 를 우회해 이름을 추측/복사하는 공격 차단
- `resources/list`, `resources/read`, `prompts/list`, `prompts/get` 에도 동일 패턴 (누락 방지용 공통 헬퍼 `assertAllowed(identity, profile, workspaceId, toolName?)` 추출)
- 7b 구현 PR 은 `mcp-handler` 의 모든 call-site 에서 `assertAllowed` 호출되는지 grep 검증을 PR 체크리스트에 포함

### 6.3 OAuth 격리 (7c)
- A identity 가 B 의 refresh_token 을 **읽거나 사용 불가** — `getValidAccessToken` 은 `byIdentity[callContext.identity]` 만 lookup
- Admin UI 에서 다른 identity 의 token prefix 는 관리자에게만 노출, 일반 요청에는 노출 안 됨 (admin 경로와 MCP 경로 분리)

### 6.4 SSE stream (7e)
- GET stream 은 POST 와 동일 Authorization 요구
- stream 내부로 들어오는 JSON-RPC 요청 (서버→클라이언트 `elicitations` 등) 은 현재 spec 지원 범위 밖 — **수신 시 drop + debug 로그**
- 401 재연결 시 exponential backoff 로 zombie 트래픽 방지

### 6.5 Usage / audit 파일 (7g)
- chmod 0600, `.ao/state/` 이미 gitignored
- 로그 sanitize 는 Phase 6 의 `oauth-sanitize.js` 재사용 — audit details 에 토큰 유출 금지
- `/api/usage`, `/api/audit` 는 Admin 토큰 보호

### 6.6 위협 모델 추가 항목
| 위협 | 대응 |
|------|------|
| 유출된 MCP 토큰으로 타인 OAuth 토큰 접근 시도 | identity 가 로컬 OAuth 토큰과 매핑 안 됨 → fail 또는 명시적 authorize 요구 |
| 악성 클라이언트가 `?profile=admin` 스푸핑 | profile 은 ACL 완화가 아닌 **추가 제약** 으로만 동작 (화이트리스트 교집합) |
| Upstream 이 무한 SSE 로 DoS | stream 당 메모리 cap + 이벤트 수 cap + 비정상 종료 시 rate-limited 재연결 |

---

## 7. 테스트 전략

### 7.1 단위 (목표 +40 tests)
- **7a**: 5 — glob 매칭 (`*`, prefix, suffix), 없는 프로필, 프로필 합성
- **7b**: 8 — bcrypt round-trip, resolve 성공/실패, ACL 필터, 해시 마이그레이션, 환경변수 주입
- **7c**: 10 — byIdentity migration, 2-identity authorize flow, per-identity mutex 독립, identity 삭제 시 tokens 만 제거, legacy read
- **7d**: 2 — 수동 폼 → registerManual → completeAuthorization
- **7e**: 7 — stream 파싱, 재연결 backoff, 401 재연결, notification 전파, Mcp-Session-Id 헤더, 비정상 이벤트 drop
- **7f**: 3 — 새 템플릿 materialize (github/linear/drive)
- **7g**: 5 — record 집계, rotation 트리거, 동시 write 안전성, audit tail 필터

### 7.2 End-to-end (기존 mock OAuth 서버 확장)
- Mock 에 `/register` 를 선택적으로 비활성화 (7d 검증) — 이미 구현됨
- Mock 에 `/stream` GET endpoint 추가 (7e)
- Mock 을 **멀티 사용자 모드** 로 확장 (7c): identity 별로 다른 access_token 반환 시뮬레이션
- E2E 시나리오:
  1. 2 MCP 토큰 발급 → 각 토큰이 같은 워크스페이스에 authorize → 서로 다른 토큰 사용 확인
  2. Profile=read-only 로 tools/list → 쓰기 도구 제외 확인
  3. Upstream 이 `tools/list_changed` → 다운스트림 클라이언트가 `/sse` 로 notification 수신

### 7.3 수동 E2E (Notion + GitHub 실계정)
- `docs/PHASE7_E2E_CHECKLIST.md` 생성 — 14 항목:
  - MCP 토큰 2개 발급 → 각각 Notion authorize → 서로 격리 확인
  - GitHub OAuth 템플릿으로 실제 연결
  - Usage 탭에서 호출 카운트 증가 확인
  - Audit 탭에서 `oauth.authorize_complete` 검색 동작 확인
  - Windows 에서 Usage/Audit JSONL 생성 후 권한 경고 배너 유지 확인

### 7.4 회귀
- Phase 6 테스트 95건 모두 PASS 유지
- 기존 `BIFROST_MCP_TOKEN` (단수) legacy 경로 smoke 테스트 추가

---

## 8. 리스크 & 완화

| ID | 리스크 | 영향 | 대응 |
|----|--------|------|------|
| R1 | `ws.oauth.tokens` → `byIdentity.default.tokens` migration 중 crash 시 토큰 손실 | High | migration 은 atomic write (기존 `_save()` 패턴 재사용), backup 유지, migration 전용 test 3건 |
| R2 | SSE stream 구독이 Notion 실제 서버에서 어떻게 동작하는지 미확인 — 6-pre 와 유사한 사전 probe 필요 | High | **7e-pre**: `GET /mcp` + `Mcp-Session-Id` 실제 응답 probe → `docs/NOTION_STREAM_PROBE.md` 생성 후 착수 |
| R3 | bcrypt 의존성 추가 | Low | node:crypto 의 `scrypt` 사용으로 대체 (외부 의존성 0) — 퍼포먼스 동등 |
| R4 | Usage JSONL 이 커져 disk 포화 | Medium | 10MB + 일자 rotation + 30일 TTL + 부팅 시 purge |
| R5 | Multi-token 등록된 워크스페이스의 warm-up 이 identity 없이 돌아 refresh 실패 audit 폭증 | Medium | warm-up 은 identity=null 인 경우 skip, tokens 존재 여부만 체크 |
| R6 | profile glob 패턴이 공격자에게 도구 이름 열거 수단 제공 | Low | tools/list 응답만 필터링, 존재하지 않는 도구 호출은 기존 경로로 `-32601` |
| R7 | Admin UI 의 Token 발급 시 plaintext 표시 후 사용자가 놓침 → 재발급 스트레스 | Low | "복사 완료 후 체크박스 확인 → 닫기" 강제 UX |
| R8 | MCP spec 의 `Mcp-Session-Id` 해석이 Notion 실제 구현과 어긋남 | Medium | 7e-pre 의 probe 결과를 fallback 로직으로 반영 (세션 없음 → non-resumable stream) |
| R9 | config `fs.watch()` hot-reload 가 byIdentity migration 중 파일을 재로드해 부분 상태로 덮어쓸 위험 | High | migration 을 `_writeLock` 체인 내부에서 수행, 완료 전 watcher 이벤트 무시 (in-progress 플래그). `_startFileWatcher` 는 migration 완료 후 호출 |
| R10 | `.ao/state/usage.jsonl` / `audit.jsonl` append 의 동시성 — 멀티 writer 또는 rotation 전환점에서 라인 깨짐 | Medium | 단일 `usage-recorder` / `audit-logger` 인스턴스가 큐잉된 write 를 직렬화 (`writeLock = writeLock.then(appendBatch)`). 프로세스는 1개 전제 (멀티 프로세스 시 advisory lock 는 Phase 8) |
| R11 | Legacy `BIFROST_MCP_TOKEN` 에서 복수 토큰으로 전환 시 `identity="legacy"` 의 권한 범위가 모호 | Medium | 6.1 에 정의 — `allowedWorkspaces=*`, `allowedProfiles=*` 기본. Admin UI 에 이관 권장 배너. 테스트로 legacy 경로 smoke 유지 |
| R12 | 발급 시 1회 노출된 plaintext 토큰을 운영자가 놓치면 복구 불가 | Low | UI 는 "복사 완료 체크박스" 강제 + 닫기 전 확인 다이얼로그. `docs/TOKEN_RECOVERY.md` 에 "revoke + re-issue" 절차 문서화. plaintext 복구 시도는 설계상 불가임을 명시 |
| R13 | 7c 의 per-identity mutex 키 확장이 Phase 6 의 기존 per-workspace mutex 테스트와 경합 | Medium | default identity 는 mutex 키 `${wsId}::default` 로 통일, 기존 테스트가 기대하는 coalescing 동작 유지. 7c-pre 의 회귀 테스트 gate 에서 검증 |
| R14 | `_computeStatus` 의 단일 `oauthActionNeeded` 가 per-identity 환경에서 UX 왜곡 (한 identity 만 문제인데 전체 ws 가 action_needed 로 표시) | Medium | 7c-pre 에서 `oauthActionNeededBy: { [identity]: true }` 로 전환. Dashboard 는 "any true → action_needed + 영향 identity 목록 병기" |

---

## 9. 성공 기준

- [ ] 2개 이상의 MCP 토큰이 같은 워크스페이스에 각각 독립 OAuth 로 authorize 가능
- [ ] A 토큰은 Notion-work 만, B 토큰은 Linear-work 만 접근하는 ACL 정책이 Admin UI 로 설정됨
- [ ] `?profile=read-only` 로 호출 시 쓰기 도구가 tools/list 에서 제외
- [ ] Notion 상위 서버가 `tools/list_changed` 발송 시 ≤ 3초 내 클라이언트에 브로드캐스트
- [ ] DCR 미지원 mock 서버도 Wizard UI 로 수동 client_id 입력 후 authorize 완료
- [ ] GitHub / Linear 템플릿으로 원클릭 OAuth 연결 가능
- [ ] Usage 탭에서 7일 상위 10 도구 + 토큰별 호출량 조회 가능
- [ ] Audit JSONL 에 `oauth.refresh_success` 가 `grep` 가능한 형태로 누적
- [ ] 95 → 135+ tests PASS
- [ ] Phase 6 의 E2E 체크리스트 전체 여전히 동작
- [ ] README 에서 Single-User 경고를 **선택사항** 으로 전환 (multi-tenant 지원 명시)
- [ ] Legacy `BIFROST_MCP_TOKEN` (단수) 환경변수는 여전히 동작 (backwards-compat)

---

## 10. 일정 추정

| 단계 | 기간 | 의존성 |
|------|------|--------|
| 7e-pre (stream probe) | 0.5일 | — |
| 7a | 1일 | — |
| 7b | 1.5일 | — |
| 7d | 0.5일 | 7b 이후 UI 붙이기 |
| 7f | 0.5일 | — |
| **7c-pre (migration shim)** | **1일** | **7b** |
| 7c | 2일 | 7c-pre |
| 7e | 2일 | 7c + 7e-pre |
| 7g | 2일 | 7b |
| 통합 + 회귀 + 수동 E2E | 1일 | 모두 |
| **버퍼 (Codex REVISE 반영)** | **1일** | 7c+7e+7g 교차 복잡도 |
| **총** | **13일** | |

Phase 6 (8.5일) 대비 +4.5일 — 멀티테넌시는 저장구조/인증/스트림/관측이 교차하고 `7c-pre` migration shim 을 독립 단계로 분리. Codex 교차 리뷰에서 "10~11일은 낙관적, 최소 2일 버퍼 필요" 지적을 반영해 7c-pre 1일 + 일반 버퍼 1일 추가.

---

## 11. 후속 / 확장 (Phase 8+)

- Admin UI SSO (Google Workspaces / GitHub 조직)
- 토큰 발급 자동 만료 / 로테이션
- Rate limiting / per-token quota 강제
- OS keychain 기반 OAuth 토큰 암호화
- Tool-level 권한 (읽기/쓰기 분류 자동화 + per-token 쓰기 승인 워크플로)
- resources/* 및 prompts/* 서브스크립션
- Per-tool 요청 변환 (input schema filtering, output redaction)

---

## 12. 진행 확인

이 계획서 기준으로 Phase 7 착수 가능.

**Codex 교차 리뷰 (2026-04-15, 판정: REVISE) 반영 완료**:
- 7c-pre 독립 단계 분리 (migration shim, 회귀 0 을 gate)
- MCP 토큰 해시는 `crypto.scrypt` 로 확정 (의존성 0)
- ACL 이중강제의 실제 코드 경로 (`server/mcp-handler.js:74`) 명시 + `assertAllowed` 공통 헬퍼
- 리스크 R9~R14 추가 (hot-reload×migration race, JSONL 동시성, legacy 토큰 권한 정의, plaintext 분실 복구 UX, mutex 키 확장 호환성, per-identity 상태 UX)
- 일정 10~11일 → 13일 (7c-pre 1일 + 버퍼 1일)
- `oauthActionNeeded` → `oauthActionNeededBy` per-identity map 으로 전환 선행

**남은 사용자 결정 항목 (소규모)**:
1. Usage JSONL 보관 기간 — 30일 기본, 조정 여부
2. Profile 정의 위치 — `config/workspaces.json` 내부 (추천) vs 별도 `config/profiles.json`
3. 추가 provider 템플릿 (GitHub / Linear / Google Drive) 중 제외할 것

승인 후 **7e-pre (stream probe)** → **7b (토큰 매니저 foundation)** → **7a/7d/7f 병렬** → **7c-pre (migration shim)** → **7c (identity 격리)** → **7e (stream subscription)** → **7g (observability)** 순서로 시작합니다.
