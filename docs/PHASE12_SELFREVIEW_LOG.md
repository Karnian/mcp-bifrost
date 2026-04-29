# Phase 12 — Self-Review Log

> 12 sub-phases × Codex peer review 누적 기록.
> 형식은 `docs/PHASE11_SELFREVIEW_LOG.md` 참고.

---

## 12-1 — Workspace schema 확장 + Slack masking (2026-04-29)

### 산출물
- `server/workspace-schema.js` — `slackOAuthSchema` / `slackOAuthTokensSchema` / `slackAppSchema` + `validateSlackAppPayload` helper, `nativeWorkspaceSchema` 에 `authMode` + batch validation (`provider=slack && authMode=oauth` ↔ botToken 금지 ↔ slackOAuth 필수, authMode=oauth 는 slack 만 허용).
- `server/workspace-manager.js` — `maskSlackOAuth` / `maskSlackApp` helpers export, `_maskSecrets` 에 slackOAuth 라우팅, `getSlackApp(Raw)` / `setSlackApp` / `deleteSlackApp` 신규 (env override + dependent guard with force), `getDeletedWorkspaces` 가 `_maskSecrets` 통과, `addWorkspace` / `updateWorkspace` 가 `authMode` + `slackOAuth` 영속화.
- `tests/phase12-1-schema-mask.test.js` — 26 건 (schema 9건, masking 8건, _maskSecrets 통합 2건, slackApp manager 4건, addWorkspace/updateWorkspace/getDeletedWorkspaces/setSlackApp 회귀 4건 신규).

### Codex review
- **Round 1**: REJECT — 2 BLOCKER + 1 REVISE
  - [BLOCKER] `getDeletedWorkspaces` 가 `slackOAuth` 토큰 누출 (`/api/workspaces/deleted`)
  - [BLOCKER] `addWorkspace` / `updateWorkspace` 가 `authMode` / `slackOAuth` 영속화 안 함 — silent downgrade 가능
  - [REVISE] `setSlackApp` 이 `validateSlackAppPayload` 우회
- **Round 2**: APPROVE
  - 3건 모두 닫힘. `restoreWorkspace` / diagnostics / `/api/workspaces` 변형 surfaces 도 추가 검증됨.
  - NIT (deferred): `updateWorkspace` 의 masked-token 판정이 `endsWith('...')` sentinel 의존 — 형태 변경 시 fragile. Phase 12 끝에 batch 처리.

### 견적 vs 실제
- 견적 1d, 실제 ~0.5d (round 2 만에 수렴). 추가 BLOCKER 2건 처리 포함.

### 누적 테스트
- 기존 phase 11 까지 428 → 12-1 추가 +26 = 474 (실측 448 — 일부 phase11 후속 추가가 brief 작성 후 합산됨, 결과적으로 0 fail).
