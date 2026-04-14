# Phase 6 실행 — 새 세션 프롬프트

아래 블록을 새 Claude Code 세션에 그대로 붙여넣기.

---

```
MCP Bifrost 프로젝트에서 Phase 6 (OAuth 2.0 for remote MCP servers) 을 처음부터 끝까지 자율적으로 구현해줘.

## 작업 방식

1. **가장 먼저** `Read` 툴로 다음 3개 파일을 이 순서로 읽어:
   - `docs/PHASE6_EXECUTION_BRIEF.md` (실행 절차 source of truth)
   - `docs/PHASE6_PLAN.md` §4 (구현 단계)
   - `CLAUDE.md` (프로젝트 규칙)
2. 브리프와 계획이 충돌하면 계획이 우선.
3. 각 phase (6-pre, 6a, 6b, 6c, 6d, 6e) 마다:
   - 체크리스트 task 로 생성
   - 하나씩 구현
   - 단위 테스트 작성 + `npm test` 전체 PASS 확인
   - Codex 교차 리뷰 (아래 명령어 사용):
     ```
     node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.0.10/scripts/ask.mjs codex <<'EOF'
     [Phase 6X 완료] docs/PHASE6_PLAN.md 의 6X 체크리스트 대비 누락/모순 리뷰.
     구현 파일: [나열]
     테스트: N passing
     한국어 PASS/FAIL + 구체적 문제만. 500자.
     EOF
     ```
   - Codex FAIL 이면 수정 후 재리뷰 → PASS 받을 때까지 반복
   - Codex 불가 시 auto → gemini fallback → 그것도 불가면 critical self-review 수행 후 `docs/PHASE6_SELFREVIEW_LOG.md` 에 기록
   - **로그 파일이 커지면** (수천 줄) 이전 phase 섹션은 "PASS — 세부는 commit {sha}" 한 줄로 압축
   - PASS 후 git commit (phase 단위, commit message 에 "codex PASS" 또는 "self-review PASS" 명시)
4. 구현 중 계획에 없는 결정이 필요하면:
   - Codex 에 옵션 제시하고 의견 요청
   - Codex 의견 + 본인 판단 종합해서 결정
   - 사용자에게 묻지 말고 진행
   - 근거를 commit message 또는 PHASE6_PLAN.md 업데이트로 기록
5. 각 phase 완료 시 다음 phase 자동 진행. Phase 6 전체 완료 후:
   - `npm test` 모두 PASS 확인 (최소 75 tests)
   - Codex 에 **전체 통합 리뷰** 요청 → PASS 받으면 최종 보고
   - `PHASE6_EXECUTION_BRIEF.md §3` 완료 체크리스트 전부 체크
   - 사용자에게 결과 요약 + Notion 수동 E2E 체크리스트 제공

## 핵심 규칙

- **source of truth**: `docs/PHASE6_PLAN.md` v3 (8.5일 범위, 6-pre ~ 6e)
- **코드 스타일**: Node.js ESM, 빌드 스텝 없음, node --test, CLAUDE.md 준수
- **보안 필수**: chmod 0o600 (Windows skip + 경고), 토큰 로그 sanitize, state HMAC
- **파괴적 동작 금지**: force push, history rewrite, 실제 외부 서비스 대량 호출
- **막히면**: 2시간 이상 막히면 진단 로그 남기고 중단, 사용자 보고
- **언어**: 커뮤니케이션 한국어, 코드는 영어 변수/주석

## 6-pre 시작 시 유의

- Notion MCP (`https://mcp.notion.com/mcp`) 에 `curl` 로 실제 요청 → 응답 형식 확인
- 응답이 SSE stream 이면 `_rpcHttp` 확장 필요 → 6c 체크리스트에 추가
- 결과를 `docs/NOTION_MCP_PROBE.md` 에 기록 (실제 응답 raw 포함)
- 이 단계가 이후 전체 설계 영향 → 반드시 먼저.

## 완료 판정 기준

- [ ] 6-pre ~ 6e 모든 체크리스트 체크
- [ ] `npm test` 75+ tests PASS
- [ ] 각 phase 별 Codex (또는 self-review) PASS
- [ ] git 에 phase 별 commit 6개 이상
- [ ] `docs/NOTION_MCP_PROBE.md`, `docs/PHASE6_SELFREVIEW_LOG.md` 생성
- [ ] `README.md`, `docs/USAGE.md` 에 OAuth 섹션 + Single-User 경고
- [ ] Notion OAuth 수동 E2E 체크리스트 사용자 전달

시작!
```

---

## 프롬프트 사용법

1. `/clear` 로 새 세션 시작
2. 이 문서의 코드 블록 (```내부```) 전체 복사 → 붙여넣기
3. 엔터
4. 자율 실행 시작

세션이 시작되면 먼저 `git status`, `npm test`, `docs/PHASE6_EXECUTION_BRIEF.md` 읽기부터 진행됩니다.

## 일시 중단 / 재개

- 세션 중단 후 재개하려면: 같은 프롬프트 재사용
- 이미 commit 된 phase 는 skip 됨 (git log 확인 후 다음 phase 로)
- `docs/PHASE6_SELFREVIEW_LOG.md` 가 있으면 그걸 읽어서 어디까지 왔는지 파악

## 예상 소요

전체 8.5일 = 단일 세션 기준 하루 단위로 분할 실행 권장:
- Day 1: 6-pre + 6a 절반
- Day 2-3: 6a 완료 + 6b
- Day 4-5: 6c + 6d 일부
- Day 6-7: 6d 완료 + 6e
- Day 8-9: 통합 리뷰 + 문서 + Notion 수동 검증

한 번에 끝내려 하지 말고 phase 별로 쉬면서 사용자 피드백 받을 것.
