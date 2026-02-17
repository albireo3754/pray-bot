import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronAction,
  CronSchedule,
  CronRunResult,
  CronStatusSummary,
  CronRunLogEntry,
} from './types.ts';
import type { CronSchedulerDeps } from './state.ts';
import type { CronSchedulerState } from './state.ts';
import * as ops from './ops.ts';

export type { CronSchedulerDeps } from './state.ts';
export type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronAction,
  CronSchedule,
  CronRunResult,
  CronStatusSummary,
  CronRunLogEntry,
  CronEvent,
  CronStoreFile,
} from './types.ts';
export { formatJobListText, formatStatusText } from './formatter.ts';
export { createBuiltinActions, type BuiltinActionDeps, ActionRegistry, type ActionHandler } from './actions/index.ts';
export { DEFAULT_STORE_PATH } from './store.ts';

export class CronScheduler {
  private state: CronSchedulerState;

  constructor(deps: CronSchedulerDeps) {
    this.state = {
      deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
      store: null,
      timer: null,
      running: false,
      op: Promise.resolve(),
    };
  }

  async init(): Promise<void> {
    await ops.start(this.state);
    const status = await this.status();
    console.log(
      `[cron] Initialized, ${status.jobCount} jobs, ` +
        `${status.enabledCount} enabled, ` +
        `next wake: ${status.nextWakeAtMs ? new Date(status.nextWakeAtMs).toISOString() : 'none'}`,
    );
  }

  stop(): void {
    ops.stop(this.state);
    console.log('[cron] Stopped');
  }

  // ── CRUD ────────────────────────────

  async list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]> {
    return ops.list(this.state, opts);
  }

  async add(input: CronJobCreate): Promise<CronJob> {
    return ops.add(this.state, input);
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob> {
    return ops.update(this.state, id, patch);
  }

  async remove(id: string): Promise<{ ok: boolean; removed: boolean }> {
    return ops.remove(this.state, id);
  }

  // ── Execution ───────────────────────

  async run(id: string): Promise<CronRunResult> {
    return ops.run(this.state, id);
  }

  // ── Status ──────────────────────────

  async status(): Promise<CronStatusSummary> {
    return ops.getStatus(this.state);
  }

  async runs(jobId: string, limit?: number): Promise<CronRunLogEntry[]> {
    return ops.runs(this.state, jobId, limit);
  }

  // ── Declarative Registration ────────

  async register(
    name: string,
    schedule: CronSchedule,
    action: CronAction,
    opts?: { description?: string; enabled?: boolean; deleteAfterRun?: boolean; timeoutMs?: number },
  ): Promise<CronJob> {
    const existing = (await this.list({ includeDisabled: true })).find(
      (j) => j.name === name && j.source === 'code',
    );

    if (existing) {
      const patch: CronJobPatch = {};
      if (!isSameJson(existing.schedule, schedule)) patch.schedule = schedule;
      if (!isSameJson(existing.action, action)) patch.action = action;
      if (opts?.description !== undefined && existing.description !== opts.description) {
        patch.description = opts.description;
      }
      if (opts?.enabled !== undefined && existing.enabled !== opts.enabled) {
        patch.enabled = opts.enabled;
      }
      if (opts?.deleteAfterRun !== undefined && existing.deleteAfterRun !== opts.deleteAfterRun) {
        patch.deleteAfterRun = opts.deleteAfterRun;
      }
      if (opts?.timeoutMs !== undefined && existing.timeoutMs !== opts.timeoutMs) {
        patch.timeoutMs = opts.timeoutMs;
      }
      if (Object.keys(patch).length === 0) {
        return existing;
      }
      return this.update(existing.id, patch);
    }

    return this.add({
      name,
      schedule,
      action,
      source: 'code',
      enabled: opts?.enabled ?? true,
      ...opts,
    });
  }
}

function isSameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
