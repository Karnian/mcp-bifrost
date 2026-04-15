# Phase 7 — End-to-End 수동 체크리스트

Phase 7 완료 이후 실계정(Notion 등)으로 수동 검증할 항목입니다. 자동 테스트
(160개) 는 모두 통과하지만, 실제 브라우저 + 실계정 flow 는 사람이 확인해야
하는 부분이 있습니다.

사전 준비:
- Bifrost 가 localhost 에서 기동 중 (`npm start`)
- `BIFROST_MCP_TOKEN` 미설정 또는 Admin UI 로 확인
- Notion 계정 + 테스트 페이지 하나

---

## A. MCP 토큰 다중 발급 + ACL (Phase 7b)

- [ ] **#1** Admin UI → **Tokens** 탭 → `+ Issue Token` 으로 토큰 2개 발급:
  - `tok_notion_only` : allowedWorkspaces=`notion-*`, allowedProfiles=`*`
  - `tok_slack_only`  : allowedWorkspaces=`slack-*`, allowedProfiles=`*`
  각각 plaintext 배너에서 `bft_…` 값 복사 후 보관.
- [ ] **#2** `tok_notion_only` 로 `/mcp` `tools/list` 호출 → notion_* 도구만
  반환, slack_* 는 제외.
  ```bash
  curl -H "Authorization: Bearer <tok_notion_only>" \
       -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
       http://localhost:3100/mcp | jq '.result.tools[].name'
  ```
- [ ] **#3** `tok_notion_only` 로 `slack_*__send_message` 호출 시도 →
  `isError: true` + `category: unauthorized` 응답 (2차 ACL 검증 동작).
- [ ] **#4** Tokens 탭에서 `Rotate` 클릭 → 기존 plaintext 로 호출 시 401, 새
  plaintext 로는 200.

## B. Profile 필터 (Phase 7a)

- [ ] **#5** `config/workspaces.json` 의 `server.profiles` 에 `read-only:
  { toolsInclude: ["*search*", "*_get_*"] }` 설정 후 Admin UI → Profiles 탭
  에서 preview 가 매칭 도구 수를 표시하는지 확인.
- [ ] **#6** `/mcp?profile=read-only` 로 `tools/list` → 쓰기 도구
  (`create_page`, `send_message` 등) 가 응답에서 제외되는지 확인.

## C. byIdentity OAuth 격리 (Phase 7c)

- [ ] **#7** Notion workspace 를 Wizard 로 생성 → "Re-authorize" (default
  identity) 로 authorize 완료. Detail 탭 **OAuth 2.0 (byIdentity)** 표에서
  `default` row 에 access token prefix / 만료 시간 표시.
- [ ] **#8** `+ Add identity` 버튼 → 새 identity `bot_ci` 입력 → 브라우저
  팝업에서 다시 로그인 → 완료. 표에 `default` 와 `bot_ci` 두 row 존재,
  accessTokenPrefix 가 서로 다름.
- [ ] **#9** `.ao/state/audit.jsonl` 에 `oauth.authorize_complete` 두 건이
  각각 `identity: "default"`, `"bot_ci"` 로 기록되었는지 확인.

## D. Remote MCP 템플릿 + 수동 DCR (Phase 7d/7f)

- [ ] **#10** Wizard 에서 `GitHub (Remote MCP · OAuth)` 템플릿 선택 → "Add
  Workspace" → OAuth flow 진행 (GitHub 로그인). 성공 시 Detail 에 tokens
  표시.
- [ ] **#11** `google-drive-oauth` 템플릿 선택 → Step 2 에서 URL 필드
  (stub) 에 사용자가 직접 입력 가능한지 확인 (URL 미입력 시 validation
  실패).
- [ ] **#12** DCR 미지원 가상 서버 시나리오: Admin API 로
  `POST /api/workspaces/<id>/authorize` body `{}` → `422 DCR_UNSUPPORTED`.
  body `{ manual: { clientId, clientSecret, authMethod: "client_secret_basic" } }`
  → 200 + authorizationUrl.

## E. Stream notifications (Phase 7e)

- [ ] **#13** Notion MCP workspace authorize 완료 후, **`BIFROST_LOG_LEVEL=debug npm start`**
  으로 서버 재기동. 콘솔에서 `[McpClient:<id>] stream: connecting/connected`
  로그 확인. Notion 쪽에서 도구가 변경되지 않아도 최소 30초 이내 재연결
  시도 (`reconnect scheduled in Nms`) 가 있는지 체크. (기본 `info` 레벨에선
  stream 전이 로그는 silent — 에러/401만 표시됨.)

## F. Usage + Audit (Phase 7g)

- [ ] **#14** 임의 도구 10회 호출 후 Admin UI → **Usage** 탭 → Top Tools /
  Top Identities / Top Workspaces 에 호출 수, 평균 지연, 에러율이 표시됨.
  **Audit** 탭에서 action prefix `oauth.` 필터 시 관련 이벤트만 남고,
  identity 필드가 채워져 있음.

---

## 보조 확인

- `.ao/state/usage.jsonl` 과 `.ao/state/audit.jsonl` 의 파일 권한이
  `600` (POSIX) — `stat -f "%Lp" .ao/state/usage.jsonl` 로 확인.
- Windows 에서 실행 시 Admin UI 상단에 파일 권한 경고 배너 표시.
- 토큰 분실 시나리오: `docs/TOKEN_RECOVERY.md` 절차대로 `Rotate` → 새
  plaintext 로 클라이언트 설정 교체 → 기존 토큰 401 확인.

모든 항목 체크 완료 시 Phase 7 E2E 인증 완료. 실패 항목은 이슈로 트래킹.
