# Phase 12 — 자율 실행 Brief

**대상**: 새 세션의 main agent (Claude Code)
**작성일**: 2026-04-29
**전제**: Plan v5 가 Codex round 5 에서 **APPROVE** 받았고, 12-1 부터 implementation 가능한 상태.

---

## 1. 목표

`docs/PHASE12_PLAN.md` 의 10 sub-phases (12-1 ~ 12-10) 를 **순차 구현 + 매번 Codex peer review + commit** 의 cycle 로 끝까지 자율 진행. 사용자 개입은 §6 멈춤 조건에 도달했을 때만.

---

## 2. 작업 환경

| 항목 | 값 |
|---|---|
| Working directory | `/Users/K/Desktop/sub_project/mcp-bifrost` |
| Plan | `docs/PHASE12_PLAN.md` (v5, APPROVED) |
| 코드 스타일 | ESM, Node.js built-in test runner, 한국어 (코드 주석/identifier 는 영어) |
| Test 명령 | `npm test` (전체) — Phase 11 까지 누적 428 통과, 0 fail, 2 skip |
| Lint | 없음 (해당 프로젝트는 Prettier/ESLint 미사용) |
| Git 브랜치 | `main` 직접 commit (이 프로젝트의 관행). branch 도 가능하지만 사용자가 명시 안 함 |
| Codex CLI | `node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" async codex` — 자세한 사용법은 §5 |

---

## 3. Sub-phase 작업 흐름 (표준 cycle)

각 sub-phase 마다 다음 단계를 차례로:

### Step A — Plan 정독
1. `docs/PHASE12_PLAN.md` 의 해당 sub-phase 절 (예: 12-1 = §3 + §4.x 관련 부분) + §6 보안 + §10 Risk 의 관련 항목 정독
2. 관련 기존 코드 read (예: 12-1 = `server/workspace-schema.js`, `server/workspace-manager.js:374`)

### Step B — Implementation
1. 코드 작성 (기존 파일 편집 우선, 신규 파일은 plan 에 명시된 것만)
2. **테스트 우선** — plan §8 의 해당 sub-phase 테스트를 같은 commit 에 포함
3. 코드 주석/identifier 영어, 사용자 향 문서/메시지 한국어
4. 기존 phase (10a/11) 의 mutex / sanitize / audit 인프라 적극 재사용

### Step C — 로컬 검증
1. `npm test` — 신규 테스트 + 기존 테스트 모두 통과 확인
2. 새로 생긴 fail 이 있으면 즉시 root cause 분석 + 수정. `--no-verify` / skip 금지
3. `git status` / `git diff` 로 변경 범위 self-check

### Step D — Codex peer review
1. 다음 명령으로 review job 발행:
   ```bash
   export CLAUDE_PLUGIN_ROOT="/Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3"
   node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" async codex <<'EOF'
   Phase 12-X (sub-phase 이름) implementation review.
   
   ## Working directory
   /Users/K/Desktop/sub_project/mcp-bifrost
   
   ## Plan reference
   docs/PHASE12_PLAN.md §X (관련 섹션)
   
   ## Changed files
   <file1>: <변경 요지 한 줄>
   <file2>: ...
   
   ## Review 관점
   1. plan §X 와의 정합성 (BLOCKER 분류)
   2. Phase 10a/11 인프라 재사용 패턴 일관성
   3. 보안 §6 의 해당 항목 (있다면) 충실도
   4. 테스트 커버리지 (plan §8 의 해당 sub-phase 항목)
   5. 신규 issue (race condition, error path 미처리, etc.)
   
   각 issue 는 [BLOCKER]/[REVISE]/[NIT] 분류. verdict (APPROVE/REVISE/REJECT) 부여.
   한국어, 출처는 file:line 인용.
   EOF
   ```
2. `node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" collect <jobId> --wait --timeout 540` 로 결과 수신
3. **runner 가 auth_failed 로 종료해도 본문은 저장됨** — `grep '"agent_message"' .ao/artifacts/ask/<jobId>.jsonl | tail -1` 로 마지막 메시지 확인

### Step E — Blockers 처리
1. BLOCKER 있으면 즉시 수정 (plan 보완 필요한 경우 plan 도 같이 갱신 — v6, v7 ...)
2. 수정 후 같은 review prompt 로 regression-only round (짧게)
3. 모든 BLOCKER closed 까지 반복. 보통 1~3 rounds 면 수렴
4. REVISE 는 가능하면 같은 commit 에 처리, 시간 초과 시 다음 sub-phase 와 묶어 처리 (plan 13장 체크리스트에 deferred 항목 기록)
5. NIT 은 무시해도 OK — phase 끝나는 시점에 batch 처리

### Step F — Commit
1. 모든 BLOCKER closed + `npm test` green 시 commit
2. Commit message format:
   ```
   feat(phase12): 12-X — <한 줄 요지>
   
   - <bullet 변경점 1>
   - <bullet 변경점 2>
   
   Codex review: <round 수> rounds, <X blockers + Y revises closed>
   Plan: docs/PHASE12_PLAN.md §X
   
   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```
3. plan 의 §13 체크리스트 항목 [x] 갱신 + 같은 commit
4. **push 는 절대 자동으로 하지 말 것** (사용자 확인 필요)

### Step G — Self-review log 누적
1. `docs/PHASE12_SELFREVIEW_LOG.md` (없으면 생성) 에 sub-phase 별 결과 누적:
   - sub-phase 번호 / 산출물 / Codex round 수 / closed blockers 수 / 견적 vs 실제 시간
2. Phase 11 의 `PHASE11_SELFREVIEW_LOG.md` 형식 참고

### Step H — 다음 sub-phase 진행
- 12-1 끝나면 12-2, ... 12-10 까지

---

## 4. 자율 결정 권한 범위

### 자동 결정 (사용자 호출 불필요)
- plan 에 명시된 모든 결정 (§12 의 12-D1 ~ 12-D13)
- plan 에 명시된 모든 데이터 모델 / API 스펙 / mutex 패턴
- 단위 테스트의 구체 케이스 추가 (plan 의 generic 한 명세를 구체화)
- Codex review 의 BLOCKER / REVISE 수정
- commit message / file naming
- 기존 utility (sanitize / audit / mask) 재사용 결정

### 사용자 호출 필요 (§6 멈춤 조건)
- plan 에 없는 트레이드오프가 새로 발견됨 (예: Slack API 가 plan 의 응답 shape 와 다름)
- 3 rounds 이상 review 해도 수렴 안 됨
- `npm test` 가 외부 의존성 (실 Slack endpoint) 없이는 통과 불가능한 시점
- Slack App credential / `BIFROST_PUBLIC_URL` 같은 사용자 input 이 필요한 E2E 테스트 단계
- Phase 12 비범위인 변경이 필요해진 시점 (다른 phase 의 코드 수정 등)

---

## 5. Codex 사용 정확 명령

### Async fire-and-collect
```bash
# 발행
export CLAUDE_PLUGIN_ROOT="/Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3"
node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" async codex <<'EOF'
<prompt 본문>
EOF
# → {"jobId":"ask-codex-...","artifactPath":"...","runnerPid":...}

# 수신 (대기 timeout 9분)
node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" collect <jobId> --wait --timeout 540
```

### auth_failed 처리
runner 가 `auth_failed: Codex process failed` 로 종료해도 **본문은 jsonl 에 저장됨**. 마지막 agent_message 확인:
```bash
grep '"agent_message"' .ao/artifacts/ask/<jobId>.jsonl | tail -1 | head -c 30000
```

### Sync 호출 금지
120s timeout 으로 잘림. async 만 사용.

### 짧은 review 도 async 권장
3 분 timeout 도 sync 로는 잘릴 수 있음. async 로 통일.

---

## 6. 멈춤 조건 (사용자 호출)

다음 중 하나라도 발생하면 **즉시 멈추고 사용자에게 보고**:

1. plan 에 없는 의사결정이 필요해진 트레이드오프 발견
2. Codex review 가 같은 BLOCKER 를 3 rounds 이상 반복 지적 (수렴 실패)
3. `npm test` fail 이 root cause 불명 또는 외부 의존성 (실 Slack) 없이 검증 불가
4. 변경이 plan 의 sub-phase 경계를 넘어감 (다른 sub-phase 영역 수정 필요)
5. Slack App credential / `BIFROST_PUBLIC_URL` / 실 OAuth handshake 가 필요한 E2E 단계 (12-10 후반부)
6. 누적 commit 수가 12 개를 넘어가는데도 절반 이상 sub-phase 완료 못 함 (속도 이상)
7. plan 의 견적 (~13.5d) 의 1.5 배를 넘기는 시점

보고 형식:
```
## Phase 12 진행 멈춤
- 현재: sub-phase 12-X (단계 Y)
- 사유: <간단 요약>
- 자율 처리 시도: <시도한 방법>
- 사용자 결정 필요: <구체 질문>
```

---

## 7. 진행 보고 cadence

각 sub-phase 완료 시점에 chat 으로 1 단락 보고:

```
## 12-X 완료
- 변경 파일: <N 개>
- 신규 테스트: <M 건> / 기존 통과: <K>
- Codex review: <R 라운드>, BLOCKER <X> closed
- Commit: <hash>
- 다음: 12-(X+1)
```

10 sub-phases 모두 끝나면:
```
## Phase 12 완료
- 총 commits: <N>
- 누적 테스트: <기존 428 → 신규 +M>
- Codex 총 라운드: <R>
- 견적 13.5d vs 실제: <D>
- self-review log: docs/PHASE12_SELFREVIEW_LOG.md
- 다음 액션: 사용자 확인 후 push, CLAUDE.md "Phase 이력" 업데이트
```

---

## 8. 시작 시 첫 액션

1. `docs/PHASE12_PLAN.md` 처음부터 끝까지 정독 (특히 §3, §4, §6, §8, §10, §12)
2. `docs/PHASE10a_SELFREVIEW_LOG.md` + `docs/PHASE11_SELFREVIEW_LOG.md` 정독 (재사용 인프라 파악)
3. `server/oauth-manager.js` + `server/workspace-manager.js` + `providers/slack.js` 의 현재 구조 review
4. 12-1 의 Step A 부터 진입
