# CLAUDE.md

MCP Bifrost — 여러 Notion, Slack 등의 워크스페이스를 단일 MCP 엔드포인트로 통합하는 멀티 워크스페이스 브릿지 서비스. 이름은 북유럽 신화의 비프로스트(세계를 잇는 무지개 다리)에서 따왔다.

## Commands

```bash
npm install          # 의존성 설치
npm start            # 서버 시작 (localhost:3100)
npm run dev          # 개발 서버 (--watch)
npm test             # 전체 테스트 실행 (node --test)
npm run tunnel       # Cloudflare Tunnel 연결
```

## Architecture

Node.js ESM + MCP SDK. 빌드 스텝 없음.

```
server/
  index.js              — 진입점, HTTP/SSE 서버
  mcp-handler.js        — MCP 프로토콜 핸들러
  workspace-manager.js  — 워크스페이스 등록/상태/토큰 관리
  tool-registry.js      — 네임스페이스 기반 도구 레지스트리
providers/
  base.js               — Provider 인터페이스 (abstract)
  notion.js             — Notion API 중계
  slack.js              — Slack API 중계
admin/
  index.js              — 관리 UI 서버
  api.js                — 관리 REST API
  public/               — 관리 UI 프론트엔드
config/
  workspaces.json       — 워크스페이스 설정 (gitignored, 토큰 포함)
  workspaces.example.json — 예시 설정
```

## Key Concepts

### Provider System
각 서비스(Notion, Slack 등)는 BaseProvider를 확장하는 provider로 구현.
`getTools()`, `callTool()`, `healthCheck()`, `validateCredentials()` 인터페이스.

### Tool Namespacing
워크스페이스별 도구 충돌 방지: `{provider}_{alias}__{tool_name}`
예: `notion_personal__search_pages`, `slack_work__send_message`

### Transport
- Streamable HTTP (MCP 2025-03-26 spec) — primary
- SSE — claude.ai remote connector 호환
- stdio — Claude Code 로컬 직접 연결 (optional)

### Retry & Backoff
`mcp-handler.js`의 `_toolsCall`은 transient 에러(connectivity, rate_limit, provider_outage) 시 최대 2회 재시도 + 지수 백오프(1s → 2s, cap 5s). 429 응답의 `Retry-After` 헤더가 있으면 해당 값을 우선 사용. 최악의 경우 단일 tool call이 ~11초 점유할 수 있음. 비동기 큐 분리는 Phase 9 후보.

### OAuth Client Isolation (Phase 10a — 완료 2026-04-22, Phase 11 후속 완료)
같은 OAuth issuer 에 여러 workspace 연결 시 발생하던 refresh-token supersede 401 루프 해소:
- `OAuthManager._clientCache` 키가 `${workspaceId}::${issuer}::${authMethod}` — workspace 단위 DCR 격리
- `_workspaceMutex` (rotation ↔ completeAuthorization 직렬화) + `_identityMutex` (refresh ↔ markAuthFailed 직렬화) FIFO chain — **acquisition order: workspace → identity**
- `workspaces.json` 의 `ws.oauth.client.*` nested 구조 (Phase 11 에서 평면필드 mirror 제거됨)
- 마이그레이션: `node scripts/migrate-oauth-clients.mjs --dry-run | --apply | --restore` (`.pre-10a.bak` 자동 생성, `0o600`). Phase 11 부터 `report.flatScrubbed` 항목도 출력.
- Phase 11 `admin/routes.js._rotateClientAndInvalidate` 헬퍼로 3개 rotation 경로 통합 — pending purge 를 `_workspaceMutex` critical section 안에서 처리해 same-client manual rotation stale-callback window 닫음
- 상세: `docs/OAUTH_CLIENT_ISOLATION_PLAN.md`, `docs/PHASE10a_SELFREVIEW_LOG.md`

## Security

- `config/workspaces.json`은 gitignored — 토큰 절대 커밋 금지
- Admin UI는 `BIFROST_ADMIN_TOKEN`으로 보호
- Tunnel 사용 시 MCP 엔드포인트만 외부 노출, admin은 로컬 전용
- Provider 토큰은 최소 권한 원칙 (read-only 우선)

## Style Guidelines

- 한국어 사용 (코드 주석/변수명은 영어)
- ESM (import/export)
- 테스트: Node.js built-in test runner (`node --test`)

## Spec

전체 기획: `docs/SPEC.md`

## Phase 이력 (완료된 것만)

- Phase 6 — OAuth 2.0 remote MCP (PKCE/DCR/refresh rotation)
- Phase 7 — Multi-tenant `byIdentity` 격리 + 다중 MCP 토큰 + 프로필
- Phase 8 — Admin UI 확장 + usage/audit 집계
- Phase 9 — 관측성 + (상세 `docs/PHASE9_PLAN.md`)
- **Phase 10a** — OAuth Client Isolation (2026-04-22 완료, Codex R11 APPROVE)
- **Phase 11** — Follow-ups (2026-04-22 완료): R10 regression test instrumentation, rotate-client helper consolidation (`_rotateClientAndInvalidate`), flat-field mirror 완전 제거 (Phase 10a §3.4 deprecation window close)

다음 세션 시작 시 `docs/NEXT_SESSION.md` 참고.
