import type { LifecycleEvent } from './types.ts';
import type { LifecycleStore } from './store.ts';
import { AbstractConsumerGroup, JsonlFileTailer } from './jsonl-file-tailer.ts';

export const DEFAULT_STREAM_PATH = process.env['KW_CHAT_STREAM_PATH'] ?? `${process.env.HOME ?? ''}/.kw-chat/streams/lifecycle.jsonl`;

// ── FileStreamConsumer ────────────────────────────────────────────────────

export interface FileStreamConsumerOptions {
  streamPath?: string;
  pollIntervalMs?: number;
}

class AuditGroup extends AbstractConsumerGroup {
  readonly group = 'audit';

  constructor(private readonly store: LifecycleStore) {
    super();
  }

  onEvent(event: LifecycleEvent): void {
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

export class FileStreamConsumer {
  private readonly tailer: JsonlFileTailer;

  constructor(store: LifecycleStore, options: FileStreamConsumerOptions = {}) {
    const streamPath = options.streamPath ?? DEFAULT_STREAM_PATH;
    const pollIntervalMs = options.pollIntervalMs;
    this.tailer = new JsonlFileTailer(streamPath, { pollIntervalMs });
    this.tailer.register(new AuditGroup(store));
  }

  start(): void {
    console.log(`[lifecycle-stream] consumer started`);
    this.tailer.start();
  }

  stop(): void {
    this.tailer.stop();
  }
}
