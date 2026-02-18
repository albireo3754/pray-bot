import { openSync, readSync, statSync, closeSync, existsSync } from 'node:fs';
import type {
  LifecycleEvent,
  SessionLifecycleEvent,
  SkillLifecycleEvent,
  TurnEndEvent,
  TurnStartEvent,
} from './types.ts';
import type { LifecycleStore } from './store.ts';

const HOME = process.env.HOME ?? '';
export const DEFAULT_STREAM_PATH = process.env['KW_CHAT_STREAM_PATH'] ?? `${HOME}/.kw-chat/streams/lifecycle.jsonl`;
const STREAM_KEY = 'lifecycle';
const POLL_INTERVAL_MS = 500;
const READ_CHUNK_SIZE = 65536; // 64 KB per read

// ── Parser ────────────────────────────────────────────────────────────────

function parseEvent(line: string): LifecycleEvent | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    switch (obj['eventType']) {
      case 'session.lifecycle': return obj as unknown as SessionLifecycleEvent;
      case 'skill.lifecycle':   return obj as unknown as SkillLifecycleEvent;
      case 'turn.end':          return obj as unknown as TurnEndEvent;
      case 'turn.start':        return obj as unknown as TurnStartEvent;
      default:                  return null;
    }
  } catch {
    return null;
  }
}

// ── FileStreamConsumer ────────────────────────────────────────────────────

export interface FileStreamConsumerOptions {
  streamPath?: string;
  pollIntervalMs?: number;
}

export class FileStreamConsumer {
  private readonly streamPath: string;
  private readonly pollIntervalMs: number;
  private readonly store: LifecycleStore;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: LifecycleStore, options: FileStreamConsumerOptions = {}) {
    this.store = store;
    this.streamPath = options.streamPath ?? DEFAULT_STREAM_PATH;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    console.log(`[lifecycle-stream] consumer started, watching: ${this.streamPath}`);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Poll ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!existsSync(this.streamPath)) return;

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

      const saved = this.store.getOffset(STREAM_KEY);

      let byteOffset = 0;
      if (saved) {
        if (saved.inode !== currentInode) {
          console.log('[lifecycle-stream] file rotation detected, resetting offset');
          byteOffset = 0;
        } else {
          byteOffset = saved.byteOffset;
        }
      }

      if (byteOffset >= fileSize) return;

      const readSize = Math.min(fileSize - byteOffset, READ_CHUNK_SIZE);
      const buf = Buffer.allocUnsafe(readSize);
      const bytesRead = readSync(fd, buf, 0, readSize, byteOffset);
      if (bytesRead === 0) return;

      const chunk = buf.subarray(0, bytesRead).toString('utf-8');
      const lines = chunk.split('\n');
      const hasTrailingNewline = chunk.endsWith('\n');
      const completeLines = hasTrailingNewline ? lines.slice(0, -1) : lines.slice(0, -1);

      let processedBytes = byteOffset;
      for (const line of completeLines) {
        const trimmed = line.trim();
        if (!trimmed) {
          processedBytes += Buffer.byteLength(line + '\n', 'utf-8');
          continue;
        }

        const event = parseEvent(trimmed);
        if (!event) {
          processedBytes += Buffer.byteLength(line + '\n', 'utf-8');
          continue;
        }

        try {
          this.dispatchEvent(event);
        } catch (err) {
          console.error('[lifecycle-stream] DB insert failed, will retry:', err);
          break;
        }

        processedBytes += Buffer.byteLength(line + '\n', 'utf-8');
      }

      if (processedBytes > byteOffset) {
        this.store.setOffset(STREAM_KEY, currentInode, processedBytes);
      }
    } finally {
      closeSync(fd);
    }
  }

  // ── Event dispatch ────────────────────────────────────────────────────

  private dispatchEvent(event: LifecycleEvent): void {
    switch (event.eventType) {
      case 'session.lifecycle':
        this.store.insertSessionEvent(event);
        break;
      case 'skill.lifecycle':
        this.store.insertSkillEvent(event);
        break;
      case 'turn.end':
      case 'turn.start':
        // audit DB에는 저장하지 않음.
        // LifecycleSessionMonitor가 JSONL을 직접 구독하여 in-memory 상태로 관리할 예정.
        break;
    }
  }
}
