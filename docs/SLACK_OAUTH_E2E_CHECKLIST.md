# Slack OAuth E2E Checklist (Phase 12)

실 Slack 환경에서 manual 검증 절차. 자동 테스트는 모두 mock 으로 끝났으므로
배포 직전 또는 운영 환경 변경 후 1회 실행 권장.

선결 조건:
- Bifrost 가 정상 부팅 (`npm start`)
- `BIFROST_PUBLIC_URL` 가 HTTPS 공개 origin (또는 dev: `http://localhost:3100`)
- `/admin` 접속 가능
- 새 Slack workspace 1개 (개인 가능) + 추가로 1~2개 더 (multi-workspace 검증용)

---

## A. Slack App 등록

- [ ] api.slack.com/apps → Create New App → From manifest 선택
- [ ] `templates/slack-app-manifest.yaml` 또는 `/admin/slack` 의 manifest 다운로드
      버튼으로 받은 yaml 붙여넣기 → Create
- [ ] **Distribution** 탭 → **Activate Public Distribution** 켜기
- [ ] **Basic Information** 에서 Client ID / Client Secret 복사
- [ ] Bifrost `/admin/slack` 에 등록 → 페이지 새로고침 후 source = `file` 배지 확인

## B. 환경변수 override (R7 보완 + plan §8.6 5-case matrix)

각 조합에서 `/api/slack/app` 의 `sources.{clientId,clientSecret}` 와 UI 배지 표시
값을 기록.

| 케이스 | env clientId | env clientSecret | file clientId | file clientSecret | 기대 sources | UI 배지 |
|---|---|---|---|---|---|---|
| 1. env+env | set | set | (any) | (any) | env / env | "Client ID: env override" + "Client Secret: env override (file ignored)" |
| 2. env+file | set | unset | (any) | set | env / file | "Client ID: env override" |
| 3. file+env | unset | set | set | (any) | file / env | "Client Secret: env override (file ignored)" |
| 4. file+file | unset | unset | set | set | file / file | "Client ID: file" + "Client Secret: file" |
| 5. none | unset | unset | unset | unset | none / none | "미설정" |

- [ ] 1. env+env: 두 env 모두 설정 후 재기동 → sources / UI 일치
- [ ] 2. env+file: BIFROST_SLACK_CLIENT_ID 만 env, secret 은 file
- [ ] 3. file+env: secret 만 env, clientId 는 file
- [ ] 4. file+file: env 모두 unset, /admin 으로만 등록
- [ ] 5. none: 모든 source 비움 → install start 가 412 SLACK_APP_NOT_CONFIGURED

플랜 §10 R7: 새 secret 등록 후 첫 refresh 가 invalid_client → action_needed 자동 전환.

## C. 단일 workspace 연결 + 도구 호출

- [ ] `/admin/slack` → **Connect Slack workspace** → popup 에서 본인 workspace 선택
- [ ] popup 자동 닫힘 + UI 가 "✓ 연결 완료" 표시
- [ ] Dashboard 에 Slack workspace 가 healthy 상태로 표시
- [ ] **Tools** 탭에서 `slack_<namespace>__search_messages`, `..._read_channel`,
      `..._list_channels` 가 보임
- [ ] MCP 클라이언트 (Claude Desktop / claude.ai connector) 로 search_messages
      호출 → 결과 반환

## D. Multi-workspace 격리

- [ ] 두 번째 Slack workspace 추가 (다른 organization 이상적)
- [ ] **연결된 Slack Workspaces** 에 두 entry 표시, team.id 다름
- [ ] 각각 search_messages 호출 → 응답이 섞이지 않음 (다른 workspace 의 결과 노출 X)

## E. 토큰 만료 / 자동 refresh

> 참고 — `expires_in` 은 Slack 의 `oauth.v2.access` 응답 필드이지 manifest 설정이
> 아님. 12 시간이 너무 길면 staging 에서 mock Slack 또는 raw config 의
> `slackOAuth.tokens.expiresAt` 을 임박값으로 직접 수정해서 검증.
> 공식 문서: https://docs.slack.dev/authentication/using-token-rotation/

- [ ] (옵션 A) 12 시간 대기 후 다음 callTool 호출
- [ ] (옵션 B) `config/workspaces.json` 의 `slackOAuth.tokens.expiresAt` 을
      `now+30s` 로 직접 수정 후 callTool 호출 → 자동 rotation 트리거
- [ ] (옵션 C) staging 환경에 mock Slack server 띄우고 `expires_in: 1` 으로
      install → 즉시 다음 호출에서 refresh
- [ ] 만료 임박 시 다음 호출에서 자동 rotation 발생 + 새 access/refresh 받음
- [ ] `/admin/slack` 의 expires 시각이 갱신됨
- [ ] 내부 audit log 에 `slack.token_refreshed` 항목 추가

## F. 강제 refresh (admin)

- [ ] 워크스페이스 행의 **Refresh** 버튼 클릭
- [ ] 응답 200 + 새 token prefix 표시
- [ ] 이전 access_token 으로 직접 호출 시 `token_revoked` / `invalid_auth`

## G. action_needed → Re-authorize 흐름

- [ ] Slack App 콘솔에서 client_secret 을 regenerate
- [ ] Bifrost 의 client_secret 갱신 없이 강제 refresh → status='action_needed'
      로 전환됨 (UI 적색 표시)
- [ ] **Re-authorize** 버튼 → install flow 재실행
- [ ] 같은 team.id 라 `re-authorize` 모드로 동일 entry 의 토큰만 갱신
- [ ] status='active' 로 복귀

## H. Disconnect

- [ ] 워크스페이스 행의 **Disconnect** → confirm
- [ ] entry 가 즉시 사라짐
- [ ] api.slack.com → My Apps → 해당 App → "Authorized for" 에서 해당 user 가 사라짐
      (또는 access_token 이 더 이상 동작 안 함)

## I. 보안 검증

- [ ] `/api/workspaces` 응답에서 raw access/refresh token 누출 없음
      (`accessToken: "xoxe.xoxp-1..."` 형태로만 노출)
- [ ] `/api/workspaces/deleted` 응답 (soft-delete 후) 도 동일하게 마스킹
- [ ] `config/workspaces.json` 파일 권한이 `0600`
- [ ] popup 차단 환경에서 polling fallback 으로도 install 완료 가능
- [ ] 잘못된 BIFROST_PUBLIC_URL 로 install 시도 → friendly 에러 (412 PUBLIC_ORIGIN_*)

## J. Public Distribution 비활성 시도

- [ ] Slack App 의 Public Distribution 을 끄고 외부 workspace 에서 install 시도
- [ ] `bad_redirect_uri` 또는 `invalid_team_for_non_distributed_app` 발생
- [ ] UI 가 한국어 친절 메시지로 안내

## K. Enterprise Grid 거부

- [ ] (가능하면) Enterprise Grid org 의 user 계정으로 install 시도
- [ ] `is_enterprise_install: true` 응답 → `org_login_required` 매핑
      "Enterprise Grid 환경 미지원" 메시지 표시
- [ ] workspace entry 생성 안 됨

## L. botToken → OAuth migration

- [ ] 기존 botToken Slack workspace 가 있다면:
      1. `node scripts/migrate-slack-to-oauth.mjs --report` 실행
      2. 출력에 alias / namespace / 다음 단계 안내 확인
      3. Workspace detail 에서 **Hard-Delete**
      4. `/admin/slack` 에서 OAuth install 재실행
      5. alias / namespace 를 동일하게 입력 → tool name 안정성 보장
- [ ] migration 후 기존 MCP 클라이언트의 tool ref 가 그대로 동작

## M. Cloudflare Tunnel (선택)

- [ ] Fixed hostname tunnel 설정 (random tunnel 미지원 명시)
- [ ] `BIFROST_PUBLIC_URL` 가 tunnel hostname 으로 설정
- [ ] install flow 가 tunnel 통해 정상 동작

---

## 결과 기록

| 절 | 결과 (PASS/FAIL/N/A) | 비고 |
|---|---|---|
| A. Slack App 등록 | | |
| B. env override | | |
| C. 단일 workspace + 도구 | | |
| D. Multi-workspace 격리 | | |
| E. 토큰 만료 / refresh | | |
| F. 강제 refresh | | |
| G. Re-authorize | | |
| H. Disconnect | | |
| I. 보안 | | |
| J. Public Distribution 비활성 | | |
| K. Enterprise Grid 거부 | | |
| L. botToken migration | | |
| M. Cloudflare Tunnel | | |

검증 완료자: __________________  날짜: __________________
