import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { DiscoveredThread } from './types.ts';

const HOME = process.env.HOME ?? '';
const DEFAULT_STORE_PATHS = HOME
  ? [`${HOME}/.pray-bot/auto-threads.json`]
  : ['/tmp/auto-threads.json'];

type AutoThreadStorePayload = {
  version: 1;
  mappings: DiscoveredThread[];
};

export class AutoThreadStore {
  private readonly storePaths: string[];

  constructor(storePathOrPaths: string | string[] = DEFAULT_STORE_PATHS) {
    this.storePaths = normalizeStorePaths(storePathOrPaths);
  }

  async load(): Promise<DiscoveredThread[]> {
    const merged = new Map<string, DiscoveredThread>();

    for (const storePath of this.storePaths) {
      const loaded = await this.loadFromPath(storePath);
      for (const item of loaded) {
        const provider = item.provider === 'codex' ? 'codex' : 'claude';
        const key = `${provider}:${item.sessionId}`;
        const existing = merged.get(key);
        if (!existing || item.updatedAt > existing.updatedAt) {
          merged.set(key, item);
        }
      }
    }

    return Array.from(merged.values());
  }

  private async loadFromPath(storePath: string): Promise<DiscoveredThread[]> {
    try {
      const file = Bun.file(storePath);
      if (!(await file.exists())) {
        return [];
      }

      const raw = await file.text();
      if (!raw.trim()) {
        return [];
      }

      const parsed = JSON.parse(raw) as Partial<AutoThreadStorePayload>;
      if (parsed.version !== 1 || !Array.isArray(parsed.mappings)) {
        console.warn(`[AutoThreadStore] invalid payload, ignore store file: ${storePath}`);
        return [];
      }
      return parsed.mappings as DiscoveredThread[];
    } catch (error) {
      console.error(`[AutoThreadStore] load failed (${storePath}):`, error);
      return [];
    }
  }

  async save(mappings: DiscoveredThread[]): Promise<void> {
    const payload: AutoThreadStorePayload = {
      version: 1,
      mappings,
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;

    await Promise.all(this.storePaths.map(async (storePath) => {
      try {
        await mkdir(dirname(storePath), { recursive: true });
        await Bun.write(storePath, serialized);
      } catch (error) {
        console.error(`[AutoThreadStore] save failed (${storePath}):`, error);
      }
    }));
  }
}

function normalizeStorePaths(pathOrPaths: string | string[]): string[] {
  const raw = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  const cleaned = raw
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (cleaned.length === 0) return [...DEFAULT_STORE_PATHS];
  return [...new Set(cleaned)];
}
