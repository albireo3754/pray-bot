// ── Schedule ──────────────────────────────────────────

export type CronSchedule =
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

// ── Action ────────────────────────────────────────────

export type CronAction = {
  type: string;
  config: Record<string, unknown>;
};

export type BuiltinActionType = 'notify' | 'http' | 'command' | 'shell';

// ── Job State ─────────────────────────────────────────

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
};

// ── Job ───────────────────────────────────────────────

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  source: 'code' | 'user';
  timeoutMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  action: CronAction;
  state: CronJobState;
};

// ── Store ─────────────────────────────────────────────

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

// ── CRUD Inputs ───────────────────────────────────────

export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state' | 'source'> & {
  source?: 'code' | 'user';
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state'>> & {
  state?: Partial<CronJobState>;
};

// ── Events ────────────────────────────────────────────

export type CronEvent = {
  jobId: string;
  action: 'added' | 'updated' | 'removed' | 'started' | 'finished';
  runAtMs?: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
  nextRunAtMs?: number;
};

// ── Run Log ───────────────────────────────────────────

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: 'finished';
  status?: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};

// ── Run Result ────────────────────────────────────────

export type CronRunResult = {
  status: 'ok' | 'error' | 'skipped';
  summary?: string;
  error?: string;
  durationMs?: number;
};

// ── Status Summary ────────────────────────────────────

export type CronStatusSummary = {
  running: boolean;
  jobCount: number;
  enabledCount: number;
  nextWakeAtMs: number | null;
  lastRefresh: Date;
};
