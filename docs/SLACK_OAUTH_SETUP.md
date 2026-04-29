# Slack OAuth Setup (Phase 12)

Bifrost 의 Slack OAuth v2 install flow 를 사용해서 한 Slack App 으로 다수의 외부
Slack workspace 를 연결하는 절차.

이 문서는 self-host Bifrost 운영자를 대상으로 한다.

---

## 1. 사전 조건

| 조건 | 설명 |
|------|------|
| `BIFROST_PUBLIC_URL` | HTTPS 공개 origin. 예: `https://bifrost.example.com`. localhost (`http://localhost:3100`) 는 개발용. Cloudflare random tunnel 은 미지원 — fixed hostname 사용. |
| Bifrost admin token | `BIFROST_ADMIN_TOKEN` 환경변수 또는 `/admin` UI 로그인. |
| Slack 계정 | api.slack.com/apps 에 접근 가능한 Slack 계정 1개. |

---

## 2. Slack App 생성

1. https://api.slack.com/apps → **Create New App** → **From manifest**
2. 어디에 install 할 workspace 1개 선택 (의미 있는 선택은 아님 — 이후 Public
   Distribution 으로 다른 workspace 도 받음).
3. 다음 둘 중 한 가지 manifest 사용:
   - 운영자 본인 manifest: `templates/slack-app-manifest.yaml` 의
     `redirect_urls` 항목을 본인 `BIFROST_PUBLIC_URL` 로 교체해서 붙여넣기.
   - Bifrost Admin UI 의 다운로드 버튼: **Slack 화면 → manifest.yaml 다운로드**
     를 누르면 canonical origin 이 자동으로 채워진 YAML 이 다운로드 됨. (admin
     token 보호)
4. **Create** 클릭.
5. 생성된 App 의 **Distribution** 탭 → **Activate Public Distribution**.
   - Marketplace 등재 (Listed) 는 Phase 12 비범위. **Unlisted distributed** 만
     활성화.
   - Public Distribution 미활성 시 외부 workspace install 시도가
     `invalid_team_for_non_distributed_app` 에러로 실패.
6. **Basic Information** 탭에서 **Client ID** / **Client Secret** 복사.

---

## 3. Bifrost 등록

1. `/admin/` → **Slack** 탭.
2. Public Origin 섹션이 녹색 ✓ 인지 확인 (`BIFROST_PUBLIC_URL` 정상).
3. **Slack App Credentials** 폼에 Client ID / Client Secret 입력 + **저장**.
4. 환경변수 override (선택): `BIFROST_SLACK_CLIENT_ID` /
   `BIFROST_SLACK_CLIENT_SECRET` 가 설정되어 있으면 file 값보다 우선. UI 에 두
   source 별도 배지로 표시 (env override 가 부분적으로 적용된 케이스도 식별 가능).

---

## 4. Workspace 연결

1. **Slack** 탭 → **+ Connect Slack workspace**.
2. 새 popup 창에서 Slack 의 workspace 선택 + 권한 동의.
3. 자동으로 popup 닫힘 + Bifrost 가 OAuth 응답 검증 + workspace entry 생성.
4. **연결된 Slack Workspaces** 섹션에 추가됨.

같은 Slack App 으로 N 개 workspace 를 추가 가능. 각 workspace 의 토큰은 Phase 10a
의 격리 인프라 (workspace-scoped mutex) 를 그대로 사용.

---

## 5. 운영 시나리오

### 5.1 토큰 만료 / 자동 refresh

- token rotation enabled 인 경우, access_token 의 expiresAt 이 60초 미만 남으면
  다음 호출에서 자동으로 rotation. concurrent refresh 는 workspace mutex 로
  직렬화됨.
- 자동 refresh 가 실패하면 `slackOAuth.status = 'action_needed'` 가 되고 UI 에
  Re-authorize 버튼이 표시됨.

### 5.2 강제 refresh (운영 검증)

- **Slack** 탭의 workspace 행에서 **Refresh** 버튼 — admin 만 실행 가능. Slack
  rotation endpoint 를 즉시 호출.

### 5.3 Re-authorize

- **action_needed** 상태에서 **Re-authorize** 버튼 → 같은 install flow 재실행.
- Bifrost 의 `completeInstall` 이 같은 `team.id` 를 발견하면 `re-authorize` 모드
  로 기존 entry 의 token 만 갱신 (entry 재생성 안 함).

### 5.4 Disconnect

- workspace 행의 **Disconnect** → Slack 의 `auth.revoke` (best-effort) + 로컬
  workspace entry 삭제.
- `?keepEntry=true` 로 entry 보존 (slackOAuth 만 strip) — 같은 alias /
  namespace 로 다시 인증할 때 사용.

### 5.5 Slack App Credential rotation (R7)

- Slack 콘솔에서 secret 을 regenerate 하면 이전 secret 은 24h 유효.
- 새 secret 을 Bifrost 에 등록 → 첫 refresh 가 `invalid_client` 면 자동으로
  `action_needed` 로 전환됨. 사용자가 Re-authorize.
- env 환경변수로 즉시 rollback 가능 (env 가 file 보다 우선).

---

## 6. 보안 고려사항

| 항목 | 처리 |
|------|------|
| `clientSecret` | `chmod 0600` 보호. audit log 에는 `hasSecret` boolean 만. |
| `slackApp` env override | `BIFROST_SLACK_CLIENT_ID` / `BIFROST_SLACK_CLIENT_SECRET` 가 file 보다 우선. 두 source 가 별도 표시되어 운영자가 진실의 출처를 식별 가능. file/env 혼합 (R7 rollback 등) 도 안전. |
| OAuth state | HMAC + `typ`/`aud`/`installId`/`iat`/`exp` 검증, 10분 TTL bound. 2-segment 강제. |
| redirect_uri | `BIFROST_PUBLIC_URL` 기반 canonical resolver — manifest 다운로드 / authorize URL / token exchange 가 모두 같은 resolver 사용. Host header 자동 치환 금지. path/query/fragment reject. |
| Slack OAuth 응답 검증 | `ok: true`, `team.id`, `authed_user.id`, `authed_user.access_token`, `token_type === 'user'` 모두 있어야 진행. half-state (expires_in XOR refresh_token) 양방향 reject. root bot token 폐기. |
| postMessage targetOrigin | canonical origin 만 허용 (와일드카드 미사용). origin 미설정 시 postMessage 자체를 안 함 — polling fallback 만 사용. |
| Enterprise Grid | `is_enterprise_install: true` 명시적 reject. silent failure 차단. |
| 토큰 노출 | `/api/workspaces` masked 응답에서 raw access/refresh token 제거. soft-deleted workspace 응답도 동일하게 마스킹. provider 인스턴스 내부에도 raw token 캐시 없음 (`_tokenProvider` closure 만). |
| Token rotation race | workspace 단위 mutex 직렬화 + 1회용 refresh 재시도 금지 + clone-then-swap durable save (디스크 쓰기 성공 후에만 in-memory swap). |
| `auth.test` rate limit | `capabilityCheck()` 60s cooldown — 다수 workspace 환경에서도 Slack 의 rate budget 보호. |
| Disconnect revoke 정책 | access + refresh token 둘 다 best-effort `auth.revoke`. 실패 시 audit 만 남기고 로컬 토큰은 항상 삭제 (workspace mutex 안에서 hard-delete / keep-entry). |
| Slack 친절 에러 매핑 | `bad_redirect_uri` / `invalid_team_for_non_distributed_app` / `unapproved_scope` / `org_login_required` / `invalid_client(_id)` / `invalid_grant` / `access_denied` — 한국어 UX 변환. |
| `incoming_webhook` 응답 | Phase 12 비범위. 받아도 무시 + 저장 금지. |

---

## 7. Cloudflare Tunnel (선택)

Cloudflare Tunnel 은 fixed hostname 모드만 지원. random tunnel 은 매 세션 host
가 바뀌므로 Slack 의 redirect_urls 와 일치 보장이 안 됨.

```
# 1. Cloudflare 대시보드에서 fixed hostname 설정 (예: bifrost.example.com)
# 2. .env 또는 systemd unit 에 BIFROST_PUBLIC_URL=https://bifrost.example.com
# 3. npm run tunnel
```

---

## 8. 트러블슈팅

| 증상 | 원인 / 해결 |
|------|------|
| `bad_redirect_uri` | Slack App 의 Redirect URLs 에 `BIFROST_PUBLIC_URL/oauth/slack/callback` 가 정확히 등록되지 않음. trailing slash, http/https 차이 모두 검증. |
| `invalid_team_for_non_distributed_app` | Public Distribution 미활성. api.slack.com → Distribution → Activate. |
| `unapproved_scope` | workspace admin 의 scope 승인 대기. 사용자에게 admin 승인 요청 안내. |
| `org_login_required` / Enterprise install | Enterprise Grid 환경. Phase 12 미지원 — 별도 phase 후보. |
| `invalid_client` | Bifrost 에 등록한 client_id / client_secret 이 Slack App 콘솔과 불일치. `/admin/slack` 에서 재등록. R7 rotation: 새 secret 등록 후 첫 refresh 가 이 코드면 자동으로 action_needed 전환됨. |
| `invalid_client_id` | client_id 자체가 Slack 에 존재하지 않음. App 삭제 / 잘못된 클립보드 등. `/admin/slack` 에서 재등록. |
| `invalid_grant` | refresh_token 이 만료되었거나 1회용 사용 끝남. `action_needed` 로 자동 전환 → Re-authorize 버튼 클릭. |
| `access_denied` | 사용자가 권한 동의를 거부. 다시 시도. |
| popup 차단 | 브라우저 popup 허용 + UI 의 직접 링크 사용. |
| `BIFROST_PUBLIC_URL` not set | install start 가 412 PUBLIC_ORIGIN_MISSING. .env 에 추가 + 서버 재시작. |
| state expired | 10분 초과. install 다시 시작. |
