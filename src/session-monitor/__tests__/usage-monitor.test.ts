import { describe, expect, test } from 'bun:test';
import type { SessionSnapshot, MonitorStatus, TokenUsageReport } from '../types.ts';
import type { SessionMonitorProvider } from '../index.ts';
import { SessionMonitor } from '../index.ts';

function makeSnapshot(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    sessionId: 'test-session',
    projectPath: '/tmp/project',
    projectName: 'project',
    slug: 'test',
    state: 'active',
    pid: null,
    cpuPercent: null,
    memMb: null,
    model: 'claude-sonnet-4',
    gitBranch: 'main',
    version: '1.0.0',
    turnCount: 1,
    lastUserMessage: null,
    currentTools: [],
    tokens: { input: 100, output: 50, cached: 10 },
    waitReason: null,
    waitToolNames: [],
    startedAt: new Date(),
    lastActivity: new Date(),
    activityPhase: null,
    jsonlPath: '/tmp/session.jsonl',
    ...overrides,
  };
}

class MockProvider implements SessionMonitorProvider {
  private sessions: SessionSnapshot[] = [];
  private refreshCb: ((sessions: SessionSnapshot[]) => Promise<void>) | null = null;

  constructor(private name: string) {}

  async init(): Promise<void> {}
  stop(): void {}

  onRefresh(cb: (sessions: SessionSnapshot[]) => Promise<void>): void {
    this.refreshCb = cb;
  }

  getAll(): SessionSnapshot[] { return this.sessions; }
  getActive(): SessionSnapshot[] { return this.sessions.filter((s) => s.state === 'active' || s.state === 'idle'); }
  getSession(query: string): SessionSnapshot | null {
    return this.sessions.find((s) => s.sessionId === query) ?? null;
  }
  getStatus(): MonitorStatus {
    return {
      sessions: this.sessions,
      activeCount: this.sessions.filter((s) => s.state === 'active').length,
      totalCount: this.sessions.length,
      lastRefresh: new Date(),
    };
  }
  getTokenUsageReport(): TokenUsageReport {
    return {
      timestamp: new Date(),
      sessions: this.sessions.map((s) => ({
        sessionId: s.sessionId,
        projectName: s.projectName,
        slug: s.slug,
        state: s.state,
        model: s.model,
        tokens: { ...s.tokens },
        estimatedCostUsd: 0.01,
        lastActivity: s.lastActivity,
        lastUserMessage: s.lastUserMessage,
        currentTools: s.currentTools,
      })),
      totals: { input: 0, output: 0, cached: 0, estimatedCostUsd: 0 },
      activeCount: this.sessions.filter((s) => s.state === 'active').length,
      totalCount: this.sessions.length,
    };
  }

  /** Simulate a refresh event */
  async emitRefresh(sessions: SessionSnapshot[]): Promise<void> {
    this.sessions = sessions;
    if (this.refreshCb) {
      await this.refreshCb(sessions);
    }
  }
}

describe('SessionMonitor', () => {
  test('merges sessions from two providers', async () => {
    const claude = new MockProvider('claude');
    const codex = new MockProvider('codex');

    const monitor = new SessionMonitor();
    monitor.addProvider('claude', claude);
    monitor.addProvider('codex', codex);
    await monitor.init();

    const now = new Date();
    await claude.emitRefresh([
      makeSnapshot({ provider: 'claude', sessionId: 'abc', state: 'active', lastActivity: now }),
    ]);
    await codex.emitRefresh([
      makeSnapshot({ provider: 'codex', sessionId: 'xyz', state: 'idle', lastActivity: now }),
    ]);

    const all = monitor.getAll();
    expect(all.length).toBe(2);
    // active comes before idle
    expect(all[0]?.provider).toBe('claude');
    expect(all[0]?.sessionId).toBe('abc');
    expect(all[1]?.provider).toBe('codex');
    expect(all[1]?.sessionId).toBe('xyz');
  });

  test('deduplicates by provider:sessionId keeping latest lastActivity', async () => {
    const claude = new MockProvider('claude');
    const codex = new MockProvider('codex');

    const monitor = new SessionMonitor();
    monitor.addProvider('claude', claude);
    monitor.addProvider('codex', codex);
    await monitor.init();

    const t1 = new Date(Date.now() - 10_000);
    const t2 = new Date();

    // Both report sessionId 's1' but with different providers
    await claude.emitRefresh([
      makeSnapshot({ provider: 'claude', sessionId: 's1', lastActivity: t1 }),
    ]);
    await codex.emitRefresh([
      makeSnapshot({ provider: 'codex', sessionId: 's1', lastActivity: t2 }),
    ]);

    const all = monitor.getAll();
    // provider:sessionId is different (claude:s1 vs codex:s1), so both should exist
    expect(all.length).toBe(2);
  });

  test('onRefresh callback receives merged sessions from all providers', async () => {
    const claude = new MockProvider('claude');
    const codex = new MockProvider('codex');

    const monitor = new SessionMonitor();
    monitor.addProvider('claude', claude);
    monitor.addProvider('codex', codex);
    await monitor.init();

    const received: SessionSnapshot[][] = [];
    monitor.onRefresh(async (sessions) => {
      received.push(sessions);
    });

    const now = new Date();
    // First: codex emits 1 session
    await codex.emitRefresh([
      makeSnapshot({ provider: 'codex', sessionId: 'codex-1', state: 'active', lastActivity: now }),
    ]);

    // Should have received merged (codex only so far)
    expect(received.length).toBe(1);
    expect(received[0]?.length).toBe(1);

    // Second: claude emits 1 session — callback gets both
    await claude.emitRefresh([
      makeSnapshot({ provider: 'claude', sessionId: 'claude-1', state: 'active', lastActivity: now }),
    ]);

    expect(received.length).toBe(2);
    expect(received[1]?.length).toBe(2);
  });

  test('serializes overlapping provider refresh events', async () => {
    const claude = new MockProvider('claude');
    const codex = new MockProvider('codex');

    const monitor = new SessionMonitor();
    monitor.addProvider('claude', claude);
    monitor.addProvider('codex', codex);
    await monitor.init();

    let callbackCalls = 0;
    let running = 0;
    let maxRunning = 0;
    monitor.onRefresh(async () => {
      callbackCalls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 40));
      running -= 1;
    });

    const now = new Date();
    await Promise.all([
      claude.emitRefresh([
        makeSnapshot({ provider: 'claude', sessionId: 'claude-overlap', state: 'active', lastActivity: now }),
      ]),
      codex.emitRefresh([
        makeSnapshot({ provider: 'codex', sessionId: 'codex-overlap', state: 'active', lastActivity: now }),
      ]),
    ]);

    // provider 2개의 refresh를 처리하되, 콜백 실행은 겹치지 않아야 한다.
    expect(callbackCalls).toBe(2);
    expect(maxRunning).toBe(1);
  });

  test('getTokenUsageReport merges reports from all providers', async () => {
    const claude = new MockProvider('claude');
    const codex = new MockProvider('codex');

    const monitor = new SessionMonitor();
    monitor.addProvider('claude', claude);
    monitor.addProvider('codex', codex);
    await monitor.init();

    const now = new Date();
    await claude.emitRefresh([
      makeSnapshot({ provider: 'claude', sessionId: 'c1', state: 'active', lastActivity: now }),
    ]);
    await codex.emitRefresh([
      makeSnapshot({ provider: 'codex', sessionId: 'x1', state: 'active', lastActivity: now }),
    ]);

    const report = monitor.getTokenUsageReport();
    expect(report.sessions.length).toBe(2);
    expect(report.totalCount).toBe(2);
  });

  test('filters out stale sessions from getAll', async () => {
    const claude = new MockProvider('claude');

    const monitor = new SessionMonitor();
    monitor.addProvider('claude', claude);
    await monitor.init();

    await claude.emitRefresh([
      makeSnapshot({ provider: 'claude', sessionId: 'active-1', state: 'active', lastActivity: new Date() }),
      makeSnapshot({ provider: 'claude', sessionId: 'stale-1', state: 'stale', lastActivity: new Date(Date.now() - 48 * 60 * 60 * 1000) }),
    ]);

    const all = monitor.getAll();
    expect(all.length).toBe(1);
    expect(all[0]?.sessionId).toBe('active-1');
  });
});
