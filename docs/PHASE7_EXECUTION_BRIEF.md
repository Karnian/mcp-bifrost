# Phase 7 — Execution Brief

새 세션이 Phase 7 을 자율 실행할 때 필요한 최소 컨텍스트.
`docs/PHASE7_PLAN.md` v1 (Codex REVISE 반영판) 이 source of truth.

---

## 0. 시작 전 확인

```bash
pwd                                         # /Users/K/Desktop/sub_project/mcp-bifrost
git status                                  # master, clean
npm test 2>&1 | tail -5                     # 95 tests passing (Phase 6 기준선)
```

**Read 툴로 먼저 읽을 파일**:
1. 이 파일
2. `docs/PHASE7_PLAN.md` §4 (구현 단계)
3. `docs/PHASE6_SELFREVIEW_LOG.md` (전 phase 컨텍스트 + 발견된 버그)
4. `CLAUDE.md`
5. `server/oauth-manager.js`, `server/workspace-manager.js`, `server/tool-registry.js`, `server/mcp-handler.js`, `providers/mcp-client.js`, `admin/routes.js`

**Codex 가용성 테스트**:
```bash
echo "ping" | node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.0/scripts/ask.mjs codex 2>&1 | head -3
```
- 응답 오면 Codex 사용 가능.
- `demoted: host permission level` 오면 `.ao/autonomy.json` 에 `{ "codex": { "approval": "full-auto" } }` 확인 (이미 설정됨). 그래도 불가하면 self-review 모드로 진행 후 `docs/PHASE7_SELFREVIEW_LOG.md` 기록.

---

## 1. 실행 규칙

### 1.1 Phase 순서 (의존성 기반)

**7e-pre → 7b → 7a / 7d / 7f (병렬) → 7c-pre → 7c → 7e → 7g**

| Phase | 내용 | 소요 |
|-------|------|------|
| 7e-pre | Notion MCP stream probe → `docs/NOTION_STREAM_PROBE.md` | 0.5일 |
| 7a | Profile 엔드포인트 (glob 기반 도구 필터) | 1일 |
| 7b | 다중 MCP 토큰 + ACL (scrypt 해시, `assertAllowed` 헬퍼) | 1.5일 |
| 7d | DCR 미지원 수동 client_id Wizard UI | 0.5일 |
| 7f | Remote MCP 템플릿 확장 (GitHub / Linear / Google Drive) | 0.5일 |
| 7c-pre | **ws.oauth migration shim + tokenProvider 시그니처 확장** ★ gate | 1일 |
| 7c | byIdentity OAuth 격리 | 2일 |
| 7e | HTTP/SSE `notifications/tools/list_changed` 구독 | 2일 |
| 7g | Usage JSONL + audit 파일 로그 + Admin UI 탭 | 2일 |
| 통합 + 회귀 + 수동 E2E | 모두 합친 뒤 검증 | 1일 |
| 버퍼 | 7c+7e+7g 교차 복잡도 | 1일 |
| **총** | | **13일** |

### 1.2 각 Phase 완료 기준
- 관련 체크리스트 모두 체크
- 단위 테스트 작성 + `npm test` 전체 PASS (95 기준선 유지 + 신규 증가)
- **Codex 교차 리뷰** (아래) → PASS
- REVISE/FAIL 시 수정 후 재리뷰
- git commit (phase 단위, 메시지에 "codex PASS" 또는 "self-review PASS")

### 1.3 Codex 교차 리뷰 방법

```bash
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.0/scripts/ask.mjs async codex <<'EOF'
[Phase 7X 완료] docs/PHASE7_PLAN.md 의 해당 phase 체크리스트 대비 누락/모순 리뷰.
구현 파일: [변경된 파일 나열]
테스트 결과: N tests passing
한국어 PASS/REVISE/FAIL + 구체 문제만 500자 이내.
EOF
```

fire 후 `collect <jobId> --wait --timeout 600` 로 회수. Codex 불가 시 `/ask auto` → 그것도 불가면 critical self-review 후 `docs/PHASE7_SELFREVIEW_LOG.md` 에 phase 별 누적 기록.

### 1.4 의사결정 규칙
- SPEC/계획서에 없는 결정 시 Codex 에 의견 묻고 종합해서 결정. **사용자에게 묻지 말고 진행**. 근거를 commit message 에 기록.
- 의사결정이 계획서 수정을 요구하면 PHASE7_PLAN.md 도 같이 업데이트.

### 1.5 Commit 규칙
- Phase 완료 단위 commit. Co-Authored-By 라인 유지.
- 예: `feat(phase7b): mcp token manager + ACL assertAllowed (codex PASS)`

### 1.6 막혔을 때
- 2시간 이상 막히면 진단 로그 남기고 중단 → 사용자 보고
- 파괴적 동작 금지

---

## 2. 각 Phase 핵심 체크포인트

### 7e-pre
- 산출물: `docs/NOTION_STREAM_PROBE.md`
- `GET https://mcp.notion.com/mcp` 에 Accept: text/event-stream 보내고 응답 확인
- `Mcp-Session-Id` 헤더 / content-type 확인
- 결과가 spec 과 어긋나면 7e 체크리스트 업데이트

### 7a — Profile
- `config/workspaces.json > server.profiles` 내부 저장 (승인된 기본값)
- `tool-registry.getTools({ profile })` glob 매칭 (`*search*` → minimatch 스타일)
- Admin UI "Profiles" 탭

### 7b — MCP 토큰 + ACL (핵심)
- `server/mcp-token-manager.js` — `crypto.scrypt` + `timingSafeEqual`
- 토큰 발급 시 plaintext 1회만 노출, 저장은 해시만
- `server/mcp-handler.js:74` 에 `assertAllowed(identity, profile, workspaceId, toolName?)` 헬퍼 추가
- tools/call, resources/*, prompts/* 전부 `assertAllowed` 호출
- Legacy `BIFROST_MCP_TOKEN` (단수) → `identity="legacy"`, `allowedWorkspaces=*`, `allowedProfiles=*`
- PR 체크리스트: `grep -n assertAllowed server/mcp-handler.js` 로 모든 call-site 검증

### 7c-pre — Migration Shim (gate)
- `ws.oauth.byIdentity` 스키마 도입, 기존 `ws.oauth.tokens` 는 `byIdentity.default.tokens` 와 동기화되는 보조 미러로 유지
- Atomic migration (`_save()` 패턴)
- `OAuthManager` 의 tokens read/write 전부 `byIdentity[identity || 'default']` 경유로 통일
- `tokenProvider` 시그니처 `(identity?) => Promise<string|null>`
- `oauthActionNeeded` bool → `oauthActionNeededBy: { [identity]: true }` 맵
- **Gate**: `npm test` 95건 전수 통과. 1건이라도 실패 시 7c 착수 금지.

### 7c — byIdentity 격리
- `initializeAuthorization(workspaceId, { identity, ... })`, `getValidAccessToken(wsId, identity)`, `forceRefresh(wsId, identity)`
- Mutex 키 `${wsId}::${identity}`, default identity 는 `${wsId}::default` 로 통일 (Phase 6 테스트 호환)
- per-identity warm-up 차단 (Phase 6 의 warmup→action_needed 오검출 재발 방지)
- Admin UI Detail: byIdentity 탭 + identity 선택 authorize

### 7d — 수동 DCR Wizard UI
- Wizard Step 3 에서 `/api/oauth/discover` 응답의 `dcrSupported=false` 분기
- Client ID / Client Secret / Auth method 폼
- `/api/workspaces/:id/authorize` body 의 `manual` 필드 재사용

### 7e — SSE subscription
- `providers/mcp-client.js` 에 GET stream 오픈 + `Mcp-Session-Id` 관리
- 파싱 후 `notifications/tools/list_changed` → `toolsCache` 무효화 + `onToolsChanged`
- 401 재연결, exponential backoff (30s → 5min)

### 7f — 템플릿 확장
- `admin/public/templates.js` 에 `github-oauth`, `linear-oauth`, `google-drive-oauth` (URL 미정이면 stub + README 안내)
- `scripts/probe-templates.mjs` 수동 검증

### 7g — Usage + Audit
- `server/usage-recorder.js` + `.ao/state/usage.jsonl` (append, chmod 0600, 10MB rotation, 30일 보관)
- `server/audit-logger.js` + `.ao/state/audit.jsonl`
- `mcp-handler.tools/call` 전후 record
- Admin UI "Usage" / "Audit" 탭

---

## 3. 완료 체크리스트 (Phase 7 전체)

- [ ] 7e-pre: NOTION_STREAM_PROBE.md + Codex PASS
- [ ] 7a / 7b / 7d / 7f: 각 Codex PASS + commit
- [ ] 7c-pre: `npm test` 95건 전수 통과 gate + Codex PASS + commit
- [ ] 7c: 2 identity E2E (mock) + Codex PASS + commit
- [ ] 7e: stream notification 전파 테스트 + Codex PASS + commit
- [ ] 7g: usage JSONL 동시성 + rotation + Codex PASS + commit
- [ ] 최종: `npm test` ≥ 135 PASS
- [ ] 최종: `docs/NOTION_STREAM_PROBE.md`, `docs/PHASE7_SELFREVIEW_LOG.md`, `docs/PHASE7_E2E_CHECKLIST.md` (14항목), `docs/TOKEN_RECOVERY.md`
- [ ] 최종: `README.md` Single-User 경고 → 선택사항 으로 전환
- [ ] 최종: Phase 7 전체 Codex 통합 리뷰 PASS
- [ ] 최종: 사용자에게 결과 보고 + 수동 E2E 체크리스트 전달

---

## 4. 실패 복구

| 상황 | 대응 |
|------|------|
| 테스트 실패 | 원인 분석 → 수정 → 재실행. 3회 실패 시 진단 로그 + 다음 phase 중단 |
| 7c-pre gate 실패 | **7c 착수 금지**. migration shim 버그 분석, PHASE7_PLAN.md 업데이트 후 재실행 |
| Codex 권한 부족 | `.ao/autonomy.json` 확인 → `/ask auto` → self-review |
| Notion API 변경 | NOTION_MCP_PROBE + STREAM_PROBE 업데이트 후 진행 |
| Git 충돌 | 사용자 보고 (자동 resolve 금지) |

---

## 5. 확정된 기본값 (사용자 승인)

- MCP 토큰 해시: `crypto.scrypt` + `timingSafeEqual`
- Usage JSONL 보관 **30일**, 10MB rotation
- Profile 정의: `config/workspaces.json > server.profiles`
- 추가 provider 템플릿: GitHub / Linear / Google Drive 모두 포함
- Legacy `BIFROST_MCP_TOKEN`: `identity="legacy"`, `allowedWorkspaces=*`, `allowedProfiles=*`

---

## 6. 주요 참고 파일

- `docs/PHASE7_PLAN.md` — 상세 계획 v1 (source of truth)
- `docs/PHASE6_SELFREVIEW_LOG.md` — 전 phase 컨텍스트
- `docs/NOTION_MCP_PROBE.md` — Phase 6-pre probe (스타일 참고)
- `docs/NOTION_E2E_CHECKLIST.md` — Phase 6 E2E (형식 참고)
- `CLAUDE.md` — 프로젝트 코딩 규칙

끝. 이 브리프만으로 실행 가능해야 함.
