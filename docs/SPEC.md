# MCP Bifrost — Specification

> Multi-workspace MCP bridge. 여러 Notion, Slack 등의 워크스페이스를 단일 MCP 엔드포인트로 통합하는 독립 서비스.

## Problem

- MCP 서버(Notion, Slack 등)는 워크스페이스 1개만 연결 가능
- 여러 조직/개인+회사 워크스페이스를 동시에 접근하려면 매번 계정 전환 필요
- claude.ai 웹/앱에서는 로컬 stdio MCP가 구조적으로 불가 → remote connector 필수

## Solution

Bifrost는 **멀티 테넌트 MCP 래퍼 서버**로, 다수의 워크스페이스 자격증명을 관리하고 MCP 프로토콜로 통합 노출한다.

```
[Notion WS-A] ──┐
[Notion WS-B] ──┤
                ├→  MCP Bifrost (HTTPS)  ←→  claude.ai / Claude Code / Palantir Console
[Slack WS-A]  ──┤       :3100
[Slack WS-B]  ──┘
```

## Architecture

### Core Components

```
mcp-bifrost/
  server/
    index.js              — 진입점, HTTP/SSE 서버
    mcp-handler.js        — MCP 프로토콜 핸들러 (tools/list, tools/call, resources/list)
    workspace-manager.js  — 워크스페이스 등록/상태/토큰 관리
    tool-registry.js      — 워크스페이스별 도구를 네임스페이스로 등록/노출
  providers/
    base.js               — Provider 인터페이스 (abstract)
    notion.js              — Notion API 중계 provider
    slack.js               — Slack API 중계 provider
  admin/
    index.js              — 관리 UI 서버 (SPA)
    api.js                — 관리 REST API
    public/               — 관리 UI 프론트엔드
  config/
    workspaces.json       — 워크스페이스 설정 (gitignored, 토큰 포함)
    workspaces.example.json — 예시 설정
  scripts/
    tunnel.js             — Cloudflare Tunnel 자동 연결
  tests/
  docs/
```

### Provider System

각 서비스(Notion, Slack, ...)는 Provider로 추상화된다.

```js
// providers/base.js
class BaseProvider {
  constructor(workspaceConfig) {}

  // MCP tools/list 에 노출할 도구 정의
  getTools() → [{ name, description, inputSchema }]

  // MCP tools/call 핸들러
  callTool(toolName, args) → result

  // 연결 상태 확인
  healthCheck() → { ok, message }

  // 토큰 유효성 검증
  validateCredentials() → boolean
}
```

### Tool Namespacing

워크스페이스별 도구 이름 충돌 방지:

```
Provider: Notion
Workspace: "personal"
Tool: search_pages

→ 노출 이름: notion_personal__search_pages
```

패턴: `{provider}_{workspace_alias}__{tool_name}`

### MCP Protocol Support

Bifrost가 구현하는 MCP 메서드:

| Method | 설명 |
|--------|------|
| `initialize` | 핸드셰이크, 서버 capabilities 선언 |
| `tools/list` | 모든 워크스페이스의 도구를 네임스페이스와 함께 반환 |
| `tools/call` | 네임스페이스에서 워크스페이스를 식별하고 해당 provider에 라우팅 |
| `resources/list` | 워크스페이스 목록/상태를 리소스로 노출 (optional) |

### Transport

- **Streamable HTTP** (MCP 2025-03-26 spec) — primary
- **SSE** (legacy 호환) — claude.ai remote connector용
- **stdio** — Claude Code 로컬 직접 연결용 (optional)

### Admin UI

독립적인 관리 웹 인터페이스 (:3101 또는 같은 포트의 /admin):

- 워크스페이스 목록 (provider별 그룹)
- 각 워크스페이스 연결 상태 (healthy / expired / error)
- 워크스페이스 추가/수정/삭제
- 토큰 갱신 (OAuth flow 또는 수동 입력)
- 연결 테스트 (health check)
- 도구 목록 미리보기 (어떤 이름으로 노출되는지)

### Security

- `workspaces.json`은 gitignored — 토큰 절대 커밋 금지
- Admin UI 접근은 `BIFROST_ADMIN_TOKEN`으로 보호
- Cloudflare Tunnel 사용 시 외부 노출은 MCP 엔드포인트만 (admin은 로컬 전용)
- 각 provider 토큰은 최소 권한 원칙 (read-only 우선)

### Tunnel Integration

```bash
# 개발/개인 사용: Cloudflare Tunnel로 공인 HTTPS 노출
npm run tunnel
# → https://bifrost-xxxx.trycloudflare.com

# 이 URL을 claude.ai remote connector로 등록
```

고정 도메인 설정도 지원 (Cloudflare 무료 플랜).

## Configuration

### workspaces.json

```json
{
  "workspaces": [
    {
      "id": "notion-personal",
      "provider": "notion",
      "alias": "personal",
      "displayName": "개인 Notion",
      "credentials": {
        "token": "ntn_xxx"
      },
      "enabled": true
    },
    {
      "id": "slack-company",
      "provider": "slack",
      "alias": "company",
      "displayName": "회사 Slack",
      "credentials": {
        "botToken": "xoxb-xxx",
        "teamId": "T0001"
      },
      "enabled": true
    }
  ],
  "server": {
    "port": 3100,
    "adminPort": 3101,
    "adminToken": "your-secret-token"
  },
  "tunnel": {
    "enabled": false,
    "fixedDomain": ""
  }
}
```

## Roadmap

### Phase 1 — Core
- [ ] MCP 프로토콜 핸들러 (Streamable HTTP + SSE)
- [ ] Workspace manager + tool registry
- [ ] Notion provider (search, read page, list databases)
- [ ] Slack provider (search messages, read channel, list channels)
- [ ] 기본 설정 파일 로딩

### Phase 2 — Admin & Auth
- [ ] Admin REST API (CRUD workspaces)
- [ ] Admin UI (워크스페이스 관리)
- [ ] 토큰 유효성 검증 + health check
- [ ] OAuth flow 지원 (Notion, Slack)

### Phase 3 — Tunnel & Distribution
- [ ] Cloudflare Tunnel 통합
- [ ] claude.ai remote connector 등록 가이드
- [ ] Claude Code .mcp.json 설정 가이드
- [ ] Palantir Console 연동 가이드

### Phase 4 — Advanced
- [ ] 추가 provider (Google Drive, GitHub, Linear, ...)
- [ ] 워크스페이스별 도구 필터링 (일부 도구만 노출)
- [ ] 사용량 로깅 / audit trail
- [ ] 토큰 자동 갱신 (OAuth refresh)

## Integration Points

### claude.ai (Remote Connector)
Settings → Connectors → Add Custom Connector → Bifrost URL 등록

### Claude Code (.mcp.json)
```json
{
  "mcpServers": {
    "bifrost": {
      "url": "https://bifrost-xxxx.trycloudflare.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

### Palantir Console
프로젝트/에이전트 설정에서 Bifrost 엔드포인트를 MCP 서버로 등록.
PM/Worker가 `notion_personal__search_pages`, `slack_company__send_message` 등 네임스페이스된 도구를 자연스럽게 호출.
