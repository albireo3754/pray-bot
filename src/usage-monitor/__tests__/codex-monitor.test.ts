import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodexUsageMonitor } from '../codex-monitor.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-'));
  tempRoots.push(root);
  return root;
}

function formatDateDir(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

async function writeCodexSessionFile(
  root: string,
  now: Date,
  sessionId: string,
  lines: unknown[],
  mtimeMs: number,
): Promise<string> {
  const dir = join(root, formatDateDir(now));
  const filePath = join(dir, `rollout-${sessionId}.jsonl`);
  await mkdir(dirname(filePath), { recursive: true });
  const body = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  await Bun.write(filePath, body);
  const mtime = new Date(mtimeMs);
  await utimes(filePath, mtime, mtime);
  return filePath;
}

describe('CodexUsageMonitor', () => {
  test('parses codex JSONL into snapshot fields', async () => {
    const root = await createTempRoot();
    const now = new Date();
    const nowIso = now.toISOString();
    const mtimeMs = now.getTime() - 1_000;
    const sessionId = '019c6b49-5103-7441-87e5-d1111f6650ec';

    await writeCodexSessionFile(
      root,
      now,
      sessionId,
      [
        {
          timestamp: nowIso,
          type: 'session_meta',
          payload: {
            id: sessionId,
            timestamp: nowIso,
            cwd: '/Users/pray/work/js/kw-chat',
            originator: 'Codex Desktop',
            source: 'vscode',
            cli_version: '0.100.0-alpha.10',
            git: { branch: 'main' },
          },
        },
        {
          timestamp: nowIso,
          type: 'turn_context',
          payload: {
            turn_id: 'turn-1',
            cwd: '/Users/pray/work/js/kw-chat',
            model: 'gpt-5.3-codex',
          },
        },
        {
          timestamp: nowIso,
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-1',
          },
        },
        {
          timestamp: nowIso,
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'auto-thread codex monitor test',
          },
        },
        {
          timestamp: nowIso,
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
        },
        {
          timestamp: nowIso,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 101,
                output_tokens: 22,
                cached_input_tokens: 33,
              },
            },
          },
        },
      ],
      mtimeMs,
    );

    const monitor = new CodexUsageMonitor({
      sessionsRoot: root,
      scanDays: 1,
      pollIntervalMs: 60_000,
    });
    await monitor.refresh();

    const session = monitor.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.provider).toBe('codex');
    expect(session?.state).toBe('active');
    expect(session?.projectPath).toBe('/Users/pray/work/js/kw-chat');
    expect(session?.projectName).toBe('kw-chat');
    expect(session?.model).toBe('gpt-5.3-codex');
    expect(session?.gitBranch).toBe('main');
    expect(session?.turnCount).toBe(1);
    expect(session?.lastUserMessage).toContain('auto-thread codex monitor test');
    expect(session?.currentTools).toContain('exec_command');
    expect(session?.tokens.input).toBe(101);
    expect(session?.tokens.output).toBe(22);
    expect(session?.tokens.cached).toBe(33);
    expect(session?.originator).toBe('Codex Desktop');
    expect(session?.source).toBe('vscode');
  });

  test('classifies idle/completed/stale by mtime', async () => {
    const root = await createTempRoot();
    const now = new Date();
    const nowIso = now.toISOString();

    const makeLines = (sessionId: string) => ([
      {
        timestamp: nowIso,
        type: 'session_meta',
        payload: {
          id: sessionId,
          timestamp: nowIso,
          cwd: '/Users/pray/work/js/kw-chat',
        },
      },
    ]);

    await writeCodexSessionFile(root, now, 'idle-session', makeLines('idle-session'), now.getTime() - 10 * 60_000);
    await writeCodexSessionFile(root, now, 'completed-session', makeLines('completed-session'), now.getTime() - 2 * 60 * 60_000);
    await writeCodexSessionFile(root, now, 'stale-session', makeLines('stale-session'), now.getTime() - 26 * 60 * 60_000);

    const monitor = new CodexUsageMonitor({
      sessionsRoot: root,
      scanDays: 1,
      pollIntervalMs: 60_000,
    });
    await monitor.refresh();

    expect(monitor.getSession('idle-session')?.state).toBe('idle');
    expect(monitor.getSession('completed-session')?.state).toBe('completed');
    expect(monitor.getSession('stale-session')?.state).toBe('stale');
    expect(monitor.getStatus().totalCount).toBe(2);
  });
});
