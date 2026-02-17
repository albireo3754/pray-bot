import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

const DEFAULT_STATE_PATH = process.env.HOME
  ? `${process.env.HOME}/.pray-bot/auto-thread-watch-state.json`
  : '/tmp/auto-thread-watch-state.json';

type AutoThreadWatchStatePayload = {
  version: 1;
  sessions: Record<string, { lastWatchAt: number }>;
};

export class AutoThreadMonitorStateStore {
  constructor(private statePath = DEFAULT_STATE_PATH) {}

  async load(): Promise<Map<string, number>> {
    try {
      const file = Bun.file(this.statePath);
      if (!(await file.exists())) {
        return new Map();
      }

      const raw = await file.text();
      if (!raw.trim()) {
        return new Map();
      }

      const parsed = JSON.parse(raw) as Partial<AutoThreadWatchStatePayload>;
      if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') {
        console.warn('[AutoThreadMonitorStateStore] invalid payload, ignore state file');
        return new Map();
      }

      const next = new Map<string, number>();
      for (const [sessionId, item] of Object.entries(parsed.sessions)) {
        if (!item || typeof item !== 'object') continue;
        const lastWatchAt = Number((item as { lastWatchAt?: unknown }).lastWatchAt);
        if (!Number.isFinite(lastWatchAt) || lastWatchAt <= 0) continue;
        next.set(sessionId, Math.floor(lastWatchAt));
      }
      return next;
    } catch (error) {
      console.error('[AutoThreadMonitorStateStore] load failed:', error);
      return new Map();
    }
  }

  async save(lastWatchAtBySession: Map<string, number>): Promise<void> {
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      const sessions: Record<string, { lastWatchAt: number }> = {};
      for (const [sessionId, lastWatchAt] of lastWatchAtBySession.entries()) {
        if (!Number.isFinite(lastWatchAt) || lastWatchAt <= 0) continue;
        sessions[sessionId] = { lastWatchAt: Math.floor(lastWatchAt) };
      }
      const payload: AutoThreadWatchStatePayload = {
        version: 1,
        sessions,
      };
      await Bun.write(this.statePath, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      console.error('[AutoThreadMonitorStateStore] save failed:', error);
    }
  }
}
