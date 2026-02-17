import type { CronJob, CronJobCreate, CronJobPatch } from './types.ts';
import { computeNextRunAtMs } from './schedule.ts';

function computeEveryNextRunAtMs(
  everyMsRaw: number,
  anchorMsRaw: number | undefined,
  state: CronJob['state'],
  createdAtMs: number,
  nowMs: number,
): number {
  const everyMs = Math.max(1, Math.floor(everyMsRaw));
  const anchor = Math.max(
    0,
    Math.floor(
      anchorMsRaw
        ?? state.nextRunAtMs
        ?? state.lastRunAtMs
        ?? createdAtMs,
    ),
  );

  if (nowMs < anchor) return anchor;
  const elapsed = nowMs - anchor;
  const steps = Math.floor(elapsed / everyMs) + 1;
  return anchor + steps * everyMs;
}

function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (job.schedule.kind === 'every') {
    return computeEveryNextRunAtMs(
      job.schedule.everyMs,
      job.schedule.anchorMs,
      job.state,
      job.createdAtMs,
      nowMs,
    );
  }
  return computeNextRunAtMs(job.schedule, nowMs);
}

export function createJob(input: CronJobCreate, nowMs: number): CronJob {
  const job: CronJob = {
    id: crypto.randomUUID().slice(0, 8),
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    deleteAfterRun: input.deleteAfterRun,
    source: input.source ?? 'user',
    timeoutMs: input.timeoutMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: input.schedule,
    action: input.action,
    state: {
      ...input.state,
      nextRunAtMs: undefined,
    },
  };
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
  return job;
}

export function applyPatch(job: CronJob, patch: CronJobPatch, nowMs: number): CronJob {
  const updated = { ...job };

  if (patch.name !== undefined) updated.name = patch.name;
  if (patch.description !== undefined) updated.description = patch.description;
  if (patch.enabled !== undefined) updated.enabled = patch.enabled;
  if (patch.deleteAfterRun !== undefined) updated.deleteAfterRun = patch.deleteAfterRun;
  if (patch.timeoutMs !== undefined) updated.timeoutMs = patch.timeoutMs;
  if (patch.schedule !== undefined) updated.schedule = patch.schedule;
  if (patch.action !== undefined) updated.action = patch.action;

  if (patch.state) {
    updated.state = { ...updated.state, ...patch.state };
  }

  // Recompute nextRunAtMs if schedule changed
  if (patch.schedule) {
    updated.state.nextRunAtMs = computeJobNextRunAtMs(updated, nowMs);
  }

  updated.updatedAtMs = nowMs;
  return updated;
}

export function computeJobNextRun(job: CronJob, nowMs: number): CronJob {
  return {
    ...job,
    state: {
      ...job.state,
      nextRunAtMs: computeJobNextRunAtMs(job, nowMs),
    },
  };
}
