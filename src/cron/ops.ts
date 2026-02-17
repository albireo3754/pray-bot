import type { CronSchedulerState } from './state.ts';
import type { CronJob, CronJobCreate, CronJobPatch, CronRunResult, CronStatusSummary, CronRunLogEntry } from './types.ts';
import { loadCronStore, saveCronStore } from './store.ts';
import { locked } from './locked.ts';
import { armTimer } from './timer.ts';
import { createJob, applyPatch, computeJobNextRun } from './jobs.ts';
import { readRunLog, deleteRunLog } from './run-log.ts';

export async function start(state: CronSchedulerState): Promise<void> {
  await locked(state, async () => {
    state.store = await loadCronStore(state.deps.storePath);

    // Recompute nextRunAtMs for jobs without preserved schedule state.
    // For `every` jobs, keep overdue nextRunAtMs so the timer fires immediately after restart.
    const now = state.deps.nowMs();
    state.store.jobs = state.store.jobs.map((job) => {
      if (job.schedule.kind === 'every' && job.state.nextRunAtMs != null) {
        return job;
      }
      return computeJobNextRun(job, now);
    });

    state.running = true;
    armTimer(state);
  });
}

export function stop(state: CronSchedulerState): void {
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export async function list(
  state: CronSchedulerState,
  opts?: { includeDisabled?: boolean },
): Promise<CronJob[]> {
  if (!state.store) return [];
  const jobs = state.store.jobs;
  if (opts?.includeDisabled) return [...jobs];
  return jobs.filter((j) => j.enabled);
}

export async function add(state: CronSchedulerState, input: CronJobCreate): Promise<CronJob> {
  return locked(state, async () => {
    if (!state.store) throw new Error('Store not initialized');

    const now = state.deps.nowMs();
    const job = createJob(input, now);
    state.store.jobs.push(job);

    await saveCronStore(state.deps.storePath, state.store);
    state.deps.onEvent?.({ jobId: job.id, action: 'added', nextRunAtMs: job.state.nextRunAtMs });
    armTimer(state);

    return job;
  });
}

export async function update(
  state: CronSchedulerState,
  id: string,
  patch: CronJobPatch,
): Promise<CronJob> {
  return locked(state, async () => {
    if (!state.store) throw new Error('Store not initialized');

    const idx = state.store.jobs.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`Job not found: ${id}`);

    const existing = state.store.jobs[idx];
    if (!existing) throw new Error(`Job not found: ${id}`);

    const now = state.deps.nowMs();
    const updated = applyPatch(existing, patch, now);
    state.store.jobs[idx] = updated;

    await saveCronStore(state.deps.storePath, state.store);
    state.deps.onEvent?.({ jobId: id, action: 'updated', nextRunAtMs: updated.state.nextRunAtMs });
    armTimer(state);

    return updated;
  });
}

export async function remove(
  state: CronSchedulerState,
  id: string,
): Promise<{ ok: boolean; removed: boolean }> {
  return locked(state, async () => {
    if (!state.store) return { ok: false, removed: false };

    const idx = state.store.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: true, removed: false };

    state.store.jobs.splice(idx, 1);
    await saveCronStore(state.deps.storePath, state.store);
    state.deps.onEvent?.({ jobId: id, action: 'removed' });
    armTimer(state);

    // Clean up run log
    deleteRunLog(state.deps.storePath, id);

    return { ok: true, removed: true };
  });
}

export async function run(
  state: CronSchedulerState,
  id: string,
): Promise<CronRunResult> {
  return locked(state, async () => {
    if (!state.store) throw new Error('Store not initialized');

    const job = state.store.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`Job not found: ${id}`);

    const startMs = state.deps.nowMs();
    let status: 'ok' | 'error' = 'ok';
    let summary: string | undefined;
    let error: string | undefined;

    try {
      const result = await state.deps.executeAction(job);
      status = result.status;
      summary = result.summary;
      error = result.error;
    } catch (err) {
      status = 'error';
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = state.deps.nowMs() - startMs;

    // Update job state
    const idx = state.store.jobs.findIndex((j) => j.id === id);
    if (idx !== -1) {
      const existing = state.store.jobs[idx];
      if (existing) {
        state.store.jobs[idx] = {
          ...existing,
          state: {
            ...existing.state,
            lastRunAtMs: startMs,
            lastStatus: status,
            lastError: error,
            lastDurationMs: durationMs,
          },
        };
        await saveCronStore(state.deps.storePath, state.store);
      }
    }

    return { status, summary, error, durationMs };
  });
}

export async function getStatus(state: CronSchedulerState): Promise<CronStatusSummary> {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter((j) => j.enabled);

  let nextWakeAtMs: number | null = null;
  for (const j of enabled) {
    if (j.state.nextRunAtMs) {
      if (nextWakeAtMs === null || j.state.nextRunAtMs < nextWakeAtMs) {
        nextWakeAtMs = j.state.nextRunAtMs;
      }
    }
  }

  return {
    running: state.running,
    jobCount: jobs.length,
    enabledCount: enabled.length,
    nextWakeAtMs,
    lastRefresh: new Date(),
  };
}

export async function runs(
  state: CronSchedulerState,
  jobId: string,
  limit?: number,
): Promise<CronRunLogEntry[]> {
  return readRunLog(state.deps.storePath, jobId, limit);
}
