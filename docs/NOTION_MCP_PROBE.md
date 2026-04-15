# Notion MCP Probe — 실제 응답 검증

**날짜**: 2026-04-15
**대상**: `https://mcp.notion.com/mcp`
**목적**: Phase 6 OAuth 설계의 전제 조건 검증 — 실제 Notion MCP 서버가 MCP spec 2025-06-18 의 어떤 변형을 구현하는지 확인

---

## 1. /mcp 엔드포인트 (인증 없이) — 401

### Request
```bash
curl -i -X POST https://mcp.notion.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bifrost-probe","version":"0.1.0"}}}'
```

### Response (핵심 헤더/바디)
```
HTTP/2 401
content-type: application/json
www-authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Missing or invalid access token"

{"error":"invalid_token","error_description":"Missing or invalid access token"}
```

### 관찰
- **Content-Type**: `application/json` (SSE stream 아님) — 401 응답 자체는 JSON
- **Mcp-Session-Id** 헤더: 응답에 **없음** (인증 실패라 세션 미생성)
- **WWW-Authenticate** 포맷: RFC 6750 + RFC 9728 `resource_metadata` 파라미터 포함
- **resource_metadata URL**: path-specific 변형 — `/.well-known/oauth-protected-resource/mcp` (RFC 9728 §3.1 variant, path suffix matches the resource path)
  - 일반적인 호스트 루트 형태(`/.well-known/oauth-protected-resource`)도 별도로 응답함 (§2 참고)
  - Bifrost discovery 는 **두 형태 모두 시도** (path-specific 우선, 404 시 호스트 루트 fallback)
- 성공 응답의 전송 포맷 (JSON vs SSE stream) 은 실제 토큰 확보 후 재검증 필요 — 기존 `_rpcHttp` 는 `Accept: application/json, text/event-stream` 로 양쪽 대응 가능

---

## 2. Resource Metadata (RFC 9728)

### 호스트 루트 (`/.well-known/oauth-protected-resource`)
```json
{
  "resource": "https://mcp.notion.com",
  "authorization_servers": ["https://mcp.notion.com"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Notion MCP (Beta)"
}
```

### Path-specific (`/.well-known/oauth-protected-resource/mcp`)
```json
{
  "resource": "https://mcp.notion.com/mcp",
  "authorization_servers": ["https://mcp.notion.com"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Notion MCP (Beta)"
}
```

### 관찰
- **issuer 와 resource host 가 동일** (`https://mcp.notion.com`) — auth server 분리 없음
- **authorization_servers** 는 단일 항목 → Bifrost 는 첫 항목 선택
- **bearer_methods_supported**: `["header"]` — Authorization 헤더로만 전송 (쿼리/바디 불가)
- `resource_name` 은 metadata 확장 — Bifrost UI 노출에 활용 가능

---

## 3. Authorization Server Metadata (RFC 8414)

### Request
```bash
curl https://mcp.notion.com/.well-known/oauth-authorization-server
```

### Response
```json
{
  "issuer": "https://mcp.notion.com",
  "authorization_endpoint": "https://mcp.notion.com/authorize",
  "token_endpoint": "https://mcp.notion.com/token",
  "registration_endpoint": "https://mcp.notion.com/register",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
  "revocation_endpoint": "https://mcp.notion.com/token",
  "code_challenge_methods_supported": ["plain", "S256"],
  "client_id_metadata_document_supported": true
}
```

### 관찰 — Phase 6 결정 사항
| 항목 | 값 | Bifrost 결정 |
|------|-----|-------------|
| DCR (registration_endpoint) | 지원 ✅ | **6a 자동 DCR 경로 적용**, 수동 fallback 은 선택적 |
| code_challenge_methods | `S256` 지원 ✅ | **S256 사용**, plain 무시 |
| grant_types | `authorization_code`, `refresh_token` | refresh rotation 지원 예상 |
| token_endpoint_auth_methods | `client_secret_basic`, `client_secret_post`, **`none`** | **Public client (`none`) 우선**, PKCE 로 보호 |
| response_modes | `query` | callback URL 의 `?code&state` 형식 |
| revocation_endpoint | `/token` | Phase 6 범위 밖 (후속 작업 가능) |
| openid-configuration | 404 ❌ | OIDC 아님 — 순수 OAuth 2.0 |

### 핵심 결정
1. **Public client + PKCE S256** 로 등록 (auth_method: `none`)
2. DCR 자동화 → 실패 시 수동 Client ID(+Secret) fallback UI 유지 (6a 에 이미 포함됨)
3. Issuer cache key = `("https://mcp.notion.com", "none")` — 같은 Notion 에 여러 워크스페이스 연결 시 client 재사용 가능

---

## 4. Mcp-Session-Id / Streamable HTTP 확인

- **401 응답 단계에서는** Mcp-Session-Id 헤더 없음 (세션 생성 전)
- 성공 시 Streamable HTTP spec 에 따라 `Mcp-Session-Id` 헤더가 내려올 수 있음
- **기존 `_rpcHttp` 는 POST-response JSON 과 SSE 이벤트 스트림 양쪽 파싱**을 이미 구현 (providers/mcp-client.js:146)
- **6c 단계에서 추가 작업**: 없음 (현재 구현으로 충분). 실제 토큰 발급 후 수동 검증 필요 (6e 통합 테스트에서 확인)

---

## 5. 전체 Phase 6 영향 요약

| Phase | 추가 작업 | 비고 |
|-------|----------|------|
| 6a | resource_metadata 경로 **2단계 fallback** (path-specific → host root) | WWW-Authenticate 에 명시된 URL 우선 |
| 6a | Public client (`none`) 기본값 | auth_method 선택 자동 |
| 6b | 특이사항 없음 | 계획대로 |
| 6c | **SSE stream 파싱 추가 작업 없음** — 기존 구현 재사용 | v1 FAIL 8 리스크 해소 |
| 6d | Wizard 에 `notion-official-oauth` 템플릿 (URL 프리셋만) | DCR 자동이라 단순 |
| 6e | 통합 테스트에서 실제 토큰으로 Mcp-Session-Id / stream 재확인 | env 플래그 경로 |

---

## 6. 결론

- Notion MCP 는 MCP spec 2025-06-18 + RFC 9728/8414/7591 표준을 **깔끔하게 구현**
- **DCR 지원 + Public client + S256 PKCE** → Phase 6a 의 자동 경로가 전부 가능
- 추가 리스크 없음 → Phase 6a 시작 가능
