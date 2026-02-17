import { mkdirSync, unlinkSync } from 'node:fs';
import type { CronRunLogEntry } from './types.ts';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_LINES = 2000;

function getRunLogDir(storePath: string): string {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'));
  return `${dir}/runs`;
}

function getRunLogPath(storePath: string, jobId: string): string {
  return `${getRunLogDir(storePath)}/${jobId}.jsonl`;
}

export async function appendRunLog(storePath: string, entry: CronRunLogEntry): Promise<void> {
  const dir = getRunLogDir(storePath);
  mkdirSync(dir, { recursive: true });

  const logPath = getRunLogPath(storePath, entry.jobId);
  const line = JSON.stringify(entry) + '\n';

  // Check if pruning needed before append
  try {
    const file = Bun.file(logPath);
    if (await file.exists() && file.size > MAX_FILE_SIZE) {
      await pruneRunLog(logPath);
    }
  } catch {
    // ignore — file may not exist yet
  }

  // Bun.write overwrites, so read existing content and append
  const existing = Bun.file(logPath);
  if (await existing.exists()) {
    const prev = await existing.text();
    await Bun.write(logPath, prev + line);
  } else {
    await Bun.write(logPath, line);
  }
}

async function pruneRunLog(logPath: string): Promise<void> {
  try {
    const file = Bun.file(logPath);
    const text = await file.text();
    const lines = text.trim().split('\n');

    if (lines.length <= MAX_LINES) return;

    // Keep the most recent entries
    const kept = lines.slice(-MAX_LINES);
    await Bun.write(logPath, kept.join('\n') + '\n');
  } catch (err) {
    console.error('[cron] Failed to prune run log:', err);
  }
}

export async function readRunLog(
  storePath: string,
  jobId: string,
  limit = 50,
): Promise<CronRunLogEntry[]> {
  const logPath = getRunLogPath(storePath, jobId);

  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) return [];

    const text = await file.text();
    const lines = text.trim().split('\n').filter(Boolean);

    const entries: CronRunLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }

    // Return most recent entries
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

export function deleteRunLog(storePath: string, jobId: string): void {
  const logPath = getRunLogPath(storePath, jobId);
  try {
    unlinkSync(logPath);
  } catch {
    // file may not exist
  }
}
