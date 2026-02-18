import type { SessionSnapshot, MonitorStatus, TokenUsageReport, TokenUsageSession } from './types.ts';

export { type SessionSnapshot, type MonitorStatus, type TokenUsageReport, type TokenUsageSession } from './types.ts';
export { type ActivityPhase, type ClaudeProcess } from './types.ts';
export {
  formatSessionsText,
  formatSessionsEmbed,
  formatSessionDetailText,
  formatSessionDetailEmbed,
} from './formatter.ts';
export { formatTokenUsageText, formatTokenUsageEmbed } from './token-usage.ts';
export { ClaudeSessionMonitor } from './claude-monitor.ts';
export {
  type HookEvent,
  type AnyHookEvent,
  type StopHookEvent,
  type UserPromptSubmitHookEvent,
  type SessionStartHookEvent,
  type SessionEndHookEvent,
  type NotificationHookEvent,
  type HookAcceptingMonitor,
  createHookRoute,
  extractLastAssistantResponse,
} from './hook-receiver.ts';
export { CodexSessionMonitor, type CodexSessionMonitorOptions } from './codex-monitor.ts';

/** 프로바이더가 구현해야 하는 최소 인터페이스 */
export interface SessionMonitorProvider {
  init(): Promise<void>;
  stop(): void;
  onRefresh(cb: (sessions: SessionSnapshot[]) => Promise<void>): void;
  getAll(): SessionSnapshot[];
  getActive(): SessionSnapshot[];
  getSession(query: string): SessionSnapshot | null;
  getStatus(): MonitorStatus;
  /** 프로바이더별 토큰 사용량 리포트 (자체 pricing 모델 적용) */
  getTokenUsageReport(): TokenUsageReport;
}

const STATE_ORDER: Record<SessionSnapshot['state'], number> = {
  active: 0, idle: 1, completed: 2, stale: 3,
};

export class SessionMonitor implements SessionMonitorProvider {
  private providers = new Map<string, SessionMonitorProvider>();
  /** provider별 최신 세션 캐시 */
  private sessionsByProvider = new Map<string, SessionSnapshot[]>();
  private onRefreshCallbacks: Array<(sessions: SessionSnapshot[]) => Promise<void>> = [];
  private lastRefresh = new Date();
  private emitRunning = false;
  private emitQueued = false;

  /** 프로바이더 등록 (init 전에 호출) */
  addProvider(name: string, provider: SessionMonitorProvider): void {
    this.providers.set(name, provider);
  }

  /** 모든 프로바이더 init + onRefresh 바인딩 */
  async init(): Promise<void> {
    for (const [name, provider] of this.providers) {
      provider.onRefresh(async (sessions) => {
        this.sessionsByProvider.set(name, sessions);
        await this.enqueueEmitMerged();
      });
      await provider.init();
    }
  }

  stop(): void {
    for (const provider of this.providers.values()) {
      provider.stop();
    }
  }

  onRefresh(cb: (sessions: SessionSnapshot[]) => Promise<void>): void {
    this.onRefreshCallbacks.push(cb);
  }

  /** 머지 로직: provider:sessionId 기준 dedup, state 우선 → lastActivity 최신 순 */
  private mergeSessions(): SessionSnapshot[] {
    const merged = new Map<string, SessionSnapshot>();
    for (const sessions of this.sessionsByProvider.values()) {
      for (const s of sessions) {
        const key = `${s.provider ?? 'claude'}:${s.sessionId}`;
        const existing = merged.get(key);
        if (!existing || s.lastActivity.getTime() > existing.lastActivity.getTime()) {
          merged.set(key, s);
        }
      }
    }
    return Array.from(merged.values())
      .filter((s) => s.state !== 'stale')
      .sort((a, b) => {
        const sd = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        if (sd !== 0) return sd;
        return b.lastActivity.getTime() - a.lastActivity.getTime();
      });
  }

  private async enqueueEmitMerged(): Promise<void> {
    if (this.emitRunning) {
      if (!this.emitQueued) {
        console.log('[SessionMonitor] merge requested while running; queueing one extra pass');
      }
      this.emitQueued = true;
      return;
    }

    this.emitRunning = true;
    try {
      do {
        this.emitQueued = false;
        await this.emitMergedOnce();
      } while (this.emitQueued);
    } finally {
      this.emitRunning = false;
    }
  }

  private async emitMergedOnce(): Promise<void> {
    this.lastRefresh = new Date();
    const sessions = this.mergeSessions();
    for (const cb of this.onRefreshCallbacks) {
      await cb(sessions).catch(console.error);
    }
  }

  getAll(): SessionSnapshot[] { return this.mergeSessions(); }
  getActive(): SessionSnapshot[] { return this.getAll().filter((s) => s.state === 'active' || s.state === 'idle'); }
  getSession(query: string): SessionSnapshot | null {
    const q = query.toLowerCase();
    for (const s of this.getAll()) {
      if (s.sessionId === query) return s;
      if (s.slug.toLowerCase().includes(q)) return s;
      if (s.sessionId.toLowerCase().startsWith(q)) return s;
      if (s.projectName.toLowerCase().includes(q)) return s;
    }
    return null;
  }
  getStatus(): MonitorStatus {
    const sessions = this.getAll();
    return { sessions, activeCount: sessions.filter((s) => s.state === 'active').length, totalCount: sessions.length, lastRefresh: this.lastRefresh };
  }

  /** 모든 프로바이더의 토큰 리포트를 머지 */
  getTokenUsageReport(): TokenUsageReport {
    const allSessions: TokenUsageSession[] = [];
    for (const provider of this.providers.values()) {
      const report = provider.getTokenUsageReport();
      allSessions.push(...report.sessions);
    }
    const totals = { input: 0, output: 0, cached: 0, estimatedCostUsd: 0 };
    for (const s of allSessions) {
      totals.input += s.tokens.input;
      totals.output += s.tokens.output;
      totals.cached += s.tokens.cached;
      totals.estimatedCostUsd += s.estimatedCostUsd;
    }
    return {
      timestamp: new Date(),
      sessions: allSessions.sort((a, b) => {
        const sd = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        return sd !== 0 ? sd : b.lastActivity.getTime() - a.lastActivity.getTime();
      }),
      totals,
      activeCount: allSessions.filter((s) => s.state === 'active').length,
      totalCount: allSessions.length,
    };
  }
}
