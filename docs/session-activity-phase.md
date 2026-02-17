# Session Activity Phase Detection

> status: draft
> created: 2026-02-17
> updated: 2026-02-17
> revision: 2

## 0. LLM Work Guide

> **Follow the Spec Execution Protocol (`/sisyphus`).** 아래는 이 스펙의 섹션 매핑.

| Item | Section |
|------|---------|
| Task Checklist | §6 |
| Naming Conventions | §3.5 |
| State file | `docs/session-activity-phase.state.md` |
| Decision Log | §8 (append-only) |
| Handoff Snapshot | §9 |
| Changelog | §10 |

<!-- ═══════════════════════════════════════════ -->
<!-- Fixed — Modify only on direction change    -->
<!-- ═══════════════════════════════════════════ -->

## 1. Goal

현재 `SessionSnapshot.state`는 `active | idle | completed | stale` 4단계로, **프로세스 존재 여부 + mtime**만 기반으로 판단한다. `active` 상태 안에서 LLM이 실제로 응답 생성 중인지, 아니면 사용자 입력을 대기 중인지 구분이 불가능하다.

새로운 `activityPhase` 필드를 추가하여, active 세션 내에서:

| Phase | 의미 | Discord 상호작용 |
|-------|------|-------------------|
| `busy` | LLM 응답 생성 중 또는 Tool 실행 중 | 불가 (대기) |
| `interactable` | Turn 완료, 사용자 입력 대기 | **가능** (메시지 전송 가능) |
| `waiting_permission` | Tool 승인 대기 | 승인/거부 가능 |
| `waiting_question` | AskUserQuestion 응답 대기 | 답변 가능 |

이를 통해 Discord에서 세션이 `interactable` 상태일 때 메시지를 이어서 보낼 수 있는 기반을 마련한다.

**이 스펙은 Phase 1 (상태 감지)만 다룬다.** Discord → 세션 메시지 전달 메커니즘은 별도 스펙.

## 2. Non-Goals

- Discord → Claude Code 세션 메시지 전달 (별도 Phase 2 스펙)
- Claude Code TUI stdin 주입/제어
- 기존 `state` 필드 제거 또는 변경 (기존 4-state 유지, `activityPhase`는 보조 필드)
- 기존 코드 리팩토링
- auto-thread 생성/라우팅 로직 변경

## 3. Design

### 3.1 Deliverables

| Deliverable | Path | Consumer | Format |
|-------------|------|----------|--------|
| ActivityPhase 타입 + 감지 로직 | `src/monitor/parser.ts` | ClaudeSessionMonitor | 기존 `extractSessionInfo()` 확장 |
| SessionSnapshot 확장 | `src/monitor/types.ts` | 전체 시스템 | `activityPhase` 필드 추가 |
| Discord 상태 표시 확장 | `src/auto-thread/formatter.ts` | AutoThreadDiscovery | 포매터 업데이트 |
| Monitor formatter 확장 | `src/monitor/formatter.ts` | HTTP API, CLI | 포매터 업데이트 |
| ActivityPhase 테스트 | `src/monitor/__tests__/activity-phase.test.ts` | CI | Bun test |

### 3.2 Interface

```typescript
// src/monitor/types.ts — 추가

/**
 * Active 세션 내 세부 활동 단계.
 * state === 'active' 일 때만 의미 있음.
 * completed/stale/idle에서는 항상 null.
 */
type ActivityPhase =
  | 'busy'                // LLM 응답 생성 중 또는 Tool 실행 중
  | 'interactable'        // Turn 완료, 사용자 입력 대기 중
  | 'waiting_permission'  // Tool 승인 대기
  | 'waiting_question';   // AskUserQuestion 응답 대기

// SessionSnapshot 확장
interface SessionSnapshot {
  // ... 기존 필드 유지
  activityPhase: ActivityPhase | null;  // state === 'active' 일 때만 non-null
}
```

```typescript
// src/monitor/parser.ts — SessionInfo 확장

interface SessionInfo {
  // ... 기존 필드 유지
  activityPhase: ActivityPhase | null;
  lastAssistantStopReason: string | null;  // 마지막 assistant의 stop_reason
}
```

```typescript
// src/monitor/parser.ts — 감지 함수 시그니처

/**
 * JSONL entries + 프로세스 정보에서 activityPhase를 결정한다.
 *
 * 판단 로직:
 * 1. waitReason === 'user_question' → 'waiting_question'
 * 2. waitReason === 'permission' → 'waiting_permission'
 * 3. 마지막 entry가 'assistant' + stop_reason === 'end_turn' + pending tool 없음 → 'interactable'
 * 4. 그 외 → 'busy'
 */
function determineActivityPhase(
  info: SessionInfo,
  mtime: number,
  now: number,
): ActivityPhase;
```

### 3.3 Flow

**JSONL 기반 ActivityPhase 판단 플로우:**

```
JSONL entries 파싱 완료 (extractSessionInfo)
  │
  ├─ waitReason === 'user_question'?
  │   └─ YES → 'waiting_question'
  │
  ├─ waitReason === 'permission'?
  │   └─ YES → 'waiting_permission'
  │
  ├─ 마지막 entry가 assistant?
  │   ├─ stop_reason === 'end_turn'?
  │   │   ├─ pending tool_use 없음?
  │   │   │   └─ YES → 'interactable' ✅ (Discord에서 메시지 가능)
  │   │   └─ NO → 'busy' (tool 실행 대기)
  │   └─ stop_reason === null or 없음?
  │       └─ 'busy' (아직 생성 중)
  │
  ├─ 마지막 entry가 user? (tool_result 포함)
  │   └─ 'busy' (Claude가 다음 응답 생성 시작)
  │
  └─ 기타 → 'busy'
```

**상태 전환 시 Discord 알림:**

```
busy → interactable:  "세션이 대기 중입니다. Discord에서 메시지를 보낼 수 있습니다."
interactable → busy:  "세션이 작업을 시작했습니다."
* → waiting_question: "세션이 질문에 대한 답변을 기다리고 있습니다."
* → waiting_permission: "세션이 도구 승인을 기다리고 있습니다: {toolNames}"
```

**Monitor refresh 전략 — On-Demand + Passive Polling:**

```
[On-Demand] Discord 명령 수신 → monitor.refresh() 즉시 호출 → 최신 상태로 응답
[Passive]   setInterval 30초 polling → 백그라운드 상태 갱신 (Discord 알림용)
[Passive]   fs.watch 변경 감지 → 10초 debounce → 백그라운드 상태 갱신
```

Discord 명령 처리 시 on-demand refresh로 즉시 최신 상태를 확보하므로,
background polling은 30초로 완화. fs.watch debounce(10초)는 기존 유지.

**refreshOnce() 내 통합:**

```
refreshOnce() 기존 흐름:
  1. getClaudeProcesses()
  2. discoverProjects()
  3. For each JSONL:
     a. extractSessionInfo(entries)
     b. determineState(proc, mtime, now)
     c. [NEW] if state === 'active': determineActivityPhase(info, mtime, now)
     d. snapshot.activityPhase = phase
```

### 3.4 Existing Code Impact

| Existing File | Change | Impact |
|---------------|--------|:------:|
| `src/monitor/types.ts` | `activityPhase` 필드 추가 | Low — 기존 필드 유지, 추가만 |
| `src/monitor/parser.ts` | `lastAssistantStopReason` 추출 + `determineActivityPhase()` 함수 | Low — extractSessionInfo 반환값 확장 |
| `src/monitor/index.ts` | refreshOnce()에서 activityPhase 할당 + pollInterval 30초로 변경 | Low — 2-3줄 추가, 상수 변경 |
| `src/auto-thread/formatter.ts` | 상태 변경 메시지에 activityPhase 반영 | Low — 분기 추가 |
| `src/monitor/formatter.ts` | 텍스트/임베드에 activityPhase 표시 | Low — 필드 추가 |

### 3.5 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| type | `ActivityPhase` | `'busy' \| 'interactable' \| 'waiting_permission' \| 'waiting_question'` |
| field | `activityPhase` | `SessionSnapshot`과 `SessionInfo`에 추가되는 필드 |
| field | `lastAssistantStopReason` | `SessionInfo`에 추가 — 마지막 assistant의 stop_reason |
| function | `determineActivityPhase` | `parser.ts` — JSONL 분석 결과로 phase 결정 |
| field | `previousActivityPhase` | `AutoThreadDiscovery`에서 phase 변화 추적용 |
| test file | `activity-phase.test.ts` | `src/monitor/__tests__/` 하위 |

## 4. Verification Criteria

- [ ] Given: active 세션 + 마지막 assistant entry의 stop_reason='end_turn' + 미해결 tool 없음 / When: monitor refresh / Then: `activityPhase === 'interactable'`
- [ ] Given: active 세션 + 마지막 entry가 user (tool_result 포함) / When: monitor refresh / Then: `activityPhase === 'busy'`
- [ ] Given: active 세션 + AskUserQuestion pending / When: monitor refresh / Then: `activityPhase === 'waiting_question'`
- [ ] Given: active 세션 + tool permission pending / When: monitor refresh / Then: `activityPhase === 'waiting_permission'`
- [ ] Given: active 세션 + 마지막 assistant에 stop_reason 없음 (스트리밍 중) / When: monitor refresh / Then: `activityPhase === 'busy'`
- [ ] Given: state !== 'active' (idle, completed, stale) / When: monitor refresh / Then: `activityPhase === null`
- [ ] Given: activityPhase가 busy → interactable로 변경 / When: auto-thread 알림 / Then: Discord에 상태 변경 메시지 전송
- [ ] No regression on existing `state` detection
- [ ] No regression on existing `waitReason` detection
- [ ] `npx tsc --noEmit` 통과
- [ ] `bun test` 통과

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| JSONL 포맷이 Claude Code 버전마다 다를 수 있음 | stop_reason 필드 누락 시 항상 busy로 fallback | 방어적 파싱: stop_reason 없으면 busy |
| mtime 기반 판단과 JSONL 내용 판단의 race condition | 짧은 순간 잘못된 phase 표시 | Discord 명령 시 on-demand refresh로 즉시 보정; passive polling 30초는 fallback |
| interactable 상태에서 TUI 사용자가 동시에 입력 | Phase 2 (메시지 전달) 시 충돌 | 이 스펙 범위 밖; Phase 2에서 lock 메커니즘 설계 |

<!-- ═══════════════════════════════════════════ -->
<!-- Iterative — Updated each loop              -->
<!-- ═══════════════════════════════════════════ -->

## 6. Task Checklist

> Mark `[x]` only after verify passes.

- [x] ✅ Step 1: `ActivityPhase` 타입 정의 + `SessionSnapshot.activityPhase` 필드 추가 (`src/monitor/types.ts`) → verify: `npx tsc --noEmit` 통과
- [x] ✅ Step 2: `extractSessionInfo()`에서 `lastAssistantStopReason` 추출 + `activityPhase` 반환 (`src/monitor/parser.ts`) → verify: unit test로 각 phase 감지 확인
- [x] ✅ Step 3: `determineActivityPhase()` 함수 작성 (`src/monitor/activity-phase.ts`, re-exported from parser.ts) → verify: unit test 8개 시나리오 통과
- [x] ✅ Step 4: `ClaudeSessionMonitor.refreshOnce()`에서 `activityPhase` 할당 (`src/monitor/index.ts`) → verify: `npx tsc --noEmit` 통과
- [x] ✅ Step 5: `formatStateChangeMessage()` + `formatActivityPhaseChangeMessage()` 추가 (`src/auto-thread/formatter.ts`) → verify: phase 변화 시 메시지 반환 확인
- [x] ✅ Step 6: Monitor formatter에 activityPhase 표시 추가 (`src/monitor/formatter.ts`) → verify: 텍스트/임베드 출력에 phase 포함
- [x] ✅ Step 7: `AutoThreadDiscovery`에서 activityPhase 변화 추적 + 알림 (`src/auto-thread/index.ts`) → verify: phase 전환 시 Discord 메시지 발송 확인
- [x] ✅ Step 8: Unit test 작성 (`src/monitor/__tests__/activity-phase.test.ts`) → verify: `bun test` 통과
- [ ] ⚠️ Step 9: 통합 확인 — 실제 Claude Code 세션으로 phase 전환 테스트 → verify: active 세션에서 busy ↔ interactable 전환 확인

## 7. Open Questions

(none — Phase 1은 읽기 전용 감지이므로 복잡한 결정 없음)

<!-- ═══════════════════════════════════════════ -->
<!-- Cumulative — Append-only, never delete     -->
<!-- ═══════════════════════════════════════════ -->

## 8. Decision Log

- 2026-02-17: `activityPhase`를 `state`와 별도 필드로 결정. 기존 `state` 4값은 프로세스 lifecycle이고, `activityPhase`는 active 내 세부 단계. 기존 consumer 호환성 보장.
- 2026-02-17: `interactable` 네이밍 — `idle_input`, `awaiting_input` 등 대신 `interactable` 선택. Discord에서 "상호작용 가능"이라는 의미가 직관적.
- 2026-02-17: stop_reason 기반 판단 — mtime delta 기반(< N초 = busy)은 polling interval에 따라 부정확. JSONL content 기반이 더 결정적(deterministic).
- 2026-02-17: Monitor refresh 전략 — Discord 명령 수신 시 on-demand `refresh()` 즉시 호출. 이로 인해 background polling을 15초→30초로 완화. fs.watch debounce(10초)는 passive 알림용으로 기존 유지.

## 9. Handoff Snapshot

## 10. Changelog

| rev | date | summary |
|-----|------|---------|
| 1 | 2026-02-17 | Initial draft |
| 2 | 2026-02-17 | Monitor refresh 전략: on-demand + passive polling 30초 |
