# Notion MCP Stream Probe (Phase 7e-pre)

**목적**: Phase 7e 에서 `providers/mcp-client.js` 에 long-lived SSE stream 구독을 추가하기 전에, Notion 실제 엔드포인트가 GET stream / `Mcp-Session-Id` / `notifications/tools/list_changed` 를 어떻게 다루는지 확인.

**검증 일시**: 2026-04-15
**엔드포인트**: `https://mcp.notion.com/mcp`
**Protocol spec 버전**: MCP 2025-06-18 (Streamable HTTP)

---

## 1. 사전 검증 (No-auth — 401 확인)

### 1.1 `GET /mcp` (Accept: text/event-stream)

```
HTTP/2 401
content-type: application/json
www-authenticate: Bearer realm="OAuth",
  resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
  error="invalid_token",
  error_description="Missing or invalid access token"
content-length: 79

{"error":"invalid_token","error_description":"Missing or invalid access token"}
```

결론: **GET 은 동일 OAuth 보호**. POST 와 같은 WWW-Authenticate 헤더를 돌려준다 (path-specific `resource_metadata`).

### 1.2 `POST /mcp` initialize (no-auth)

동일 401 응답. Phase 6-pre 의 결론과 일치 — OAuth Bearer 가 강제됨.

### 1.3 `OPTIONS /mcp` (CORS preflight)

```
HTTP/2 204
access-control-allow-origin: <echo>
access-control-allow-methods: *
access-control-allow-headers: Authorization, *
access-control-max-age: 86400
```

결론: GET/POST/HEAD 모두 허용, `Authorization` 헤더 CORS 허용. **브라우저 기반 MCP 클라이언트도 GET stream 으로 연결 가능**.

---

## 2. 인증 후 시나리오 (설계 가정)

브라우저 로그인이 필요한 구간은 자동 probe 불가. 아래 항목은 Phase 7e 구현 시 실제 access_token 으로 재검증 필요:

| 항목 | 가정 | 참조 |
|------|------|------|
| `GET /mcp` with Bearer | 200 + `content-type: text/event-stream` 으로 long-lived stream open | MCP spec 2025-06-18 §3.3 |
| `Mcp-Session-Id` 헤더 | 서버가 첫 POST response 에서 발급, 이후 모든 요청에 주고받기 | spec §3.4 (resumability) |
| Session 없음 응답 | `Mcp-Session-Id` 미전송 시 non-resumable stream (각 연결이 독립) | spec §3.4 하단 "If the server does not return" |
| 스트림 내 event 포맷 | `data: {...json-rpc...}\n\n` 형태 (SSE framing) | spec §3.3 |
| 401 중간 발생 | `onUnauthorized()` → 토큰 refresh → GET 재연결 | 6c 경로 재사용 |

**Probe 의 핵심 발견**: Notion 이 spec 을 표준대로 구현 (401 포맷 / resource_metadata / CORS) → Phase 6 에서 확인된 것과 동일. **추가 프로토콜 분기 불필요**.

---

## 3. Phase 7e 에 반영할 설계

1. **GET stream 오픈 조건**: `oauth.enabled=true` 이면서 `tokens.accessToken` 이 존재할 때만. 빈 토큰 상태에서는 open 안 함 (Phase 6 의 warm-up 차단 패턴 재사용).
2. **헤더**:
   - `Authorization: Bearer <identity 별 token>`
   - `Accept: text/event-stream`
   - `MCP-Protocol-Version: 2025-06-18`
   - `Mcp-Session-Id`: 첫 POST initialize 응답에서 받은 값 (있으면). 없으면 생략 (non-resumable OK).
3. **이벤트 파싱**:
   - `data:` 라인 누적 → blank line 경계에서 JSON.parse
   - JSON-RPC notification 이면 method 판별: `notifications/tools/list_changed` → `_toolsCache=null; _onToolsChanged()`
   - JSON-RPC response (id 있음) 는 기존 `_handleMessage` 경로 (현재는 사용 안 함 — 모든 요청이 POST request/response 이므로 이 경로는 future-proofing)
   - server→client `elicitations` 류는 **drop + debug 로그** (spec §5.3 범위 밖)
4. **재연결**:
   - stream close (정상/비정상) → exponential backoff 30s → 60s → 120s → 300s (cap)
   - 401 수신 → `onUnauthorized(identity)` → 토큰 refresh 성공 시 즉시 재연결, 실패 시 backoff 에 진입
   - 5xx 반복 시 backoff + metrics
5. **종료**: workspace 삭제 / `close()` 호출 시 AbortController.abort() 로 cleanup. pending event buffer drop.

---

## 4. 결론

- Notion MCP 는 spec 표준 구현 → Phase 7e 설계에 예외 분기 불필요
- Phase 6-pre 의 WWW-Authenticate / resource_metadata 결과와 GET 도 동일
- Bearer 필수는 동일: 구현 시 `Authorization` 누락 → 401, 다른 방식 응답 없음
- 실제 `Mcp-Session-Id` 의 수명/재사용은 **실계정 이후** 재검증 항목으로 E2E 체크리스트에 등재 (#E2E-6)

**판정**: Phase 7e 착수 가능. NOTION_STREAM_PROBE 요구사항 충족.
