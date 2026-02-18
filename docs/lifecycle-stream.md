# Session & Skill Hook Stream Lite Spec

> status: draft
> created: 2026-02-18
> updated: 2026-02-18
> revision: 2

## 1. Goal

Claude Code 세션 라이프사이클과 스킬 실행 라이프사이클을 추적하기 위해:

1. Claude Code 훅(SessionStart / SessionEnd / Stop / UserPromptSubmit / Notification / PreToolUse:Skill / PostToolUse:Skill)에서 이벤트를 JSONL로 append
2. `pray-bot`이 해당 JSONL을 tail-read
3. 세션/스킬 상태를 SQLite로 지속 저장
4. 대시보드/모니터에서 세션별 최신 상태 조회 가능하게 한다.

## 2. Scope (Light)

- 포함:
  - Hook 이벤트 7종 정의 (SessionStart / SessionEnd / Stop / UserPromptSubmit / Notification / PreToolUse:Skill / PostToolUse:Skill)
  - JSONL 파일 포맷 정의 (session + skill 이벤트 혼재)
  - pray-bot 파일 스트림 consumer + DB 저장 설계
  - 최소 운영 안정성 (중복 방지, 재시작 복구, offset 저장)
- 제외:
  - Kafka/Redis/NATS 같은 외부 메시지 브로커 도입
  - 실시간 WebSocket push UI
  - 기존 hook approval 플로우 전면 교체
  - PreToolUse/PostToolUse Skill 외 다른 tool 로깅 (오버헤드 대비 불필요)

## 3. Hook → Event 매핑

| Claude Code 훅 | matcher | 발동 빈도 | 생성 이벤트 |
|----------------|---------|:---------:|------------|
| `SessionStart` | 없음 | 세션당 1회 | `session.lifecycle` phase=`started` |
| `SessionEnd` | 없음 | 세션당 1회 | `session.lifecycle` phase=`ended` |
| `Stop` | 없음 | 매 턴 완료마다 | `turn.end` (transcript_path 포함) |
| `UserPromptSubmit` | 없음 | 매 턴 시작마다 | `turn.start` (prompt 캡처) |
| `Notification` | 없음 | 알림 발생마다 | `session.lifecycle` phase=`waiting_permission` \| `waiting_question` |
| `PreToolUse` | `Skill` | 스킬 실행마다 | `skill.lifecycle` phase=`in_progress` |
| `PostToolUse` | `Skill` | 스킬 실행마다 | `skill.lifecycle` phase=`completed` |

> **주의**: `Stop` 훅은 세션 종료가 아니라 **매 턴(응답) 완료** 시 발동. 실제 세션 종료는 `SessionEnd`.

**스킬 파라미터 추출**: `PreToolUse:Skill` stdin의 `tool_input.skill_name` (e.g. `"/spec"`), `tool_input.skill_args` (e.g. `"docs/abc.md"`)으로 스킬명과 인자를 확인 가능.

**targetDocPath 추출**: `spec`, `spec-review`, `lite-spec` 스킬은 `skill_args` 첫 번째 토큰이 스펙 파일 경로 → `targetDocPath`로 저장.

**오버헤드**: SessionStart/End는 세션당 각 1회. Stop/UserPromptSubmit은 턴 수만큼 (일반적 10~30회/세션). Skill 훅은 5~15회 — 체감 오버헤드 없음.

## 4. Event Model

```ts
export type SessionLifecyclePhase = "started" | "ended";
export type SkillLifecyclePhase = "in_progress" | "completed";

export type SessionLifecycleEvent = {
  id: string;             // ULID/UUID, producer generated
  eventType: "session.lifecycle";
  phase: SessionLifecyclePhase;
  occurredAtIso: string;
  sessionId: string;
  provider: "claude" | "codex" | "unknown";
  projectPath: string | null;
  cwd: string | null;
};

export type SkillLifecycleEvent = {
  id: string;             // ULID/UUID, producer generated
  eventType: "skill.lifecycle";
  phase: SkillLifecyclePhase;
  occurredAtIso: string;
  sessionId: string;
  provider: "claude" | "codex" | "unknown";
  projectPath: string | null;
  skillName: string;      // e.g. "spec", "spec-review" (leading "/" stripped)
  triggerCommand: string | null; // e.g. "/spec docs/x.md" (skill_name + skill_args)
  turnSeq: number | null;
  targetDocPath: string | null;  // spec/spec-review/lite-spec 스킬의 첫 번째 인자 (파일 경로)
};

export type LifecycleEvent = SessionLifecycleEvent | SkillLifecycleEvent;
```

## 5. Shared JSONL Contract

경로:
- 기본: `~/.kw-chat/streams/lifecycle.jsonl`
- env override: `KW_CHAT_STREAM_PATH` 환경변수로 변경 가능

session + skill 이벤트를 **단일 파일**에 혼재:

```jsonl
{"id":"01HS...","eventType":"session.lifecycle","phase":"started","occurredAtIso":"2026-02-18T13:10:00.000Z","sessionId":"sess-123","provider":"claude","projectPath":"/Users/pray/work/js/kw-chat","cwd":"/Users/pray/work/js/kw-chat"}
{"id":"01HS...","eventType":"skill.lifecycle","phase":"in_progress","occurredAtIso":"2026-02-18T13:10:02.120Z","sessionId":"sess-123","provider":"claude","projectPath":"/Users/pray/work/js/kw-chat","skillName":"spec","triggerCommand":"/spec docs/abc.md","turnSeq":42,"targetDocPath":"docs/abc.md"}
{"id":"01HS...","eventType":"skill.lifecycle","phase":"completed","occurredAtIso":"2026-02-18T13:12:15.440Z","sessionId":"sess-123","provider":"claude","projectPath":"/Users/pray/work/js/kw-chat","skillName":"spec","triggerCommand":"/spec docs/abc.md","turnSeq":42,"targetDocPath":"docs/abc.md"}
{"id":"01HS...","eventType":"session.lifecycle","phase":"ended","occurredAtIso":"2026-02-18T13:20:00.000Z","sessionId":"sess-123","provider":"claude","projectPath":"/Users/pray/work/js/kw-chat","cwd":"/Users/pray/work/js/kw-chat"}
```

작성 규칙:
- append-only
- 한 줄 단위 write (partial write 방지)

## 6. Producer: Hook Script + Installer

### 6.1 파일 위치 (pray-bot)

```
src/lifecycle-stream/
├── lifecycle-logger.sh    # 훅 스크립트 본체 (pray-bot 내 관리)
└── install-hooks.ts       # 훅 설치 스크립트
```

### 6.2 Hook stdin JSON 구조 (실측)

Claude Code는 훅 스크립트에 컨텍스트를 **환경변수가 아닌 stdin JSON**으로 전달한다.
환경변수로 제공되는 건 `CLAUDE_PROJECT_DIR` 하나뿐.

**공통 필드 (모든 훅):**

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/pray/work/js/pray-bot",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

**PreToolUse / PostToolUse (Skill 매처):**

```json
{
  "session_id": "abc123",
  "cwd": "/Users/pray/work/js/pray-bot",
  "hook_event_name": "PreToolUse",
  "tool_name": "Skill",
  "tool_input": {
    "skill_name": "/spec",
    "skill_args": "docs/abc.md"
  },
  "tool_use_id": "toolu_01ABC..."
}
```

> `skill_name`은 `/` 접두사 포함 (e.g. `/spec`). skillName DB 저장 시 접두사 제거 → `spec`.
> `trigger_command` = `skill_name + " " + skill_args` (e.g. `/spec docs/abc.md`).

**SessionStart:**

```json
{
  "session_id": "abc123",
  "hook_event_name": "SessionStart",
  "source": "startup|resume|clear|compact",
  "model": "claude-sonnet-4-6"
}
```

**Stop (매 턴 완료):**

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

> `stop_hook_active: true`이면 Stop 훅이 이미 한 번 실행된 상태 → 무한루프 방지용 플래그.

**UserPromptSubmit:**

```json
{
  "session_id": "abc123",
  "cwd": "...",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "유저가 입력한 프롬프트"
}
```

**Notification:**

```json
{
  "session_id": "abc123",
  "hook_event_name": "Notification",
  "notification_type": "permission_prompt|idle_prompt|elicitation_dialog|auth_success"
}
```

### 6.3 lifecycle-logger.sh

`EVENT_TYPE` / `PHASE`는 훅 command prefix에서 환경변수로 주입.
실제 세션 컨텍스트(`session_id`, `cwd`, `tool_input` 등)는 stdin JSON에서 파싱.

```bash
#!/usr/bin/env bash
STREAM_FILE="${KW_CHAT_STREAM_PATH:-$HOME/.kw-chat/streams/lifecycle.jsonl}"
mkdir -p "$(dirname "$STREAM_FILE")"

STDIN_DATA=$(cat)  # stdin JSON 한 번만 읽기

LINE=$(EVENT_TYPE="$EVENT_TYPE" PHASE="$PHASE" python3 -c "
import sys, json, uuid, os
from datetime import datetime, timezone

data = json.loads(sys.stdin.read() or '{}')
event_type = os.environ['EVENT_TYPE']
phase       = os.environ.get('PHASE', '')
session_id  = data.get('session_id', 'unknown')
project_path = data.get('cwd') or None

if event_type == 'skill.lifecycle':
    tool_input   = data.get('tool_input', {})
    raw_name     = tool_input.get('skill_name') or None   # e.g. '/spec'
    skill_args   = tool_input.get('skill_args') or None   # e.g. 'docs/abc.md'
    skill_name   = raw_name.lstrip('/') if raw_name else None  # 'spec'
    trigger_cmd  = (raw_name + (' ' + skill_args if skill_args else '')) if raw_name else None
    event = { 'skillName': skill_name, 'triggerCommand': trigger_cmd, ... }
...
print(json.dumps(event))
" <<< "$STDIN_DATA")

[ -n "$LINE" ] && echo "$LINE" >> "$STREAM_FILE"
```

> 전체 구현: `src/lifecycle-stream/lifecycle-logger.sh`

### 6.4 install-hooks.ts

실행: `bun run src/lifecycle-stream/install-hooks.ts`

처리 순서:
1. `lifecycle-logger.sh`를 `~/.claude/hooks/lifecycle-logger.sh`로 **symlink** 생성 (이미 있으면 skip)
2. `chmod +x` 확인
3. `~/.claude/settings.json` 읽기
4. 아래 훅 항목을 **기존 설정에 merge** (중복 방지: command 문자열로 존재 여부 확인 후 없을 때만 추가)
5. 구 v1 lifecycle-logger 그룹 자동 제거 후 v2 등록 (migration)
6. `~/.claude/settings.json` 저장

merge할 훅 항목 (v2):

```json
{
  "SessionStart":      [{ "hooks": [{ "type": "command", "command": "EVENT_TYPE=session.lifecycle PHASE=started ~/.claude/hooks/lifecycle-logger.sh" }] }],
  "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "EVENT_TYPE=session.lifecycle PHASE=ended ~/.claude/hooks/lifecycle-logger.sh" }] }],
  "Stop":              [{ "hooks": [{ "type": "command", "command": "EVENT_TYPE=turn.end ~/.claude/hooks/lifecycle-logger.sh" }] }],
  "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "EVENT_TYPE=turn.start ~/.claude/hooks/lifecycle-logger.sh" }] }],
  "Notification":      [{ "hooks": [{ "type": "command", "command": "EVENT_TYPE=session.activity ~/.claude/hooks/lifecycle-logger.sh" }] }],
  "PreToolUse":        [{ "matcher": "Skill", "hooks": [{ "type": "command", "command": "EVENT_TYPE=skill.lifecycle PHASE=in_progress ~/.claude/hooks/lifecycle-logger.sh" }] }],
  "PostToolUse":       [{ "matcher": "Skill", "hooks": [{ "type": "command", "command": "EVENT_TYPE=skill.lifecycle PHASE=completed ~/.claude/hooks/lifecycle-logger.sh" }] }]
}
```

설치 완료 후 출력:

```
✓ symlink: ~/.claude/hooks/lifecycle-logger.sh → {pray-bot}/src/lifecycle-stream/lifecycle-logger.sh
✓ hooks merged into ~/.claude/settings.json
  - SessionStart: lifecycle-logger
  - SessionEnd: lifecycle-logger
  - Stop: lifecycle-logger (turn.end)
  - UserPromptSubmit: lifecycle-logger (turn.start)
  - Notification: lifecycle-logger (session.activity)
  - PreToolUse[Skill]: lifecycle-logger
  - PostToolUse[Skill]: lifecycle-logger

Run to verify:
  claude --dangerously-skip-permissions -p "snowflake 스킬 1 테스트"
  cat ~/.kw-chat/streams/lifecycle.jsonl
```

## 7. Consumer/DB Design (pray-bot)

### 7.1 Components

```
src/lifecycle-stream/
├── lifecycle-logger.sh      # 훅 스크립트 본체
├── install-hooks.ts         # 훅 설치 스크립트
├── types.ts                 # 이벤트 타입 정의
├── file-stream-consumer.ts  # 폴링 consumer
├── store.ts                 # SQLite (better-sqlite3)
└── index.ts                 # 진입점 (consumer 시작)
```

### 7.2 DB Schema

```sql
create table if not exists session_lifecycle_events (
  id text primary key,
  occurred_at_iso text not null,
  session_id text not null,
  provider text not null,
  phase text not null,           -- started | ended
  project_path text,
  cwd text,
  raw_json text not null
);

create index if not exists idx_session_events_time
  on session_lifecycle_events (session_id, occurred_at_iso desc);

create table if not exists skill_lifecycle_events (
  id text primary key,
  occurred_at_iso text not null,
  session_id text not null,
  provider text not null,
  skill_name text not null,
  phase text not null,           -- in_progress | completed
  trigger_command text,
  target_doc_path text,
  turn_seq integer,
  project_path text,
  raw_json text not null
);

create index if not exists idx_skill_events_session_time
  on skill_lifecycle_events (session_id, occurred_at_iso desc);

create table if not exists lifecycle_stream_offsets (
  stream_key text primary key,
  inode text not null,
  byte_offset integer not null,
  updated_at_iso text not null
);
```

### 7.3 Consumer Read Loop

500ms 폴링 → 버퍼 읽기 → DB 일괄 insert → offset 갱신:

```
setInterval(500ms)
  └─ readFromOffset(current_byte_offset)
       ├─ 줄 단위 파싱
       │    ├─ JSON 유효 → 버퍼에 적재
       │    └─ 잘린 줄(EOF 중간) → skip, offset 유지
       └─ DB batch insert (INSERT OR IGNORE)
            └─ insert 성공 후 byte_offset 갱신
                 └─ offsets 테이블 UPDATE
```

**포인터 갱신 규칙:**
- offset 갱신은 **DB insert 성공 직후**에만 수행
- 버퍼 내 레코드 중 일부 실패 시: 성공한 것까지만 offset 전진, 실패 레코드는 다음 사이클에 재처리
- 프로세스 재시작 시 offsets 테이블에서 `byte_offset` 복원 → 해당 위치부터 읽기 재개

**rotation 감지:**
- 읽기 시작 시 현재 파일의 inode 확인
- 저장된 inode와 다르면 파일이 교체된 것으로 판단 → offset 0으로 초기화 후 재읽기

### 7.4 상태 전이 규칙

**session.lifecycle:**
- `started` 수신: 세션을 활성 상태로 등록
- `ended` 수신: 세션을 종료 상태로 마킹

**skill.lifecycle:**
- `in_progress` 수신: session+skill 기준 현재 상태를 `in_progress`로 등록
- `completed` 수신: 동일 session+skill의 최신 `in_progress`를 `completed`로 마킹

## 8. Library Review

| 후보 | 용도 | 결론 |
|------|------|------|
| Node/Bun 내장(폴링 500ms + offset 추적) | JSONL tail | **채택 (Phase 1)** |
| `chokidar` | 파일 변경 감지 | 보류 |
| Kafka/Redpanda | 메시지 브로커 | Phase 2 이후 |
| Redis Streams | 경량 브로커 | Phase 2 후보 |

## 9. Verification (Light)

**훅 동작 확인 (실제 실행):**

```bash
claude --dangerously-skip-permissions -p "snowflake 스킬 1 테스트"
```

- [ ] 위 명령 실행 후 `~/.kw-chat/streams/lifecycle.jsonl` 에 다음 4줄 확인:
  - `session.lifecycle started`
  - `skill.lifecycle in_progress` (skillName: "snowflake")
  - `skill.lifecycle completed` (skillName: "snowflake")
  - `session.lifecycle ended`

**Consumer/DB:**
- [ ] consumer가 이벤트 수신 후 1초 내 DB 반영 (폴링 500ms + insert 여유)
- [ ] 같은 `id` 재처리 시 DB 중복 insert 없음
- [ ] 프로세스 재시작 후 offset부터 이어서 처리
- [ ] 잘린 JSON 라인 발생 시 해당 라인 skip 후 다음 라인 처리

## 10. Rollout Plan

1. `lifecycle-logger.sh` 작성
2. `install-hooks.ts` 작성 + `bun run src/lifecycle-stream/install-hooks.ts` 실행
3. Claude Code 훅 환경변수 실제 변수명 확인 (sessionId, projectPath 등)
4. `claude --dangerously-skip-permissions -p "snowflake 스킬 1 테스트"` 실행 → JSONL append 확인 (훅 동작 검증)
4. pray-bot에 `lifecycle-stream` consumer + DB store 추가
5. 동일 명령 재실행 → DB row 확인 (end-to-end 검증)
6. 기존 monitor API에 세션/스킬 상태 read-only 노출
7. 1~2일 운영 후 누락/지연 확인

## 11. Phase 3: LifecycleSessionMonitor

> status: 미구현 — Phase 2 완료 후 진행

### 목표

`ClaudeSessionMonitor`(process polling + JSONL fswatch)를 lifecycle-stream 기반으로 대체.
`SessionMonitorProvider` 인터페이스를 구현하는 `LifecycleSessionMonitor` 추가.

### 설계

```
lifecycle.jsonl ──┬── FileStreamConsumer → SQLite (audit)
                  └── LifecycleSessionMonitor → in-memory Map<sessionId, SessionSnapshot>
```

두 컨슈머가 **동일 JSONL을 독립 offset으로** 구독. DB 읽기 불필요.

### 상태 머신

| 이벤트 | 상태 변화 |
|--------|-----------|
| `session.lifecycle started` | snapshot 생성, state=`active`, activityPhase=`busy` |
| `turn.start` | lastUserMessage=prompt, activityPhase=`busy` |
| `turn.end` + tailJsonl(transcriptPath) | model/tokens/turnCount/gitBranch 갱신, activityPhase=`interactable` |
| `session.lifecycle waiting_permission` | activityPhase=`waiting_permission` |
| `session.lifecycle waiting_question` | activityPhase=`waiting_question` |
| `skill.lifecycle in_progress` | currentSkill 세팅 |
| `skill.lifecycle completed` | currentSkill 클리어 |
| `session.lifecycle ended` | state=`completed` |
| 5분 무활동 타이머 | state=`idle` |

### turn.end enrichment (TurnRichData)

`turn.end` 이벤트의 `transcriptPath`를 `tailJsonl` + `extractSessionInfo`로 읽어
`SessionSnapshot`에 반영. DB 저장 없이 in-memory에만 유지.

```ts
type TurnRichData = {
  model: string | null;
  tokens: { input: number; output: number; cached: number };
  turnCount: number;
  gitBranch: string | null;
};
```

### 재시작 복구

시작 시 `lifecycle.jsonl` offset=0부터 replay → 현재 상태 복원.
24시간 이전 `session.lifecycle ended` 세션은 skip.

### 미지원 항목 (ClaudeSessionMonitor 대비)

- `pid`, `cpuPercent`, `memMb` — process polling 없음. 필요 시 경량 폴러 병행.

---

## 12. Open Decisions (해결됨)

| 결정 사항 | 결론 |
|-----------|------|
| stream 파일 경로 고정 vs env override | env override 허용 (`KW_CHAT_STREAM_PATH`) |
| `failed` Phase 1 포함 여부 | 제외 — PostToolUse:Skill은 정상/오류 무관하게 발동하므로 `completed`로 통합 |
| session + skill 파일 분리 여부 | 단일 파일 혼재 (`lifecycle.jsonl`) |
| rotate 기준 | Phase 2에서 결정 (10MB 초과 시 검토) |
