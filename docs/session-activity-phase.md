# Session Activity Phase — Hook-Based Detection

> status: draft
> created: 2026-02-17
> updated: 2026-02-18
> revision: 7

<!-- ═══════════════════════════════════════════════════ -->
<!-- LLM Work Guide — Instructions for implementing LLM -->
<!-- ═══════════════════════════════════════════════════ -->

## 0. LLM Work Guide

> **Follow the Spec Execution Protocol (`/sisyphus`).** 이 스펙 고유 사항만 아래에 기술.

- State file: `docs/session-activity-phase.state.md`
- §3.5 Naming Conventions의 이름을 그대로 사용할 것
- Design decision 발생 시 §8에 append

<!-- ═══════════════════════════════════════════ -->
<!-- Fixed — Modify only on direction change    -->
<!-- ═══════════════════════════════════════════ -->

## 1. Goal

Claude Code 세션의 활동 단계를 **Hook 이벤트 push 기반**으로 실시간 감지한다.

현재 문제:
- `SessionSnapshot.state`는 `active | idle | completed | stale` 4단계, 프로세스 존재 + mtime 기반
- `active` 내에서 LLM 응답 중 vs 사용자 입력 대기 구분 불가
- auto-thread 세션 발견이 15초 polling 기반 → 지연

Hook 기반 해결:

| Hook Event | → ActivityPhase | 용도 |
|------------|----------------|------|
| `Stop` | → `interactable` + 응답 포워딩 | Turn 완료, 입력 대기 + 마지막 assistant 응답을 Discord thread에 전달 |
| `UserPromptSubmit` | → `busy` | 유저 입력 → LLM 처리 시작 |
| `Notification` (idle_prompt) | → `waiting_question` | AskUserQuestion 대기 |
| `Notification` (permission_prompt) | → `waiting_permission` | Tool 승인 대기 |
| `SessionStart` | → auto-thread 즉시 생성 | 세션 발견 지연 제거 |
| `SessionEnd` | → `completed` | 세션 종료 즉시 반영 |

**Codex는 이미 JSON-RPC로 양방향 통신.** 이 스펙은 **Claude Code 전용**이며 기존 monitor JSONL 로직을 건드리지 않는다.

**이 스펙은 Phase 1 (상태 감지 + auto-thread 보강)만 다룬다.** Discord → 세션 메시지 전달은 별도 스펙.

## 2. Non-Goals

- Discord → Claude Code 세션 메시지 전달 (별도 Phase 2 스펙)
- Claude Code TUI stdin 주입/제어
- Codex 세션 관련 변경 (이미 JSON-RPC로 충분)
- 기존 `state` 4값 변경 (유지, `activityPhase`는 보조 필드)
- 기존 monitor JSONL 파싱 로직 변경
- 기존 `notify-completion.py` hook 리팩토링

## 3. Design

### 3.1 Deliverables

| Deliverable | Path | Consumer | Format |
|-------------|------|----------|--------|
| Hook HTTP 엔드포인트 | `src/usage-monitor/hook-receiver.ts` | Claude Code hooks | HTTP POST receiver (새 파일) |
| Hook 스크립트 | `hooks/pray-bot-hook.sh` | Claude Code settings.json | Shell → curl pray-bot (새 파일) |
| Monitor hook 통합 | `src/usage-monitor/claude-monitor.ts` | PrayBot | hook → snapshot 업데이트 (메서드 추가) |
| Auto-thread hook 통합 | `src/auto-thread/index.ts` | AutoThreadDiscovery | SessionStart 즉시 생성 + 응답 포워딩 (메서드 추가) |
| Hook receiver 테스트 | `src/usage-monitor/__tests__/hook-receiver.test.ts` | CI | Bun test (새 파일) |

### 3.2 Interface

```typescript
// src/usage-monitor/hook-receiver.ts — 새 파일

/** Hook stdin의 공통 필드 — provider-agnostic */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  provider: 'claude' | 'codex';  // 향후 프로바이더 추가 시 union 확장
  permission_mode?: string;
}

export interface StopHookEvent extends HookEvent {
  hook_event_name: 'Stop';
  stop_hook_active?: boolean;
}

export interface UserPromptSubmitHookEvent extends HookEvent {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface SessionStartHookEvent extends HookEvent {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  model?: string;
  agent_type?: string;
}

export interface SessionEndHookEvent extends HookEvent {
  hook_event_name: 'SessionEnd';
  reason?: string;
}

export interface NotificationHookEvent extends HookEvent {
  hook_event_name: 'Notification';
  notification_type: 'permission_prompt' | 'idle_prompt' | 'elicitation_dialog' | 'auth_success';
  message: string;
  title?: string;
}

export type AnyHookEvent =
  | StopHookEvent
  | UserPromptSubmitHookEvent
  | SessionStartHookEvent
  | SessionEndHookEvent
  | NotificationHookEvent;

/**
 * Hook 이벤트를 수용할 수 있는 monitor의 인터페이스.
 * SessionMonitorProvider와 별도 — 기존 인터페이스를 오염시키지 않는다.
 * ClaudeUsageMonitor가 이 인터페이스를 구현한다.
 * 향후 CodexUsageMonitor 등도 구현 가능.
 */
export interface HookAcceptingMonitor {
  updateActivityPhase(sessionId: string, phase: ActivityPhase): void;
  updateSessionState(sessionId: string, state: SessionSnapshot['state']): void;
  registerSession(event: SessionStartHookEvent): SessionSnapshot;
}

/**
 * Hook HTTP route factory.
 * provider 필드로 라우팅: providers Map에서 해당 monitor를 찾아 위임.
 *
 * HTTP handler는 200을 즉시 반환한 후, 응답 포워딩 등 부가 작업은
 * fire-and-forget (.catch(console.error))으로 처리한다.
 * → transcript I/O가 hook 응답을 블로킹하지 않음.
 *
 * HTTP Responses:
 *   200 { ok: true }                    — 정상 처리
 *   400 { error: "invalid JSON" }       — body 파싱 실패
 *   400 { error: "unknown provider" }   — providers Map에 없는 provider
 */
export function createHookRoute(
  providers: Map<string, HookAcceptingMonitor>,
  autoThread: AutoThreadDiscovery,
): RouteDefinition;

/**
 * Transcript JSONL tail에서 마지막 assistant 텍스트 응답을 추출.
 * 내부적으로 claude-parser.ts의 tailJsonl(transcriptPath, 256_000)을 호출하여
 * 마지막 256KB를 읽은 뒤, 역순으로 type === 'assistant' entry를 탐색.
 * message.content[] 에서 type === 'text' 블록만 추출 (tool_use 블록 무시).
 *
 * @param maxLength - Discord 메시지 길이 제한 (default: 1900, Discord 2000 - 여유분)
 * @returns 텍스트 또는 null (assistant 메시지 없음 / text 블록 없음)
 */
export async function extractLastAssistantResponse(
  transcriptPath: string,
  maxLength?: number,
): Promise<string | null>;
```

```typescript
// src/auto-thread/index.ts — AutoThreadDiscovery에 메서드 추가

export class AutoThreadDiscovery {
  // ... 기존 메서드 유지

  /**
   * SessionStart hook에서 즉시 thread 생성.
   * 기존 onMonitorRefresh() 기반 발견의 즉시 버전.
   */
  onSessionStart(snapshot: SessionSnapshot): Promise<void>;

  /**
   * 세션의 Discord thread에 메시지 전송.
   * discoveredMap에서 buildSessionKey(provider, sessionId)로 thread 조회 →
   * discordClient.sendMessage().
   *
   * @returns true = 전송 성공, false = thread 미존재 (미생성 or 매핑 없음)
   *          Discord API 실패 시에도 false 반환 (에러는 console.error로 로깅).
   */
  sendToSessionThread(provider: string, sessionId: string, message: string): Promise<boolean>;
}
```

```typescript
// src/usage-monitor/claude-monitor.ts — ClaudeUsageMonitor에 HookAcceptingMonitor 구현 추가

export class ClaudeUsageMonitor implements SessionMonitorProvider, HookAcceptingMonitor {
  // ... 기존 메서드 유지 (refreshOnce, determineState, getAll 등)

  /** sessions Map에서 sessionId로 찾아 activityPhase만 교체. */
  updateActivityPhase(sessionId: string, phase: ActivityPhase): void;

  /** SessionEnd → completed 등. */
  updateSessionState(sessionId: string, state: SessionSnapshot['state']): void;

  /** 최소 정보(sessionId, cwd, model)로 skeleton snapshot 생성. 다음 polling에서 보강. */
  registerSession(event: SessionStartHookEvent): SessionSnapshot;
}
```

### 3.3 Flow

**Hook 이벤트 흐름:**

```
Claude Code TUI
  │
  ├─ 세션 시작 ─────── SessionStart hook ──→ pray-bot POST /api/hook
  │                                            ├─ monitor.registerSession()
  │                                            └─ autoThread.onSessionStart() → Discord thread 즉시 생성
  │
  ├─ 유저 입력 ─────── UserPromptSubmit ───→ pray-bot POST /api/hook
  │                                            └─ monitor.updateActivityPhase(sid, 'busy')
  │
  ├─ LLM 응답 중 ──── (JSONL에 기록됨, hook 없음 — busy 유지)
  │
  ├─ Turn 완료 ─────── Stop hook ──────────→ pray-bot POST /api/hook
  │                                            ├─ 200 즉시 반환
  │                                            ├─ monitor.updateActivityPhase(sid, 'interactable')
  │                                            └─ (fire-and-forget) extractLastAssistantResponse()
  │                                                 → autoThread.sendToSessionThread() → Discord: 응답 내용
  │
  ├─ 권한 요청 ─────── Notification ───────→ pray-bot POST /api/hook
  │   (permission_prompt)                      └─ monitor.updateActivityPhase(sid, 'waiting_permission')
  │
  ├─ 질문 대기 ─────── Notification ───────→ pray-bot POST /api/hook
  │   (idle_prompt)                            └─ monitor.updateActivityPhase(sid, 'waiting_question')
  │
  └─ 세션 종료 ─────── SessionEnd hook ────→ pray-bot POST /api/hook
                                               └─ monitor.updateSessionState(sid, 'completed')
                                                  → Discord: "세션이 종료되었습니다"
```

**기존 JSONL polling과의 관계:**

```
Hook push (즉시)     ← activityPhase, 세션 시작/종료, assistant 응답 포워딩
JSONL polling (15초) ← 메타데이터 보강 (model, tokens, tools, turnCount, waitReason 등)
```

- Hook이 activityPhase의 primary source
- JSONL polling은 메타데이터 보강 + hook을 놓쳤을 때 fallback
- 두 시스템이 같은 `SessionSnapshot`에 쓰지만 서로 다른 필드를 담당

**Auto-thread SessionStart 통합:**

```
현재: 15초 polling → 새 세션 발견 → thread 생성 (최대 15초 지연)
변경: SessionStart hook → 즉시 thread 생성 (< 1초)
     + 15초 polling은 fallback으로 유지 (hook이 실패했을 때)
```

**Hook 스크립트:**

```bash
#!/bin/bash
# hooks/pray-bot-hook.sh
# Claude Code hook → pray-bot HTTP push
# 모든 hook event에서 공유. async로 실행되어 Claude Code를 블록하지 않음.
#
# 환경변수:
#   PRAY_BOT_URL      — pray-bot HTTP base URL (default: http://localhost:4488)
#   PRAY_BOT_PROVIDER — provider 식별자 (default: claude)

PRAY_BOT_URL="${PRAY_BOT_URL:-http://localhost:4488}"
PROVIDER="${PRAY_BOT_PROVIDER:-claude}"

# stdin에서 hook event JSON 읽기 + provider 필드 주입
INPUT=$(cat | jq -c --arg p "$PROVIDER" '. + {provider: $p}')

# pray-bot에 전달 (fire-and-forget, 1초 timeout)
curl -s -X POST "${PRAY_BOT_URL}/api/hook" \
  -H "Content-Type: application/json" \
  -d "$INPUT" \
  --max-time 1 \
  > /dev/null 2>&1 || true
```

### 3.4 Existing Code Impact

| Existing File | Change | Impact |
|---------------|--------|:------:|
| `src/usage-monitor/claude-monitor.ts` | `HookAcceptingMonitor` implements + 3개 메서드 추가 | Low — 기존 로직 변경 없음, 메서드 추가 |
| `src/auto-thread/index.ts` | `onSessionStart()` + `sendToSessionThread()` 메서드 추가 | Med — SessionStart 즉시 생성 + 응답 포워딩 경로 추가 |
| `src/bot.ts` (또는 plugin) | hook route 등록 | Low — `addRoute()` 호출 1줄 |

**건드리지 않는 파일:**
- `src/usage-monitor/claude-parser.ts` — JSONL 파싱 로직 변경 없음 (`tailJsonl` import만 사용)
- `src/usage-monitor/claude-discovery.ts` — 프로세스 발견 로직 변경 없음
- `src/codex-server/` — Codex 관련 코드 일체 변경 없음
- `~/.claude/hooks/notify-completion.py` — 기존 hook 변경 없음 (새 hook 추가)

### 3.5 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| type | `AnyHookEvent` | Hook event union type (provider-agnostic) |
| type | `StopHookEvent`, `SessionStartHookEvent`, ... | 개별 hook event 타입 |
| interface | `HookAcceptingMonitor` | hook 이벤트를 수용하는 monitor 인터페이스 |
| method | `updateActivityPhase` | `HookAcceptingMonitor` — hook에서 phase 업데이트 |
| method | `updateSessionState` | `HookAcceptingMonitor` — hook에서 state 업데이트 |
| method | `registerSession` | `HookAcceptingMonitor` — SessionStart hook에서 세션 등록 |
| method | `onSessionStart` | `AutoThreadDiscovery` — hook에서 즉시 thread 생성 |
| method | `sendToSessionThread` | `AutoThreadDiscovery` — provider:sessionId로 thread 조회 → 메시지 전송 (true=sent, false=not found) |
| function | `createHookRoute` | `hook-receiver.ts` — HTTP route factory |
| function | `extractLastAssistantResponse` | `hook-receiver.ts` — transcript tail에서 마지막 assistant 텍스트 추출 |
| file | `hook-receiver.ts` | `src/usage-monitor/` — Hook HTTP 엔드포인트 (새 파일) |
| file | `pray-bot-hook.sh` | `hooks/` — Claude Code hook script |
| endpoint | `POST /api/hook` | Hook 이벤트 수신 엔드포인트 |

## 4. Verification Criteria

- [ ] Given: Stop hook event 수신 / When: `POST /api/hook` / Then: 해당 세션 `activityPhase === 'interactable'`
- [ ] Given: UserPromptSubmit hook event 수신 / When: `POST /api/hook` / Then: 해당 세션 `activityPhase === 'busy'`
- [ ] Given: Notification(permission_prompt) 수신 / When: `POST /api/hook` / Then: `activityPhase === 'waiting_permission'`
- [ ] Given: Notification(idle_prompt) 수신 / When: `POST /api/hook` / Then: `activityPhase === 'waiting_question'`
- [ ] Given: SessionStart hook event 수신 + channel mapping 존재 / When: `POST /api/hook` / Then: Discord thread 즉시 생성
- [ ] Given: SessionEnd hook event 수신 / When: `POST /api/hook` / Then: 해당 세션 `state === 'completed'`
- [ ] Given: state !== 'active' / When: 어떤 hook이든 / Then: `activityPhase === null`
- [ ] Given: Stop hook + transcript에 assistant 텍스트 존재 + thread 매핑 존재 / When: `POST /api/hook` / Then: Discord thread에 마지막 assistant 응답 전달
- [ ] Given: Stop hook + assistant 응답 2000자 초과 / When: `POST /api/hook` / Then: 1900자 + `...` 로 truncate하여 전달
- [ ] Given: Stop hook + transcript에 assistant가 tool_use만 (텍스트 없음) / When: `POST /api/hook` / Then: 응답 포워딩 skip (null 반환)
- [ ] Given: Stop hook + thread 매핑 미존재 (thread 미생성) / When: `POST /api/hook` / Then: 응답 포워딩 silently skip, `activityPhase` 업데이트는 정상 수행
- [ ] Given: phase busy → interactable 전환 / When: auto-thread 처리 / Then: Discord에 상태 변경 메시지
- [ ] Given: pray-bot이 꺼져있을 때 hook 실행 / When: curl 실패 / Then: Claude Code에 영향 없음 (fire-and-forget)
- [ ] Given: body가 유효하지 않은 JSON / When: `POST /api/hook` / Then: `400 { error: "invalid JSON" }`
- [ ] Given: provider가 providers Map에 없음 / When: `POST /api/hook` / Then: `400 { error: "unknown provider" }`
- [ ] Given: 빈 transcript 파일 / When: `extractLastAssistantResponse()` / Then: null 반환
- [ ] Given: transcript에 assistant 없음 (user entry만) / When: `extractLastAssistantResponse()` / Then: null 반환
- [ ] Given: transcript에 thinking 블록만 있는 assistant / When: `extractLastAssistantResponse()` / Then: null 반환 (text 블록 없음)
- [ ] No regression on existing JSONL-based monitoring
- [ ] No regression on existing Codex JSON-RPC integration
- [ ] `npx tsc --noEmit` 통과
- [ ] `bun test` 통과

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| pray-bot이 꺼져있으면 hook event 유실 | 세션 상태 부정확 | JSONL polling이 fallback으로 메타데이터 보강; hook 미수신 세션은 `activityPhase = null` (unknown) |
| Hook 스크립트의 curl timeout으로 Claude Code 지연 | 사용자 경험 저하 | `--max-time 1` + `|| true` + hook 설정에서 `timeout: 5` |
| 동시에 여러 hook이 빠르게 연속 발생 | race condition | `updateActivityPhase()`는 단순 필드 교체, last-write-wins로 충분 |
| SessionStart hook은 JSONL이 아직 없는 시점에 발생 | registerSession()에 메타데이터 부족 | 최소 snapshot 생성 (sessionId, cwd, model만) → 다음 JSONL polling에서 보강 |
| transcript 파일이 크면 tail 읽기 지연 | Stop hook 응답 시간 증가 | `tailJsonl(path, 256_000)` — 마지막 256KB만 읽음. 200 즉시 반환 후 fire-and-forget이므로 hook 응답에 영향 없음 |

<!-- ═══════════════════════════════════════════ -->
<!-- Iterative — Updated each loop              -->
<!-- ═══════════════════════════════════════════ -->

## 6. Task Checklist

> Mark `[x]` only after verify passes.

- [x] ✅ Step 1: `HookAcceptingMonitor` 인터페이스 + hook event 타입 정의 + `createHookRoute()` 구현 (`src/usage-monitor/hook-receiver.ts`) → verify: unit test — provider 라우팅 + event type 파싱 확인
- [x] ✅ Step 2: `ClaudeUsageMonitor`에 `HookAcceptingMonitor` implements + 3개 메서드 추가 (`src/usage-monitor/claude-monitor.ts`) → verify: unit test — phase/state 업데이트 확인
- [x] ✅ Step 3: `AutoThreadDiscovery.onSessionStart()` + `sendToSessionThread()` 구현 (`src/auto-thread/index.ts`) → verify: hook event 수신 시 thread 생성 확인 + 메시지 전달 확인
- [x] ✅ Step 4: `extractLastAssistantResponse()` 구현 + Stop hook에서 응답 포워딩 연동 (`src/usage-monitor/hook-receiver.ts`) → verify: Stop hook 수신 시 transcript 마지막 assistant 텍스트가 Discord thread에 전달
- [x] ✅ Step 5: Hook route를 PrayBot에 등록 — `providers Map` 구성 + `createHookRoute()` 호출 (`src/bot.ts` 또는 plugin) → verify: `POST /api/hook` 응답 확인
- [x] ✅ Step 6: Hook 스크립트 작성 (`hooks/pray-bot-hook.sh`) → verify: `echo '{"hook_event_name":"Stop","session_id":"test","cwd":"/tmp"}' | bash hooks/pray-bot-hook.sh` 동작
- [x] ✅ Step 7: Unit test (`src/usage-monitor/__tests__/hook-receiver.test.ts`) → verify: `bun test` 통과
- [x] ⚠️ Step 8: Claude Code settings.json에 hook 등록 안내 문서 + 실제 세션 통합 테스트 → verify: tsc --noEmit 통과, bun test 126 pass / 0 fail

## 7. Open Questions

(none)

<!-- ═══════════════════════════════════════════ -->
<!-- Cumulative — Append-only, never delete     -->
<!-- ═══════════════════════════════════════════ -->

## 8. Decision Log

- 2026-02-17: `activityPhase`를 `state`와 별도 필드로 결정. 기존 4-state는 프로세스 lifecycle, `activityPhase`는 active 내 세부 단계.
- 2026-02-17: `interactable` 네이밍 선택. Discord에서 "상호작용 가능" 의미 직관적.
- 2026-02-18: **JSONL `stop_reason` 기반 → Hook push 기반으로 전면 변경.** 실제 JSONL에서 `stop_reason`은 항상 `null`. `system:turn_duration`도 가능하지만 hook이 더 직접적이고 빠름.
- 2026-02-18: Hook 선택 — `Stop`(interactable), `UserPromptSubmit`(busy), `Notification`(waiting_*), `SessionStart`(thread 생성), `SessionEnd`(completed).
- 2026-02-18: JSONL polling은 메타데이터 보강용으로 유지. Hook은 activityPhase + 세션 lifecycle의 primary source.
- 2026-02-18: auto-thread SessionStart hook 즉시 생성 추가. 기존 15초 polling은 fallback으로 유지.
- 2026-02-18: Codex는 변경 없음. JSON-RPC `turn/completed`, `requestApproval`이 이미 동등한 역할.
- 2026-02-18: **코드베이스 검증** — `src/monitor/`는 존재하지 않으며 실제 경로는 `src/usage-monitor/`. 클래스명도 `ClaudeUsageMonitor`. `ActivityPhase` 타입, `SessionSnapshot.activityPhase` 필드, `formatActivityPhaseChangeMessage()`는 이미 구현 완료.
- 2026-02-18: **provider-agnostic hook 설계** — `HookAcceptingMonitor` 인터페이스 도입. `createHookRoute()`는 `providers: Map<string, HookAcceptingMonitor>`를 받아 `event.provider` 필드로 라우팅. HookEvent에 `provider` 필드 추가, 엔드포인트 `/api/hook`으로 통합, hook 스크립트에서 `PRAY_BOT_PROVIDER` 환경변수로 provider 주입.
- 2026-02-18: **Stop hook 응답 포워딩** — `Stop` hook 수신 시 `transcript_path`에서 마지막 assistant 텍스트를 추출해 Discord thread에 전달. `extractLastAssistantResponse()`는 `tailJsonl()` 재활용. tool_use만 있는 턴은 skip. 2000자 초과 시 1900자에서 truncate.
- 2026-02-18: **Stop hook handler는 200 즉시 반환** — transcript I/O + Discord 포워딩은 fire-and-forget (`.catch(console.error)`). Hook 응답 지연 방지.
- 2026-02-18: **`sendToSessionThread` 반환값** — `true` = 전송 성공, `false` = thread 미존재 또는 Discord API 실패. 호출자는 반환값 무시 (fire-and-forget 패턴).

## 9. Handoff Snapshot

## 10. Changelog

| rev | date | summary |
|-----|------|---------|
| 1 | 2026-02-17 | Initial draft (JSONL stop_reason 기반) |
| 2 | 2026-02-17 | Monitor refresh 전략 추가 |
| 3 | 2026-02-18 | Hook push 기반으로 전면 재설계. SessionStart auto-thread 보강 추가. Codex 분리 명시. |
| 4 | 2026-02-18 | 코드베이스 검증: 경로 `src/usage-monitor/`, 클래스 `ClaudeUsageMonitor` 수정. 이미 구현된 항목 제거. |
| 5 | 2026-02-18 | Review 반영: §0 Spec Execution Protocol, formatter 태스크 제거(이미 구현), §4 에러 케이스, HTTP 응답 스펙 명시. |
| 6 | 2026-02-18 | Stop hook 응답 포워딩: extractLastAssistantResponse() + sendToSessionThread(). |
| 7 | 2026-02-18 | Review 반영: Stop hook fire-and-forget 명시, thread 미존재 케이스, tailJsonl import 관계, sendToSessionThread 반환값 시맨틱, extractLastAssistantResponse edge case 검증. |
