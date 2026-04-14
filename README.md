# MCP Bifrost

Multi-workspace MCP bridge — 임의의 MCP 서버(stdio/HTTP/SSE)를 단일 엔드포인트로 통합하는 범용 허브.

```
[Filesystem MCP] ──┐
[GitHub MCP]     ──┤
[Notion (공식)]   ──┼→ MCP Bifrost (HTTPS) ←→ claude.ai / Claude Code / Palantir
[회사 Slack]     ──┤      :3100
[Linear]         ──┘
```

## 왜 Bifrost?

- **MCP 서버 1개당 클라이언트 1개 제약**을 우회 — 한 곳에 다 모아서 단일 엔드포인트로 노출
- **같은 MCP 서버를 여러 토큰/계정으로** 동시 등록 (개인 GitHub + 회사 GitHub)
- **네임스페이스로 충돌 방지**: `github_personal__create_issue` vs `github_work__create_issue`
- **claude.ai 원격 커넥터** 호환 (SSE), Claude Code `.mcp.json` 자동 생성

## Quick Start

```bash
npm install
npm start
# → http://localhost:3100/admin/  (Setup Wizard 자동 진입)
```

상세 사용법은 **[docs/USAGE.md](docs/USAGE.md)** 참고.

## Architecture

```
server/
  index.js              — HTTP/SSE 서버 진입점 (단일 포트 :3100)
  mcp-handler.js        — MCP JSON-RPC (initialize, tools/list, tools/call, resources/*)
  workspace-manager.js  — 워크스페이스 CRUD, 원자적 쓰기, hot reload, 5단계 상태
  tool-registry.js      — 네임스페이스 + 역방향 lookup 테이블
  sse-manager.js        — SSE 세션 + notifications/tools/list_changed broadcast

providers/
  base.js               — Provider 추상 인터페이스
  mcp-client.js         — 범용 MCP 클라이언트 (stdio/http/sse) ★ 1등 시민
  notion.js             — Notion REST 어댑터 (legacy)
  slack.js              — Slack REST 어댑터 (legacy)

admin/
  auth.js               — Admin/MCP 토큰 검증, command whitelist
  routes.js             — REST API + 정적 파일 서빙
  public/               — Vanilla SPA (Login, Wizard, Dashboard, Detail, Tools, Connect)

scripts/
  tunnel.js             — Cloudflare Tunnel 통합 + .mcp.json 자동 생성

tests/
  fixtures/mock-mcp-server.js — 테스트용 stdio MCP 서버
  *.test.js                   — 60개 테스트 (node --test)
```

## 주요 개념

| 개념 | 설명 |
|------|------|
| **kind** | `mcp-client`(범용) 또는 `native`(Notion/Slack 직접 어댑터, legacy) |
| **transport** | mcp-client 의 연결 방식: `stdio` / `http` / `sse` |
| **namespace** | MCP 도구 이름의 일부, **불변** (`github_personal__create_issue` 의 `personal`) |
| **alias / displayName** | UI 표시용, 자유 변경 |
| **toolFilter** | 워크스페이스별 도구 화이트리스트 |
| **profile** | `/mcp?profile=read-only` 처럼 클라이언트별 도구셋 제한 |

## Status

- ✅ MCP 프로토콜 (Streamable HTTP + SSE)
- ✅ 범용 MCP 클라이언트 (stdio/HTTP/SSE)
- ✅ 워크스페이스 CRUD + soft delete + restore + 마이그레이션
- ✅ 5단계 상태 (Healthy/Limited/Action Needed/Error/Disabled)
- ✅ 자동 재시작 + exponential backoff
- ✅ Admin UI (Wizard, Dashboard, Detail, Tools Overview, Connect Guide)
- ✅ 템플릿 라이브러리 (Filesystem, GitHub, Notion, ...)
- ✅ Cloudflare Tunnel + .mcp.json 자동 생성
- ✅ 60 tests passing

## License

MIT
