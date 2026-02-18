import { openSync, readSync, statSync, closeSync, existsSync } from 'node:fs';
import type { LifecycleEvent, SessionLifecycleEvent, SkillLifecycleEvent } from './types.ts';
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
    if (obj['eventType'] === 'session.lifecycle') {
      return obj as unknown as SessionLifecycleEvent;
    }
    if (obj['eventType'] === 'skill.lifecycle') {
      return obj as unknown as SkillLifecycleEvent;
    }
    return null;
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
          // File was rotated — restart from 0
          console.log('[lifecycle-stream] file rotation detected, resetting offset');
          byteOffset = 0;
        } else {
          byteOffset = saved.byteOffset;
        }
      }

      if (byteOffset >= fileSize) return;

      // Read new data
      const readSize = Math.min(fileSize - byteOffset, READ_CHUNK_SIZE);
      const buf = Buffer.allocUnsafe(readSize);
      const bytesRead = readSync(fd, buf, 0, readSize, byteOffset);
      if (bytesRead === 0) return;

      const chunk = buf.subarray(0, bytesRead).toString('utf-8');

      // Split into lines; last partial line (no newline at end) is skipped
      const lines = chunk.split('\n');
      // If chunk doesn't end with newline, the last "line" is incomplete
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
          // Invalid JSON — skip line, advance offset past it
          processedBytes += Buffer.byteLength(line + '\n', 'utf-8');
          continue;
        }

        // Insert — if it fails we don't advance the offset
        let inserted: boolean;
        try {
          if (event.eventType === 'session.lifecycle') {
            inserted = this.store.insertSessionEvent(event);
          } else {
            inserted = this.store.insertSkillEvent(event);
          }
        } catch (err) {
          console.error('[lifecycle-stream] DB insert failed, will retry:', err);
          // Stop processing here; retry next poll from current processedBytes
          break;
        }

        // INSERT OR IGNORE — treat both insert and duplicate as "consumed"
        void inserted; // suppress unused warning
        processedBytes += Buffer.byteLength(line + '\n', 'utf-8');
      }

      if (processedBytes > byteOffset) {
        this.store.setOffset(STREAM_KEY, currentInode, processedBytes);
      }
    } finally {
      closeSync(fd);
    }
  }
}
