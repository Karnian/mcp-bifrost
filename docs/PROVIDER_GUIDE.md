# Provider Development Guide

Bifrost에 새로운 서비스 provider를 추가하는 방법을 안내합니다.

## Overview

Provider는 외부 서비스(Notion, Slack 등)를 MCP 도구로 변환하는 어댑터입니다. `BaseProvider`를 확장하여 구현합니다.

## Quick Start

### 1. Provider 클래스 생성

```js
// providers/my-service.js
import { BaseProvider } from './base.js';

export class MyServiceProvider extends BaseProvider {
  constructor(workspaceConfig) {
    super(workspaceConfig);
    this.token = workspaceConfig.credentials?.token;
  }

  getTools() {
    return [
      {
        name: 'search',
        description: 'Search items in My Service',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
        readOnly: true,  // tools/list 의 read-only 프로필에서 노출
      },
    ];
  }

  async callTool(toolName, args) {
    switch (toolName) {
      case 'search':
        const results = await this._search(args.query);
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
    }
  }

  async healthCheck() {
    try {
      // API 연결 확인
      await this._fetch('/health');
      return { ok: true, message: 'Connected' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async validateCredentials() {
    try {
      await this._fetch('/me');
      return true;
    } catch {
      return false;
    }
  }

  async capabilityCheck() {
    return {
      scopes: [],
      resources: { count: 0, samples: [] },
      tools: this.getTools().map(t => ({ name: t.name, usable: 'usable' })),
    };
  }
}
```

### 2. BaseProvider 인터페이스

| 메서드 | 반환값 | 필수 | 설명 |
|--------|--------|------|------|
| `getTools()` | `Array<Tool>` | ✅ | MCP tools/list에 노출할 도구 목록 |
| `callTool(name, args)` | `{content, isError?}` | ✅ | 도구 실행 |
| `healthCheck()` | `{ok, message}` | ✅ | 연결 상태 확인 |
| `validateCredentials()` | `boolean` | ✅ | 토큰 유효성 검증 |
| `capabilityCheck()` | `{scopes, resources, tools}` | ✅ | 접근 가능 범위 |
| `getPrompts()` | `Array<Prompt>` | ❌ | MCP prompts (선택) |
| `getPromptMessages(name, args)` | `Array<Message>` | ❌ | 프롬프트 메시지 생성 |

### 3. Tool 정의 구조

```js
{
  name: 'tool_name',           // 영문 소문자 + 밑줄
  description: '도구 설명',     // 사용자에게 보이는 설명
  inputSchema: {               // JSON Schema
    type: 'object',
    properties: { ... },
    required: ['...'],
  },
  readOnly: true,              // true: read-only 프로필에서도 노출
}
```

### 4. Prompt 정의 (선택)

```js
getPrompts() {
  return [{
    name: 'summarize',
    description: '워크스페이스 내용을 요약합니다.',
    arguments: [
      { name: 'topic', description: '요약 주제', required: false },
    ],
  }];
}

async getPromptMessages(name, args) {
  if (name === 'summarize') {
    return [{
      role: 'user',
      content: { type: 'text', text: `${this.displayName}의 내용을 요약해주세요.` },
    }];
  }
  return [];
}
```

### 5. 에러 응답 패턴

```js
// 비즈니스 에러 (재시도 불필요)
return {
  content: [{ type: 'text', text: '페이지를 찾을 수 없습니다.' }],
  isError: true,
};

// HTTP 에러 (mcp-handler retry 활용)
const err = new Error('API error');
err.status = 429;  // rate_limit → 자동 재시도
throw err;
```

### 6. workspace-manager에 등록

`server/workspace-manager.js`의 `_createProvider()` 메서드에 분기 추가:

```js
case 'my-service':
  const { MyServiceProvider } = await import('../providers/my-service.js');
  return new MyServiceProvider(wsConfig);
```

### 7. Admin UI 템플릿 추가

`admin/public/templates.js`에 템플릿 추가:

```js
{
  id: 'my-service',
  name: 'My Service',
  icon: 'MS',
  category: 'productivity',     // productivity, development, communication, storage, demo
  description: '서비스 설명',
  kind: 'native',
  provider: 'my-service',
  fields: [
    { name: 'token', label: 'API Token', required: true, secret: true },
  ],
}
```

## Checklist

- [ ] `BaseProvider`의 5개 필수 메서드 모두 구현
- [ ] `callTool()`: 알 수 없는 도구 이름에 대해 `isError: true` 반환
- [ ] `healthCheck()`: 절대 throw하지 않음 (catch 후 `{ ok: false }` 반환)
- [ ] `capabilityCheck()`: scope/resource 파악 → 도구별 usable/limited 판정
- [ ] `getTools()`: `readOnly` 플래그 설정 (read-only 프로필 지원)
- [ ] Admin UI 템플릿에 `category` 필드 포함
- [ ] 테스트 파일 작성 (mock API 기반)
- [ ] `config/workspaces.example.json`에 예시 추가

## Namespace 규칙

- 소문자 영문 + 숫자 + 하이픈만 허용: `[a-z0-9][a-z0-9-]*`
- 밑줄(`_`) 금지 — MCP 도구 이름 충돌 방지
- 최대 50자
- 워크스페이스 생성 후 변경 불가 (immutable)
