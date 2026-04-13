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

독립적인 관리 웹 인터페이스 (:3101 또는 같은 포트의 /admin).
SPA로 구현, 빌드 스텝 없이 vanilla HTML/CSS/JS.

#### 화면 구성

**1. Dashboard (메인)**
- 연결된 워크스페이스 카드 그리드 (provider 아이콘 + alias + 상태 뱃지)
- 상태 뱃지: `● Connected` (green) / `● Expired` (amber) / `● Error` (red) / `○ Disabled` (gray)
- 카드 클릭 → 상세/편집 패널
- 우측 상단 "+ Add Workspace" 버튼
- 빈 상태(워크스페이스 0개)일 때 → Setup Wizard로 자동 진입

**2. Setup Wizard (온보딩)**
첫 실행 또는 워크스페이스가 없을 때 표시되는 단계별 가이드:

```
Step 1: Provider 선택
  → Notion / Slack / (추후 확장) 카드 UI로 선택

Step 2: 워크스페이스 정보 입력
  → alias (영문, URL-safe), displayName (자유)
  → Provider별 필수 필드 자동 표시
    - Notion: Integration Token (+ 발급 가이드 링크)
    - Slack: Bot Token + Team ID (+ 발급 가이드 링크)

Step 3: 연결 테스트
  → "Test Connection" 버튼 → healthCheck 실행
  → 성공: ✓ 연결됨 + 접근 가능한 리소스 요약 (e.g., "12 pages accessible")
  → 실패: 구체적 에러 메시지 + 해결 가이드
    - 401: "토큰이 유효하지 않습니다. [토큰 재발급 →]"
    - 403: "권한이 부족합니다. Notion Integration에 페이지 공유가 필요합니다. [설정 방법 →]"
    - Network: "서버에 연결할 수 없습니다. URL과 네트워크를 확인하세요."

Step 4: 완료
  → 노출될 도구 이름 미리보기 (e.g., notion_personal__search_pages)
  → "Add Another Workspace" / "Go to Dashboard"
```

**3. Workspace Detail (편집)**
- 기본 정보 수정 (alias, displayName)
- 토큰 갱신 (마스킹 표시, 변경 시에만 입력)
- 연결 상태 + 마지막 health check 시간
- "Test Connection" 버튼
- 노출 도구 목록 (체크박스로 개별 도구 활성화/비활성화)
- Enable/Disable 토글
- 삭제 (확인 다이얼로그 필수)

**4. Tools Overview**
- 전체 워크스페이스의 노출 도구를 한눈에 보는 테이블
- 컬럼: Provider | Workspace | Tool Name | MCP Name | Status
- 검색/필터 지원
- 각 도구의 inputSchema를 펼쳐볼 수 있는 accordion

**5. Connect Guide (연동 가이드)**
- 현재 서버 상태 (port, tunnel URL 등) 표시
- 연동 대상별 탭:
  - **claude.ai**: Tunnel URL 원클릭 복사 + 스크린샷 포함 단계별 안내
  - **Claude Code**: `.mcp.json` 설정 코드블록 + 복사 버튼
  - **기타**: 일반 MCP 엔드포인트 정보

#### UX 원칙

- **에러는 해결책과 함께**: 모든 에러 메시지에 "왜 발생했는지 + 어떻게 해결하는지" 포함
- **위험 동작은 확인 필수**: 삭제, 토큰 변경 시 확인 다이얼로그
- **상태는 항상 시각적으로**: 연결 상태를 색상 뱃지로 즉시 인지 가능
- **복사 가능한 모든 값**: URL, 토큰(마스킹), 도구 이름 등 클릭 투 카피
- **Progressive disclosure**: 기본 뷰는 단순하게, 상세 정보는 펼쳐서 확인

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

### Phase 1 — Core + Minimal Admin
- [ ] MCP 프로토콜 핸들러 (Streamable HTTP + SSE)
- [ ] Workspace manager + tool registry
- [ ] Notion provider (search, read page, list databases)
- [ ] Slack provider (search messages, read channel, list channels)
- [ ] 기본 설정 파일 로딩
- [ ] Admin REST API (CRUD workspaces, health check)
- [ ] Admin UI — Dashboard + Setup Wizard + Workspace Detail
- [ ] 토큰 유효성 검증 + health check (연결 테스트 버튼)
- [ ] 에러 메시지에 해결 가이드 포함

### Phase 2 — Auth & Connect Guide
- [ ] OAuth flow 지원 (Notion — 토큰 수동 입력 대체)
- [ ] OAuth flow 지원 (Slack — Bot Token 자동 발급)
- [ ] Admin UI — Connect Guide 탭 (claude.ai, Claude Code 연동 안내)
- [ ] Admin UI — Tools Overview (전체 도구 테이블 + 검색)
- [ ] 워크스페이스별 도구 필터링 (개별 도구 활성화/비활성화)

### Phase 3 — Tunnel & Distribution
- [ ] Cloudflare Tunnel 통합
- [ ] Connect Guide에 Tunnel URL 자동 반영 + 원클릭 복사
- [ ] Claude Code .mcp.json 자동 생성 기능
- [ ] Palantir Console 연동 가이드

### Phase 4 — Advanced
- [ ] 추가 provider (Google Drive, GitHub, Linear, ...)
- [ ] 사용량 로깅 / audit trail
- [ ] 토큰 자동 갱신 (OAuth refresh)
- [ ] 설정 export/import (환경 간 이동)
- [ ] 워크스페이스 삭제 undo (soft delete + 30일 보관)

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
