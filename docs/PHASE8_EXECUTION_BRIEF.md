# Phase 8 — Execution Brief

새 세션이 Phase 8 을 자율 실행할 때 필요한 최소 컨텍스트.
`docs/PHASE8_PLAN.md` 가 source of truth.

---

## 0. 시작 전 확인

```bash
pwd                                         # /Users/K/Desktop/sub_project/mcp-bifrost
git status                                  # master, clean
npm test 2>&1 | tail -5                     # 167 tests passing (Phase 7 기준선)
```

**Read 툴로 먼저 읽을 파일**:
1. 이 파일
2. `docs/PHASE8_PLAN.md` §4 (구현 단계)
3. `CLAUDE.md`
4. `server/index.js`, `admin/routes.js`, `admin/auth.js`
5. `server/workspace-manager.js`, `server/mcp-handler.js`
6. `server/mcp-token-manager.js`, `server/oauth-manager.js`
7. `server/usage-recorder.js`, `server/sse-manager.js`
8. `providers/mcp-client.js`, `server/logger.js`

**Codex 가용성 테스트**:
```bash
echo "ping" | codex exec 2>&1 | tail -3
```
불가 시 self-review 후 `docs/PHASE8_SELFREVIEW_LOG.md` 에 기록.

---

## 1. 실행 규칙

### 1.1 Phase 순서

**8a (★ Gate) → 8c (보안 보강) → 8b (안정성) → 8d (품질) → 8e (선택)**

### 1.2 각 Phase 완료 기준
- 관련 체크리스트 모두 체크
- 단위 테스트 작성 + `npm test` 전체 PASS (167 기준선 유지 + 신규)
- **Codex 교차 리뷰** → PASS
- REVISE/FAIL 시 수정 후 재리뷰
- git commit (phase 단위, 메시지에 "codex PASS" 또는 "self-review PASS")

### 1.3 Codex 교차 리뷰 방법

```bash
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.0/scripts/ask.mjs async codex <<'EOF'
**코드 실행 금지. 아래 변경 요약만 읽고 분석.**
[Phase 8X 완료] docs/PHASE8_PLAN.md 의 해당 phase 체크리스트 대비 누락/모순 리뷰.
구현 파일: [변경된 파일 나열]
테스트 결과: N tests passing
한국어 PASS/REVISE/FAIL + 구체 문제만 500자 이내.
EOF
```

collect 로 회수. Codex 불가 시 self-review fallback.

### 1.4 8a Gate 규칙
- `npm test` 167건 전수 + 8a 신규 전부 통과 확인
- path traversal, body limit, XSS 각각 수동 curl 검증:
  ```bash
  # path traversal
  curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/admin/../../config/workspaces.json
  # → 403

  # body limit
  python3 -c "print('x'*2_000_000)" | curl -s -o /dev/null -w "%{http_code}" -X POST -d @- http://localhost:3100/mcp
  # → 413

  # XSS
  curl -s "http://localhost:3100/oauth/callback?error=<script>alert(1)</script>" | grep -c '&lt;script&gt;'
  # → 1
  ```
- 1건이라도 실패 시 8b 착수 금지

### 1.5 의사결정 규칙
- 계획서에 없는 결정은 Codex 에 의견 묻고 종합해서 스스로 결정
- 근거를 commit message 에 기록

### 1.6 Commit 규칙
- Phase 완료 단위 commit. Co-Authored-By 유지
- 예: `fix(phase8a): path traversal + body limit + XSS + slowloris + callTool retry (codex PASS)`

### 1.7 막혔을 때
- 2시간 이상 막히면 진단 로그 남기고 중단 → 사용자 보고
- 파괴적 동작 금지

---

## 2. 완료 체크리스트 (Phase 8 전체)

- [ ] 8a: 5건 보안 패치 (path traversal, body limit, XSS, slowloris, retry) + Gate 통과 + Codex PASS
- [ ] 8c: 4건 보안 보강 (timingSafeEqual ×2, rate limit, CSP) + Codex PASS + commit
- [ ] 8b: 8건 안정성/성능 (watcher guard 포함) + Codex PASS + commit
- [ ] 8d: 5건 코드 품질 + Codex PASS + commit
- [ ] 8e: 선택 항목 (가용 시간에 따라)
- [ ] 최종: `npm test` ≥ 192 PASS
- [ ] 최종: Phase 7 테스트 167건 회귀 0
- [ ] 최종: `docs/PHASE8_SELFREVIEW_LOG.md` 누적 기록
- [ ] 최종: Phase 8 전체 Codex 통합 리뷰 PASS
- [ ] 최종: 사용자에게 결과 보고

---

## 3. 실패 복구

| 상황 | 대응 |
|------|------|
| 테스트 실패 | 원인 분석 → 수정 → 재실행. 3회 실패 시 진단 로그 + 다음 phase 중단 |
| 8a gate 실패 | **8b 착수 금지**. 패치 버그 분석 후 재실행 |
| callTool throw 변경이 기존 테스트 깨뜨림 | 비즈니스 에러 vs HTTP 에러 분기 재검토. Phase 7 e2e mock 동작 확인 |
| Git 충돌 | 사용자 보고 (자동 resolve 금지) |

---

끝. 이 브리프만으로 실행 가능해야 함.
