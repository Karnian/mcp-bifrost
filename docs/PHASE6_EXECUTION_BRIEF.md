# Phase 6 — Execution Brief

이 문서는 **새 Claude Code 세션** 이 Phase 6 구현을 자율적으로 실행할 때 필요한 최소 컨텍스트와 절차를 담습니다.
세션 시작 시 이 파일을 먼저 읽고, `docs/PHASE6_PLAN.md` v3 를 source of truth 로 삼으세요.

---

## 0. 시작 전 확인

```bash
pwd                                         # /Users/K/Desktop/sub_project/mcp-bifrost
git status                                  # master, clean (uncommitted 있으면 먼저 정리)
npm test 2>&1 | tail -5                     # 60+ tests passing 확인 (기준선)
cat docs/PHASE6_PLAN.md | head -60          # 계획 v3 확인
```

**Read 툴로 먼저 읽을 파일**:
1. `docs/PHASE6_EXECUTION_BRIEF.md` (이 파일)
2. `docs/PHASE6_PLAN.md` §4 전체 (구현 단계)
3. `CLAUDE.md` (프로젝트 규칙)

실패 시 중단하고 보고.

### Codex 가용성 테스트 (시작 시 1회)
```bash
echo "ping" | node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.0.10/scripts/ask.mjs codex 2>&1 | head -3
```
- 응답 오면 Codex 사용 가능. 이후 phase 마다 Codex 리뷰.
- `demoted: host permission level (suggest) too low` 메시지 오면 → **사용자에게 보고**: "Codex 권한 레벨을 accept 이상으로 올려주세요. 불가 시 self-review 로 대체하고 진행합니다." → 5분 대기 후 진행.
- auto → gemini fallback 도 체크. 둘 다 불가면 self-review only 모드로 진행.

---

## 1. 실행 규칙

### 1.1 Phase 순서 (docs/PHASE6_PLAN.md §4)
1. **6-pre** — Notion 실제 응답 probe → `docs/NOTION_MCP_PROBE.md` 생성
2. **6a** — Discovery + DCR (+ fallback, issuer cache, chmod, sanitize)
3. **6b** — PKCE + state HMAC + pending state 영속
4. **6c** — Token 사용 + refresh mutex(timeout) + rotation + audit
5. **6d** — Wizard OAuth 모드 + Detail Re-authorize + Windows 배너 + 템플릿
6. **6e** — Mock fixture + 단위 테스트 + 실제 Notion 통합 테스트 env 플래그 + 문서

각 phase 마다 task 생성/업데이트 하면서 진행.

### 1.2 각 Phase 완료 기준
- 관련 체크리스트 모두 체크
- 단위 테스트 작성 + 전체 `npm test` 통과 (60 + 증가)
- **Codex 교차 리뷰** (아래 1.3) → PASS
- Codex FAIL 시 수정 후 재리뷰, PASS 받을 때까지 반복
- git commit (phase 단위)

### 1.3 Codex 교차 리뷰 방법

```bash
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.0.10/scripts/ask.mjs codex <<'EOF'
[Phase 6X 완료] docs/PHASE6_PLAN.md 의 해당 phase 체크리스트 대비 구현이 누락·모순 없는지 리뷰해줘.
구현 파일: [변경된 파일 나열]
테스트 결과: N tests passing
한국어 PASS/FAIL + 구체적 문제만. 500자 이내.
EOF
```

**Codex 불가 시 fallback**:
1. `auto` 모드 시도 → 자동으로 gemini fallback
2. 둘 다 실패 시: **critical self-review** 를 제가 직접 수행하고 PASS/FAIL 기록. 이후 다시 ask 시도 가능해지면 재리뷰.
3. self-review 결과는 `docs/PHASE6_SELFREVIEW_LOG.md` 에 phase 별 누적 기록.

### 1.4 의사결정 규칙
- SPEC/계획서에 없는 결정 필요 시 **Codex 에 의견 묻고 내 판단 종합**. 사용자에게 묻지 말고 진행. 근거 간단히 commit message 에 기록.
- 의사결정이 계획서 수정을 요구하면 PHASE6_PLAN.md 도 같이 업데이트.

### 1.5 Commit 규칙
- Phase 완료 단위 commit. 메시지에 Codex 리뷰 PASS 명시.
- 예: `feat(phase6a): OAuth discovery + DCR + issuer cache (codex PASS)`
- Phase 내부에서도 논리 단위로 sub-commit 가능 (예: `oauth-manager 초안`, `sanitize util`) — 단 phase 완료 commit 은 별도로.
- Co-Authored-By 라인 유지.

### 1.6 막혔을 때
- 2시간 이상 막히면 상세 진단 로그 남기고 일시 중단 → 사용자 보고
- 파괴적 동작 금지 (force push, history rewrite, 외부 서비스에 실제 호출 등)

---

## 2. 각 Phase 핵심 체크포인트

### 6-pre
- 산출물: `docs/NOTION_MCP_PROBE.md`
- **첫 항목으로 Mcp-Session-Id 헤더 동작 확인 필수** — 이게 SSE stream 쓰면 6c 작업 추가
- Notion 서버가 보낸 실제 JSON raw 를 문서에 그대로 붙여넣기

### 6a
- 신규 파일: `server/oauth-manager.js` (나머지는 기존 수정)
- `server/oauth-sanitize.js` 공통 유틸 (`sanitize(str)` — 토큰 패턴 마스킹)
- `.ao/state/oauth-issuer-cache.json` 파일 chmod 0o600
- **Cache key = `${issuer}::${authMethod}`**
- Windows 감지: `process.platform === 'win32'` → chmod skip + API 응답에 `fileSecurityWarning: true`

### 6b
- Server secret: `.ao/state/server-secret` (없으면 첫 기동 시 랜덤 생성)
- Pending state file: `.ao/state/oauth-pending.json` chmod 0o600
- Startup purge: `WorkspaceManager.load()` 직후 `_purgeStaleOAuthPending()` 호출
- HMAC state: `HMAC-SHA256(serverSecret, `${random}:${workspaceId}:${issuedAt}`)` + base64url

### 6c
- Mutex: `Map<workspaceId, Promise>` on OAuthManager
- Timeout: `Promise.race([refreshPromise, timeoutPromise(30_000)])`
- Rotation: token 응답의 `refresh_token` 이 있으면 교체, 없으면 유지
- Audit 이벤트: WorkspaceManager.logAudit 확장 — `oauth.*` action 에 `{ issuer, tokenPrefix: 'ey***XYZ' }` 메타만 기록

### 6d
- 템플릿: `admin/public/templates.js` 에 `notion-official-oauth` 추가
- Wizard 새 진입점: "HTTP (OAuth 필요)" 선택지
- Detail view: transport==http && oauth.enabled 이면 credentials 편집 UI 숨김, Re-authorize 버튼 표시
- Windows 경고 배너: 앱 헤더 하단에 한 줄

### 6e
- Mock server: `tests/fixtures/mock-oauth-server.js`
- 단위 테스트: `tests/phase6-oauth.test.js` (15+ cases)
- 통합 테스트: `tests/integration/notion-oauth.test.js` — `BIFROST_TEST_NOTION_OAUTH=1` 일 때만 실행
- 문서 업데이트: `docs/USAGE.md`, `README.md`

---

## 3. 완료 체크리스트 (Phase 6 전체)

- [ ] 6-pre: NOTION_MCP_PROBE.md 생성 + Codex PASS
- [ ] 6a: discovery + DCR + fallback + issuer cache + chmod + sanitize → Codex PASS + commit
- [ ] 6b: PKCE + state HMAC + pending 영속 + purge → Codex PASS + commit
- [ ] 6c: token 사용 + mutex+timeout + rotation + audit → Codex PASS + commit
- [ ] 6d: Wizard OAuth + Detail Re-auth + 템플릿 + Windows 배너 → Codex PASS + commit
- [ ] 6e: mock + 단위 테스트 + integration env + 문서 → Codex PASS + commit
- [ ] 최종: `npm test` 기준선(60+) 유지 + Phase 6 테스트 증가분 확인
- [ ] 최종: Codex 에 **전체 통합 리뷰** 요청 → PASS (불가 시 self-review 최종판)
- [ ] 최종: `docs/PHASE6_SELFREVIEW_LOG.md` 정리 (phase 별 요약만 남기고 세부는 압축)
- [ ] 최종: Notion 수동 E2E 체크리스트 작성 (아래 §5)
- [ ] 최종: 사용자에게 결과 보고

---

## 4. 실패 복구

| 상황 | 대응 |
|------|------|
| 테스트 실패 | 원인 분석 → 수정 → 재실행. 3회 실패 시 진단 로그 남기고 다음 phase 중단 |
| Codex 권한 부족 | self-review 로 대체, 로그 기록 |
| Notion API 변경 감지 | PHASE6_PLAN.md + NOTION_MCP_PROBE.md 업데이트 후 진행 |
| 실제 Notion 토큰 없음 | integration test skip, mock 만으로 진행 |
| Git 충돌 | 사용자 보고 (자동 resolve 금지) |

---

## 5. 주요 참고 파일

- `docs/PHASE6_PLAN.md` — 상세 계획 v3 (source of truth)
- `docs/SPEC.md` — Bifrost 전체 설계
- `CLAUDE.md` — 프로젝트 코딩 규칙
- `providers/mcp-client.js` — 수정 대상 (OAuth 주입)
- `server/workspace-manager.js` — 수정 대상 (oauth 필드, audit)
- `admin/routes.js` — 수정 대상 (/api/workspaces/:id/authorize, /oauth/callback)
- `admin/public/app.js` + `templates.js` — Wizard/Detail UI 수정

---

## 6. Notion 수동 E2E 체크리스트 (6e 완료 시 사용자에게 전달)

이 체크리스트를 `docs/NOTION_E2E_CHECKLIST.md` 에 생성. 사용자가 실제 Notion 계정으로 검증하도록.

```
[ ] 1. Bifrost 기동 (localhost only, 인증 없음)
       $ npm start
[ ] 2. 브라우저로 http://localhost:3100/admin/ 접속
[ ] 3. Wizard → "Notion (공식 MCP)" 템플릿 또는 "HTTP (OAuth)" 수동 선택
       URL: https://mcp.notion.com/mcp
[ ] 4. "연결 테스트 & 저장" 클릭 → discovery 성공 메시지 확인
[ ] 5. "Authorize with Notion" 버튼 → 새 탭 열림 → Notion 로그인 → 페이지 선택 → Accept
[ ] 6. Admin UI 로 돌아와 "완료" 화면 → Dashboard 진입
[ ] 7. Dashboard 카드: ● Healthy + "MCP · http" 배지 + namespace 확인
[ ] 8. Detail 화면: access_token 만료 시간 표시, "Re-authorize" 버튼 보임, client_id 마스킹됨
[ ] 9. Tools 탭: notion-* 도구 목록 노출 확인 (search, query_database, get_page 등)
[ ] 10. curl 로 tools/call 호출 → 정상 응답
       $ curl -X POST http://localhost:3100/mcp -H "Content-Type: application/json" \
         -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<namespace>__search","arguments":{"query":"test"}}}'
[ ] 11. 두 번째 Notion 워크스페이스 (다른 계정) 등록 → 네임스페이스 충돌 없이 동작
[ ] 12. 1시간 대기 (또는 access_token 강제 만료) → 재호출 → 자동 refresh 성공
[ ] 13. Admin UI > Diagnostics: oauth.refresh_success audit 이벤트 기록 확인
[ ] 14. `cat config/workspaces.json` → 토큰 평문이지만 권한 0600 확인 (Unix)
[ ] 15. API 응답 어디에도 access_token 전체 문자열 노출 없음 확인
```

끝. 이 브리프만으로 실행 가능해야 함.
