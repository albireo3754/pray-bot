import { watch, type FSWatcher } from 'node:fs';
import type { SessionSnapshot, MonitorStatus, ClaudeProcess, TokenUsageReport, TokenUsageSession, ActivityPhase } from './types.ts';
import { getClaudeProcesses, enrichProcesses, discoverProjects, encodeProjectKey, CLAUDE_HOMES } from './claude-discovery.ts';
import { tailJsonl, extractSessionInfo, determineActivityPhase } from './claude-parser.ts';
import type { SessionMonitorProvider } from './index.ts';
import type { HookAcceptingMonitor, SessionStartHookEvent } from './hook-receiver.ts';

const FIVE_MINUTES = 5 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

// Rough per-token pricing (Claude Opus 4.6 as reference)
const COST_PER_INPUT_TOKEN = 15 / 1_000_000;   // $15/MTok
const COST_PER_OUTPUT_TOKEN = 75 / 1_000_000;   // $75/MTok
const COST_PER_CACHED_TOKEN = 1.5 / 1_000_000;  // $1.5/MTok (cache read)

function estimateCost(tokens: { input: number; output: number; cached: number }): number {
  return (
    (tokens.input - tokens.cached) * COST_PER_INPUT_TOKEN +
    tokens.output * COST_PER_OUTPUT_TOKEN +
    tokens.cached * COST_PER_CACHED_TOKEN
  );
}

export class ClaudeUsageMonitor implements SessionMonitorProvider, HookAcceptingMonitor {
  private sessions = new Map<string, SessionSnapshot>();
  private timer: Timer | null = null;
  private watchDebounceTimer: Timer | null = null;
  private watchers: FSWatcher[] = [];
  private mtimeCache = new Map<string, number>();
  private lastRefresh = new Date();
  private onRefreshCallbacks: Array<(sessions: SessionSnapshot[]) => Promise<void>> = [];
  private refreshRunning = false;
  private refreshQueued = false;

  constructor(
    private pollIntervalMs = 30_000,
    private watchDebounceMs = 10_000,
  ) {}

  async init(): Promise<void> {
    await this.refresh();
    this.startProjectWatchers();
    this.timer = setInterval(() => this.refresh().catch(console.error), this.pollIntervalMs);
    console.log(`[ClaudeMonitor] Initialized, ${this.sessions.size} sessions found`);
  }

  async refresh(): Promise<void> {
    if (this.refreshRunning) {
      this.refreshQueued = true;
      return;
    }

    this.refreshRunning = true;
    try {
      do {
        this.refreshQueued = false;
        await this.refreshOnce();
      } while (this.refreshQueued);
    } finally {
      this.refreshRunning = false;
    }
  }

  private async refreshOnce(): Promise<void> {
    try {
      // 1. Get running Claude processes
      const processes = await getClaudeProcesses();
      await enrichProcesses(processes);

      // Build PID→process, sessionId→process, and cwd→process maps
      const pidMap = new Map<number, ClaudeProcess>();
      const sessionProcessMap = new Map<string, ClaudeProcess>();
      const cwdProcessMap = new Map<string, ClaudeProcess[]>();
      for (const proc of processes) {
        pidMap.set(proc.pid, proc);
        if (proc.sessionId) {
          sessionProcessMap.set(proc.sessionId, proc);
        }
        // Also map by resumeId
        if (proc.resumeId) {
          sessionProcessMap.set(proc.resumeId, proc);
        }
        // Map by encoded CWD for fallback matching (only if no sessionId/resumeId)
        if (proc.cwd && !proc.sessionId && !proc.resumeId) {
          const key = encodeProjectKey(proc.cwd);
          const list = cwdProcessMap.get(key) ?? [];
          list.push(proc);
          cwdProcessMap.set(key, list);
        }
      }

      // 2. Discover projects and their JSONL files
      const projects = await discoverProjects();

      // 3. Match processes to JSONL files and build snapshots
      const now = Date.now();
      const seen = new Set<string>();
      const matchedPids = new Set<number>();

      for (const proj of projects) {
        for (const jsonlFile of proj.jsonlFiles) {
          const sessionId = jsonlFile.name.replace('.jsonl', '');

          // Skip if already processed (same JSONL in both .claude and .claude-silba)
          if (seen.has(sessionId)) continue;

          const jsonlPath = `${proj.baseDir}/projects/${proj.key}/${jsonlFile.name}`;

          // Check if process exists for this session (by sessionId/resumeId, then CWD fallback)
          let proc = sessionProcessMap.get(sessionId) ?? null;

          // Fallback: match by CWD — most recent JSONL file per project gets the process
          if (!proc && jsonlFile === proj.jsonlFiles[0]) {
            const cwdProcs = cwdProcessMap.get(proj.key);
            if (cwdProcs) {
              // Skip processes already matched to other sessions
              while (cwdProcs.length > 0 && cwdProcs[0] && matchedPids.has(cwdProcs[0].pid)) {
                cwdProcs.shift();
              }
              if (cwdProcs.length > 0) {
                proc = cwdProcs.shift()!;
              }
            }
          }

          // Skip stale sessions (no process + older than 24h)
          if (!proc && now - jsonlFile.mtime > TWENTY_FOUR_HOURS) continue;

          // Track matched PIDs to prevent double-matching
          if (proc) matchedPids.add(proc.pid);

          // Check mtime cache - only re-parse if changed
          const cachedMtime = this.mtimeCache.get(jsonlPath);
          const existing = this.sessions.get(sessionId);

          if (existing && cachedMtime === jsonlFile.mtime) {
            // Just update process info and state
            existing.pid = proc?.pid ?? null;
            existing.cpuPercent = proc?.cpuPercent ?? null;
            existing.memMb = proc?.memMb ?? null;
            existing.state = this.determineState(proc ?? null, jsonlFile.mtime, now);
            existing.activityPhase = existing.state === 'active'
              ? (existing.activityPhase ?? 'busy')
              : null;
            seen.add(sessionId);
            continue;
          }

          // Parse JSONL
          const entries = await tailJsonl(jsonlPath);
          if (entries.length === 0) continue;

          const info = extractSessionInfo(entries);
          this.mtimeCache.set(jsonlPath, jsonlFile.mtime);

          const projectPath = info.cwd || proc?.cwd || '';
          const projectName = projectPath.split('/').pop() || proj.key;

          const state = this.determineState(proc ?? null, jsonlFile.mtime, now);

          // Preserve hook-set activityPhase if session already exists (hook is primary source)
          const prevSnapshot = this.sessions.get(sessionId);
          const activityPhase = state === 'active'
            ? (prevSnapshot?.activityPhase ?? determineActivityPhase(info))
            : null;

          const snapshot: SessionSnapshot = {
            provider: 'claude',
            sessionId: info.sessionId || sessionId,
            projectPath,
            projectName,
            slug: info.slug || sessionId.slice(0, 8),
            state,
            pid: proc?.pid ?? null,
            cpuPercent: proc?.cpuPercent ?? null,
            memMb: proc?.memMb ?? null,
            model: info.model,
            gitBranch: info.gitBranch,
            version: info.version,
            turnCount: info.turnCount,
            lastUserMessage: info.lastUserMessage,
            currentTools: info.currentTools,
            tokens: info.tokens,
            waitReason: info.waitReason,
            waitToolNames: info.waitToolNames,
            startedAt: info.startedAt,
            lastActivity: info.lastActivity,
            activityPhase,
            jsonlPath,
          };

          this.sessions.set(sessionId, snapshot);
          seen.add(sessionId);
        }
      }

      // Also check for processes that have CWD but weren't matched to any session yet
      for (const proc of processes) {
        // Skip processes already matched (by sessionId or PID)
        if (matchedPids.has(proc.pid)) continue;
        if (proc.sessionId && seen.has(proc.sessionId)) continue;

        // Try by sessionId first (original logic)
        if (proc.sessionId && !seen.has(proc.sessionId)) {
          const encodedCwd = encodeProjectKey(proc.cwd);
          for (const baseDir of CLAUDE_HOMES) {
            const jsonlPath = `${baseDir}/projects/${encodedCwd}/${proc.sessionId}.jsonl`;
            const file = Bun.file(jsonlPath);
            if (await file.exists()) {
              const entries = await tailJsonl(jsonlPath);
              const info = extractSessionInfo(entries);

              this.sessions.set(proc.sessionId, {
                provider: 'claude',
                sessionId: proc.sessionId,
                projectPath: proc.cwd || info.cwd,
                projectName: (proc.cwd || info.cwd).split('/').pop() || encodedCwd,
                slug: info.slug || proc.sessionId.slice(0, 8),
                state: 'active',
                pid: proc.pid,
                cpuPercent: proc.cpuPercent,
                memMb: proc.memMb,
                model: info.model,
                gitBranch: info.gitBranch,
                version: info.version,
                turnCount: info.turnCount,
                lastUserMessage: info.lastUserMessage,
                currentTools: info.currentTools,
                tokens: info.tokens,
                waitReason: info.waitReason,
                waitToolNames: info.waitToolNames,
                startedAt: info.startedAt,
                lastActivity: info.lastActivity,
                activityPhase: determineActivityPhase(info),
                jsonlPath,
              });
              seen.add(proc.sessionId);
              break;
            }
          }
          continue;
        }

        // Fallback: find most recent JSONL by CWD for processes without sessionId
        if (!proc.cwd) continue;
        const encodedCwd = encodeProjectKey(proc.cwd);
        for (const baseDir of CLAUDE_HOMES) {
          const projDir = `${baseDir}/projects/${encodedCwd}`;
          const proj = projects.find((p) => p.key === encodedCwd && p.baseDir === baseDir);
          if (!proj || proj.jsonlFiles.length === 0) continue;

          // Find the most recent JSONL that wasn't already matched
          const unmatched = proj.jsonlFiles.find((f) => !seen.has(f.name.replace('.jsonl', '')));
          if (!unmatched) continue;

          const sid = unmatched.name.replace('.jsonl', '');
          const jsonlPath = `${projDir}/${unmatched.name}`;
          const entries = await tailJsonl(jsonlPath);
          if (entries.length === 0) continue;
          const info = extractSessionInfo(entries);

          const fallbackState = this.determineState(proc, unmatched.mtime, now);
          this.sessions.set(sid, {
            provider: 'claude',
            sessionId: info.sessionId || sid,
            projectPath: proc.cwd || info.cwd,
            projectName: (proc.cwd || info.cwd).split('/').pop() || encodedCwd,
            slug: info.slug || sid.slice(0, 8),
            state: fallbackState,
            pid: proc.pid,
            cpuPercent: proc.cpuPercent,
            memMb: proc.memMb,
            model: info.model,
            gitBranch: info.gitBranch,
            version: info.version,
            turnCount: info.turnCount,
            lastUserMessage: info.lastUserMessage,
            currentTools: info.currentTools,
            tokens: info.tokens,
            waitReason: info.waitReason,
            waitToolNames: info.waitToolNames,
            startedAt: info.startedAt,
            lastActivity: info.lastActivity,
            activityPhase: fallbackState === 'active' ? determineActivityPhase(info) : null,
            jsonlPath,
          });
          seen.add(sid);
          break;
        }
      }

      // Remove sessions that are stale and no longer seen
      for (const [id, session] of this.sessions) {
        if (!seen.has(id) && session.state === 'stale') {
          this.sessions.delete(id);
          this.mtimeCache.delete(session.jsonlPath);
        }
      }

      this.lastRefresh = new Date();
      const all = this.getAll();
      for (const cb of this.onRefreshCallbacks) {
        await cb(all).catch((err) => {
          console.error('[ClaudeMonitor] onRefresh callback error:', err);
        });
      }
    } catch (err) {
      console.error('[ClaudeMonitor] Refresh error:', err);
    }
  }

  onRefresh(cb: (sessions: SessionSnapshot[]) => Promise<void>): void {
    this.onRefreshCallbacks.push(cb);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  getAll(): SessionSnapshot[] {
    const STATE_ORDER: Record<SessionSnapshot['state'], number> = {
      active: 0,
      idle: 1,
      completed: 2,
      stale: 3,
    };
    return Array.from(this.sessions.values())
      .filter((s) => s.state !== 'stale')
      .sort((a, b) => {
        const stateD = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        if (stateD !== 0) return stateD;
        return b.lastActivity.getTime() - a.lastActivity.getTime();
      });
  }

  getActive(): SessionSnapshot[] {
    return this.getAll().filter((s) => s.state === 'active' || s.state === 'idle');
  }

  /**
   * Find a session by partial ID, slug, or project name.
   */
  getSession(query: string): SessionSnapshot | null {
    const q = query.toLowerCase();

    // Exact session ID match
    const exact = this.sessions.get(query);
    if (exact) return exact;

    // Partial match: slug, session ID prefix, project name
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
      activeCount: sessions.filter((s) => s.state === 'active').length,
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

  // ── HookAcceptingMonitor implementation ──────────────────────────

  /** Hook에서 activityPhase만 업데이트. 세션이 존재하지 않으면 무시. */
  updateActivityPhase(sessionId: string, phase: ActivityPhase): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activityPhase = session.state === 'active' ? phase : null;
  }

  /** Hook에서 state 업데이트 (SessionEnd → completed 등). */
  updateSessionState(sessionId: string, state: SessionSnapshot['state']): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = state;
    if (state !== 'active') {
      session.activityPhase = null;
    }
  }

  /** SessionStart hook에서 최소 정보로 skeleton snapshot 생성. 다음 polling에서 보강. */
  registerSession(event: SessionStartHookEvent): SessionSnapshot {
    const existing = this.sessions.get(event.session_id);
    if (existing) {
      existing.state = 'active';
      existing.activityPhase = 'busy';
      if (event.model) existing.model = event.model;
      return existing;
    }

    const projectPath = event.cwd || '';
    const projectName = projectPath.split('/').pop() || 'unknown';
    const snapshot: SessionSnapshot = {
      provider: event.provider ?? 'claude',
      sessionId: event.session_id,
      projectPath,
      projectName,
      slug: event.session_id.slice(0, 8),
      state: 'active',
      pid: null,
      cpuPercent: null,
      memMb: null,
      model: event.model ?? null,
      gitBranch: null,
      version: null,
      turnCount: 0,
      lastUserMessage: null,
      currentTools: [],
      tokens: { input: 0, output: 0, cached: 0 },
      waitReason: null,
      waitToolNames: [],
      startedAt: new Date(),
      lastActivity: new Date(),
      activityPhase: 'busy',
      jsonlPath: event.transcript_path || '',
    };

    this.sessions.set(event.session_id, snapshot);
    return snapshot;
  }

  private determineState(
    proc: ClaudeProcess | null,
    mtime: number,
    now: number,
  ): SessionSnapshot['state'] {
    if (proc) {
      return now - mtime < FIVE_MINUTES ? 'active' : 'idle';
    }
    return now - mtime < TWENTY_FOUR_HOURS ? 'completed' : 'stale';
  }

  private startProjectWatchers(): void {
    this.stopProjectWatchers();

    for (const baseDir of CLAUDE_HOMES) {
      const projectsDir = `${baseDir}/projects`;
      try {
        const watcher = watch(projectsDir, { recursive: true }, () => {
          this.scheduleDebouncedRefresh();
        });
        watcher.on('error', (error) => {
          console.error(`[ClaudeMonitor] project watch error (${projectsDir}):`, error);
        });
        this.watchers.push(watcher);
      } catch (error) {
        // projects 디렉토리가 아직 없으면 watch를 생략한다.
      }
    }
  }

  private stopProjectWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private scheduleDebouncedRefresh(): void {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }
    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = null;
      this.refresh().catch((error) => {
        console.error('[ClaudeMonitor] watch-triggered refresh error:', error);
      });
    }, this.watchDebounceMs);
  }
}
