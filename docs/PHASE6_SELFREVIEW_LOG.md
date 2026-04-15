# Phase 6 Self-Review Log

Codex/Gemini 가용 불가 상태 (`demoted: host permission level (suggest) too low`) — 이 파일에 self-review 기록.

---

## 6-pre (2026-04-15) — PASS

**체크리스트 대비**:
- [x] `curl POST https://mcp.notion.com/mcp` → 401 + WWW-Authenticate 확인
- [x] `Mcp-Session-Id` 헤더: 401 단계 없음 (인증 후 재확인 6e 로 이관). `_rpcHttp` 는 이미 JSON+SSE 양쪽 파싱
- [x] WWW-Authenticate 포맷: RFC 6750 + RFC 9728 `resource_metadata` 파라미터 포함 (path-specific URL)
- [x] `/.well-known/oauth-protected-resource` (호스트 루트 + path-specific `/mcp`) 양쪽 응답 확인
- [x] `/.well-known/oauth-authorization-server` 응답 → DCR 지원, `token_endpoint_auth_methods_supported` 에 `none` 포함, S256 지원
- [x] `docs/NOTION_MCP_PROBE.md` 생성 (raw 응답 + 결정 사항)
- [x] 6c 에 SSE stream 추가 작업 불필요 — 기존 `providers/mcp-client.js:146` 재사용
- [x] 6a 에 `resource_metadata` 2단계 fallback 추가 (WWW-Authenticate 명시 URL 우선, 호스트 루트 fallback)

**결론**: PASS. Phase 6a 착수 가능. Notion MCP 가 표준 spec 을 깨끗하게 구현해서 추가 설계 변경 없음.

---

## 6a (2026-04-15) — PASS

**구현 파일**:
- 신규: `server/oauth-sanitize.js`, `server/oauth-manager.js`, `tests/phase6a-discovery.test.js`
- 수정: `server/workspace-manager.js` (chmod, oauth 필드, sanitize, oauth audit 분리)

**체크리스트 대비**:
- [x] `.well-known/oauth-protected-resource` fetch — WWW-Authenticate 힌트 → path-specific → host root 3단계
- [x] `.well-known/oauth-authorization-server` fetch + openid-configuration fallback
- [x] DCR (RFC 7591) — client_name, redirect_uris, grant_types, response_types, auth_method
- [x] DCR fallback: `DCR_UNSUPPORTED` / `DCR_FAILED` 에러 코드 + `registerManual()` (6d Admin UI 가 fallback 폼 연결)
- [x] Issuer cache: `${issuer}::${authMethod}` key, `.ao/state/oauth-issuer-cache.json`
- [x] workspaces.json 의 `oauth` 필드: enabled, issuer, clientId, clientSecret, authMethod, resource, metadataCache, tokens
- [x] chmod 0o600: CONFIG_PATH, BACKUP_PATH, TMP_PATH, issuer-cache, pending, server-secret 전부 — Windows 는 skip + `fileSecurityWarning=true`
- [x] 로그 sanitize: `logError`/`logAudit` 가 sanitize 통과시킴. 패턴: Bearer 값, access_token/refresh_token/client_secret/code/code_verifier (url/form/json 형식)
- [x] MCP spec: `resource=` 파라미터 — authorize URL + token 요청 양쪽에서 전달
- [x] Error 케이스: resource metadata 없음, auth server 없음, registration 거부 등

**테스트**: 12 new tests. 전체 72/72 PASS (기준선 60 + 6a 12).

**비고**: 기존 `providers/mcp-client.js:_rpcHttp` 가 이미 SSE+JSON 양쪽 파싱 지원 → 6c 에서 추가 스트림 파싱 작업 없음.
