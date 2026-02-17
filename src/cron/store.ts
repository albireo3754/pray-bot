import { mkdirSync, renameSync } from 'node:fs';
import type { CronStoreFile } from './types.ts';

const HOME = process.env.HOME ?? '';
export const DEFAULT_STORE_PATH = `${HOME}/.pray-bot/cron/jobs.json`;

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const file = Bun.file(storePath);
    if (!(await file.exists())) return { version: 1, jobs: [] };
    const parsed = await file.json();
    return { version: 1, jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [] };
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, jobs: [] };
    }
    console.error('[cron] Failed to load store, returning empty:', err);
    return { version: 1, jobs: [] };
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  // 1. Backup current file BEFORE writing new content
  try {
    const existing = Bun.file(storePath);
    if (await existing.exists()) {
      const content = await existing.text();
      await Bun.write(`${storePath}.bak`, content);
    }
  } catch (err) {
    console.error('[cron] Failed to create backup:', err);
  }

  // 2. Write to temp file, then atomic rename
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await Bun.write(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, storePath);
}
