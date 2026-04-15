# MCP Bifrost — 사용 가이드

이 문서는 Bifrost를 설치하고, MCP 서버를 등록하고, 클라이언트(Claude.ai / Claude Code)에서 연결하는 전체 흐름을 다룹니다.

---

## 목차

1. [설치 & 기본 실행](#1-설치--기본-실행)
2. [환경변수](#2-환경변수)
3. [Admin UI 사용법](#3-admin-ui-사용법)
4. [워크스페이스 등록](#4-워크스페이스-등록)
   - [4.1 템플릿](#41-템플릿으로-등록-가장-쉬움) · [4.2 직접 설정](#42-직접-설정-stdio--http--sse) · [4.3 스코프 ★](#43-스코프--어느-머신의-자원에-접근하나)
5. [REST API 사용법](#5-rest-api-사용법)
6. [클라이언트 연결](#6-클라이언트-연결)
7. [외부 노출 (LAN/Tunnel)](#7-외부-노출-lantunnel)
8. [보안 권장 설정](#8-보안-권장-설정)
9. [테스트 시나리오](#9-테스트-시나리오)
10. [트러블슈팅](#10-트러블슈팅)

---

## 1. 설치 & 기본 실행

### 사전 요구사항
- Node.js 20+ (built-in `fetch` 사용)
- (선택) `cloudflared` — 외부 노출 시 필요

### 설치
```bash
cd /path/to/mcp-bifrost
npm install
```

### 실행
```bash
# 기본 — localhost:3100 만 바인딩, Admin/MCP 인증 없음 (개발용)
npm start

# 개발 모드 (파일 변경 시 자동 재시작)
npm run dev

# 외부 인터페이스에 바인딩
BIFROST_HOST=0.0.0.0 npm start
```

기동 시 출력:
```
[Bifrost] Server running on http://127.0.0.1:3100
[Bifrost] MCP endpoint:  POST /mcp
[Bifrost] SSE endpoint:  GET  /sse
[Bifrost] Admin UI:      /admin/
[Bifrost] Workspaces loaded: 0
```

워크스페이스가 0 개라면 Admin UI(`http://localhost:3100/admin/`) 열 때 자동으로 **Setup Wizard** 진입.

---

## 2. 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `BIFROST_HOST` | `127.0.0.1` | listen 인터페이스. 외부 노출 시 `0.0.0.0` |
| `BIFROST_ADMIN_TOKEN` | (없음) | Admin UI/API 인증 토큰. 미설정 시 토큰 검사 생략 |
| `BIFROST_MCP_TOKEN` | (없음) | MCP 클라이언트 인증 토큰. 미설정 시 인증 생략 |
| `BIFROST_ADMIN_EXPOSE` | `0` | `1` 로 설정 시 Admin API 가 외부에서도 접근 가능 |
| `BIFROST_ALLOWED_COMMANDS` | (없음) | stdio command 화이트리스트 (콤마 구분: `npx,node,uvx,python3`). 미설정 시 모든 명령 허용 |

### 권장 운영 설정

```bash
export BIFROST_ADMIN_TOKEN="$(openssl rand -hex 32)"
export BIFROST_MCP_TOKEN="$(openssl rand -hex 32)"
export BIFROST_ALLOWED_COMMANDS="npx,node,uvx,python3"
# 외부 PC에서 Admin도 쓰려면:
# export BIFROST_ADMIN_EXPOSE=1
BIFROST_HOST=0.0.0.0 npm start
```

---

## 3. Admin UI 사용법

브라우저에서 `http://localhost:3100/admin/` 접속.

### 화면 구성

| 화면 | 진입 경로 | 용도 |
|------|----------|------|
| Login | 토큰 설정 시 자동 | Admin 토큰 입력 |
| Setup Wizard | 워크스페이스 0 개 또는 `+ Add` | 신규 등록 |
| Dashboard | 기본 | 워크스페이스 카드 그리드, 상태, 일괄 재검사 |
| Detail | 카드 클릭 | 편집, 토큰/명령 변경, 삭제, Test Connection |
| Tools | 상단 `Tools` 버튼 | 노출된 모든 도구 목록 + 검색 |
| Connect | 상단 `Connect` 버튼 | 클라이언트 연결 안내 (claude.ai / Claude Code / 기타) |

### Dashboard 카드 보는 법

```
┌─────────────────────────────────┐
│ MCP · stdio │ Filesystem Home   │ ● Healthy
│ namespace: fs-home               │
└─────────────────────────────────┘
```

- 좌측 작은 라벨 = `kind · transport` (mcp-client) 또는 provider 이름 (native)
- 우측 점 = 5단계 상태 (Healthy / Limited / Action Needed / Error / Disabled / Checking)
- namespace = MCP 도구 이름의 prefix (불변)

---

## 4. 워크스페이스 등록

### 4.1 템플릿으로 등록 (가장 쉬움)

Wizard 검색창에 키워드 입력 → 카드 클릭 → 필요한 값만 채우고 저장.

#### 내장 템플릿

| ID | 설명 | 필요한 값 |
|----|------|----------|
| `filesystem` | 로컬 파일 시스템 (MCP 공식) | 경로 (예: `/Users/me/Documents`) |
| `fetch` | HTTP fetch (MCP 공식) | 없음 |
| `everything` | MCP 데모 서버 (모든 기능) | 없음 |
| `github` | GitHub API (공식 MCP) | Personal Access Token |
| `notion-official` | Notion 공식 MCP | Headers JSON (`{"Authorization":"Bearer ntn_..."}`) |
| `notion-native` | Notion (Bifrost 내장 어댑터, legacy) | Integration Token |
| `slack-native` | Slack (Bifrost 내장 어댑터, legacy) | Bot Token, (Team ID) |

> 💡 **Notion/Slack 은 가능하면 공식 MCP** (`notion-official`)를 사용하세요. 내장 native는 호환성 유지용 legacy 입니다.

> ⚠️ **stdio MCP는 Bifrost 서버 PC의 자원에 접근합니다.** 예를 들어 Filesystem 템플릿에 입력한 경로 `/Users/me/Documents` 는 **Bifrost 가 돌고 있는 머신의 절대 경로**입니다. 다른 PC의 Claude Code 에서 Bifrost를 호출해도, 결국 **Bifrost 서버 PC의 파일**을 읽고 쓰게 됩니다. 자세한 설명은 [§4.3 스코프 — 어느 머신의 자원에 접근하나](#43-스코프--어느-머신의-자원에-접근하나)

### 4.2 직접 설정 (stdio / HTTP / SSE)

Wizard 하단의 **`> 직접 설정`** 펼치기 → 트랜스포트 선택.

#### stdio 모드 (로컬 자식 프로세스 spawn)

```
Command: npx
Args:    -y, @some/mcp-server, --option, value
Env:     API_KEY=sk-...
         BASE_URL=https://...
```

저장 즉시 자식 프로세스 spawn → `initialize` → `tools/list` 호출하여 도구 발견.

#### HTTP 모드 (Streamable HTTP MCP)

```
URL:     https://mcp.example.com/mcp
Headers: Authorization: Bearer xyz
         X-Custom: value
```

#### SSE 모드 (claude.ai 호환 SSE)

HTTP 모드와 동일한 폼. URL 만 SSE 엔드포인트 형식.

### 4.3 스코프 — 어느 머신의 자원에 접근하나

**핵심 원칙**: Bifrost 가 등록한 MCP 서버는 **Bifrost 가 돌고 있는 머신**에서 실행되고, 그 머신의 자원에 접근합니다. 클라이언트(Claude Code, claude.ai)가 어디서 호출하든 마찬가지입니다.

```
[Claude Code on PC-A]                          [Browser on PC-C]
         │                                              │
         │  /mcp call                          /sse call│
         └─────────────────────┬────────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Bifrost on PC-B     │
                    │  (단일 진입점)         │
                    └──────────┬───────────┘
                               │ stdio spawn / HTTP request
                               ▼
              ┌────────────────┴────────────────┐
              ▼                                 ▼
   [Filesystem MCP]                  [Notion API (HTTPS)]
   PC-B의 /Users/k/Documents          notion.com 의 워크스페이스
```

#### Transport 별 스코프

| Transport | 자원 위치 | 예시 |
|-----------|---------|------|
| **stdio** | **Bifrost 서버 머신**의 OS / 파일시스템 / 환경변수 | `npx server-filesystem /Users/k/...` → PC-B의 파일 |
| **http / sse** | **원격 SaaS / 외부 서버** | `https://mcp.linear.app/mcp` → Linear 클라우드 |
| **native (Notion/Slack)** | **외부 SaaS API** | Notion REST API → notion.com |

#### 사용 패턴별 권장

| 시나리오 | 권장 |
|---------|------|
| 개인 노트북에서 본인용으로 쓴다 | 본인 PC에서 Bifrost 실행 → 본인 파일/SaaS 접근 |
| 회사 공용 서버에 올려 팀이 같이 쓴다 | **stdio 사용 자제**. SaaS(GitHub, Notion, Slack) 만 등록하고 토큰을 사용자별로 분리 |
| 동료에게 내 노트북의 파일을 보여줘야 한다 | Bifrost 가 아닌 다른 도구(파일 공유, GitHub) 사용. Bifrost는 "원격 통합" 용도 |
| 각자 PC에서 자기 파일을 쓰고 싶다 | 각 클라이언트가 **자기 로컬에 Filesystem MCP** 를 직접 등록 (Bifrost 거치지 말고) |

#### 흔한 오해

- ❌ "claude.ai에서 Bifrost로 Filesystem 등록하면 내 PC 파일을 볼 수 있겠지" → **아님**. Bifrost가 돌고 있는 PC의 파일을 봅니다.
- ❌ "각자 다른 PC의 파일을 모아서 보여주는 게 Bifrost의 역할이지" → **아님**. 그건 Bifrost 범위 밖. Bifrost는 단일 머신/원격 SaaS 통합.
- ✅ "여러 SaaS (Notion 개인+회사, GitHub 개인+회사) 를 한 엔드포인트로 통합" → **이게 핵심 가치**.

---

## 5. REST API 사용법

모든 응답은 `{ "ok": boolean, "data"?: ..., "error"?: { code, message } }` 포맷.

### 인증
- Admin 토큰 설정 시: `Authorization: Bearer <ADMIN_TOKEN>` 헤더 필수
- 미설정 시: 인증 생략 (단, localhost-only 가드는 여전히 적용)

### 5.1 워크스페이스 등록 — 예시 모음

#### 예시 A. Filesystem 등록 (stdio)
```bash
curl -X POST http://localhost:3100/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "mcp-client",
    "transport": "stdio",
    "displayName": "내 문서",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"]
  }'
```

#### 예시 B. GitHub 등록 (stdio + env)
```bash
curl -X POST http://localhost:3100/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "mcp-client",
    "transport": "stdio",
    "displayName": "회사 GitHub",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
  }'
```

#### 예시 C. 원격 HTTP MCP 등록
```bash
curl -X POST http://localhost:3100/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "mcp-client",
    "transport": "http",
    "displayName": "Linear",
    "url": "https://mcp.linear.app/mcp",
    "headers": { "Authorization": "Bearer xxx" }
  }'
```

#### 예시 D. Notion (legacy native)
```bash
curl -X POST http://localhost:3100/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "native",
    "provider": "notion",
    "displayName": "내 Notion",
    "credentials": { "token": "ntn_..." }
  }'
```

### 5.2 워크스페이스 관리

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/workspaces` | 전체 목록 (토큰 마스킹) |
| GET | `/api/workspaces/:id` | 상세 |
| PUT | `/api/workspaces/:id` | 수정 (namespace는 불변) |
| DELETE | `/api/workspaces/:id` | soft delete (30일 보관) |
| POST | `/api/workspaces/:id/test` | 연결 테스트 (healthCheck + capabilityCheck) |
| POST | `/api/workspaces/:id/restore` | 삭제 복원 |
| POST | `/api/workspaces/test-all` | 일괄 재검사 |
| GET | `/api/workspaces/deleted` | soft-deleted 목록 |
| GET | `/api/status` | 서버 상태, 도구 수, 활성 세션 |
| GET | `/api/diagnostics` | 에러 로그 + audit log |
| GET | `/api/tools` | 노출된 모든 도구 목록 |
| GET | `/api/connect-info` | Connect Guide용 서버 정보 |
| GET | `/api/export` | 설정 export (credentials 제외) |
| POST | `/api/import` | 설정 import |

### 5.3 토큰 갱신 (env / headers / credentials)

PUT 요청 시 빈 값이거나 마스킹된 값(`***` 포함)은 무시됨 → 기존 값 유지. 새 값만 전달:

```bash
# Notion 토큰만 갱신
curl -X PUT http://localhost:3100/api/workspaces/notion-personal \
  -H "Content-Type: application/json" \
  -d '{"credentials": {"token": "ntn_NEW..."}}'

# stdio env 변수만 갱신
curl -X PUT http://localhost:3100/api/workspaces/stdio-github \
  -H "Content-Type: application/json" \
  -d '{"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_NEW..."}}'
```

---

## 6. 클라이언트 연결

### 6.1 Claude Code (`.mcp.json`)

프로젝트 루트의 `.mcp.json`:

```json
{
  "mcpServers": {
    "bifrost": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

MCP 토큰을 설정한 경우:

```json
{
  "mcpServers": {
    "bifrost": {
      "url": "http://localhost:3100/mcp",
      "headers": { "Authorization": "Bearer <BIFROST_MCP_TOKEN>" }
    }
  }
}
```

> 💡 `npm run tunnel` 실행 시 `.mcp.json` 이 자동 생성됩니다.

### 6.2 claude.ai (Remote Connector)

1. Bifrost 외부 노출 (`npm run tunnel` 또는 reverse proxy)
2. claude.ai → Settings → Connectors → Add Custom Connector
3. URL 입력: `https://your-tunnel.trycloudflare.com/sse`
4. (MCP 토큰 설정 시) Authorization 헤더 추가

Bifrost Admin UI 의 **Connect 탭**에서 자동 생성된 URL을 복사하면 됩니다.

### 6.3 curl (수동 테스트)

```bash
# initialize
curl -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# tools/list
curl -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# tools/call (예: filesystem 의 read_file)
curl -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{"name":"stdio_my-docs__read_file","arguments":{"path":"/tmp/test.txt"}}
  }'
```

### 6.4 Profile 기반 도구셋 제한

`?profile=read-only` 쿼리로 읽기 전용 도구만 노출:

```bash
curl -X POST 'http://localhost:3100/mcp?profile=read-only' \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 7. 외부 노출 (LAN/Tunnel)

### 7.1 LAN 내부 노출

```bash
BIFROST_HOST=0.0.0.0 \
BIFROST_ADMIN_TOKEN="..." \
BIFROST_MCP_TOKEN="..." \
BIFROST_ADMIN_EXPOSE=1 \
npm start
```

내 IP 확인:
```bash
ipconfig getifaddr en0
# 또는
ifconfig | grep "inet " | grep -v 127.0.0.1
```

다른 PC: `http://10.x.x.x:3100/admin/` 접속.

### 7.2 Cloudflare Tunnel (공인 HTTPS)

```bash
# 1) cloudflared 설치
brew install cloudflare/cloudflare/cloudflared

# 2) Bifrost 기동
npm start

# 3) 별도 터미널에서 tunnel 시작
npm run tunnel
# → https://bifrost-xxxx.trycloudflare.com 출력
# → .mcp.json 자동 생성
```

이 URL을 claude.ai Custom Connector에 등록.

> ⚠️ Tunnel 사용 시 `BIFROST_MCP_TOKEN` 반드시 설정. Admin은 기본적으로 외부 노출 안 됨 (`BIFROST_ADMIN_EXPOSE=1` 명시 필요).

---

## 8. 보안 권장 설정

### Production 체크리스트

- [ ] `BIFROST_ADMIN_TOKEN` 설정 (32자 이상 랜덤)
- [ ] `BIFROST_MCP_TOKEN` 설정
- [ ] `BIFROST_ALLOWED_COMMANDS` 화이트리스트 (`npx,node,uvx,python3`)
- [ ] Tunnel 사용 시 `BIFROST_ADMIN_EXPOSE` **미설정** (Admin은 localhost 전용)
- [ ] `config/workspaces.json` git ignore 확인 (이미 .gitignore 등재)
- [ ] HTTPS / Tunnel을 통해서만 외부 노출 (평문 HTTP 비공개 LAN 외 금지)

### 보안 모델 요약

| 자원 | 인증 | 외부 노출 |
|------|------|----------|
| `/health` | 없음 | 항상 가능 |
| `/mcp`, `/sse` | `BIFROST_MCP_TOKEN` (있을 때) | `BIFROST_HOST=0.0.0.0` 시 가능 |
| `/api/*`, `/admin/*` | `BIFROST_ADMIN_TOKEN` (있을 때) | `BIFROST_ADMIN_EXPOSE=1` 명시 필요 |
| stdio 자식 프로세스 spawn | `BIFROST_ALLOWED_COMMANDS` 화이트리스트 (선택) | — |

> ⚠️ Admin API는 임의 명령(stdio command)을 등록할 수 있으므로 RCE 표면입니다. 가능하면 localhost 전용 + command 화이트리스트 사용.

> ⚠️ **공유 서버 배포 시 stdio 자제**: stdio MCP 서버는 Bifrost 서버 머신의 자원(파일/env)에 접근하므로, 클라이언트가 여러 명인 환경에서 stdio Filesystem 등을 등록하면 모든 사용자가 같은 파일을 보게 됩니다. 자세한 내용은 [§4.3 스코프](#43-스코프--어느-머신의-자원에-접근하나).

---

## 9. 테스트 시나리오

### 9.1 단위 테스트

```bash
npm test
# → 60 tests passing
```

특정 phase 만:
```bash
node --test tests/phase5.test.js
```

### 9.2 Mock MCP 서버로 종단 테스트

```bash
# 1. Bifrost 기동
npm start

# 2. Mock 서버 등록 (별도 터미널)
curl -X POST http://localhost:3100/api/workspaces \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "kind": "mcp-client",
  "transport": "stdio",
  "displayName": "Mock",
  "command": "node",
  "args": ["$(pwd)/tests/fixtures/mock-mcp-server.js"]
}
EOF
)"

# 3. tools/list 확인
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq

# 4. echo 도구 호출
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"stdio_mock__echo","arguments":{"message":"hi"}}}' | jq

# 5. 크래시 복구 테스트 (crash 도구는 자식 프로세스를 강제 종료)
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stdio_mock__crash","arguments":{}}}'
# 이후 echo 호출 시 자동 재시작 후 정상 응답
```

### 9.3 Mock MCP 서버 도구

| 도구 | 동작 |
|------|------|
| `echo` | 입력 메시지 그대로 반환 |
| `add` | 두 숫자 합 |
| `fail_once` | 1회차 isError, 이후 성공 |
| `crash` | 자식 프로세스 강제 종료 (재시작 테스트용) |
| `slow` | 200ms sleep 후 응답 |

### 9.4 실제 MCP 서버로 통합 테스트

```bash
# Filesystem MCP (npx 자동 설치)
curl -X POST http://localhost:3100/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "mcp-client",
    "transport": "stdio",
    "displayName": "Tmp",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  }'

# 잠시 대기 (npm 다운로드 + spawn)
sleep 5

# tools/list 에 fs 도구들 노출 확인
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq '.result.tools | map(.name)'
```

---

## 10. 트러블슈팅

### "Workspace status: error"
- Detail 에서 `Test Connection` 클릭 → 에러 메시지 확인
- stdio: command 경로 오류, env 누락 가능성
- http/sse: URL/auth 오류, 네트워크 차단

### "tools/list 에 새 도구가 안 보임"
- Bifrost 가 워크스페이스 등록 직후 백그라운드로 `tools/list` 캐시함 (1~2초 소요)
- `POST /api/workspaces/:id/test` 명시적 재검사

### stdio 자식 프로세스가 계속 죽음
- Diagnostics API에서 에러 로그 확인: `GET /api/diagnostics`
- 자동 재시작은 5회까지 (exponential backoff). 그 이후엔 수동 `Test Connection` 필요
- stderr ring buffer는 provider 인스턴스에 보관 — 향후 Admin UI에 노출 예정

### MCP Token 설정했는데 401
- `Authorization: Bearer <token>` 헤더 확인
- 또는 쿼리 `?token=<token>` 도 가능 (SSE 일부 클라이언트용)

### Admin UI 가 외부 PC에서 안 열림
- `BIFROST_ADMIN_EXPOSE=1` 환경변수 추가 후 재기동
- 보안상 권장하지 않음 — 가능하면 SSH tunnel로 우회

### "Command not allowed"
- `BIFROST_ALLOWED_COMMANDS` 화이트리스트에 추가 필요
- 또는 화이트리스트 자체를 비활성화 (env 변수 unset)

### `/admin/` 가 빈 화면
- DevTools Console 에러 확인
- 정적 파일 로딩 실패 (서버 재기동 / 캐시 무효화)
- ESM import 실패 시 브라우저 콘솔에 모듈 경로 표시됨

---

## 부록: 폴더 구조 / 설정 파일

### `config/workspaces.json` 스키마

```json
{
  "workspaces": [
    {
      "id": "stdio-fs-home",
      "kind": "mcp-client",
      "provider": "stdio",
      "namespace": "fs-home",
      "alias": "fs-home",
      "displayName": "내 문서",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"],
      "env": {},
      "enabled": true,
      "toolFilter": { "mode": "all", "enabled": [] }
    },
    {
      "id": "notion-personal",
      "kind": "native",
      "provider": "notion",
      "namespace": "personal",
      "alias": "personal",
      "displayName": "개인 Notion",
      "credentials": { "token": "ntn_..." },
      "enabled": true,
      "toolFilter": { "mode": "all", "enabled": [] }
    }
  ],
  "server": { "port": 3100 },
  "tunnel": { "enabled": false, "fixedDomain": "" }
}
```

### Hot reload
`config/workspaces.json` 직접 편집해도 `fs.watch()` 로 감지하여 즉시 반영. 단 안전한 업데이트는 Admin UI / API 사용 권장 (원자적 쓰기 + audit log).

### 백업
저장 시 `workspaces.json` → `workspaces.backup.json` 자동 백업 (1세대만). `workspaces.tmp.json` → `rename()` 으로 atomic write.

---

## 11. OAuth 2.0 원격 MCP 서버 (Phase 6)

Notion 공식 hosted MCP (`https://mcp.notion.com/mcp`) 같은 OAuth-only 원격 MCP 서버는 **OAuth 2.0 Authorization Code + PKCE** 로 인증합니다.

### Single-User 전제 (중요)

Bifrost 는 단일 사용자 시나리오 전제로 설계되었습니다. OAuth 로 받은 access_token 은 Bifrost 인스턴스 전체가 공유하므로, 여러 사용자가 같은 Bifrost 엔드포인트를 공유하면 서로의 Notion 데이터에 접근할 수 있습니다. **사용자별 Bifrost 인스턴스 분리**를 권장합니다.

### Wizard 로 등록

1. Admin UI → `+ Add Workspace` → **Notion (공식 MCP · OAuth)** 템플릿 선택
2. Display Name 입력 → 다음 단계 → 자동으로 discovery + DCR 실행
3. 팝업에서 Notion 로그인 + 페이지 선택 + `Accept`
4. 팝업이 닫히면 Admin UI 가 자동으로 완료 화면으로 이동

### 수동 client_id 입력 (DCR 미지원 서버)

DCR 을 지원하지 않는 서버라면 운영자 측에서 Bifrost 를 사전 등록해 `client_id`(필요 시 `client_secret`)를 받은 뒤:

```bash
curl -X POST http://localhost:3100/api/workspaces/{id}/authorize \
  -H "Authorization: Bearer $BIFROST_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "manual": {
          "clientId": "preset_client_id",
          "clientSecret": "optional_secret",
          "authMethod": "client_secret_basic"
        }
      }'
```

응답의 `authorizationUrl` 을 브라우저에서 열면 동일한 flow 가 이어집니다.

### Re-authorize

Detail 화면 > OAuth 패널 > **Re-authorize** 버튼. refresh_token 이 만료/revoke 되어 상태가 `action_needed` 로 바뀌면 이 버튼을 사용합니다.

### 토큰 갱신 동작

- Access token 은 만료 60초 전 leeway 로 자동 refresh
- Per-workspace mutex 로 동시 호출 직렬화 (30s timeout)
- Refresh token rotation 지원 (OAuth 2.1 권장): 응답에 `refresh_token` 이 있으면 자동 교체
- 갱신 실패 → 워크스페이스 `action_needed` + Admin UI 배너

### 보안

- `config/workspaces.json`, `.ao/state/oauth-*.json`, `.ao/state/server-secret` 은 POSIX 에서 `chmod 0600` 강제
- Windows 는 파일 권한 보호가 제한적이므로 **공유 PC 사용 자제** — Admin UI 상단에 경고 배너 자동 노출
- 로그 sanitize: `Authorization: Bearer`, `access_token=`, `refresh_token=`, `code=`, `client_secret=` 패턴을 정규식으로 `***` 치환
- Audit 이벤트 (`GET /api/oauth/audit`) 는 토큰 값을 기록하지 않고 `tokenPrefix` 등 메타만 남김

### Remote Admin UI (SSH tunnel 권장)

OAuth flow 는 **localhost 브라우저 + localhost Admin UI** 조합에서만 공식 지원합니다. 원격 Bifrost 를 운영할 때는 SSH tunnel 로 localhost 체감을 만드세요:

```bash
# 로컬 머신에서
ssh -L 3100:localhost:3100 user@bifrost-host
# 이후 로컬 브라우저로 http://localhost:3100/admin/ 접속 → Authorize 팝업 정상 동작
```

외부에 `0.0.0.0` 로 바인딩된 Bifrost 에 다른 네트워크 브라우저로 직접 접근하면 redirect_uri(`http://localhost:3100/oauth/callback`)가 해석되지 않아 실패합니다.

### 수동 E2E 검증

`docs/NOTION_E2E_CHECKLIST.md` 참고.

### 통합 테스트 (선택)

```bash
# 첫 실행 — discovery 만 검증 (토큰 불필요)
BIFROST_TEST_NOTION_OAUTH=1 npm test

# refresh_token 확보 후 반복 실행
BIFROST_TEST_NOTION_OAUTH=1 \
BIFROST_TEST_NOTION_CLIENT_ID=dyn_abc \
BIFROST_TEST_NOTION_REFRESH_TOKEN=RT.xxx \
  npm test
```

환경변수가 없으면 integration 테스트는 자동 skip 됩니다.

---

질문/이슈는 README의 링크를 따라가세요.
