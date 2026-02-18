/**
 * 재현 시나리오:
 *
 * 1. Discord /claude 명령으로 thread + Claude 세션 시작
 *    → getOrCreateDiscordThreadForProvider가 discordThreadRoutes에 route 등록
 *    → route.providerSessionId = '' (아직 Claude가 session ID 미반환)
 * 2. Claude 프로세스 시작 직후 SessionStart hook 수신
 *    → onSessionStart 호출
 *    → isAlreadyMapped 체크: getThreadRoutes()에서 providerSessionId=''이므로 매칭 실패
 *    → auto-thread 중복 생성!
 * 3. Claude 응답 후 route.providerSessionId가 설정됨
 * 4. 사용자가 댓글(resume) → 새 SessionStart hook
 *    → 이번엔 providerSessionId가 설정되어 있으므로 isAlreadyMapped=true → 막힘 (정상)
 *
 * 핵심 버그: route.providerSessionId가 비어있는 시간 동안 SessionStart hook이 오면
 * auto-thread가 중복 생성된다.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { AutoThreadDiscovery } from '../index.ts';
import type { AutoThreadConfig } from '../types.ts';
import type { SessionMonitorProvider } from '../../session-monitor/index.ts';
import type { ChannelRegistry } from '../../discord/channel-registry.ts';
import type { DiscordClient } from '../../discord/client.ts';
import type { SessionSnapshot } from '../../session-monitor/types.ts';

// ── Helpers ───────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    provider: 'claude',
    sessionId: 'sess-aaa',
    projectPath: '/Users/pray/work/js/pray-bot',
    projectName: 'pray-bot',
    slug: 'sess-aaa',
    state: 'active',
    pid: 12345,
    cpuPercent: null,
    memMb: null,
    model: 'claude-sonnet-4-6',
    gitBranch: 'main',
    version: '2.1.45',
    turnCount: 0,
    lastUserMessage: null,
    currentTools: [],
    tokens: { input: 0, output: 0, cached: 0 },
    waitReason: null,
    waitToolNames: [],
    startedAt: new Date(),
    lastActivity: new Date(),
    activityPhase: 'busy',
    jsonlPath: '/tmp/test.jsonl',
    ...overrides,
  };
}

type DiscordThreadRoute = {
  threadId: string;
  parentChannelId: string;
  mappingKey: string;
  provider: 'codex' | 'codex-app-server' | 'claude';
  providerSessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  autoDiscovered?: boolean;
};

function makeConfig(overrides: Partial<AutoThreadConfig> = {}): AutoThreadConfig {
  const id = Math.random().toString(36).slice(2);
  return {
    enabled: true,
    targetStates: ['active', 'idle'],
    fallbackChannelId: 'ch-fallback',
    storePaths: [`/tmp/auto-threads-test-${id}.json`],
    monitorLogEnabled: false,
    monitorIntervalMs: 0,
    monitorStatePath: `/tmp/auto-thread-state-test-${id}.json`,
    excludedProjectPathPrefixes: [],
    sendInitialEmbed: false,
    archiveOnComplete: false,
    ...overrides,
  };
}

function makeMonitor(): SessionMonitorProvider {
  return {
    init: mock(async () => {}),
    stop: mock(() => {}),
    onRefresh: mock(() => {}),
    getAll: mock(() => []),
    getActive: mock(() => []),
    getSession: mock(() => null),
    getStatus: mock(() => ({ sessions: [], activeCount: 0, totalCount: 0, lastRefresh: new Date() })),
    getTokenUsageReport: mock(() => ({
      timestamp: new Date(),
      sessions: [],
      totals: { input: 0, output: 0, cached: 0, estimatedCostUsd: 0 },
      activeCount: 0,
      totalCount: 0,
    })),
  };
}

function makeChannelRegistry(channelId = 'ch-parent'): ChannelRegistry {
  return {
    listAll: mock(() => [{ key: 'pray-bot', path: '/Users/pray/work/js/pray-bot', channelId, category: 'js' }]),
    getByChannelId: mock(() => undefined),
    getByKey: mock(() => undefined),
  } as unknown as ChannelRegistry;
}

let createdThreadCount = 0;

function makeDiscordClient(): DiscordClient {
  return {
    createThread: mock(async (_parentChannelId: string, name: string) => {
      createdThreadCount++;
      return `thread-${createdThreadCount}`;
    }),
    sendMessage: mock(async () => {}),
    sendEmbed: mock(async () => {}),
    addAllowedChannel: mock(() => {}),
  } as unknown as DiscordClient;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('AutoThreadDiscovery - discord session then comment scenario', () => {
  let threadRoutes: Map<string, DiscordThreadRoute>;
  let discovery: AutoThreadDiscovery;
  let discordClient: DiscordClient;

  beforeEach(async () => {
    createdThreadCount = 0;
    threadRoutes = new Map();

    const config = makeConfig();
    const monitor = makeMonitor();
    const channelRegistry = makeChannelRegistry('ch-parent');
    discordClient = makeDiscordClient();

    discovery = new AutoThreadDiscovery(
      config,
      monitor,
      channelRegistry,
      discordClient,
      () => threadRoutes as any,
    );
    await discovery.init();
  });

  test('fix: SessionStart hook with providerSessionId="" is claimed by cwd → no auto-thread', async () => {
    const SESSION_ID = 'sess-aaa';
    const CWD = '/Users/pray/work/js/pray-bot';

    // Step 1: /claude 명령으로 discord thread 생성.
    // Claude stdout 파싱 전이므로 providerSessionId='' 상태.
    const discordRoute: DiscordThreadRoute = {
      threadId: 'discord-thread-001',
      parentChannelId: 'ch-parent',
      mappingKey: 'pray-bot',
      provider: 'claude',
      providerSessionId: '',   // ← stdout 파싱 전, 아직 빈 문자열
      cwd: CWD,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autoDiscovered: false,
    };
    threadRoutes.set('discord-thread-001', discordRoute);

    // Step 2: Claude 시작 직후 SessionStart hook 수신.
    // claimRouteBySessionId가 cwd 매칭으로 discordRoute.providerSessionId를 선점 등록.
    // → isAlreadyMapped = true → auto-thread 생성 안 함.
    const snapshot = makeSnapshot({ sessionId: SESSION_ID, projectPath: CWD });
    await discovery.onSessionStart(snapshot);

    expect(discordClient.createThread).toHaveBeenCalledTimes(0);
    // claimRouteBySessionId가 route에 session_id를 선점 등록했는지 확인
    expect(discordRoute.providerSessionId).toBe(SESSION_ID);

    // Step 3: 사용자 댓글 → resume → SessionStart hook 재수신.
    // 이미 providerSessionId가 설정되어 있으므로 여전히 막힌다.
    await discovery.onSessionStart(snapshot);
    expect(discordClient.createThread).toHaveBeenCalledTimes(0);
  });

  test('normal: onSessionStart creates thread when no discord route exists', async () => {
    // Discord route 없음 — 순수 terminal에서 실행
    const snapshot = makeSnapshot({ sessionId: 'sess-ccc' });
    await discovery.onSessionStart(snapshot);

    expect(discordClient.createThread).toHaveBeenCalledTimes(1);
  });

  test('normal: second onSessionStart for same sessionId does not create duplicate (discoveredMap guard)', async () => {
    const snapshot = makeSnapshot({ sessionId: 'sess-ddd' });

    await discovery.onSessionStart(snapshot);
    await discovery.onSessionStart(snapshot); // 두 번째 호출

    expect(discordClient.createThread).toHaveBeenCalledTimes(1);
  });

  test('race: concurrent onSessionStart and onMonitorRefresh both see empty providerSessionId', async () => {
    const SESSION_ID = 'sess-eee';

    // Discord route 등록 (providerSessionId 비어있음)
    threadRoutes.set('discord-thread-003', {
      threadId: 'discord-thread-003',
      parentChannelId: 'ch-parent',
      mappingKey: 'pray-bot',
      provider: 'claude',
      providerSessionId: '',
      cwd: '/Users/pray/work/js/pray-bot',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autoDiscovered: false,
    });

    const snapshot = makeSnapshot({ sessionId: SESSION_ID });

    // onSessionStart (hook)와 onMonitorRefresh가 거의 동시에 실행
    await Promise.all([
      discovery.onSessionStart(snapshot),
      discovery.onMonitorRefresh([snapshot]),
    ]);

    // pendingCreations guard가 작동하더라도 두 경로가 동시에 isAlreadyMapped=false를 볼 수 있음
    // 현재 버그: createThread가 2번 호출될 수 있음
    const callCount = (discordClient.createThread as ReturnType<typeof mock>).mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(1); // 최대 1개만 허용
  });

  test('resume: after comment on discord thread, SessionStart(resume) should not create auto-thread', async () => {
    const SESSION_ID = 'sess-fff';

    // Step 1: /claude 명령으로 thread 생성, 세션 실행, providerSessionId 설정 완료
    const discordRoute: DiscordThreadRoute = {
      threadId: 'discord-thread-004',
      parentChannelId: 'ch-parent',
      mappingKey: 'pray-bot',
      provider: 'claude',
      providerSessionId: SESSION_ID,  // ← 이미 설정됨
      cwd: '/Users/pray/work/js/pray-bot',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autoDiscovered: false,
    };
    threadRoutes.set('discord-thread-004', discordRoute);

    // Step 2: 댓글 달면 Claude가 resume으로 재시작 → SessionStart(source='resume') hook
    const snapshot = makeSnapshot({ sessionId: SESSION_ID });
    await discovery.onSessionStart(snapshot);

    // providerSessionId가 설정된 후엔 isAlreadyMapped가 막아야 함
    expect(discordClient.createThread).toHaveBeenCalledTimes(0);
  });
});
