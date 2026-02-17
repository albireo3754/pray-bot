import type { CronEvent, CronJob, CronStoreFile } from './types.ts';

export type CronActionExecutor = (
  job: CronJob,
) => Promise<{ status: 'ok' | 'error'; summary?: string; error?: string }>;

export type CronSchedulerDeps = {
  storePath: string;
  enabled: boolean;
  executeAction: CronActionExecutor;
  onEvent?: (evt: CronEvent) => void;
  nowMs?: () => number;
  defaultTimeoutMs?: number;
};

export type CronSchedulerState = {
  deps: CronSchedulerDeps & { nowMs: () => number };
  store: CronStoreFile | null;
  timer: Timer | null;
  running: boolean;
  op: Promise<unknown>;
};
