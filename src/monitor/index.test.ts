import { beforeEach, describe, expect, mock, test } from 'bun:test';

type MockProcess = {
  pid: number;
  sessionId: string | null;
  cwd: string;
  resumeId: string | null;
  cpuPercent: number;
  memMb: number;
};

type MockProject = {
  key: string;
  baseDir: string;
  path: string;
  jsonlFiles: { name: string; mtime: number }[];
};

type MockSessionInfo = {
  sessionId: string;
  slug: string;
  cwd: string;
  gitBranch: string | null;
  version: string | null;
  model: string | null;
  turnCount: number;
  lastUserMessage: string | null;
  currentTools: string[];
  tokens: { input: number; output: number; cached: number };
  startedAt: Date | null;
  lastActivity: Date;
  waitReason: 'user_question' | 'permission' | null;
  waitToolNames: string[];
};

let mockProcesses: MockProcess[] = [];
let mockProjects: MockProject[] = [];
let mockSessionInfoByPath = new Map<string, MockSessionInfo>();
let tailCallCount = 0;

const DEFAULT_INFO: MockSessionInfo = {
  sessionId: '',
  slug: '',
  cwd: '',
  gitBranch: null,
  version: null,
  model: null,
  turnCount: 0,
  lastUserMessage: null,
  currentTools: [],
  tokens: { input: 0, output: 0, cached: 0 },
  startedAt: null,
  lastActivity: new Date(),
  waitReason: null,
  waitToolNames: [],
};

mock.module('./discovery', () => ({
  CLAUDE_HOMES: ['/mock-home'],
  encodeProjectKey(path: string) {
    return path.replace(/\//g, '-');
  },
  async getClaudeProcesses() {
    return mockProcesses.map((p) => ({ ...p }));
  },
  async enrichProcesses(_processes: MockProcess[]) {
    // no-op in unit tests
  },
  async discoverProjects() {
    return mockProjects.map((p) => ({
      ...p,
      jsonlFiles: p.jsonlFiles.map((f) => ({ ...f })),
    }));
  },
}));

mock.module('./parser', () => ({
  async tailJsonl(path: string) {
    tailCallCount += 1;
    return [{ __path: path }];
  },
  extractSessionInfo(entries: Array<{ __path?: string }>) {
    const path = entries[0]?.__path ?? '';
    return mockSessionInfoByPath.get(path) ?? { ...DEFAULT_INFO };
  },
}));

const { ClaudeSessionMonitor } = await import('./index');

function buildPath(projectKey: string, fileName: string): string {
  return `/mock-home/projects/${projectKey}/${fileName}`;
}

beforeEach(() => {
  mockProcesses = [];
  mockProjects = [];
  mockSessionInfoByPath = new Map<string, MockSessionInfo>();
  tailCallCount = 0;
});

describe('ClaudeSessionMonitor.refresh', () => {
  test('builds active session snapshot from process + jsonl metadata', async () => {
    const now = Date.now();
    const projectKey = '-Users-user-work-js-my-project';
    const fileName = 'session-1.jsonl';
    const jsonlPath = buildPath(projectKey, fileName);

    mockProcesses = [
      {
        pid: 4321,
        sessionId: 'session-1',
        cwd: '/Users/user/work/js/my-project',
        resumeId: null,
        cpuPercent: 1.2,
        memMb: 256,
      },
    ];

    mockProjects = [
      {
        key: projectKey,
        baseDir: '/mock-home',
        path: projectKey,
        jsonlFiles: [{ name: fileName, mtime: now }],
      },
    ];

    mockSessionInfoByPath.set(jsonlPath, {
      sessionId: 'session-1',
      slug: 'myproject',
      cwd: '/Users/user/work/js/my-project',
      gitBranch: 'feature/monitor',
      version: '1.0.0',
      model: 'claude-opus-4',
      turnCount: 12,
      lastUserMessage: 'status?',
      currentTools: ['Read', 'Bash'],
      tokens: { input: 100, output: 200, cached: 30 },
      startedAt: new Date(now - 60_000),
      lastActivity: new Date(now - 5_000),
      waitReason: null,
      waitToolNames: [],
    });

    const monitor = new ClaudeSessionMonitor();
    await monitor.refresh();

    const status = monitor.getStatus();
    expect(status.totalCount).toBe(1);
    expect(status.activeCount).toBe(1);

    const session = monitor.getSession('myproject');
    expect(session).not.toBeNull();
    expect(session?.state).toBe('active');
    expect(session?.projectName).toBe('my-project');
    expect(session?.pid).toBe(4321);
    expect(session?.gitBranch).toBe('feature/monitor');
  });

  test('skips stale sessions older than 24h when no process exists', async () => {
    const oldMtime = Date.now() - 25 * 60 * 60 * 1000;
    const projectKey = '-Users-user-work-js-old-project';
    const fileName = 'stale-session.jsonl';

    mockProjects = [
      {
        key: projectKey,
        baseDir: '/mock-home',
        path: projectKey,
        jsonlFiles: [{ name: fileName, mtime: oldMtime }],
      },
    ];

    const monitor = new ClaudeSessionMonitor();
    await monitor.refresh();

    const status = monitor.getStatus();
    expect(status.totalCount).toBe(0);
    expect(status.activeCount).toBe(0);
  });

  test('does not re-parse unchanged jsonl file due to mtime cache', async () => {
    const now = Date.now();
    const projectKey = '-Users-user-work-js-cache-test';
    const fileName = 'session-cache.jsonl';
    const jsonlPath = buildPath(projectKey, fileName);

    mockProcesses = [
      {
        pid: 9001,
        sessionId: 'session-cache',
        cwd: '/Users/user/work/js/cache-test',
        resumeId: null,
        cpuPercent: 0.5,
        memMb: 128,
      },
    ];

    mockProjects = [
      {
        key: projectKey,
        baseDir: '/mock-home',
        path: projectKey,
        jsonlFiles: [{ name: fileName, mtime: now }],
      },
    ];

    mockSessionInfoByPath.set(jsonlPath, {
      sessionId: 'session-cache',
      slug: 'cache',
      cwd: '/Users/user/work/js/cache-test',
      gitBranch: 'main',
      version: '1.0.0',
      model: 'claude-sonnet-4',
      turnCount: 3,
      lastUserMessage: 'hello',
      currentTools: [],
      tokens: { input: 10, output: 20, cached: 0 },
      startedAt: new Date(now - 5_000),
      lastActivity: new Date(now - 1_000),
      waitReason: null,
      waitToolNames: [],
    });

    const monitor = new ClaudeSessionMonitor();
    await monitor.refresh();
    await monitor.refresh();

    expect(tailCallCount).toBe(1);
  });
});
