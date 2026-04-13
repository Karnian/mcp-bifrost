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
    api.js                — 관리 REST API (인증 미들웨어 포함)
    auth.js               — Admin 토큰 인증 (env > config fallback)
    public/               — 관리 UI 프론트엔드 (Login, Dashboard, Wizard, Detail, ...)
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

  // 실제 사용 가능 범위 검사 (scope, 접근 가능 리소스, 도구별 usable 판정)
  capabilityCheck() → {
    scopes: [...],           // 부여된 권한 목록
    resources: { count, samples },  // 접근 가능 리소스 수 + 샘플
    tools: [{ name, usable, reason }] // 도구별 사용 가능 여부
  }
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

#### Workspace 상태 모델

단순 Connected/Error 이분법이 아닌, 실제 운영 상태를 반영하는 5단계:

| 상태 | 뱃지 | 의미 | 자동 전환 조건 |
|------|------|------|---------------|
| `Healthy` | `●` green | 토큰 유효 + 전체 도구 사용 가능 | capabilityCheck 전체 통과 |
| `Limited` | `◐` amber | 연결됨, 일부 도구/리소스 제한 | capabilityCheck에서 일부 도구 usable=false |
| `Action Needed` | `▲` orange | 토큰 만료 임박, scope 부족, 권한 변경 감지 | 만료 7일 전, scope 불일치 감지 |
| `Error` | `●` red | 연결 실패 또는 토큰 무효 | healthCheck 실패 |
| `Disabled` | `○` gray | 사용자가 수동 비활성화 | enabled: false |

상태 뱃지는 **색상 + 아이콘 + 텍스트 레이블** 병행 (색각 접근성 보장).

#### 에러 분류 체계

에러를 HTTP 상태 코드가 아닌 **원인 유형**으로 분류하고, 각 에러에 표준 UI 구조 적용:

| 분류 | 예시 | 사용자 액션 | 재시도 |
|------|------|-----------|--------|
| **Credential** | 토큰 무효, 만료 | 토큰 재발급/갱신 | 수동 |
| **Permission** | scope 부족, 리소스 미공유 | 외부 서비스 설정 변경 (토큰 문제 아님을 명시) | 수동 |
| **Connectivity** | 네트워크 단절, DNS 실패 | 네트워크 확인 | 자동 재시도 (backoff) |
| **Provider Outage** | Notion/Slack API 장애 | 대기 | 자동 재시도 (5분 간격) |
| **Config Conflict** | alias 중복, 포트 충돌 | 설정 수정 | 즉시 (수정 후) |
| **Rate Limit** | 429 Too Many Requests | 대기 (countdown 표시) | 자동 (Retry-After 헤더) |
| **Internal** | 파일 쓰기 실패, 서버 에러 | 로그 확인, 재시작 | 수동 |

에러 UI 공통 구조:
```
┌─ Error Banner ────────────────────────────┐
│ [아이콘] 무슨 문제인지 (1줄 요약)           │
│ 영향: 어떤 워크스페이스/도구가 영향받는지     │
│ 해결: 사용자가 지금 할 수 있는 구체적 행동    │
│ [다시 테스트] [기술 세부정보 ▼]             │
└───────────────────────────────────────────┘
```

#### 화면 구성

**0. Login (인증)**
- Admin UI 접근 시 `BIFROST_ADMIN_TOKEN` 입력 폼
- 토큰은 `Authorization: Bearer` 헤더로 전송, 서버 검증
- 인증 성공 → `sessionStorage`에 토큰 저장 (탭 닫으면 만료)
- 인증 실패 → "토큰이 일치하지 않습니다" + `.env` 설정 안내
- API 응답에서 provider 토큰은 항상 마스킹 (`ntn_***xxx`) — DevTools 노출 방지

**1. Dashboard (운영 콘솔)**
- **Needs Attention 영역** (상단): Error/Action Needed 상태인 워크스페이스 배너, 클릭 시 해당 Detail로 이동
- **워크스페이스 카드 그리드** (provider 아이콘 + alias + 상태 뱃지)
  - 카드/테이블 뷰 전환 토글 (워크스페이스 5개 이상 시 테이블 기본)
  - Provider 필터, 상태 필터, 검색
  - 카드 클릭 → Workspace Detail
- **"+ Add Workspace"** 버튼 → 워크스페이스 1개 이상: 오른쪽 Drawer / 0개: 전체 화면 Wizard
- **일괄 재검사** 버튼 → 전체 워크스페이스 healthCheck + capabilityCheck
- **전체 노출 도구 수** 카운터 (경고: 50개 초과 시 MCP 클라이언트 부하 알림)
- **빈 상태**: 워크스페이스 0개 → Setup Wizard 자동 진입 (Skip → 빈 Dashboard 가능)
- **All-disabled/error 상태**: "모든 워크스페이스에 문제가 있습니다" 배너 + 일괄 재검사

**2. Setup Wizard (온보딩)**
첫 실행 또는 워크스페이스가 없을 때 표시되는 단계별 가이드.
단계 간 자유 이동 가능 (뒤로 가기, 단계 클릭 네비게이션).
외부 이탈 대비 `localStorage`에 임시 저장 (토큰 제외).

```
Step 1: Provider 선택
  → Notion / Slack / (추후 확장) 카드 UI로 선택

Step 2: 연결 정보 입력
  → displayName (자유)
  → Provider별 필수 필드 + 인라인 발급 가이드
    - Notion: Integration Token
      ※ 축약 가이드: "notion.so/my-integrations → New → Token 복사"
      ※ "외부 탭에서 발급하고 여기에 붙여넣으세요" 패턴
    - Slack: Bot Token (Team ID는 토큰에서 자동 추출 시도, 실패 시 수동 입력)
      ※ 축약 가이드: "api.slack.com/apps → Create → Bot Token 복사"
  → alias는 displayName에서 자동 생성 (영문 소문자 + 하이픈)
    ※ 중복 검사 실시간 수행, 충돌 시 suffix 자동 추가
    ※ 사용자가 원하면 수동 수정 가능

Step 3: 연결 테스트 + Capability Check
  자동으로 3단계 검증 실행 (진행 표시줄):
  
  3a. 토큰 검증 (validateCredentials)
    → 실패: Credential 에러 분류에 따른 해결 가이드
  
  3b. Capability Check (capabilityCheck)
    → 부여된 scope 목록 표시
    → 접근 가능 리소스 수 + 샘플 (e.g., "12 pages, 3 databases")
    → 도구별 사용 가능 여부 (usable/limited/unavailable)
    → scope 부족 시: Permission 에러 + "이 권한이 추가로 필요합니다" 안내
  
  3c. 샘플 도구 호출 (dry-run, optional)
    → 대표 도구 1개 실행 (e.g., Notion search_pages로 빈 쿼리)
    → 성공/실패 결과 표시

  결과 요약:
    → Healthy: "모든 도구 사용 가능"
    → Limited: "N개 도구 사용 가능, M개 제한됨 [상세 보기]"
    → Error: Step 2로 돌아가기 유도

Step 4: 완료
  → 최종 alias 확인/수정 기회
  → 노출될 도구 이름 미리보기 (usable/limited 구분)
  → 다음 추천 액션 분기:
    - "Add Another Workspace" — 추가 연결
    - "View Connect Guide" — claude.ai/Claude Code 연동 방법
    - "Go to Dashboard" — 대시보드로 이동
```

**3. Workspace Detail (편집)**
- 기본 정보 수정 (displayName)
- **alias 변경 시 Breaking Change 경고**:
  ```
  ⚠ alias를 변경하면 MCP 도구 이름이 바뀝니다.
  변경 전: notion_personal__search_pages
  변경 후: notion_home__search_pages
  현재 이 도구를 사용 중인 클라이언트에 영향을 줍니다.
  [변경 확인] [취소]
  ```
- 토큰 갱신 (API 응답에서 항상 마스킹, 변경 시에만 입력)
- 연결 상태 + 마지막 health check + capability check 결과
- "Test Connection" 버튼 (재검사)
- 노출 도구 목록 (체크박스로 개별 도구 활성화/비활성화 + usable 상태 표시)
- 최근 검사 이력 (마지막 3회 검사 결과, 타임스탬프)
- Enable/Disable 토글
- 삭제 (확인 다이얼로그 + 영향받는 MCP 도구 이름 목록 표시)

**4. Tools Overview**
- 전체 워크스페이스의 노출 도구를 한눈에 보는 테이블
- 컬럼: Provider | Workspace | Tool Name | MCP Name | Status (usable/limited/disabled)
- 검색/필터 지원 (provider별, 상태별, 워크스페이스별)
- 각 도구의 inputSchema를 펼쳐볼 수 있는 accordion
- 총 도구 수 카운터 + 50개 초과 경고

**5. Connect Guide (연동 가이드)**
- 현재 서버 상태 (port, tunnel URL 등) 표시
- Tunnel URL 변경 감지 시 전역 경고 배너: "Tunnel URL이 변경되었습니다. 클라이언트 설정을 업데이트하세요."
- 연동 대상별 탭:
  - **claude.ai**: Tunnel URL 원클릭 복사 + 단계별 안내
  - **Claude Code**: `.mcp.json` 설정 코드블록 + 복사 버튼
  - **기타**: 일반 MCP 엔드포인트 정보

**6. Server Settings**
- 현재 서버 포트, admin 포트 표시
- Tunnel 상태 (활성/비활성, 현재 URL)
- admin 토큰 변경 (현재 토큰 입력 → 새 토큰 설정)
- `workspaces.json` 위치 표시 + 수동 편집 경고
- 서버 재시작 버튼 (설정 변경 반영)

**7. Diagnostics**
- 전체 워크스페이스 상태 요약 테이블
- 워크스페이스별 마지막 healthCheck / capabilityCheck 결과
- 최근 에러 로그 (마지막 50건, 에러 분류별 필터)
- Provider API 응답 시간 그래프 (간단한 bar chart)
- MCP 엔드포인트 상태 (Streamable HTTP, SSE 각각)
- 일괄 재검사 + 결과 내보내기 (JSON)

#### UX 원칙

- **에러는 해결책과 함께**: 에러 분류 체계에 따라 "왜 + 어떻게" 항상 포함
- **위험 동작은 확인 필수**: 삭제, alias 변경, 토큰 변경 시 영향 범위를 보여주는 확인 다이얼로그
- **상태는 다중 채널로**: 색상 + 아이콘 + 텍스트 레이블 병행 (색각 접근성)
- **복사 가능한 모든 값**: URL, 도구 이름, 설정 코드 등 클릭 투 카피
- **Progressive disclosure**: 기본 뷰는 단순하게, 상세 정보는 펼쳐서 확인
- **Breaking change 명시**: 외부 소비자에 영향을 주는 변경(alias, 도구 비활성화)은 diff로 표시
- **임시 저장**: Wizard 중 외부 이탈 시 진행 상태 보존 (토큰 제외)
- **빈 상태 = 가이드**: 데이터 없는 화면은 단순 빈 화면이 아닌 다음 행동 안내

### Security

- `workspaces.json`은 gitignored — 토큰 절대 커밋 금지
- Admin 토큰은 **환경변수 `BIFROST_ADMIN_TOKEN` 우선**, `workspaces.json`의 `server.adminToken`은 fallback (환경변수 설정 권장)
- Admin UI 인증: `Authorization: Bearer <token>` 헤더 기반, `sessionStorage`에 저장 (탭 닫으면 만료)
- **API 응답에서 provider 토큰은 항상 마스킹** (`ntn_***xxx`) — 프론트가 아닌 서버 레벨 마스킹
- Cloudflare Tunnel 사용 시 외부 노출은 MCP 엔드포인트만 (admin은 로컬 전용)
- 각 provider 토큰은 최소 권한 원칙 (read-only 우선)
- Admin API CORS: 같은 호스트 내에서만 허용 (`localhost:3101` → `localhost:3100`)

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
      "enabled": true,
      "toolFilter": {
        "mode": "all",
        "enabled": []
      }
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
      "enabled": true,
      "toolFilter": {
        "mode": "all",
        "enabled": []
      }
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

> **Note**: `server.adminToken`은 fallback. 운영 환경에서는 `BIFROST_ADMIN_TOKEN` 환경변수 사용 권장.
> `toolFilter.mode`가 `"all"`이면 전체 도구 노출, `"include"`이면 `enabled` 배열에 명시된 도구만 노출.
```

## Roadmap

### Phase 1 — Core MVP
Notion 1개 Provider로 전체 파이프라인을 관통하는 최소 동작 제품.

- [ ] MCP 프로토콜 핸들러 (Streamable HTTP + SSE)
- [ ] Workspace manager + tool registry
- [ ] Notion provider (search, read page, list databases)
- [ ] 기본 설정 파일 로딩
- [ ] Admin REST API (CRUD workspaces, health check, capability check)
- [ ] Admin UI — Login 화면 (BIFROST_ADMIN_TOKEN 인증)
- [ ] Admin UI — Dashboard (Needs Attention 영역, 카드 그리드, 일괄 재검사)
- [ ] Admin UI — Setup Wizard (4단계: Provider → 연결 정보 → 검증+Capability Check → 완료)
- [ ] Admin UI — Workspace Detail (편집, alias 변경 경고, 도구 토글, 삭제 확인)
- [ ] Workspace 상태 모델 5단계 (Healthy/Limited/Action Needed/Error/Disabled)
- [ ] 에러 분류 체계 (Credential/Permission/Connectivity/Config Conflict/Internal)
- [ ] alias 자동 생성 + 중복 검사 + 변경 시 breaking change 경고
- [ ] API 레벨 토큰 마스킹

### Phase 1.5 — 운영 안정성 + Slack
운영 중 문제를 빠르게 진단하고 복구할 수 있는 기반.

- [ ] Slack provider (search messages, read channel, list channels)
- [ ] Slack Team ID 자동 추출 (Bot Token에서)
- [ ] Admin UI — Diagnostics 화면 (에러 로그, 상태 요약, 일괄 재검사)
- [ ] Admin UI — Server Settings 화면 (포트, tunnel 상태, admin 토큰 변경)
- [ ] Rate Limit (429) 에러 처리 + countdown UI
- [ ] Provider Outage 자동 감지 + 재시도 (backoff)
- [ ] 최소 audit log (설정 변경 이력, 마지막 10건)

### Phase 2 — Auth & Connect Guide
외부 서비스 연동을 쉽게 만드는 단계.

- [ ] OAuth flow 지원 (Notion — 토큰 수동 입력 대체)
- [ ] OAuth flow 지원 (Slack — Bot Token 자동 발급)
- [ ] Admin UI — Connect Guide 탭 (claude.ai, Claude Code 연동 안내)
- [ ] Admin UI — Tools Overview (전체 도구 테이블 + 검색 + inputSchema)
- [ ] Tunnel URL 변경 감지 + 전역 경고 배너

### Phase 3 — Tunnel & Distribution
- [ ] Cloudflare Tunnel 통합
- [ ] Connect Guide에 Tunnel URL 자동 반영 + 원클릭 복사
- [ ] Claude Code .mcp.json 자동 생성 기능
- [ ] Palantir Console 연동 가이드

### Phase 4 — Advanced
- [ ] 추가 provider (Google Drive, GitHub, Linear, ...)
- [ ] 토큰 자동 갱신 (OAuth refresh)
- [ ] 설정 export/import (환경 간 이동)
- [ ] 워크스페이스 삭제 undo (soft delete + 30일 보관)
- [ ] 사용량 대시보드 / 상세 audit trail
- [ ] 도구 수 상한 경고 (50개 초과 시 MCP 클라이언트 부하 알림)

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
