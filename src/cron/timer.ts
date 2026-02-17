import type { CronSchedulerState } from './state.ts';
import type { CronJob } from './types.ts';
import { locked } from './locked.ts';
import { saveCronStore } from './store.ts';
import { appendRunLog } from './run-log.ts';
import { computeJobNextRun } from './jobs.ts';

const MAX_TIMEOUT = 2 ** 31 - 1; // ~24.8 days
const STUCK_RUN_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_TIMEOUT_MS = 30_000;

export function armTimer(state: CronSchedulerState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  if (!state.running || !state.store) return;

  const now = state.deps.nowMs();
  let earliest = Infinity;

  for (const job of state.store.jobs) {
    if (!job.enabled || !job.state.nextRunAtMs) continue;
    if (job.state.nextRunAtMs < earliest) {
      earliest = job.state.nextRunAtMs;
    }
  }

  if (earliest === Infinity) return;

  const delay = Math.max(0, Math.min(earliest - now, MAX_TIMEOUT));
  state.timer = setTimeout(() => onTimer(state), delay);
  (state.timer as ReturnType<typeof setTimeout>).unref();
}

async function onTimer(state: CronSchedulerState): Promise<void> {
  state.timer = null;
  await locked(state, async () => {
    if (!state.running || !state.store) return;
    await runDueJobs(state);
    await saveCronStore(state.deps.storePath, state.store);
    armTimer(state);
  });
}

async function runDueJobs(state: CronSchedulerState): Promise<void> {
  if (!state.store) return;

  const now = state.deps.nowMs();

  for (let i = 0; i < state.store.jobs.length; i++) {
    const job = state.store.jobs[i];
    if (!job) continue;
    if (!job.enabled) continue;
    if (!job.state.nextRunAtMs || job.state.nextRunAtMs > now) continue;

    // Skip if already running (unless stuck)
    if (job.state.runningAtMs) {
      if (now - job.state.runningAtMs < STUCK_RUN_MS) continue;
      console.warn(`[cron] Job ${job.id} stuck since ${new Date(job.state.runningAtMs).toISOString()}, clearing`);
    }

    state.store.jobs[i] = await executeJob(state, job);
  }
}

async function executeJob(state: CronSchedulerState, job: CronJob): Promise<CronJob> {
  const now = state.deps.nowMs();

  // Mark running
  job = { ...job, state: { ...job.state, runningAtMs: now } };
  state.deps.onEvent?.({ jobId: job.id, action: 'started', runAtMs: now });

  let status: 'ok' | 'error' = 'ok';
  let summary: string | undefined;
  let error: string | undefined;

  const startMs = now;

  try {
    const result = await executeWithTimeout(state, job);
    status = result.status;
    summary = result.summary;
    error = result.error;
  } catch (err) {
    status = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = state.deps.nowMs() - startMs;

  // Compute next run
  const nextNow = state.deps.nowMs();
  const nextRunAtMs = job.deleteAfterRun ? undefined : computeJobNextRun(job, nextNow).state.nextRunAtMs;

  const updated: CronJob = {
    ...job,
    state: {
      nextRunAtMs,
      lastRunAtMs: startMs,
      lastStatus: status,
      lastError: error,
      lastDurationMs: durationMs,
      runningAtMs: undefined,
    },
  };

  // Emit event
  state.deps.onEvent?.({
    jobId: job.id,
    action: 'finished',
    runAtMs: startMs,
    durationMs,
    status,
    error,
    summary,
    nextRunAtMs,
  });

  // Append run log
  await appendRunLog(state.deps.storePath, {
    ts: nextNow,
    jobId: job.id,
    action: 'finished',
    status,
    error,
    summary,
    runAtMs: startMs,
    durationMs,
    nextRunAtMs,
  }).catch((err) => console.error('[cron] Failed to append run log:', err));

  // Handle deleteAfterRun
  if (job.deleteAfterRun && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    state.deps.onEvent?.({ jobId: job.id, action: 'removed' });
    return updated; // won't be in store anymore
  }

  return updated;
}

async function executeWithTimeout(
  state: CronSchedulerState,
  job: CronJob,
): Promise<{ status: 'ok' | 'error'; summary?: string; error?: string }> {
  const timeoutMs = job.timeoutMs ?? state.deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = await Promise.race([
    state.deps.executeAction(job),
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`Action timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      (t as ReturnType<typeof setTimeout>).unref();
    }),
  ]);

  return result;
}
