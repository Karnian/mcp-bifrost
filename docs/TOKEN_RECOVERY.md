# MCP 토큰 복구 가이드

Phase 7b 에서 도입된 MCP 토큰은 **plaintext 를 발급 시 1회만 노출**하고 이후에는
`scrypt` 해시만 저장합니다. 토큰 원본을 잃어버렸을 때의 복구 절차입니다.

## 원칙

- Plaintext 는 복구 **불가능** 합니다. 해시에서 원본을 되돌릴 수 없고, Bifrost
  는 의도적으로 plaintext 를 저장하지 않습니다.
- 분실 = **revoke 후 재발급**. 새 plaintext 를 생성하고 MCP 클라이언트 설정을
  교체하세요.

## 복구 절차

1. **Admin UI 로 접속** (로컬에서 `http://localhost:3100/admin/`).
2. **Tokens 탭** 으로 이동. 분실된 토큰 row 에서:
   - `Rotate` 버튼 → 기존 id 유지, 새 plaintext 발급. 기존 plaintext 는 즉시
     무효화됩니다.
   - 또는 `Revoke` → 삭제 후 `+ Issue Token` 으로 새로 발급.
3. 화면 상단 녹색 배너에서 **새 plaintext 를 1회 노출** 합니다. 즉시 복사하세요.
4. **MCP 클라이언트 설정 교체**:
   - Claude Code: `.mcp.json` 의 `Authorization: Bearer <OLD>` → `<NEW>`
   - claude.ai Custom Connector: URL 의 `?token=` 또는 Authorization 헤더 갱신
   - Cloudflare Tunnel: 클라이언트 쪽 Authorization 만 교체 (Tunnel 서버는
     토큰을 보지 않음)
5. 테스트: `curl -H "Authorization: Bearer <NEW>" http://localhost:3100/mcp -d
   '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -H "Content-Type:
   application/json"` → 200 응답 확인.

## 환경변수 경로

환경변수로 등록된 토큰은 파일이 아닌 프로세스 메모리에만 존재합니다.

| 변수 | 복구 방법 |
|------|-----------|
| `BIFROST_MCP_TOKEN` (단수, legacy) | 서버 재시작 전에 `.env`/배포 스크립트에서 확인. 모르면 새로 `openssl rand -hex 32` 로 재설정. |
| `BIFROST_MCP_TOKENS` (복수) | 동일. 포맷은 `id:plaintext[:wsGlob[:profileGlob]]` (쉼표 구분). |

환경변수 토큰은 해시되지 않으므로 `.env` 파일 자체의 권한 관리가 중요합니다.

## 감사 로그 확인

분실/교체 내역은 Admin UI → **Audit** 탭 또는 `.ao/state/audit.jsonl` 에서 `action=token.issue|token.revoke|token.rotate` 로 필터링 가능합니다.

## 보안 권장

- 토큰은 password manager 에 즉시 보관 (plaintext 배너는 1회뿐).
- 여러 클라이언트가 같은 토큰을 공유하지 말 것. 각 클라이언트마다 별도 토큰을
  발급해 `allowedWorkspaces`/`allowedProfiles` 를 세분화하면 유출 시 피해
  최소화.
- 정기 로테이션: 90일마다 `Rotate` 버튼으로 교체하고 감사 로그 리뷰.
