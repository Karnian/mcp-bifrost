# Notion OAuth 수동 E2E 체크리스트

Phase 6 구현을 실제 Notion 계정으로 검증하는 체크리스트.
사용자가 직접 수행하여 결과를 기록합니다.

## 준비물

- Notion 계정 (Member 권한 이상) × 최소 2개 (다중 워크스페이스 검증용)
- Bifrost 기동 환경 (POSIX 권장)

## 체크리스트

```
[ ]  1. Bifrost 기동 (localhost only, admin/mcp 토큰 미설정이어도 가능)
        $ npm start
        
[ ]  2. 브라우저로 http://localhost:3100/admin/ 접속

[ ]  3. Wizard → "Notion (공식 MCP · OAuth)" 템플릿 선택 → Display Name 입력

[ ]  4. "연결 테스트 & 저장" 진행 → Discovery + DCR 자동 실행 확인

[ ]  5. "Authorize with Notion" 팝업 → Notion 로그인 → 페이지 선택 → Accept

[ ]  6. 팝업 자동 닫힘 후 Admin UI 가 완료 화면으로 진입 → Dashboard

[ ]  7. Dashboard 카드: ● Healthy + "MCP · http" 배지 + namespace 표시

[ ]  8. Detail 화면:
        - OAuth 2.0 패널 노출 (issuer, client_id 마스킹, 만료까지 N분, last refresh)
        - credentials 편집 UI 는 숨겨짐 (URL readonly)
        - "Re-authorize" 버튼 존재

[ ]  9. Tools 탭: notion-* 도구 목록 노출 (search, query_database, get_page 등)

[ ] 10. curl 로 tools/call 호출 → 정상 응답
        $ curl -X POST http://localhost:3100/mcp \
          -H "Content-Type: application/json" \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
               "params":{"name":"notion-<alias>__search","arguments":{"query":"test"}}}'

[ ] 11. 두 번째 Notion 워크스페이스 (다른 계정) 등록 →
        - 네임스페이스 충돌 없이 양쪽 도구 모두 노출
        - issuer cache 덕분에 client_id 가 공유됨 (`.ao/state/oauth-issuer-cache.json` 확인)

[ ] 12. 1시간 대기 후 (또는 `expiresAt` 을 강제로 과거로 조작 후) 재호출:
        → 자동 refresh 성공 + access_token 변경 확인
        → Detail 화면에서 "Last Refresh" 갱신 시각 변경 확인

[ ] 13. Admin UI > Diagnostics 또는 `GET /api/oauth/audit`:
        → `oauth.authorize_start`, `oauth.authorize_complete`,
          `oauth.refresh_success` 이벤트 기록 확인 (토큰 값 없음, tokenPrefix 만)

[ ] 14. `stat config/workspaces.json` (POSIX) → `-rw-------` (0600) 확인
        Windows 인 경우 Admin UI 상단 경고 배너 표시 확인

[ ] 15. Admin UI / API 응답 어디에도 access_token 전체 문자열 노출 없음
        → 마스킹된 prefix(`AT.xxxx***yyyy`)만 노출되는지 확인

[ ] 16. refresh_token 을 의도적으로 revoke (Notion 설정에서) → /test-all 또는 tools/call:
        → 워크스페이스 상태 `action_needed` 로 전환
        → Dashboard 의 Needs Attention 영역 표시
        → Detail 에서 "Re-authorize" 클릭 → 정상 복구
```

## 실패 시

- 1~6 단계에서 실패: `docs/NOTION_MCP_PROBE.md` 의 실제 응답과 Bifrost discovery 로그 비교
- 12 단계 refresh 실패: `GET /api/oauth/audit` 에서 `oauth.refresh_fail` 메시지 확인
- 14 단계 권한 불일치: 운영자가 `chmod 0o600` 수동 적용 후 원인 점검

## 참고

- 관련 PR: Phase 6a/6b/6c/6d/6e
- 테스트 커버: `tests/phase6a-*.test.js`, `tests/phase6b-*.test.js`, `tests/phase6c-*.test.js`, `tests/phase6e-*.test.js`
- Mock E2E: `tests/phase6e-e2e-mock.test.js` 는 브라우저 없이 동일한 flow 를 자동으로 재현
