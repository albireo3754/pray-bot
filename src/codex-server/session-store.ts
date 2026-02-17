import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_STORE_PATH = process.env.HOME
  ? `${process.env.HOME}/.pray-bot/codex-server-sessions.json`
  : null;

export interface SessionRegistryRecord {
  sessionId: string;
  provider: 'codex';
  ownerUserId: string;
  mappingKey: string;
  cwd: string;
  threadChannelId: string;
  parentChannelId: string;
  lastUsedAt: number;
  createdAt: number;
  archivedAt?: number;
}

export interface SessionRegistryUpsert {
  sessionId: string;
  provider?: 'codex';
  ownerUserId: string;
  mappingKey: string;
  cwd: string;
  threadChannelId: string;
  parentChannelId: string;
  timestamp?: number;
}

export interface SessionRegistryListFilter {
  ownerUserId?: string;
  mappingKey?: string;
  includeArchived?: boolean;
  now?: number;
}

export interface ResolveResumeTargetOptions {
  explicitSessionId?: string;
  threadChannelId?: string;
  ownerUserId: string;
  mappingKey: string;
  now?: number;
}

export type ResolveResumeTargetResult =
  | {
      ok: true;
      source: 'explicit' | 'thread' | 'recent';
      record: SessionRegistryRecord;
    }
  | {
      ok: false;
      reason: 'not_found';
      message: string;
    };

interface SessionStorePayload {
  version: 1;
  sessions: SessionRegistryRecord[];
}

interface SessionRegistryStoreOptions {
  ttlMs?: number;
  storePath?: string | null;
}

export class CodexSessionRegistry {
  private readonly ttlMs: number;
  private readonly storePath: string | null;
  private readonly sessions = new Map<string, SessionRegistryRecord>();
  private readonly threadToSession = new Map<string, string>();

  constructor(options: SessionRegistryStoreOptions = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs ?? 0) > 0
      ? (options.ttlMs as number)
      : DEFAULT_TTL_MS;
    this.storePath = options.storePath === undefined
      ? DEFAULT_STORE_PATH
      : options.storePath;
  }

  async load(): Promise<void> {
    if (!this.storePath) return;

    try {
      const file = Bun.file(this.storePath);
      if (!(await file.exists())) return;

      const raw = await file.text();
      if (!raw.trim()) return;

      const parsed = JSON.parse(raw) as Partial<SessionStorePayload>;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        console.warn('[CodexSessionRegistry] invalid store payload. skipping load.');
        return;
      }

      this.sessions.clear();
      this.threadToSession.clear();

      for (const record of parsed.sessions) {
        if (!record?.sessionId || !record.ownerUserId) continue;
        this.sessions.set(record.sessionId, record);
        this.threadToSession.set(record.threadChannelId, record.sessionId);
      }

      this.pruneExpired();
    } catch (error) {
      console.warn('[CodexSessionRegistry] failed to load store:', error);
    }
  }

  get(sessionId: string): SessionRegistryRecord | null {
    this.pruneExpired();
    return this.sessions.get(sessionId) ?? null;
  }

  getByThread(threadChannelId: string): SessionRegistryRecord | null {
    this.pruneExpired();
    const sessionId = this.threadToSession.get(threadChannelId);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  upsert(input: SessionRegistryUpsert): SessionRegistryRecord {
    const now = input.timestamp ?? Date.now();
    this.pruneExpired(now);

    const existing = this.sessions.get(input.sessionId);
    const record: SessionRegistryRecord = {
      sessionId: input.sessionId,
      provider: input.provider ?? 'codex',
      ownerUserId: input.ownerUserId,
      mappingKey: input.mappingKey,
      cwd: input.cwd,
      threadChannelId: input.threadChannelId,
      parentChannelId: input.parentChannelId,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      archivedAt: existing?.archivedAt,
    };

    this.sessions.set(record.sessionId, record);
    this.threadToSession.set(record.threadChannelId, record.sessionId);
    this.persist();
    return record;
  }

  archive(sessionId: string, timestamp = Date.now()): boolean {
    const existing = this.sessions.get(sessionId);
    if (!existing) return false;
    if (!existing.archivedAt) {
      existing.archivedAt = timestamp;
      this.sessions.set(sessionId, existing);
      this.persist();
    }
    return true;
  }

  list(filter: SessionRegistryListFilter = {}): SessionRegistryRecord[] {
    const now = filter.now ?? Date.now();
    this.pruneExpired(now);

    const includeArchived = filter.includeArchived === true;
    const items = Array.from(this.sessions.values()).filter((record) => {
      if (!includeArchived && record.archivedAt) return false;
      if (filter.ownerUserId && record.ownerUserId !== filter.ownerUserId) return false;
      if (filter.mappingKey && record.mappingKey !== filter.mappingKey) return false;
      return true;
    });

    items.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return items;
  }

  resolveResumeTarget(options: ResolveResumeTargetOptions): ResolveResumeTargetResult {
    const now = options.now ?? Date.now();
    this.pruneExpired(now);

    if (options.explicitSessionId) {
      const explicit = this.sessions.get(options.explicitSessionId);
      if (!explicit) {
        return {
          ok: false,
          reason: 'not_found',
          message: `Session not found: ${options.explicitSessionId}`,
        };
      }
      if (explicit.archivedAt) {
        return {
          ok: false,
          reason: 'not_found',
          message: 'Session is archived.',
        };
      }
      return {
        ok: true,
        source: 'explicit',
        record: explicit,
      };
    }

    if (options.threadChannelId) {
      const mappedSessionId = this.threadToSession.get(options.threadChannelId);
      if (mappedSessionId) {
        const mapped = this.sessions.get(mappedSessionId);
        if (mapped && !mapped.archivedAt) {
          return {
            ok: true,
            source: 'thread',
            record: mapped,
          };
        }
      }
    }

    const recent = this.list({
      ownerUserId: options.ownerUserId,
      mappingKey: options.mappingKey,
      includeArchived: false,
      now,
    })[0];

    if (recent) {
      return {
        ok: true,
        source: 'recent',
        record: recent,
      };
    }

    return {
      ok: false,
      reason: 'not_found',
      message: 'No recent session to resume.',
    };
  }

  private pruneExpired(now = Date.now()): void {
    for (const [sessionId, record] of this.sessions.entries()) {
      if (now - record.lastUsedAt <= this.ttlMs) continue;
      this.sessions.delete(sessionId);
      if (this.threadToSession.get(record.threadChannelId) === sessionId) {
        this.threadToSession.delete(record.threadChannelId);
      }
    }
  }

  private persist(): void {
    if (!this.storePath) return;

    const payload: SessionStorePayload = {
      version: 1,
      sessions: this.list({ includeArchived: true }),
    };

    void (async () => {
      try {
        await mkdir(dirname(this.storePath as string), { recursive: true });
        await Bun.write(this.storePath as string, `${JSON.stringify(payload, null, 2)}\n`);
      } catch (error) {
        console.warn('[CodexSessionRegistry] failed to persist store:', error);
      }
    })();
  }
}
