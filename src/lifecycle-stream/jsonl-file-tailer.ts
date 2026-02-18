import { openSync, readSync, statSync, closeSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LifecycleEvent, SessionLifecyclePhase, SkillLifecyclePhase } from './types.ts';

const READ_CHUNK_SIZE = 65536; // 64 KB per read

// ── Raw hook transformer ───────────────────────────────────────────────────
// lifecycle-logger.sh writes raw Claude Code hook payloads with hookType injected.
// This converts them into typed LifecycleEvents.

const DOC_SKILLS = new Set(['spec', 'spec-review', 'lite-spec']);
const SESSION_PHASES = new Set<string>(['started', 'ended', 'waiting_permission', 'waiting_question']);
const SKILL_PHASES = new Set<string>(['in_progress', 'completed']);

function transformRawHook(obj: Record<string, unknown>): LifecycleEvent | null {
  const hookType = typeof obj['hookType'] === 'string' ? obj['hookType'] : '';
  const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id'] : 'unknown';
  const projectPath = typeof obj['cwd'] === 'string' ? obj['cwd'] : null;
  const occurredAtIso = typeof obj['occurredAtIso'] === 'string'
    ? obj['occurredAtIso']
    : new Date().toISOString();
  const id = crypto.randomUUID();

  switch (hookType) {
    case 'session.lifecycle': {
      const phase = typeof obj['phase'] === 'string' ? obj['phase'] : '';
      if (!SESSION_PHASES.has(phase)) return null;
      return {
        id, eventType: 'session.lifecycle',
        phase: phase as SessionLifecyclePhase,
        occurredAtIso, sessionId, provider: 'claude',
        projectPath, cwd: projectPath,
      };
    }

    case 'session.activity': {
      const notifType = typeof obj['notification_type'] === 'string' ? obj['notification_type'] : '';
      let phase: SessionLifecyclePhase;
      if (notifType === 'permission_prompt') phase = 'waiting_permission';
      else if (notifType === 'idle_prompt' || notifType === 'elicitation_dialog') phase = 'waiting_question';
      else return null;
      return {
        id, eventType: 'session.lifecycle',
        phase, occurredAtIso, sessionId, provider: 'claude',
        projectPath, cwd: projectPath,
      };
    }

    case 'skill.lifecycle': {
      const phase = typeof obj['phase'] === 'string' ? obj['phase'] : '';
      if (!SKILL_PHASES.has(phase)) return null;
      const toolInput = obj['tool_input'] !== null && typeof obj['tool_input'] === 'object'
        ? obj['tool_input'] as Record<string, unknown>
        : {};
      const rawSkillName = typeof toolInput['skill'] === 'string' ? toolInput['skill'] : null;
      const skillArgs = typeof toolInput['args'] === 'string' ? toolInput['args'] : null;
      if (!rawSkillName) return null;
      const skillName = rawSkillName.replace(/^\//, '');
      const triggerCommand = `/${skillName}` + (skillArgs ? ` ${skillArgs}` : '');
      const firstArg = skillArgs?.trim().split(/\s+/)[0] ?? null;
      const targetDocPath = DOC_SKILLS.has(skillName) ? firstArg : null;
      return {
        id, eventType: 'skill.lifecycle',
        phase: phase as SkillLifecyclePhase,
        occurredAtIso, sessionId, provider: 'claude',
        projectPath, skillName, triggerCommand,
        turnSeq: null, targetDocPath,
      };
    }

    case 'turn.end': {
      const transcriptPath = typeof obj['transcript_path'] === 'string' ? obj['transcript_path'] : null;
      return { id, eventType: 'turn.end', occurredAtIso, sessionId, provider: 'claude', projectPath, transcriptPath };
    }

    case 'turn.start': {
      const prompt = typeof obj['prompt'] === 'string' ? obj['prompt'] : null;
      return { id, eventType: 'turn.start', occurredAtIso, sessionId, provider: 'claude', projectPath, prompt };
    }

    default:
      return null;
  }
}

// ── Parser ────────────────────────────────────────────────────────────────

function parseEvent(line: string): LifecycleEvent | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;

    // New format: raw hook payload written by lifecycle-logger.sh
    if (typeof obj['hookType'] === 'string') {
      return transformRawHook(obj);
    }

    // Legacy format: pre-transformed event with eventType (backwards compat)
    switch (obj['eventType']) {
      case 'session.lifecycle': return obj as unknown as LifecycleEvent;
      case 'skill.lifecycle':   return obj as unknown as LifecycleEvent;
      case 'turn.end':          return obj as unknown as LifecycleEvent;
      case 'turn.start':        return obj as unknown as LifecycleEvent;
      default:                  return null;
    }
  } catch {
    return null;
  }
}

// ── OffsetStore ──────────────────────────────────────────────────────────

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

  getOffset(key: string): OffsetRecord | null {
    return this.offsets.get(key) ?? null;
  }

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
  private readonly offsetFilePath: string;

  constructor(offsetFilePath: string) {
    this.offsetFilePath = offsetFilePath;
  }

  getOffset(key: string): OffsetRecord | null {
    if (!existsSync(this.offsetFilePath)) return null;
    try {
      const raw = readFileSync(this.offsetFilePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, OffsetRecord>;
      return data[key] ?? null;
    } catch {
      return null;
    }
  }

  setOffset(key: string, inode: string, byteOffset: number): void {
    mkdirSync(dirname(this.offsetFilePath), { recursive: true });

    let data: Record<string, OffsetRecord> = {};
    if (existsSync(this.offsetFilePath)) {
      try {
        const raw = readFileSync(this.offsetFilePath, 'utf-8');
        data = JSON.parse(raw) as Record<string, OffsetRecord>;
      } catch {
        data = {};
      }
    }

    data[key] = { inode, byteOffset };
    writeFileSync(this.offsetFilePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

// ── AbstractConsumerGroup ────────────────────────────────────────────────

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

// ── JsonlFileTailer ──────────────────────────────────────────────────────

export interface JsonlFileTailerOptions {
  pollIntervalMs?: number;
  /**
   * group별 offsetStore 미설정 시 fallback.
   * 생략 시 FileOffsetStore(`${streamPath}.offsets.json`) 자동 생성.
   */
  defaultOffsetStore?: OffsetStore;
}

export class JsonlFileTailer {
  private readonly streamPath: string;
  private readonly pollIntervalMs: number;
  private readonly defaultOffsetStore: OffsetStore;
  private readonly groups = new Map<string, AbstractConsumerGroup>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKnownFileSize = 0;

  constructor(streamPath: string, options: JsonlFileTailerOptions = {}) {
    this.streamPath = streamPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.defaultOffsetStore =
      options.defaultOffsetStore ?? new FileOffsetStore(`${streamPath}.offsets.json`);
  }

  /**
   * Consumer group 등록. start() 전후 모두 허용.
   * 같은 group.group 값으로 중복 등록 시 throw.
   */
  register(group: AbstractConsumerGroup): void {
    if (this.groups.has(group.group)) {
      throw new Error(`Consumer group '${group.group}' is already registered`);
    }
    this.groups.set(group.group, group);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 모든 group이 현재 fileSize까지 소비했으면 true.
   * Phase 2 파일 rotation 트리거 기준으로 사용.
   */
  canRotate(): boolean {
    if (this.groups.size === 0) return false;
    for (const group of this.groups.values()) {
      const store = group.offsetStore ?? this.defaultOffsetStore;
      const saved = store.getOffset(group.group);
      const byteOffset = saved?.byteOffset ?? 0;
      if (byteOffset < this.lastKnownFileSize) return false;
    }
    return true;
  }

  // ── Poll ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!existsSync(this.streamPath)) return;
    if (this.groups.size === 0) return;

    let fd: number;
    try {
      fd = openSync(this.streamPath, 'r');
    } catch {
      return;
    }

    try {
      const stat = statSync(this.streamPath);
      const currentInode = String(stat.ino);
      const fileSize = stat.size;
      this.lastKnownFileSize = fileSize;

      // inode 변경 감지 → ALL group offset 리셋
      for (const group of this.groups.values()) {
        const store = group.offsetStore ?? this.defaultOffsetStore;
        const saved = store.getOffset(group.group);
        if (saved && saved.inode !== currentInode) {
          console.log(`[jsonl-tailer] file rotation detected for group '${group.group}', resetting offset`);
          store.setOffset(group.group, currentInode, 0);
        }
      }

      // 모든 group의 최솟값부터 읽기
      let minOffset = fileSize;
      for (const group of this.groups.values()) {
        const store = group.offsetStore ?? this.defaultOffsetStore;
        const saved = store.getOffset(group.group);
        const byteOffset = saved ? saved.byteOffset : 0;
        if (byteOffset < minOffset) minOffset = byteOffset;
      }

      if (minOffset >= fileSize) return;

      const readSize = Math.min(fileSize - minOffset, READ_CHUNK_SIZE);
      const buf = Buffer.allocUnsafe(readSize);
      const bytesRead = readSync(fd, buf, 0, readSize, minOffset);
      if (bytesRead === 0) return;

      const chunk = buf.subarray(0, bytesRead).toString('utf-8');
      const lines = chunk.split('\n');
      const hasTrailingNewline = chunk.endsWith('\n');
      const completeLines = hasTrailingNewline ? lines.slice(0, -1) : lines.slice(0, -1);

      let lineBytePos = minOffset;
      for (const line of completeLines) {
        const lineByteLen = Buffer.byteLength(line + '\n', 'utf-8');
        const lineEndPos = lineBytePos + lineByteLen;

        const trimmed = line.trim();
        if (!trimmed) {
          lineBytePos = lineEndPos;
          continue;
        }

        const event = parseEvent(trimmed);

        for (const group of this.groups.values()) {
          const store = group.offsetStore ?? this.defaultOffsetStore;
          const saved = store.getOffset(group.group);
          const groupOffset = saved ? saved.byteOffset : 0;

          if (groupOffset > lineBytePos) {
            // 이미 처리된 라인
            continue;
          }

          if (event) {
            try {
              group.onEvent(event);
            } catch (err) {
              console.error(`[jsonl-tailer] group '${group.group}' onEvent failed, will retry:`, err);
              continue; // 이 group은 다음 poll에서 재시도, 다른 group은 계속
            }
          }

          store.setOffset(group.group, currentInode, lineEndPos);
        }

        lineBytePos = lineEndPos;
      }
    } finally {
      closeSync(fd);
    }
  }
}
