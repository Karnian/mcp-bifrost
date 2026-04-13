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
    routes.js             — /api/* REST 라우트 + /admin/* 정적 파일 서빙
    auth.js               — Admin 토큰 인증 미들웨어 (env > config fallback)
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

#### Provider별 capabilityCheck 구현 기준

**Notion:**
- `GET /v1/users/me` → 토큰 유효성 + bot info
- `POST /v1/search` (빈 쿼리, limit:1) → 접근 가능 페이지 수 샘플링
- `GET /v1/databases` (limit:1) → 데이터베이스 접근 확인
- scope: Notion Integration은 scope 개념이 없으므로, 리소스 접근 여부로 판정
- usable 기준: search 결과 0건 → `search_pages` limited (공유된 페이지 없음)

**Slack:**
- `GET /api/auth.test` → 토큰 유효성 + team_id 추출
- `GET /api/conversations.list` (limit:1) → 채널 접근 확인
- scope: `auth.test` 응답에 포함된 scope 문자열 파싱
- usable 기준: `channels:read` 없으면 → `list_channels` unavailable

```
```

### Tool Namespacing

워크스페이스별 도구 이름 충돌 방지:

```
Provider: Notion
Workspace namespace: "personal"
Tool: search_pages

→ 노출 이름: notion_personal__search_pages
```

패턴: `{provider}_{namespace}__{tool_name}`

#### 불변 Namespace vs 가변 Alias

`alias`(displayName에서 자동 생성, 사용자 수정 가능)와 `namespace`(MCP 도구 이름에 사용)를 분리한다.

- `namespace`: 워크스페이스 최초 생성 시 alias에서 복사, **이후 변경 불가** (immutable)
- `alias`/`displayName`: Admin UI 표시용, 자유롭게 변경 가능
- MCP 도구 이름은 `namespace` 기반이므로, displayName을 바꿔도 클라이언트에 영향 없음
- workspaces.json에 `namespace` 필드 추가 (한번 설정되면 변경 불가)

```json
{
  "id": "notion-personal",
  "provider": "notion",
  "namespace": "personal",
  "alias": "personal",
  "displayName": "개인 Notion"
}
```

> alias와 namespace가 다를 수 있다: displayName "김팀장 메모장"으로 변경 → alias "kimteam-memo" → namespace는 여전히 "personal" → MCP 이름 `notion_personal__search_pages` 유지.

#### Tool Description 규약

LLM은 도구 이름보다 **description을 보고 선택**한다. 따라서 description은 반드시 다음 구조를 따른다:

```
description 템플릿:
"[displayName] 워크스페이스에서 [동작]. [구분 정보]."

필수 포함 정보:
1. displayName (사용자가 자연어로 참조할 이름)
2. provider 종류 (Notion/Slack)
3. 읽기/쓰기 여부
4. 동일 provider 다중 워크스페이스 구분점

예시:
- "개인 Notion 워크스페이스에서 페이지를 검색합니다. 개인 메모와 프로젝트용. (읽기 전용)"
- "회사 Slack (ACME Corp)에서 메시지를 검색합니다. 개인 Slack이 아닌 업무용 워크스페이스입니다."
```

Bifrost는 provider의 원본 description에 워크스페이스 컨텍스트를 **자동 주입**한다:
- Provider가 반환하는 원본 description: `"Search pages in Notion"`
- Bifrost가 노출하는 description: `"[개인 Notion] Search pages in Notion. 개인 메모와 프로젝트용 워크스페이스. (읽기 전용)"`

#### 도구 수 스케일링

LLM의 도구 선택 정확도는 도구 수에 반비례한다:
- ~20개: 정확도 양호
- 20-30개: 정확도 저하 시작
- 50개+: 유의미한 degradation

**대응 전략:**

1. **도구 수 경고 임계값**: Admin UI에서 노출 도구 20개 초과 시 주의, 30개 초과 시 경고
2. **toolFilter 적극 활용**: 워크스페이스별로 필요한 도구만 선택적 노출
3. **Profile 기반 엔드포인트** (Phase 4): `/mcp?profile=read-only` 같은 분기로 클라이언트별 도구셋 제한
4. **쓰기 도구 opt-in**: 기본은 읽기 전용 도구만 노출, 쓰기 도구는 toolFilter에서 명시적 활성화

#### Bifrost 메타 도구

네임스페이스 바깥의 Bifrost 자체 도구:

| 도구 | 설명 |
|------|------|
| `bifrost__list_workspaces` | 연결된 워크스페이스 목록 + displayName + 상태 반환. LLM이 모호한 요청 시 워크스페이스를 먼저 확인할 수 있음 |
| `bifrost__workspace_info` | 특정 워크스페이스의 상세 정보 (접근 가능 리소스, 활성 도구 목록) |

#### 도구 노출 결정 규칙

`tools/list`에 도구가 노출되려면 다음 조건을 **모두** 통과해야 한다 (평가 순서대로):

```
1. workspace.enabled === true        (워크스페이스 활성화)
2. toolFilter 통과                    (mode:"all" → 통과, mode:"include" → enabled 배열에 포함)
3. 해당 도구의 capabilityCheck 결과가 usable === true  (도구별 개별 판정)
```

호출(`tools/call`) 시에도 동일 규칙 재검사. 노출되지 않은 도구를 호출하면 `isError: true` + "이 도구는 현재 비활성화되어 있습니다" 반환.

#### healthCheck / capabilityCheck 실행 시점

| 시점 | healthCheck | capabilityCheck |
|------|:-----------:|:---------------:|
| 서버 시작 시 | 전체 워크스페이스 | 전체 워크스페이스 |
| 워크스페이스 저장 시 | 해당 워크스페이스 | 해당 워크스페이스 |
| Admin UI "Test Connection" | 해당 워크스페이스 | 해당 워크스페이스 |
| Admin UI "일괄 재검사" | 전체 | 전체 |
| 주기적 background | 5분 간격 (healthCheck만) | 없음 (비용 높음) |

#### 상태 전이 규칙

복수 조건이 겹칠 때 **가장 심각한 상태가 우선**한다:

```
Disabled는 수동 override로, 다른 조건보다 우선 적용된다.
나머지 상태 간 우선순위: Error > Action Needed > Limited > Healthy

예시:
- enabled: false → Disabled (수동 override, 다른 조건 평가하지 않음)
- enabled: true + healthCheck 실패 → Error
- enabled: true + healthCheck 성공 + 토큰 만료 7일 이내 → Action Needed
- enabled: true + healthCheck 성공 + 만료 아님 + 일부 도구 usable=false → Limited
- enabled: true + healthCheck 성공 + 만료 아님 + 전체 도구 usable=true → Healthy
```

### MCP Protocol Support

Bifrost가 구현하는 MCP 메서드:

| Method | 설명 |
|--------|------|
| `initialize` | 핸드셰이크, capabilities 선언 (`tools.listChanged: true`) |
| `tools/list` | 모든 활성 워크스페이스의 도구를 네임스페이스와 함께 반환 |
| `tools/call` | 네임스페이스에서 워크스페이스를 식별하고 해당 provider에 라우팅 |
| `resources/list` | 워크스페이스 목록/상태를 리소스로 노출 |
| `resources/read` | 특정 워크스페이스의 상세 정보 (JSON) 반환 |
| `notifications/tools/list_changed` | 워크스페이스 변경 시 클라이언트에 알림 (서버→클라이언트) |

#### MCP 엔드포인트 계약

| 경로 | 트랜스포트 | 설명 |
|------|-----------|------|
| `POST /mcp` | Streamable HTTP | MCP JSON-RPC 요청/응답. `Mcp-Session-Id` 헤더로 세션 추적 |
| `GET /sse` | SSE | SSE 연결. `Authorization: Bearer` 쿼리/헤더. 연결 유지 중 서버→클라이언트 알림 |
| `POST /sse` | SSE message | SSE 세션에 대한 클라이언트→서버 메시지 |

#### resources/list 스키마

```json
{
  "resources": [
    {
      "uri": "bifrost://workspaces/notion-personal",
      "name": "개인 Notion",
      "description": "Notion 워크스페이스 (namespace: personal, 상태: healthy)",
      "mimeType": "application/json"
    }
  ]
}
```

URI 패턴: `bifrost://workspaces/{workspace-id}`

#### resources/read 응답

```json
{
  "contents": [{
    "uri": "bifrost://workspaces/notion-personal",
    "mimeType": "application/json",
    "text": "{\"id\":\"notion-personal\",\"provider\":\"notion\",\"namespace\":\"personal\",\"displayName\":\"개인 Notion\",\"status\":\"healthy\",\"tools\":[{\"name\":\"search_pages\",\"usable\":true},{\"name\":\"read_page\",\"usable\":true}],\"lastChecked\":\"2026-04-14T10:00:00Z\"}"
  }]
}
```

#### MCP 에러 응답 포맷

`tools/call` 실패 시 LLM이 이해하고 사용자에게 전달할 수 있는 구조화된 응답:

```json
{
  "content": [{
    "type": "text",
    "text": "개인 Notion에서 페이지 검색에 실패했습니다. 토큰이 만료되었습니다. 사용자에게 Bifrost 관리 페이지에서 Notion 토큰을 갱신해야 한다고 알려주세요."
  }],
  "isError": true,
  "_meta": {
    "bifrost": {
      "category": "credential",
      "workspace": "notion-personal",
      "provider": "notion",
      "tool": "search_pages",
      "retryable": false,
      "userMessage": "Notion 토큰이 만료되었습니다. Bifrost Admin에서 갱신이 필요합니다.",
      "suggestedAction": "관리자에게 토큰 갱신을 요청하세요."
    }
  }
}
```

에러 메시지 원칙:
- `content.text`: LLM이 사용자에게 **그대로 전달할 수 있는** 자연어 메시지
- `_meta.bifrost`: 구조화된 메타데이터 (프로그래밍적 처리용)
- `isError: true`: LLM이 재시도 vs 포기를 판단하는 신호
- `retryable: true` + `retryAfter`: 재시도 가능 여부와 권장 대기 시간

#### 세션 일관성 모델

Admin에서 워크스페이스를 변경하면 기존 MCP 세션에 영향을 줄 수 있다.
**Session Snapshot 모델**을 채택한다:

1. 서버는 도구 카탈로그의 **버전 번호**(`toolsVersion`, 정수 증가)를 관리. 워크스페이스 변경 시 +1
2. Admin에서 워크스페이스 변경 시:
   - **SSE 세션**: `notifications/tools/list_changed` 전송 → 클라이언트가 `tools/list` 재호출
   - **Streamable HTTP**: stateless이므로 매 `tools/list` 호출마다 최신 카탈로그 반환 (별도 스냅샷 저장 불필요)
3. 클라이언트가 알림을 무시하거나 못 받아도, reconnect하면 새 스냅샷을 받음
4. **in-flight 안전성**: 세션 중 삭제된 도구를 호출하면 즉시 에러 (isError + "이 도구는 더 이상 사용할 수 없습니다")
5. Admin UI에 "현재 N개 활성 MCP 세션" 표시 + "변경 사항은 SSE 세션에 즉시, HTTP 세션에는 다음 요청부터 적용됩니다" 안내

### MCP Endpoint Authentication

Admin 인증과 MCP 클라이언트 인증을 **분리**한다:

| 토큰 | 용도 | 환경변수 | 권한 |
|------|------|---------|------|
| **Admin Token** | Admin UI/API 접근 | `BIFROST_ADMIN_TOKEN` | 전체 관리 (CRUD, 설정 변경) |
| **MCP Token** | MCP 엔드포인트 접근 | `BIFROST_MCP_TOKEN` | 도구 호출만 (tools/list, tools/call) |

- MCP 클라이언트는 `Authorization: Bearer <MCP_TOKEN>` 헤더로 인증
- MCP Token이 설정되지 않으면 → 로컬 전용 모드 (localhost만 허용, Tunnel 비활성화)
- MCP Token으로는 Admin API에 접근 불가 (워크스페이스 수정, 토큰 조회 등 차단)
- SSE: 연결 시 Bearer 검증 → 연결 유지
- Streamable HTTP: 매 요청마다 Bearer 검증 (stateless)

### Transport

- **Streamable HTTP** (MCP 2025-03-26 spec) — primary, stateless 인증
- **SSE** (legacy 호환) — claude.ai remote connector용, 연결 시 인증
- **stdio** — Claude Code 로컬 직접 연결용 (인증 불필요, 같은 머신)

Streamable HTTP와 SSE는 동일한 도구 목록, 동일한 에러 포맷, 동일한 인증 방식(Bearer)을 보장한다.
stdio는 로컬 전용이므로 인증 불필요 (예외).
Streamable HTTP가 표준 경로, SSE는 호환성 경로로 명시 구분.

### Admin UI

단일 서버(:3100)에서 MCP 엔드포인트와 Admin UI를 함께 서빙한다.
- MCP: `/mcp` (Streamable HTTP), `/sse` (SSE)
- Admin UI: `/admin/*` (SPA 정적 파일)
- Admin API: `/api/*` (REST)

SPA로 구현, 빌드 스텝 없이 vanilla HTML/CSS/JS.
단일 포트이므로 CORS 불필요, Tunnel은 `/mcp`와 `/sse`만 외부 노출.

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
- **전체 노출 도구 수** 카운터 (20개 초과: 주의, 30개 초과: 경고)
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
- 기본 정보 수정 (displayName, alias — 자유롭게 변경 가능)
- **namespace는 읽기 전용** 표시 (불변, MCP 도구 이름의 안정성 보장)
  ```
  Namespace: personal (변경 불가 — MCP 도구 이름에 사용)
  Display Name: [김팀장 메모장] (자유 변경)
  → MCP 이름: notion_personal__search_pages (namespace 기반, 변경 없음)
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
- 총 도구 수 카운터 (20개 초과: 주의, 30개 초과: 경고)

**5. Connect Guide (연동 가이드)**
- 현재 서버 상태 (port, tunnel URL 등) 표시
- Tunnel URL 변경 감지 시 전역 경고 배너: "Tunnel URL이 변경되었습니다. 클라이언트 설정을 업데이트하세요."
- 연동 대상별 탭:
  - **claude.ai**: Tunnel URL 원클릭 복사 + 단계별 안내
  - **Claude Code**: `.mcp.json` 설정 코드블록 + 복사 버튼
  - **기타**: 일반 MCP 엔드포인트 정보

**6. Server Settings**
- 현재 서버 포트 표시
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
- **Breaking change 명시**: 도구 비활성화 시 영향받는 MCP 도구 이름을 diff로 표시 (namespace는 불변이므로 alias 변경은 breaking change가 아님)
- **임시 저장**: Wizard 중 외부 이탈 시 진행 상태 보존 (토큰 제외)
- **빈 상태 = 가이드**: 데이터 없는 화면은 단순 빈 화면이 아닌 다음 행동 안내

### Security

- `workspaces.json`은 gitignored — 토큰 절대 커밋 금지
- **Admin 토큰** (`BIFROST_ADMIN_TOKEN`): Admin UI/API 전용, 워크스페이스 관리 권한
- **MCP 토큰** (`BIFROST_MCP_TOKEN`): MCP 클라이언트 전용, 도구 호출만 가능 (Admin API 접근 불가)
- MCP 토큰 미설정 시 → 로컬 전용 모드 (localhost만 허용)
- Admin UI 인증: `Authorization: Bearer <admin_token>` 헤더, `sessionStorage`에 저장
- **API 응답에서 provider 토큰은 항상 마스킹** (`ntn_***xxx`) — 서버 레벨 마스킹
- Cloudflare Tunnel 사용 시 외부 노출은 MCP 엔드포인트만 (admin은 로컬 전용)
- 각 provider 토큰은 최소 권한 원칙 (read-only 우선)
- 단일 포트(:3100)에서 MCP + Admin 서빙, CORS 불필요

### Tunnel Integration

```bash
# 개발/개인 사용: Cloudflare Tunnel로 공인 HTTPS 노출
npm run tunnel
# → https://bifrost-xxxx.trycloudflare.com

# 이 URL을 claude.ai remote connector로 등록
```

고정 도메인 설정도 지원 (Cloudflare 무료 플랜).

## Configuration

### 설정 저장 정책

- **원자적 쓰기**: `workspaces.tmp.json`에 먼저 쓰고 `rename()`으로 교체 (partial write 방지)
- **백업**: 저장 전 `workspaces.backup.json`에 이전 버전 복사 (1세대만 유지)
- **직렬화**: Admin API 요청은 쓰기 잠금으로 serialize (Node.js 단일 스레드이므로 비동기 큐로 충분)
- **hot reload**: 파일 변경 시 `fs.watch()`로 감지, 서버 재시작 없이 반영
- **JSON 파싱 실패**: 백업에서 복구 시도, 실패 시 서버 에러 상태 + Admin UI에 "설정 파일 손상" 경고

### Admin REST API 계약

| Method | Path | 설명 | 인증 |
|--------|------|------|------|
| `GET` | `/api/workspaces` | 워크스페이스 목록 (토큰 마스킹) | Admin |
| `GET` | `/api/workspaces/:id` | 워크스페이스 상세 (토큰 마스킹) | Admin |
| `POST` | `/api/workspaces` | 워크스페이스 추가 (namespace 자동 생성) | Admin |
| `PUT` | `/api/workspaces/:id` | 워크스페이스 수정 (namespace 변경 불가) | Admin |
| `DELETE` | `/api/workspaces/:id` | 워크스페이스 삭제 | Admin |
| `POST` | `/api/workspaces/:id/test` | 연결 테스트 (healthCheck + capabilityCheck) | Admin |
| `POST` | `/api/workspaces/test-all` | 전체 일괄 재검사 | Admin |
| `GET` | `/api/status` | 서버 상태, 활성 세션 수, toolsVersion | Admin |
| `GET` | `/api/diagnostics` | 에러 로그, 상태 요약 | Admin |

응답 형식:
```json
// 성공
{ "ok": true, "data": { ... } }

// 실패
{ "ok": false, "error": { "code": "NAMESPACE_CONFLICT", "message": "..." } }
```

토큰 마스킹 규칙: credentials 내 모든 값은 API 응답에서 마지막 4자만 표시 (`ntn_***abcd`). PUT 요청에서 credentials 필드가 비어있으면 기존 값 유지.

### workspaces.json

```json
{
  "workspaces": [
    {
      "id": "notion-personal",
      "provider": "notion",
      "namespace": "personal",
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
      "namespace": "company",
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
    "adminToken": "your-secret-token"
  },
  "tunnel": {
    "enabled": false,
    "fixedDomain": ""
  }
}
```

> **Notes**:
> - `namespace`: 최초 생성 시 alias에서 복사, **이후 변경 불가**. MCP 도구 이름의 안정성 보장.
> - `alias`/`displayName`: Admin UI 표시용, 자유롭게 변경 가능. MCP 도구 이름에 영향 없음.
> - `server.adminToken`은 fallback. 운영 환경에서는 `BIFROST_ADMIN_TOKEN` 환경변수 사용 권장.
> - `toolFilter.mode`가 `"all"`이면 전체 도구 노출, `"include"`이면 `enabled` 배열에 명시된 도구만 노출.
> - MCP 클라이언트 인증: `BIFROST_MCP_TOKEN` 환경변수 (Admin 토큰과 분리).
```

## Roadmap

### Phase 1a — MCP Core (1~2주)
Notion 1개로 MCP 프로토콜이 동작하는 최소 서버. Admin은 최소한.

- [ ] MCP 프로토콜 핸들러 (Streamable HTTP 우선)
- [ ] `initialize`, `tools/list`, `tools/call` 구현
- [ ] Workspace manager + tool registry
- [ ] Notion provider (search, read page, list databases) + healthCheck
- [ ] 기본 설정 파일 로딩 (workspaces.json) + 원자적 쓰기
- [ ] 불변 namespace + 가변 alias 분리
- [ ] Tool description 자동 생성 (displayName + provider 컨텍스트 주입)
- [ ] MCP 에러 응답 구조화 (isError + content.text + _meta.bifrost)
- [ ] MCP 엔드포인트 인증 (BIFROST_MCP_TOKEN)
- [ ] Admin REST API (CRUD + test connection)
- [ ] Admin UI — Login + Dashboard (카드 그리드 + Add/Edit form) + 상태 3단계 (Healthy/Error/Disabled)
- [ ] API 레벨 토큰 마스킹

### Phase 1b — 운영 품질 (1~2주)
MCP 서버를 실제 운영 가능한 수준으로 보강.

- [ ] SSE 트랜스포트 추가 (claude.ai remote connector 호환)
- [ ] capabilityCheck 구현 (Notion) + 상태 5단계로 확장 (Healthy/Limited/Action Needed/Error/Disabled)
- [ ] Bifrost 메타 도구 (bifrost__list_workspaces, bifrost__workspace_info)
- [ ] `resources/list` 구현
- [ ] toolsVersion + `notifications/tools/list_changed` (SSE)
- [ ] toolFilter (워크스페이스별 도구 선택적 노출)
- [ ] 에러 분류 체계 (Credential/Permission/Connectivity/Config Conflict/Internal)
- [ ] Admin UI — Setup Wizard (4단계) + Workspace Detail (도구 토글, 삭제 확인)
- [ ] Dashboard — Needs Attention 영역, 도구 수 경고 (20/30개)
- [ ] 주기적 background healthCheck (5분)

### Phase 1.5 — Slack + Diagnostics (1~2주)
두 번째 Provider 추가, 운영 진단 도구.

- [ ] Slack provider (search messages, read channel, list channels)
- [ ] Slack capabilityCheck (scope 파싱, Team ID 자동 추출)
- [ ] Admin UI — Diagnostics 화면 (에러 로그, 상태 요약, 일괄 재검사)
- [ ] Admin UI — Server Settings 화면
- [ ] Rate Limit (429) 에러 처리 + countdown UI
- [ ] Provider Outage 자동 감지 + 재시도 (backoff)
- [ ] 최소 audit log (설정 변경 이력, 마지막 10건)
- [ ] hot reload (workspaces.json 변경 감지)

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
- [ ] Profile 기반 엔드포인트 (`/mcp?profile=read-only` — 클라이언트별 도구셋 제한)
- [ ] 다중 MCP 토큰 (클라이언트별 토큰 + 접근 가능 워크스페이스 제한)

## Integration Points

### claude.ai (Remote Connector)
Settings → Connectors → Add Custom Connector → Bifrost URL 등록

### Claude Code (.mcp.json)
```json
{
  "mcpServers": {
    "bifrost": {
      "url": "https://bifrost-xxxx.trycloudflare.com/mcp",
      "headers": { "Authorization": "Bearer <BIFROST_MCP_TOKEN>" }
    }
  }
}
```
> MCP 토큰 사용 (Admin 토큰 아님). 로컬 stdio 연결 시 인증 불필요.

### Palantir Console
프로젝트/에이전트 설정에서 Bifrost 엔드포인트를 MCP 서버로 등록.
PM/Worker가 `notion_personal__search_pages`, `slack_company__send_message` 등 네임스페이스된 도구를 자연스럽게 호출.
