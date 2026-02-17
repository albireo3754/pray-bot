import { readdir, stat } from 'node:fs/promises';
import type { MonitorStatus, SessionSnapshot, TokenUsageReport, TokenUsageSession } from './types.ts';
import type { SessionMonitorProvider } from './index.ts';

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_DAYS = 2;
const DEFAULT_SESSIONS_ROOT = process.env.HOME
  ? `${process.env.HOME}/.codex/sessions`
  : '/tmp/.codex/sessions';
const FIRST_LINE_READ_LIMIT = 2_000_000;
const TAIL_READ_BYTES = 512_000;

// Rough per-token pricing (Codex/GPT-5.3 as reference)
const COST_PER_INPUT_TOKEN = 2 / 1_000_000;    // $2/MTok
const COST_PER_OUTPUT_TOKEN = 8 / 1_000_000;    // $8/MTok
const COST_PER_CACHED_TOKEN = 0.5 / 1_000_000;  // $0.5/MTok (cache read)

type JsonObject = Record<string, unknown>;

type CodexEntry = {
  timestamp?: string;
  type?: string;
  payload?: JsonObject;
};

export interface CodexUsageMonitorOptions {
  pollIntervalMs?: number;
  scanDays?: number;
  sessionsRoot?: string;
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  if (!normalized) return '';
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function previewText(raw: string, max = 120): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function toCodexEntry(value: unknown): CodexEntry | null {
  if (!isRecord(value)) return null;
  return {
    timestamp: asString(value.timestamp) ?? undefined,
    type: asString(value.type) ?? undefined,
    payload: isRecord(value.payload) ? value.payload : undefined,
  };
}

async function readFirstEntry(path: string): Promise<CodexEntry | null> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= 0) return null;

  const head = await file.slice(0, Math.min(size, FIRST_LINE_READ_LIMIT)).text();
  const newlineIndex = head.indexOf('\n');
  let firstLine = '';

  if (newlineIndex >= 0) {
    firstLine = head.slice(0, newlineIndex).trim();
  } else if (size <= FIRST_LINE_READ_LIMIT) {
    firstLine = head.trim();
  } else {
    // Rare oversized first line (large base instructions): fallback to full read once.
    const full = await file.text();
    const fullNewlineIndex = full.indexOf('\n');
    firstLine = (fullNewlineIndex >= 0 ? full.slice(0, fullNewlineIndex) : full).trim();
  }

  if (!firstLine) return null;

  try {
    return toCodexEntry(JSON.parse(firstLine));
  } catch {
    return null;
  }
}

async function readJsonlTail(path: string, bytes = TAIL_READ_BYTES): Promise<CodexEntry[]> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= 0) return [];

  const start = Math.max(0, size - bytes);
  const text = await file.slice(start, size).text();
  const lines = text.split('\n');
  if (start > 0) lines.shift();

  const entries: CodexEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = toCodexEntry(JSON.parse(trimmed));
      if (parsed) entries.push(parsed);
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

function determineState(mtimeMs: number, nowMs: number): SessionSnapshot['state'] {
  const age = Math.max(0, nowMs - mtimeMs);
  if (age < FIVE_MINUTES) return 'active';
  if (age < ONE_HOUR) return 'idle';
  if (age < TWENTY_FOUR_HOURS) return 'completed';
  return 'stale';
}

type TailParseResult = {
  model: string | null;
  turnCount: number;
  lastUserMessage: string | null;
  currentTools: string[];
  tokens: { input: number; output: number; cached: number };
  lastActivity: Date;
};

function parseTailEntries(entries: CodexEntry[], fallbackLastActivity: Date): TailParseResult {
  let model: string | null = null;
  let turnCount = 0;
  let turnContextCount = 0;
  let lastUserMessage: string | null = null;
  const toolNames: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let lastActivityMs = fallbackLastActivity.getTime();

  const trackToolName = (name: string) => {
    const idx = toolNames.indexOf(name);
    if (idx >= 0) toolNames.splice(idx, 1);
    toolNames.push(name);
    if (toolNames.length > 8) toolNames.shift();
  };

  for (const entry of entries) {
    const ts = parseDate(entry.timestamp ?? null);
    if (ts) {
      const ms = ts.getTime();
      if (ms > lastActivityMs) lastActivityMs = ms;
    }

    if (entry.type === 'turn_context') {
      turnContextCount += 1;
      const payload = entry.payload;
      const nextModel = asString(payload?.model);
      if (nextModel) model = nextModel;
      continue;
    }

    if (entry.type === 'event_msg') {
      const payload = entry.payload;
      const eventType = asString(payload?.type);
      if (!eventType) continue;

      if (eventType === 'task_started') {
        turnCount += 1;
        continue;
      }

      if (eventType === 'user_message') {
        const text = asString(payload?.message);
        if (text) lastUserMessage = previewText(text);
        continue;
      }

      if (eventType === 'token_count') {
        const info = isRecord(payload?.info) ? payload.info : null;
        const total = info && isRecord(info.total_token_usage)
          ? info.total_token_usage
          : null;
        if (total) {
          inputTokens = asNumber(total.input_tokens) ?? inputTokens;
          outputTokens = asNumber(total.output_tokens) ?? outputTokens;
          cachedTokens = asNumber(total.cached_input_tokens) ?? cachedTokens;
        }
      }
      continue;
    }

    if (entry.type === 'response_item') {
      const payload = entry.payload;
      if (asString(payload?.type) !== 'function_call') continue;
      const toolName = asString(payload?.name);
      if (toolName) trackToolName(toolName);
    }
  }

  return {
    model,
    turnCount: turnCount > 0 ? turnCount : turnContextCount,
    lastUserMessage,
    currentTools: toolNames,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cached: cachedTokens,
    },
    lastActivity: new Date(lastActivityMs),
  };
}

type SessionFileEntry = {
  path: string;
  mtimeMs: number;
};

function formatDateDir(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function estimateCost(tokens: { input: number; output: number; cached: number }): number {
  return (
    (tokens.input - tokens.cached) * COST_PER_INPUT_TOKEN +
    tokens.output * COST_PER_OUTPUT_TOKEN +
    tokens.cached * COST_PER_CACHED_TOKEN
  );
}

export class CodexUsageMonitor implements SessionMonitorProvider {
  private sessions = new Map<string, SessionSnapshot>();
  private timer: Timer | null = null;
  private lastRefresh = new Date();
  private onRefreshCallbacks: Array<(sessions: SessionSnapshot[]) => Promise<void>> = [];
  private readonly pollIntervalMs: number;
  private readonly scanDays: number;
  private readonly sessionsRoot: string;

  constructor(options: CodexUsageMonitorOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.scanDays = Math.max(1, options.scanDays ?? DEFAULT_SCAN_DAYS);
    this.sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
  }

  async init(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(console.error), this.pollIntervalMs);
    console.log(`[CodexMonitor] Initialized, ${this.sessions.size} sessions found`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onRefresh(cb: (sessions: SessionSnapshot[]) => Promise<void>): void {
    this.onRefreshCallbacks.push(cb);
  }

  async refresh(): Promise<void> {
    try {
      const snapshots = await this.discoverSessions();
      this.sessions.clear();
      for (const snapshot of snapshots) {
        this.sessions.set(snapshot.sessionId, snapshot);
      }

      this.lastRefresh = new Date();
      const all = this.getAll();
      for (const cb of this.onRefreshCallbacks) {
        await cb(all).catch((err) => {
          console.error('[CodexMonitor] onRefresh callback error:', err);
        });
      }
    } catch (err) {
      console.error('[CodexMonitor] Refresh error:', err);
    }
  }

  getAll(): SessionSnapshot[] {
    const STATE_ORDER: Record<SessionSnapshot['state'], number> = {
      active: 0,
      idle: 1,
      completed: 2,
      stale: 3,
    };

    return Array.from(this.sessions.values())
      .filter((session) => session.state !== 'stale')
      .sort((a, b) => {
        const stateDiff = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        if (stateDiff !== 0) return stateDiff;
        return b.lastActivity.getTime() - a.lastActivity.getTime();
      });
  }

  getActive(): SessionSnapshot[] {
    return this.getAll().filter((session) => session.state === 'active' || session.state === 'idle');
  }

  getSession(query: string): SessionSnapshot | null {
    const q = query.toLowerCase();
    const exact = this.sessions.get(query);
    if (exact) return exact;

    for (const session of this.sessions.values()) {
      if (session.slug.toLowerCase().includes(q)) return session;
      if (session.sessionId.toLowerCase().startsWith(q)) return session;
      if (session.projectName.toLowerCase().includes(q)) return session;
    }
    return null;
  }

  getStatus(): MonitorStatus {
    const sessions = this.getAll();
    return {
      sessions,
      activeCount: sessions.filter((session) => session.state === 'active').length,
      totalCount: sessions.length,
      lastRefresh: this.lastRefresh,
    };
  }

  getTokenUsageReport(): TokenUsageReport {
    const allSessions = this.getActive();

    const sessions: TokenUsageSession[] = allSessions.map((s) => ({
      sessionId: s.sessionId,
      projectName: s.projectName,
      slug: s.slug,
      state: s.state,
      model: s.model,
      tokens: { ...s.tokens },
      estimatedCostUsd: estimateCost(s.tokens),
      lastActivity: s.lastActivity,
      lastUserMessage: s.lastUserMessage,
      currentTools: s.currentTools,
    }));

    const totals = {
      input: 0,
      output: 0,
      cached: 0,
      estimatedCostUsd: 0,
    };

    for (const s of sessions) {
      totals.input += s.tokens.input;
      totals.output += s.tokens.output;
      totals.cached += s.tokens.cached;
      totals.estimatedCostUsd += s.estimatedCostUsd;
    }

    return {
      timestamp: new Date(),
      sessions,
      totals,
      activeCount: allSessions.filter((s) => s.state === 'active').length,
      totalCount: allSessions.length,
    };
  }

  private async discoverSessions(): Promise<SessionSnapshot[]> {
    const now = Date.now();
    const files: SessionFileEntry[] = [];

    for (const dateDir of this.getRecentDateDirs(new Date(now))) {
      const entries = await this.listJsonlFiles(`${this.sessionsRoot}/${dateDir}`);
      files.push(...entries);
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const bySessionId = new Map<string, SessionSnapshot>();

    for (const file of files) {
      const snapshot = await this.parseSession(file.path, file.mtimeMs, now);
      if (!snapshot) continue;

      const existing = bySessionId.get(snapshot.sessionId);
      if (!existing || snapshot.lastActivity.getTime() > existing.lastActivity.getTime()) {
        bySessionId.set(snapshot.sessionId, snapshot);
      }
    }

    return Array.from(bySessionId.values());
  }

  private getRecentDateDirs(now: Date): string[] {
    const dirs: string[] = [];
    for (let dayOffset = 0; dayOffset < this.scanDays; dayOffset++) {
      const d = new Date(now.getTime() - dayOffset * TWENTY_FOUR_HOURS);
      dirs.push(formatDateDir(d));
    }
    return dirs;
  }

  private async listJsonlFiles(dirPath: string): Promise<SessionFileEntry[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => `${dirPath}/${entry.name}`);

      const result: SessionFileEntry[] = [];
      for (const path of files) {
        try {
          const stats = await stat(path);
          result.push({ path, mtimeMs: stats.mtimeMs });
        } catch {
          // file may disappear during scan
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  private async parseSession(
    filePath: string,
    mtimeMs: number,
    nowMs: number,
  ): Promise<SessionSnapshot | null> {
    const first = await readFirstEntry(filePath);
    if (!first || first.type !== 'session_meta') return null;
    if (!isRecord(first.payload)) return null;

    const payload = first.payload;
    const sessionId = asString(payload.id);
    const projectPath = asString(payload.cwd);
    if (!sessionId || !projectPath) return null;

    const git = isRecord(payload.git) ? payload.git : null;
    const gitBranch = asString(git?.branch);
    const version = asString(payload.cli_version);
    const originator = asString(payload.originator);
    const source = asString(payload.source);
    const startedAt = parseDate(asString(payload.timestamp) ?? first.timestamp ?? null);
    const fallbackLastActivity = startedAt ?? new Date(mtimeMs);

    const tailEntries = await readJsonlTail(filePath);
    const parsed = parseTailEntries(tailEntries, fallbackLastActivity);
    const lastActivityMs = Math.max(parsed.lastActivity.getTime(), mtimeMs);

    return {
      provider: 'codex',
      sessionId,
      projectPath,
      projectName: basename(projectPath) || projectPath,
      slug: sessionId.slice(0, 8),
      state: determineState(mtimeMs, nowMs),
      pid: null,
      cpuPercent: null,
      memMb: null,
      model: parsed.model,
      gitBranch,
      version,
      turnCount: parsed.turnCount,
      lastUserMessage: parsed.lastUserMessage,
      currentTools: parsed.currentTools,
      tokens: parsed.tokens,
      waitReason: null,
      waitToolNames: [],
      startedAt,
      lastActivity: new Date(lastActivityMs),
      activityPhase: null,
      jsonlPath: filePath,
      originator,
      source,
    };
  }
}
