# Quick Start — 5분 가이드

처음 써보는 사람용. 이 문서대로 따라하면 5분 내에 Bifrost 가 동작하고 Claude Code 에서 접속됩니다.

## Step 1 — 설치 & 기동

```bash
cd /path/to/mcp-bifrost
npm install
npm start
```

→ `http://localhost:3100/admin/` 자동 진입 가능.

## Step 2 — 첫 워크스페이스 추가 (Wizard)

1. 브라우저에서 `http://localhost:3100/admin/` 열기
2. **Filesystem** 카드 클릭
3. 경로 입력: `/Users/me/Documents` (자기 PC 경로)
4. **연결 테스트 & 저장** 클릭
5. ✓ 모두 통과되면 **Dashboard** 클릭

## Step 3 — Claude Code 에서 사용

프로젝트 루트에 `.mcp.json`:

```json
{
  "mcpServers": {
    "bifrost": { "url": "http://localhost:3100/mcp" }
  }
}
```

Claude Code 재시작 → `/mcp` 로 도구 목록 확인:
- `stdio_my-docs__read_file`
- `stdio_my-docs__list_directory`
- ...

## Step 4 — 두 번째 워크스페이스 (선택)

같은 방법으로 GitHub 등 추가:
- Wizard → **GitHub** 카드 → Personal Access Token 입력
- `github_personal__create_issue` 등 도구 자동 노출

## 끝

상세 설명은 [USAGE.md](./USAGE.md) 참고.

문제가 있으면:
- `npm test` 로 60개 테스트 통과 확인
- Admin UI **Tools** 탭에서 도구가 실제로 노출되는지 확인
- Detail 화면의 **Test Connection** 으로 워크스페이스별 진단
