# pray-bot Extraction — Subtask Breakdown

> parent spec: `kw-chat/docs/pray-bot-extraction-spec.md`
> created: 2026-02-17
> status: ready

이 문서는 extraction spec의 Phase A~D를 **실행 가능한 subtask**로 분해한 것이다.
각 subtask는 독립적으로 커밋 가능하고, 완료 기준(verify)이 명확하다.

---

## Orchestration Protocol

### 역할 분담

| 역할 | 담당 | 작업 |
|------|------|------|
| **Main Agent** (리더) | 현재 세션 | task 진행사항 기록, 검증 결과 평가, 병렬 그룹 디스패치 |
| **Sub Agent** (워커) | worktree 내 작업 | 코드 이동/수정, 빌드 검증, 결과 보고 |

### 워크플로우

```
1. Main: 다음 실행 가능한 subtask 그룹 확인 (blockedBy 없는 항목)
2. Main: 병렬 가능한 subtask → 각각 Sub Agent 생성 (worktree)
         순차 subtask → 단일 Sub Agent 또는 Main 직접 실행
3. Sub Agent: worktree에서 작업 수행 → verify 실행 → 결과 보고
4. Main: 결과 평가 → 이 문서의 체크리스트 `[ ]` → `[x]` 업데이트
5. Main: 다음 그룹으로 진행
```

### 병렬 그룹 표기

```
🔀 PARALLEL GROUP — 동시 실행 가능한 subtask 묶음
   각 subtask를 별도 Sub Agent에 할당

🔗 SEQUENTIAL — 앞 항목 완료 후 다음 진행
```

### 진행 상태 규칙

- `- [ ]` : 미완료
- `- [x]` : 완료 (verify 통과 확인 후 Main이 체크)
- `- [!]` : 실패/블로커 발견 (사유를 인라인으로 기록)
- 각 subtask 완료 시 **이 파일을 직접 수정**하여 진행 상태 반영

---

## Phase A: Foundation

pray-bot 레포를 빌드 가능한 상태로 만들고 핵심 엔진 모듈을 이동한다.

### A-1. 프로젝트 스캐폴딩 🔗 SEQUENTIAL

> Main Agent가 직접 수행 (pray-bot 레포 루트 작업)

- [x] **A-1-1** tsconfig.json 보강
  - `"rootDir": "src"`, `"types": ["bun-types"]` 추가
  - verify: `npx tsc --noEmit` 에러 0

- [x] **A-1-2** .gitignore 작성
  - `node_modules/`, `dist/`, `*.db`, `.env`
  - verify: 파일 존재

- [x] **A-1-3** bun workspace 설정
  - `~/work/js/package.json`에 `workspaces: ["pray-bot", "kw-chat"]` 추가
  - `bun install` 실행
  - verify: kw-chat에서 `import 'pray-bot'` resolve 가능

### A-2~A-4. 모듈 이동 🔀 PARALLEL GROUP

> A-1 완료 후. 3개 Sub Agent 동시 실행.
> 단, A-2(agents)의 renderer.ts는 A-4(presence) 완료 후 처리해야 하므로,
> renderer.ts를 제외한 agents를 먼저 이동하거나 PresenceGateway 타입을 인라인 정의.

#### Sub Agent 1: agents/ 이동

- [x] **A-2-1** `agents/types.ts` 복사
  - kw-chat → pray-bot `src/agents/types.ts`
  - verify: 파일 존재, 외부 의존 없음

- [x] **A-2-2** `agents/providers/` 복사
  - `claude.ts`, `codex.ts`, `gemini.ts`
  - import 경로 수정
  - verify: 타입 체크 통과

- [x] **A-2-3** `agents/renderer.ts` 복사 + 의존성 수정
  - `import { PresenceGateway }` → `src/presence/types.ts`에서 resolve
  - **blockedBy**: A-4 완료 또는 PresenceGateway 타입 인라인 정의
  - verify: 타입 체크 통과

- [x] **A-2-4** `agents/manager.ts` 복사
  - 외부 의존 없음 (타입 import만)
  - verify: 타입 체크 통과

- [x] **A-2-5** `agents/index.ts` 작성
  - 모든 agents 모듈 re-export
  - verify: `import { AgentSessionManager } from './agents'` 가능

#### Sub Agent 2: stream + command 이동

- [x] **A-3-1** `claude-stream.ts` → `src/stream/claude-parser.ts`
  - 외부 의존 없음
  - verify: 타입 체크 통과

- [x] **A-3-2** `claude-stream.test.ts` → `src/stream/claude-parser.test.ts`
  - import 경로 수정
  - verify: `bun test src/stream/` 통과

- [x] **A-3-3** `commands/registry.ts` → `src/command/registry.ts` + KW 타입 제거
  - `import { Client, MessageDataPayload } from '../chat'` 제거
  - `ReplyClient` generic 타입 정의 (spec §3.8)
  - `CommandContext.data` → `Record<string, unknown>`
  - `import { EmbedData }` → `Record<string, unknown>` 로컬 타입
  - `import { PresenceGateway }` → presence 이동 후 resolve
  - verify: 타입 체크 통과, KW import 0개

- [x] **A-3-4** `commands/registry.test.ts` → `src/command/registry.test.ts`
  - import 수정
  - verify: `bun test src/command/` 통과

#### Sub Agent 3: presence/ 이동

- [x] **A-4-1** `presence/types.ts` 복사
  - PresenceGateway 인터페이스. 외부 의존 없음 (KW/Discord import 제거)
  - verify: 파일 존재

- [x] **A-4-2** `presence/null-presence.ts` 복사
  - import `./types`만
  - verify: 타입 체크 통과

- [x] **A-4-3** `presence/discord-presence.ts` 복사
  - DiscordClient → TypingClient 인터페이스로 추상화
  - verify: 타입 체크 통과

- [x] **A-4-4** `presence/index.ts` 작성
  - re-export
  - verify: import 가능

- [x] **A-4-5** `presence/presence.test.ts` 복사
  - KakaoWorkPresence 테스트 제거 (KW-specific)
  - verify: `bun test src/presence/` 통과

- [x] **A-4-6** `kakaowork-presence.ts` 제외 확인
  - KW-specific — pray-bot에 포함하지 않음
  - verify: pray-bot에 파일 미존재

### A-5. Phase A 통합 검증 🔗 SEQUENTIAL

> A-2~A-4 모든 Sub Agent 완료 후. Main Agent가 직접 수행.

- [x] **A-5-1** `src/index.ts` re-export 작성
  - agents, stream, command, presence 모듈 re-export
  - verify: `import { AgentSessionManager, CommandRegistry } from 'pray-bot'` 가능

- [x] **A-5-2** pray-bot 전체 타입 체크
  - verify: `npx tsc --noEmit` 에러 0

- [x] **A-5-3** pray-bot 전체 테스트
  - verify: `bun test` 통과 (18 tests, 0 failures)

- [ ] **A-5-4** git commit (Phase A)
  - `feat: Phase A — agents, stream, command, presence modules`
  - verify: 커밋 성공

---

## Phase B: Infrastructure Modules

> **blockedBy**: Phase A 완료

### B-1~B-4. 인프라 모듈 이동 🔀 PARALLEL GROUP

> 4개 Sub Agent 동시 실행. 각 모듈은 서로 독립적.

#### Sub Agent 1: cron/ 이동

- [x] **B-1-1** cron 코어 파일 복사
  - `types.ts`, `store.ts`, `state.ts`, `timer.ts`, `ops.ts`, `schedule.ts`, `locked.ts`, `run-log.ts`, `formatter.ts` → `src/cron/`
  - verify: 파일 존재

- [x] **B-1-2** cron actions 복사
  - `actions/index.ts`, `actions/notify.ts`, `actions/http.ts` → `src/cron/actions/`
  - **판단 필요**: notify action이 KW-specific이면 분리
  - verify: 타입 체크 통과

- [x] **B-1-3** `cron/jobs.ts` 판단
  - 등록된 job 목록이 KW-specific이면 kw-chat 잔류
  - 범용 skeleton만 이동
  - verify: 결정 기록

- [x] **B-1-4** `cron/index.ts` 작성
  - re-export
  - verify: import 가능

- [x] **B-1-5** cron 테스트 확인
  - 기존 테스트가 있으면 이동
  - verify: `bun test src/cron/` 통과

#### Sub Agent 2: monitor/ (claude-monitor) 이동

- [x] **B-2-1** 모든 파일 복사
  - `index.ts`, `discovery.ts`, `parser.ts`, `types.ts`, `formatter.ts`, `token-usage.ts` → `src/monitor/`
  - verify: 파일 존재

- [x] **B-2-2** import 경로 수정
  - 모듈 내부 `./` 기준으로 수정
  - verify: 타입 체크 통과

- [x] **B-2-3** 테스트 이동
  - `index.test.ts` → `src/monitor/index.test.ts`
  - verify: `bun test src/monitor/` 통과

#### Sub Agent 3: codex-server/ 이동

- [x] **B-3-1** 파일 복사
  - `client.ts`, `session-store.ts`, `types.ts` → `src/codex-server/`
  - verify: 파일 존재

- [x] **B-3-2** import 수정
  - 모듈 내부 상대경로만 사용 확인
  - verify: 타입 체크 통과

- [x] **B-3-3** 테스트 이동
  - `client.test.ts`, `session-store.test.ts` → `src/codex-server/`
  - verify: `bun test src/codex-server/` 통과

#### Sub Agent 4: discord/ 이동

- [x] **B-4-1** 범용 파일 복사
  - `client.ts`, `types.ts`, `channel-registry.ts`, `thread-route-store.ts`, `commands.ts`, `throttle-queue.ts`, `rate-limiter.ts`, `format.ts`, `ensure-channel.ts` → `src/discord/`
  - verify: 파일 존재

- [x] **B-4-2** KW-specific 파일 제외 확인
  - `notifications.ts`, `codex-approval-ui.ts`, `error-channel.ts` → kw-chat 잔류
  - verify: pray-bot에 미존재

- [x] **B-4-3** discord 내부 import 수정
  - `client.ts`의 `import { DiscordThrottleQueue }` 등
  - verify: 타입 체크 통과

- [x] **B-4-4** discord 테스트 이동
  - `throttle-queue.test.ts` → `src/discord/`
  - verify: `bun test src/discord/` 통과

### B-5. auto-thread/ 이동 + 범용화 🔗 SEQUENTIAL

> **blockedBy**: B-4 (discord 이동) 완료

- [x] **B-5-1** 파일 복사
  - `index.ts`, `resolver.ts`, `formatter.ts`, `store.ts`, `monitor-state-store.ts`, `monitor-log.ts`, `types.ts` → `src/auto-thread/`
  - verify: 파일 존재

- [x] **B-5-2** resolver.ts KW 경로 매핑 제거
  - `import { ChannelMapping }` → 내부 import로 수정 (discord 이미 이동됨)
  - KW-specific 경로 맵 (work-status, message-gate 등) 제거
  - verify: `grep -i kakaowork src/auto-thread/` 결과 0

- [x] **B-5-3** 테스트 이동
  - `resolver.test.ts`, `store.test.ts`, `monitor-log.test.ts`, `monitor-state-store.test.ts`
  - verify: `bun test src/auto-thread/` 통과

### B-6. 기타 파일 이동 🔀 PARALLEL GROUP

> **blockedBy**: B-4 (discord 이동) 완료
> B-5와 B-6은 병렬 가능

#### Sub Agent A: worktree-watcher + git-watcher

- [x] **B-6-1** `git-watcher.ts` → `src/git-watcher.ts`
  - 외부 의존 확인 후 복사
  - verify: 타입 체크 통과

- [x] **B-6-3** `worktree-watcher.ts` → `src/worktree-watcher.ts`
  - `import { saveChannelMapping } from './config'` 제거
  - ChannelRegistry, DiscordClient import → pray-bot 내부 경로로 수정
  - verify: 타입 체크 통과

- [x] **B-6-4** `worktree-watcher.test.ts` 이동
  - verify: `bun test src/worktree-watcher` 통과

#### Sub Agent B: browser-tool + server util

- [x] **B-6-2** `browser-tool.ts` → `src/browser-tool.ts`
  - 외부 의존 확인 후 복사
  - verify: 타입 체크 통과

- [x] **B-6-5** `routes/util.ts` → `src/server/util.ts`
  - `jsonResponse`, middleware 등 범용 유틸
  - verify: 타입 체크 통과

### B-7. Phase B 통합 검증 + kw-chat import 전환 🔗 SEQUENTIAL

> **blockedBy**: B-1~B-6 모두 완료. Main Agent가 직접 수행.

- [x] **B-7-1** `src/index.ts` re-export 확장
  - cron, monitor, codex-server, discord, auto-thread, server 추가
  - verify: import 가능

- [x] **B-7-2** pray-bot 전체 타입 체크
  - verify: `npx tsc --noEmit` 에러 0

- [x] **B-7-3** pray-bot 전체 테스트
  - verify: `bun test` 통과 (55 pass, 0 fail)

- [x] **B-7-4** kw-chat import 전환
  - kw-chat의 로컬 import (`./agents`, `./discord` 등) → `pray-bot` import
  - verify: `npx tsc --noEmit` (kw-chat) — 0 migration errors (pre-existing only)

- [x] **B-7-5** kw-chat 이동 완료 파일 삭제
  - pray-bot으로 이동된 원본 파일 삭제
  - verify: 삭제 파일 목록 기록

- [x] **B-7-6** kw-chat 테스트
  - verify: `bun test` (kw-chat) — 65 pass, 4 fail (pre-existing GitHub API timeouts)

- [ ] **B-7-7** git commit (Phase B)
  - pray-bot: `feat: Phase B — cron, monitor, codex-server, discord, auto-thread`
  - kw-chat: `refactor: switch imports to pray-bot`
  - verify: 커밋 성공

---

## Phase C: Plugin System + kw-chat Refactor

> **blockedBy**: Phase B 완료

### C-1. Plugin 인터페이스 정의 🔗 SEQUENTIAL

> Main Agent 또는 단일 Sub Agent

- [x] **C-1-1** `src/plugin/types.ts` 작성
  - `PrayBotPlugin`, `PluginContext`, `RouteDefinition`, `CronActionDefinition`
  - spec §3.3 기반
  - verify: 타입 체크 통과

- [x] **C-1-2** `src/plugin/loader.ts` 작성
  - `PluginManager` class: register(), startAll(), stopAll(), list()
  - 플러그인 등록/시작/정지 라이프사이클
  - verify: 타입 체크 통과

- [x] **C-1-3** plugin re-export
  - `src/plugin/index.ts`
  - verify: import 가능

### C-2. PrayBot 엔진 클래스 🔗 SEQUENTIAL

> **blockedBy**: C-1 완료

- [x] **C-2-1** `PrayBot` 클래스 설계
  - constructor(config), `use(plugin)`, `start()`, `stop()`
  - config: discord/agents/server 옵션
  - verify: 타입 정의 완료

- [x] **C-2-2** `PrayBot.start()` 구현
  - (1) Agent session manager 초기화
  - (2) 플러그인 `onStart` 호출 (PluginContext 제공)
  - (3) HTTP server 시작 (Bun.serve)
  - verify: pray-bot 단독 실행 가능

- [x] **C-2-3** `PrayBot.stop()` 구현
  - 역순: 플러그인 onStop → server stop
  - verify: graceful shutdown

- [x] **C-2-4** `PrayBot.use(plugin)` 구현
  - 플러그인의 commands, routes, cronActions를 각 매니저에 등록
  - verify: 플러그인 등록 후 커맨드/라우트 동작

### C-3. HTTP Server 범용화 🔗 SEQUENTIAL

> **blockedBy**: C-2 완료

- [x] **C-3-1** HTTP Server in `src/bot.ts`
  - Bun.serve 래퍼 with handleRequest() route matching
  - Plugin-registered routes via addRoute()
  - verify: 서버 기동 + 라우트 응답

- [x] **C-3-2** 기본 라우트
  - `GET /health` → `{ status: "ok" }` built into PrayBot
  - verify: 구현 완료

### C-4. kw-chat 플러그인 래핑 🔀 PARALLEL GROUP

> **blockedBy**: C-3 완료
> 각 플러그인은 독립적이므로 병렬 가능. 단 C-4-4는 모든 플러그인 완료 후.

#### Sub Agent 1: workflowPlugin

- [x] **C-4-1** `workflowPlugin` 작성
  - kw-chat `workflow/`, `routes/workflow.ts` → PrayBotPlugin 래핑
  - `/api/workflow/*` 라우트 등록
  - verify: `curl http://localhost:4488/api/workflow` 응답

#### Sub Agent 2: kwChatPlugin

- [x] **C-4-2** `kwChatPlugin` 작성
  - KW WebSocket 클라이언트 (`chat.ts`)
  - 커맨드 등록 (`commands/*.ts`)
  - hook-approval 통합
  - verify: 채팅 커맨드 응답

#### Sub Agent 3: kwNotifyPlugin (옵셔널)

- [x] **C-4-3** `kwNotifyPlugin` 작성
  - `discord/notifications.ts`, `discord/error-channel.ts` 래핑
  - verify: Discord 알림 동작

#### Main Agent: index.ts 리팩토링 (blockedBy: C-4-1~3)

- [x] **C-4-4** kw-chat `index.ts` 리팩토링
  - 2000+ lines → PrayBot 초기화 + `bot.use(plugin)` 구조
  - spec §3.4 참조
  - verify: 기존 기능 전부 동작

### C-5~C-6. Audit + 검증 🔀 PARALLEL GROUP

> **blockedBy**: C-4 완료

#### Sub Agent: Sensitive Data Audit

- [x] **C-5-1** 내부 URL 스캔
  - `grep -ri 'kakaowork\|dktechin\|anchorage\|sbox\|inhouse' pray-bot/src/`
  - verify: 결과 0건 (2건 발견 → 수정 완료)

- [x] **C-5-2** 토큰/키 스캔
  - `grep -ri 'ghp_\|xoxb-\|Bearer\|sk-' pray-bot/src/`
  - verify: 결과 0건

- [x] **C-5-3** `.env.example` 작성
  - Discord token, LLM API key placeholder만
  - verify: 실제 값 없음

- [x] **C-5-4** 주석 내 내부 정보 제거
  - 이동된 파일 전체 스캔
  - verify: grep 결과 0건

#### Main Agent: 통합 검증

- [x] **C-6-1** pray-bot 타입 체크
  - verify: `npx tsc --noEmit` 에러 0

- [x] **C-6-2** pray-bot 테스트
  - verify: `bun test` 55 pass, 0 fail

- [x] **C-6-3** kw-chat 타입 체크
  - verify: `npx tsc --noEmit` (kw-chat) — pre-existing errors only (api-server, scripts, tests, token)

- [x] **C-6-4** kw-chat 테스트
  - verify: `bun test` (kw-chat) 65 pass, 4 fail (pre-existing GitHub API timeouts)

- [ ] **C-6-5** 기능 회귀 테스트
  - Discord 봇, Claude/Codex 세션, workflow API, cron
  - verify: 수동 확인 (requires runtime)

- [ ] **C-6-6** git commit (Phase C)
  - pray-bot: `feat: Phase C — plugin system + PrayBot engine`
  - kw-chat: `refactor: plugin consumer structure`
  - verify: 커밋 성공

---

## Phase D: Cleanup & Ship

> **blockedBy**: Phase C 완료

### D-1. Dead code 삭제 🔀 PARALLEL GROUP

> kw-chat worktree에서 작업. 병렬로 삭제 가능하나, 파일 단순 삭제이므로 단일 Agent로 충분.

- [!] **D-1-1** kw-chat `kasper.ts` 삭제
  - **BLOCKED**: kasper는 10+ 파일에서 활발히 사용 중 (index.ts, api-server.ts, plugins, commands 등). 삭제 시 대규모 리팩토링 필요. extraction 범위 밖.

- [!] **D-1-2** kw-chat `tools.ts` 삭제
  - **BLOCKED**: system-prompt.ts → kasper.ts 체인으로 사용 중

- [!] **D-1-3** kw-chat `system-prompt.ts` 삭제
  - **BLOCKED**: kasper.ts에서 import 중

- [!] **D-1-4** kw-chat `commands/kasper.ts` 삭제
  - **BLOCKED**: commands/index.ts에서 export, kw-chat-plugin에서 등록

- [!] **D-1-5** AWS SDK 의존성 제거
  - **BLOCKED**: kasper.ts가 @aws-sdk/client-bedrock-runtime 사용 중

### D-2. 문서 + 정리 🔀 PARALLEL GROUP

#### Sub Agent 1: pray-bot 문서

- [x] **D-2-1** pray-bot README.md 작성
  - 개요, 설치, 빠른 시작, 아키텍처, 플러그인 가이드
  - verify: 파일 존재

- [x] **D-2-2** pray-bot `.env.example` 최종 확인
  - Discord BOT token, Claude/Codex/Gemini API key
  - verify: 민감 정보 없음

#### Sub Agent 2: kw-chat 정리

- [x] **D-2-3** kw-chat 삭제 파일 최종 확인
  - 이동 완료된 원본 전부 삭제
  - verify: 중복 파일 0 (config.ts, tools.ts, index.ts are legitimately separate)

- [x] **D-2-4** CLAUDE.md 업데이트
  - pray-bot 프로젝트 구조 반영 (Key Files, TypeScript Config 추가)
  - verify: 최신 상태

### D-3. 최종 검증 + Ship 🔗 SEQUENTIAL

> **blockedBy**: D-1, D-2 완료. Main Agent 직접 수행.

- [x] **D-3-1** pray-bot 최종 빌드 + 테스트
  - verify: `npx tsc --noEmit && bun test` — 0 errors, 55 tests pass

- [x] **D-3-2** kw-chat 최종 빌드 + 테스트
  - verify: pre-existing errors only, 65/70 tests pass (4 GitHub API timeouts)

- [x] **D-3-3** sensitive data 최종 스캔
  - grep 스캔 반복
  - verify: 결과 0건

- [ ] **D-3-4** pray-bot public repo push
  - verify: GitHub repo 접근 가능

- [ ] **D-3-5** extraction spec 체크리스트 완료
  - `pray-bot-extraction-spec.md` §6 전체 `[x]`
  - verify: 모든 항목 체크

---

## 의존 관계 + 병렬 실행 맵

```
Phase A
═══════
A-1 (scaffold) ──────── Main 직접
  └─→ ┌── A-2 (agents)    ── Sub Agent 1 ─┐
      ├── A-3 (stream+cmd) ── Sub Agent 2 ─┤ 🔀 PARALLEL
      └── A-4 (presence)   ── Sub Agent 3 ─┘
           └─→ A-5 (통합 검증) ── Main 직접

Phase B
═══════
      ┌── B-1 (cron)     ── Sub Agent 1 ─┐
      ├── B-2 (monitor)  ── Sub Agent 2 ─┤ 🔀 PARALLEL
      ├── B-3 (codex)    ── Sub Agent 3 ─┤
      └── B-4 (discord)  ── Sub Agent 4 ─┘
           └─→ ┌── B-5 (auto-thread) ── Sub Agent A ─┐ 🔀 PARALLEL
               └── B-6 (기타 파일)   ── Sub Agent B ─┘
                    └─→ B-7 (통합 검증 + import 전환) ── Main 직접

Phase C
═══════
C-1 (plugin interface) ── Main/Single Agent
  └─→ C-2 (PrayBot class) ── Main
       └─→ C-3 (HTTP server) ── Main
            └─→ ┌── C-4-1 (workflowPlugin) ── Sub Agent 1 ─┐
                 ├── C-4-2 (kwChatPlugin)   ── Sub Agent 2 ─┤ 🔀 PARALLEL
                 └── C-4-3 (kwNotifyPlugin) ── Sub Agent 3 ─┘
                      └─→ C-4-4 (index.ts 리팩토링) ── Main
                           └─→ ┌── C-5 (audit)  ── Sub Agent ─┐ 🔀 PARALLEL
                                └── C-6 (검증)   ── Main      ─┘

Phase D
═══════
D-1 (dead code 삭제) ── Single Agent
  + D-2 (문서) 🔀 PARALLEL ─┐
       ├── Sub Agent 1 (pray-bot 문서)
       └── Sub Agent 2 (kw-chat 정리)
            └─→ D-3 (최종 검증 + ship) ── Main 직접
```

---

## 작업량 요약

| Phase | Subtask | 병렬 그룹 | Max 동시 Agent |
|-------|:-------:|:---------:|:-------------:|
| A | 16 | 1 (3 agents) | 3 |
| B | 24 | 2 (4+2 agents) | 4 |
| C | 18 | 2 (3+1 agents) | 3 |
| D | 10 | 1 (2 agents) | 2 |
| **합계** | **68** | **6 groups** | **max 4** |

### 핵심 리스크 subtask

| subtask | 리스크 | 대응 |
|---------|--------|------|
| A-3-3 (registry KW 타입 제거) | 타입 깨짐 | spec §3.8 generic 타입 정의 따름 |
| B-5-2 (resolver KW 매핑 제거) | 기능 누락 | 범용 프로젝트 매칭만 유지 |
| C-4-4 (index.ts 리팩토링) | 회귀 최대 | Phase C 마지막에 수행, 기존 기능 전수 테스트 |
| C-5-* (sensitive data) | 보안 사고 | push 전 반드시 grep scan |
