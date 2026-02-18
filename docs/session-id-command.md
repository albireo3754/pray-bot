# `/session-id` Discord Slash Command

> status: ready
> type: lite-spec
> created: 2026-02-18

## 0. LLM Work Guide

> **Follow the Spec Execution Protocol (`/sisyphus`).** Lite-spec은 의존성 분석/병렬 실행/멀티세션 복구 없이 순차 루프만 사용.

| Item | Section |
|------|---------|
| Task Checklist | §4 |
| Naming Conventions | §3.4 |
| State file | `docs/session-id-command.state.md` |

<!-- ═══════════════════════════════════ -->
<!-- Spec Body                          -->
<!-- ═══════════════════════════════════ -->

## 1. Goal

Discord 스레드 내에서 `/session-id` 슬래시 커맨드를 실행하면, 해당 스레드에 연결된 Claude/Codex 세션 ID를 응답으로 돌려준다.

**용도**: 사용자가 `/claude session:<id>` 또는 `/codex-app-server session:<id>`로 기존 세션을 재개하거나, 외부 도구에서 세션을 참조할 때 ID를 손쉽게 조회하기 위함.

## 2. Non-Goals

- 세션 ID로 세션 상태를 조회하거나 제어하는 기능 (기존 `/health` 커맨드 영역)
- DM 채널 또는 스레드가 아닌 일반 채널에서의 조회
- provider_session_id 이외의 메타데이터(cwd, model 등) 표시

## 3. Design

### 3.1 Architecture Context

pray-bot은 **라이브러리**다. `CommandDefinition` 핸들러는 소비자 앱(consuming app)이 플러그인을 통해 `ctx.addCommand()`로 등록한다. 따라서:

- **라이브러리(pray-bot)**: Discord 슬래시 커맨드 선언 + `channelId` 전달 + `createSessionIdCommand()` 팩토리 export
- **소비자 앱**: `ctx.addCommand(createSessionIdCommand())` 한 줄 등록

### 3.2 Deliverables

| Deliverable | Path | Description |
|-------------|------|-------------|
| 슬래시 커맨드 선언 | `src/discord/commands.ts` | `buildSlashCommands()`에 `session-id` 빌더 추가 |
| channelId 주입 | `src/discord/commands.ts` | `interactionToMessagePayload()`에 `channelId` 필드 추가 |
| 커맨드 팩토리 | `src/discord/thread-route-store.ts` | `createSessionIdCommand()` export |
| 소비자 앱 등록 | consuming app의 플러그인 | `ctx.addCommand(createSessionIdCommand())` |

### 3.3 Interface

```typescript
// 1. buildSlashCommands()에 추가 (commands.ts)
new SlashCommandBuilder()
  .setName('session-id')
  .setDescription('현재 스레드의 세션 ID 조회'),

// 2. interactionToMessagePayload()에 channelId 추가 (commands.ts)
function interactionToMessagePayload(interaction: ChatInputCommandInteraction) {
  return {
    id: interaction.id,
    channelId: interaction.channelId,  // ← 추가
    user: { ... },
    text: '',
    source_message_id: '',
    sent_time: ...,
    extensions: {},
  };
}

// 3. createSessionIdCommand() 팩토리 (thread-route-store.ts)
import type { CommandDefinition } from '../command/registry.ts';

export function createSessionIdCommand(): CommandDefinition {
  return {
    name: '/session-id',
    description: '현재 스레드의 세션 ID 조회',
    execute: async (ctx) => {
      const threadId = ctx.data['channelId'] as string | undefined;
      if (!threadId) {
        ctx.client.sendMessage('채널 ID를 확인할 수 없습니다.');
        return;
      }
      const route = getDiscordThreadRoute(threadId);
      if (!route || !route.providerSessionId) {
        ctx.client.sendMessage('이 스레드에 연결된 세션을 찾을 수 없습니다.');
        return;
      }
      ctx.client.sendMessage(
        `**Session ID** (\`${route.provider}\`)\n\`\`\`\n${route.providerSessionId}\n\`\`\``
      );
    },
  };
}
```

**응답 형식 (성공)**
```
**Session ID** (`claude`)
```
03e7a6b5-1234-abcd-5678-efgh90123456
```
```

**응답 형식 (세션 미연결)**
```
이 스레드에 연결된 세션을 찾을 수 없습니다.
```

### 3.4 Existing Code Impact

| Existing File | Change | Impact |
|---------------|--------|:------:|
| `src/discord/commands.ts` | `buildSlashCommands()`에 `session-id` 빌더 추가 | Low |
| `src/discord/commands.ts` | `interactionToMessagePayload()`에 `channelId` 필드 추가 | Low |
| `src/discord/thread-route-store.ts` | `createSessionIdCommand()` 함수 추가 & export | Low |
| consuming app 플러그인 | `ctx.addCommand(createSessionIdCommand())` 등록 | Low |

> `getDiscordThreadRoute(threadId)`는 `src/discord/thread-route-store.ts`에 이미 존재 — 신규 DB 로직 없음.

### 3.5 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| Slash command | `session-id` | Discord 커맨드명 (kebab-case, 기존 패턴 동일) |
| CommandDefinition name | `/session-id` | CommandRegistry 키 (슬래시 포함, 기존 패턴 동일) |
| Factory function | `createSessionIdCommand` | camelCase, `create` 접두사 (팩토리 컨벤션) |
| ctx.data key | `channelId` | interaction.channelId, 기존 `id` 필드와 구분 |

## 4. Task Checklist

> Mark `[x]` only after verify passes.

- [ ] ✅ **Step 1**: `src/discord/commands.ts` — `buildSlashCommands()`에 `session-id` 슬래시 커맨드 빌더 추가
  → verify: 반환 배열에 `{ name: 'session-id' }` 항목 존재

- [ ] ✅ **Step 2**: `src/discord/commands.ts` — `interactionToMessagePayload()`에 `channelId: interaction.channelId` 추가
  → verify: 반환 객체에 `channelId` 필드 포함

- [ ] ✅ **Step 3**: `src/discord/thread-route-store.ts` — `createSessionIdCommand()` 팩토리 추가 & export
  → verify: 함수가 `CommandDefinition` 타입을 만족하며, `execute`에서 `getDiscordThreadRoute` 호출

- [ ] ✅ **Step 4**: `npx tsc --noEmit` 타입 에러 0개
  → verify: 타입 오류 없음

- [ ] ⚠️ **Step 5**: consuming app 플러그인에 `ctx.addCommand(createSessionIdCommand())` 등록
  → verify: consuming app에서 `/session-id` 커맨드 resolve 가능

## 5. Verification Criteria

- [ ] Given: 세션이 연결된 Discord 스레드 / When: `/session-id` 실행 / Then: `providerSessionId`와 `provider` 포함 응답
- [ ] Given: 세션 미연결 채널 / When: `/session-id` 실행 / Then: "찾을 수 없습니다" 메시지 응답
- [ ] No regression: 기존 슬래시 커맨드 동작 변경 없음 (`channelId` 필드 추가는 기존 핸들러에 영향 없음)

## 6. Open Questions

- ~~CommandDefinition 등록 위치~~ → **resolved**: consuming app 플러그인에서 `ctx.addCommand()`로 등록
- ~~interaction.channelId가 스레드 ID인지 부모 채널 ID인지~~ → **resolved**: Discord.js에서 스레드 내 interaction의 `channelId`는 스레드 자체 ID
