import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailJsonl, extractSessionInfo } from '../claude-parser.ts';
import { determineActivityPhase } from '../activity-phase.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function writeFixture(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-parser-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'session.jsonl');
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await Bun.write(path, body);
  return path;
}

const NOW = '2026-02-17T13:20:00.000Z';
const LATER = '2026-02-17T13:25:00.000Z';

function systemEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: 'system',
    sessionId: 'session-abc-123',
    slug: 'my-project',
    cwd: '/Users/test/work/my-project',
    gitBranch: 'feature/test',
    version: '2.1.44',
    timestamp: NOW,
    ...overrides,
  };
}

function userEntry(content: string, timestamp = LATER) {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content },
  };
}

function assistantEntry(overrides: {
  model?: string;
  stop_reason?: string | null;
  content?: unknown[];
  usage?: Record<string, number>;
  timestamp?: string;
} = {}) {
  return {
    type: 'assistant',
    timestamp: overrides.timestamp ?? LATER,
    message: {
      role: 'assistant',
      model: overrides.model ?? 'claude-opus-4-6',
      stop_reason: overrides.stop_reason ?? null,
      content: overrides.content ?? [{ type: 'text', text: 'Hello' }],
      usage: overrides.usage ?? {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
      },
    },
  };
}

describe('tailJsonl', () => {
  test('parses all valid lines from a JSONL file', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('hello'),
      assistantEntry(),
    ]);

    const entries = await tailJsonl(path);
    expect(entries.length).toBe(3);
    expect(entries[0]?.type).toBe('system');
    expect(entries[1]?.type).toBe('user');
    expect(entries[2]?.type).toBe('assistant');
  });

  test('returns empty array for empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-parser-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'empty.jsonl');
    await Bun.write(path, '');

    const entries = await tailJsonl(path);
    expect(entries.length).toBe(0);
  });

  test('skips malformed lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-parser-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'mixed.jsonl');
    await Bun.write(path, [
      JSON.stringify(systemEntry()),
      'this is not json',
      JSON.stringify(userEntry('test')),
      '',
    ].join('\n') + '\n');

    const entries = await tailJsonl(path);
    expect(entries.length).toBe(2);
  });
});

describe('extractSessionInfo', () => {
  test('extracts metadata from system + user + assistant entries', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('fix the bug'),
      assistantEntry({ model: 'claude-opus-4-6', usage: { input_tokens: 3000, output_tokens: 800, cache_read_input_tokens: 500 } }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.sessionId).toBe('session-abc-123');
    expect(info.slug).toBe('my-project');
    expect(info.cwd).toBe('/Users/test/work/my-project');
    expect(info.gitBranch).toBe('feature/test');
    expect(info.version).toBe('2.1.44');
    expect(info.model).toBe('claude-opus-4-6');
    expect(info.turnCount).toBe(1);
    expect(info.lastUserMessage).toBe('fix the bug');
    expect(info.tokens.input).toBe(3000);
    expect(info.tokens.output).toBe(800);
    expect(info.tokens.cached).toBe(500);
  });

  test('accumulates tokens across multiple assistant messages', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('first question'),
      assistantEntry({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 100 } }),
      userEntry('second question'),
      assistantEntry({ usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 150 } }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.turnCount).toBe(2);
    expect(info.tokens.input).toBe(3000);
    expect(info.tokens.output).toBe(500);
    expect(info.tokens.cached).toBe(250);
    expect(info.lastUserMessage).toBe('second question');
  });

  test('extracts tool_use names from latest assistant message', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('read this file'),
      assistantEntry({
        content: [
          { type: 'text', text: 'Let me read the file.' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/tmp/test.ts' } },
          { type: 'tool_use', id: 'tool_2', name: 'Grep', input: { pattern: 'foo' } },
        ],
      }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.currentTools).toEqual(['Read', 'Grep']);
  });

  test('detects permission wait when tool_use has no matching tool_result', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('run the tests'),
      assistantEntry({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'bun test' } },
        ],
      }),
      // No tool_result follows — tool is pending approval
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.waitReason).toBe('permission');
    expect(info.waitToolNames).toEqual(['Bash']);
  });

  test('detects user_question wait for AskUserQuestion tool', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('implement auth'),
      assistantEntry({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'AskUserQuestion', input: { question: 'OAuth or JWT?' } },
        ],
      }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.waitReason).toBe('user_question');
    expect(info.waitToolNames).toEqual(['AskUserQuestion']);
  });

  test('no wait when tool_result resolves all tool_uses', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('read file'),
      assistantEntry({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
        ],
      }),
      {
        type: 'user',
        timestamp: LATER,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'file contents here' },
          ],
        },
      },
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.waitReason).toBeNull();
    expect(info.waitToolNames).toEqual([]);
  });

  test('truncates long user messages to 100 chars', async () => {
    const longMessage = 'A'.repeat(200);
    const path = await writeFixture([
      systemEntry(),
      userEntry(longMessage),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.lastUserMessage?.length).toBeLessThanOrEqual(101); // 100 + '…'
    expect(info.lastUserMessage?.endsWith('…')).toBe(true);
  });
});

describe('determineActivityPhase (via parsed info)', () => {
  test('busy when assistant is streaming (no stop_reason)', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('hello'),
      assistantEntry({ stop_reason: null }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);
    const phase = determineActivityPhase(info);

    expect(phase).toBe('busy');
  });

  test('interactable when end_turn with no pending tools', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('hello'),
      assistantEntry({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done!' }],
      }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);
    const phase = determineActivityPhase(info);

    expect(phase).toBe('interactable');
  });

  test('waiting_permission when tool pending approval', async () => {
    const path = await writeFixture([
      systemEntry(),
      userEntry('deploy'),
      assistantEntry({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'git push' } },
        ],
      }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);
    const phase = determineActivityPhase(info);

    expect(phase).toBe('waiting_permission');
  });
});
