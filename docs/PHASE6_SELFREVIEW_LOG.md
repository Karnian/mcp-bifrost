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
