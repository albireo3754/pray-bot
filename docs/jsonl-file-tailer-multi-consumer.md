# JsonlFileTailer Multi-Consumer Refactor

> status: draft
> type: lite-spec
> created: 2026-02-19

## 0. LLM Work Guide

> **Follow the Spec Execution Protocol (`/sisyphus`).** Lite-spec은 의존성 분석/병렬 실행/멀티세션 복구 없이 순차 루프만 사용.

| Item | Section |
|------|---------|
| Task Checklist | §4 |
| Naming Conventions | §3.4 |
| State file | `docs/jsonl-file-tailer-multi-consumer.state.md` |

## 1. Goal

`FileStreamConsumer`의 `LifecycleStore` 하드 커플링을 제거하고, 여러 consumer가 독립 offset으로 같은 JSONL 파일을 구독할 수 있도록 리팩터링한다.

- `dispatchEvent` → `onEvent` callback으로 분리
- **offset을 JSON 파일로 영속 관리** — SQLite `lifecycle_stream_offsets` 테이블 제거
- **consumer group 단위로 offset 관리** — 같은 group의 consumer들은 offset을 공유, group 간 독립
- 단일 poll 루프 안에서 모든 group에게 이벤트 브로드캐스트
- 파일 rotation 시 ALL group offset을 동시 리셋 (이중 처리 방지)
- `canRotate()` — 모든 group이 현재 fileSize까지 소비했을 때 `true` 반환 (Phase 2 파일 정리 기준)

## 2. Non-Goals

- 실제 파일 삭제/truncation 구현 (Phase 2)
- chokidar/inotify 도입 (polling 유지)
- `LifecycleSessionMonitor` 구현 (별도 스펙)
- `LifecycleStore`의 기존 session/skill insert 로직 변경
- 기존 `FileStreamConsumerOptions` 인터페이스 시그니처 변경 (공개 API 하위 호환)
- offset 파일 atomic write 실패 복구 (crash-safe write는 Phase 2)

## 3. Design

### 3.1 Deliverables

| Deliverable | Path | Description |
|-------------|------|-------------|
| `OffsetStore` interface | `src/lifecycle-stream/jsonl-file-tailer.ts` | getOffset/setOffset 인터페이스 |
| `InMemoryOffsetStore` | `src/lifecycle-stream/jsonl-file-tailer.ts` | 영속성 없는 오프셋 스토어 (테스트용) |
| `FileOffsetStore` | `src/lifecycle-stream/jsonl-file-tailer.ts` | JSON 파일 기반 오프셋 영속 스토어 |
| `JsonlFileTailer` | `src/lifecycle-stream/jsonl-file-tailer.ts` | 신규 파일 — 핵심 tail 로직 |
| `LifecycleStore` (수정) | `src/lifecycle-stream/store.ts` | `lifecycle_stream_offsets` 테이블 + `getOffset`/`setOffset` 제거 |
| `FileStreamConsumer` (수정) | `src/lifecycle-stream/file-stream-consumer.ts` | `JsonlFileTailer` + `FileOffsetStore` 사용 |
| `index.ts` (수정) | `src/lifecycle-stream/index.ts` | 신규 export 추가 |

### 3.2 Interface

```ts
// ── jsonl-file-tailer.ts ──────────────────────────────────────────────────

import type { LifecycleEvent } from './types.ts';

// ─ OffsetStore ─────────────────────────────────────────────────────────────

export interface OffsetRecord {
  inode: string;
  byteOffset: number;
}

export interface OffsetStore {
  getOffset(key: string): OffsetRecord | null;
  setOffset(key: string, inode: string, byteOffset: number): void;
}

/** 영속성 없음 — 테스트·임시 consumer용 */
export class InMemoryOffsetStore implements OffsetStore {
  private offsets = new Map<string, OffsetRecord>();
  getOffset(key: string): OffsetRecord | null { return this.offsets.get(key) ?? null; }
  setOffset(key: string, inode: string, byteOffset: number): void {
    this.offsets.set(key, { inode, byteOffset });
  }
}

/**
 * JSON 파일 기반 offset 영속 스토어.
 * 기본 경로: `${streamPath}.offsets.json`
 *
 * 파일 포맷:
 * { "audit": { "inode": "12345", "byteOffset": 5000 },
 *   "monitor": { "inode": "12345", "byteOffset": 3000 } }
 */
export class FileOffsetStore implements OffsetStore {
  constructor(offsetFilePath: string);
  getOffset(key: string): OffsetRecord | null;
  setOffset(key: string, inode: string, byteOffset: number): void;
  // 내부: 파일 read-parse / JSON.stringify + writeFileSync (동기 write)
}

// ─ AbstractConsumerGroup ────────────────────────────────────────────────────

/**
 * Consumer group 기반 클래스. 상속하여 구체적인 group을 구현한다.
 *
 * @example
 * class AuditConsumerGroup extends AbstractConsumerGroup {
 *   readonly group = 'audit';
 *   onEvent(event: LifecycleEvent): void { ... }
 * }
 */
export abstract class AbstractConsumerGroup {
  /** Group 이름 — OffsetStore의 key로 사용. tailer 내 유일해야 함. */
  abstract readonly group: string;

  /** 이벤트 수신 핸들러 */
  abstract onEvent(event: LifecycleEvent): void;

  /**
   * 이 group 전용 OffsetStore.
   * 미설정 시 tailer의 defaultOffsetStore 사용.
   * defaultOffsetStore도 없으면 FileOffsetStore 자동.
   */
  offsetStore?: OffsetStore;
}

// ─ JsonlFileTailer ─────────────────────────────────────────────────────────

export interface JsonlFileTailerOptions {
  pollIntervalMs?: number;
  /**
   * group별 offsetStore 미설정 시 fallback.
   * 생략 시 FileOffsetStore(`${streamPath}.offsets.json`) 자동 생성.
   */
  defaultOffsetStore?: OffsetStore;
}

export class JsonlFileTailer {
  constructor(streamPath: string, options?: JsonlFileTailerOptions);

  /**
   * Consumer group 등록. start() 전후 모두 허용.
   * 같은 group.group 값으로 중복 등록 시 throw.
   */
  register(group: AbstractConsumerGroup): void;

  start(): void;
  stop(): void;

  /**
   * 모든 group이 현재 fileSize까지 소비했으면 true.
   * Phase 2 파일 rotation 트리거 기준으로 사용.
   */
  canRotate(): boolean;
}


// ── store.ts — lifecycle_stream_offsets 테이블 제거 ───────────────────────

// getOffset / setOffset 메서드 및 lifecycle_stream_offsets DDL 삭제.
// insertSessionEvent / insertSkillEvent / close 는 유지.
export class LifecycleStore { /* offset 관련 없음 */ }


// ── file-stream-consumer.ts (기존 public API 유지) ────────────────────────

export interface FileStreamConsumerOptions {
  streamPath?: string;
  pollIntervalMs?: number;
}

// 내부 구현 예시:
//
// class AuditGroup extends AbstractConsumerGroup {
//   readonly group = 'audit';
//   constructor(private store: LifecycleStore) { super(); }
//   onEvent(event: LifecycleEvent): void {
//     if (event.eventType === 'session.lifecycle') this.store.insertSessionEvent(event);
//     else if (event.eventType === 'skill.lifecycle') this.store.insertSkillEvent(event);
//   }
// }
//
// this.tailer = new JsonlFileTailer(streamPath, { pollIntervalMs });
// this.tailer.register(new AuditGroup(store));
export class FileStreamConsumer {
  constructor(store: LifecycleStore, options?: FileStreamConsumerOptions);
  start(): void;
  stop(): void;
}
```

### 3.3 Existing Code Impact

| 기존 파일 | 변경 내용 | 영향 |
|-----------|-----------|:----:|
| `store.ts` | `lifecycle_stream_offsets` DDL + `getOffset`/`setOffset` **제거** | Low — 호출부 없음 |
| `file-stream-consumer.ts` | 내부 poll 루프 → `JsonlFileTailer` 위임, public API 유지 | Low |
| `index.ts` | `JsonlFileTailer`, `OffsetStore`, `FileOffsetStore`, `InMemoryOffsetStore` export 추가 | Low |

### 3.4 Naming Conventions

| Category | Name | Description |
|----------|------|-------------|
| Class | `JsonlFileTailer` | 기존 `FileStreamConsumer` 네이밍 패턴 따름 |
| Interface | `OffsetStore` | `Store` suffix — 기존 `LifecycleStore` 패턴 |
| Field | `group` | Kafka consumer group에 대응 — `key` 대신 사용 |
| Class | `AbstractConsumerGroup` | `Abstract` prefix — 상속용 기반 클래스 |
| Class | `FileOffsetStore` | `File` prefix — JSON 파일 영속 스토어 |
| Class | `InMemoryOffsetStore` | `InMemory` prefix — 영속성 없음을 명시 |
| File | `${streamPath}.offsets.json` | offset 파일 경로 컨벤션 (`lifecycle.jsonl` → `lifecycle.jsonl.offsets.json`) |

### 3.5 Multi-Group Poll 동작

```
poll():
  stat(file) → currentInode, fileSize

  inode 변경 감지:
    └─ ALL group의 byteOffset = 0으로 리셋 (rotation 동시 반영)
         └─ group.offsetStore.setOffset(group, currentInode, 0)

  minOffset = min(all group byteOffsets)
  if minOffset >= fileSize → return (nothing to read)

  readChunk(from=minOffset, size=min(fileSize-minOffset, 64KB))
  parse complete lines

  for each line at bytePos:
    for each group where group.byteOffset <= bytePos:
      try:
        group.onEvent(parsedEvent)
        group.byteOffset = bytePos + lineByteLen
        group.offsetStore.setOffset(group.group, currentInode, group.byteOffset)
      catch:
        break (이 group은 다음 poll에서 재시도)
```

**핵심 불변식**: group.byteOffset은 해당 group이 성공적으로 처리한 마지막 라인의 끝 위치.
**group 독립성**: group A의 처리 실패가 group B의 진행을 막지 않음.

## 4. Task Checklist

> Mark `[x]` only after verify passes.

- [ ] ✅ **Task 1**: `jsonl-file-tailer.ts` 신규 파일 생성
  - `OffsetStore` interface, `OffsetRecord` type 정의
  - `InMemoryOffsetStore` 구현
  - `FileOffsetStore` 구현
    - 생성자: `offsetFilePath` 받음
    - `getOffset`: JSON 파일 읽기 (없으면 null)
    - `setOffset`: 전체 Map을 JSON.stringify → `writeFileSync` (동기)
    - 파일 없으면 directory `mkdirSync({ recursive: true })` 후 생성
  - `JsonlFileTailer` 구현
    - 기존 `file-stream-consumer.ts`의 poll 로직(inode 감지, chunk read, line parse) 추출
    - `register(consumer)`: groups Map에 추가 (같은 group 중복 시 throw)
    - multi-group dispatch: `group.byteOffset <= lineBytePos`인 group에게만 dispatch
    - `canRotate()`: `groups.every(g => g.byteOffset >= lastKnownFileSize)`
    - `defaultOffsetStore` 미지정 시 `FileOffsetStore("${streamPath}.offsets.json")` 자동 생성
  → verify: `npx tsc --noEmit` 통과

- [ ] ✅ **Task 2**: `store.ts` 수정 — offset 관련 코드 제거
  - `lifecycle_stream_offsets` CREATE TABLE DDL 삭제
  - `getOffset()` / `setOffset()` 메서드 삭제
  → verify: `npx tsc --noEmit` 통과, `LifecycleStore` 기존 호출부(`file-stream-consumer.ts`) 오류 없음

- [ ] ✅ **Task 3**: `file-stream-consumer.ts` 리팩터링
  - 내부 poll 루프 제거
  - `JsonlFileTailer` 인스턴스 생성 (streamPath, pollIntervalMs 전달)
  - 내부 `AuditGroup extends AbstractConsumerGroup` 정의 후 `register(new AuditGroup(store))` — offsetStore 미설정 (defaultOffsetStore=FileOffsetStore 자동)
  - `dispatchEvent()` → `onEvent` callback으로 inline (session/skill insert 분기)
  - 기존 `start()` / `stop()` public API 유지
  → verify: `npx tsc --noEmit` 통과, 기존 `FileStreamConsumer` 사용 코드(`bot.ts` 등) 수정 불필요

- [ ] ✅ **Task 4**: `index.ts` export 업데이트
  - `JsonlFileTailer`, `JsonlFileTailerOptions`, `AbstractConsumerGroup` 추가
  - `OffsetStore`, `OffsetRecord`, `FileOffsetStore`, `InMemoryOffsetStore` 추가
  → verify: `npx tsc --noEmit` 통과

## 5. Verification Criteria

- [ ] Given: `FileStreamConsumer(store)` 생성 / When: `start()` 후 JSONL에 이벤트 append / Then: 기존과 동일하게 `store.insertSessionEvent` / `store.insertSkillEvent` 호출됨 (regression 없음)
- [ ] Given: `FileStreamConsumer` 시작 후 프로세스 재시작 / When: `start()` 재호출 / Then: `lifecycle.jsonl.offsets.json`에서 offset 복원, 중복 처리 없음
- [ ] Given: `JsonlFileTailer`에 group 2개 등록 (InMemoryOffsetStore 각각) / When: 이벤트 3개 append / Then: 두 group의 `onEvent`가 각각 3회 호출됨
- [ ] Given: group 'audit'이 offset 50, group 'monitor'가 offset 0 / When: poll 실행 / Then: 'audit'은 offset 50 이후 라인만 수신, 'monitor'는 offset 0부터 모든 라인 수신
- [ ] Given: 파일 inode 변경 (rotation) / When: poll 실행 / Then: 모든 group의 byteOffset이 0으로 동시 리셋
- [ ] Given: 두 group 모두 fileSize까지 소비 / When: `canRotate()` / Then: `true` 반환
- [ ] Given: group 1개만 fileSize까지 소비 / When: `canRotate()` / Then: `false` 반환
- [ ] Given: 같은 `group` 값을 가진 `AbstractConsumerGroup` 두 번 register / When: 두 번째 `register()` 호출 / Then: throw 발생
- [ ] Given: `FileOffsetStore` 경로의 디렉토리 미존재 / When: `setOffset` 최초 호출 / Then: 디렉토리 자동 생성 후 파일 write 성공
- [ ] `npx tsc --noEmit` passes with zero errors

## 6. Open Questions

- `JsonlFileTailer.register()` — `start()` 이후 동적 등록 허용 여부: **허용** (poll 루프 중 groups Map에 추가만 하면 됨, 다음 poll부터 포함)
- inode 변경 시 old file에서 못 읽은 데이터 유실 가능성: **허용** — Phase 1에서는 rotation이 외부 트리거이므로 유실 감수. Phase 2에서 pre-rotation drain 구현 검토.
