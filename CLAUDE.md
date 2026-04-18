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
