import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSnapshot } from '../session-monitor/types.ts';
import { buildMonitorLogMessage } from './monitor-log.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function makeSnapshot(jsonlPath: string): SessionSnapshot {
  return {
    sessionId: 's-1',
    projectPath: '/tmp/project',
    projectName: 'project',
    slug: 'slug1',
    state: 'active',
    pid: null,
    cpuPercent: null,
    memMb: null,
    model: 'claude-sonnet-4',
    gitBranch: 'main',
    version: '1.0.0',
    turnCount: 2,
    lastUserMessage: 'latest user',
    currentTools: [],
    tokens: { input: 0, output: 0, cached: 0 },
    waitReason: null,
    waitToolNames: [],
    startedAt: new Date(),
    lastActivity: new Date(),
    activityPhase: null,
    jsonlPath,
  };
}

describe('buildMonitorLogMessage', () => {
  test('returns null when there is no text added since last watch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-log-test-'));
    tempDirs.push(dir);
    const jsonlPath = join(dir, 'session.jsonl');
    const base = Date.now() - 60_000;

    await writeFile(
      jsonlPath,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date(base).toISOString(),
        message: { content: 'old question' },
      })}\n`,
    );

    const msg = await buildMonitorLogMessage(makeSnapshot(jsonlPath), Date.now() - 10_000);
    expect(msg).toBeNull();
  });

  test('returns latest Q/A summary for new lines after watch time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'monitor-log-test-'));
    tempDirs.push(dir);
    const jsonlPath = join(dir, 'session.jsonl');
    const now = Date.now();
    const qTs = new Date(now - 1_000).toISOString();
    const aTs = new Date(now - 500).toISOString();

    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: qTs,
        message: { content: '배포 실패 원인 확인해줘' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: aTs,
        message: { content: [{ type: 'text', text: '원인은 DB connection timeout 입니다.' }] },
      }),
    ].join('\n');

    await writeFile(jsonlPath, `${lines}\n`);

    const msg = await buildMonitorLogMessage(makeSnapshot(jsonlPath), now - 5_000);
    expect(msg).not.toBeNull();
    expect(msg).toContain('auto-thread monitor (10m)');
    expect(msg).toContain('Q: 배포 실패 원인 확인해줘');
    expect(msg).toContain('A: 원인은 DB connection timeout 입니다.');
  });
});
