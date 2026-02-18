/**
 * Integration test for the Claude JSONL -> SessionSnapshot pipeline.
 *
 * Uses REAL parser functions (tailJsonl, extractSessionInfo, determineActivityPhase)
 * with JSONL files written to temp directories.
 *
 * Uses dynamic await import() with absolute paths (via import.meta.dir) to bypass
 * Bun's global mock.module scope from claude-monitor.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { tailJsonl, extractSessionInfo } = await import(join(import.meta.dir, '../claude-parser.ts'));
const { determineActivityPhase } = await import(join(import.meta.dir, '../activity-phase.ts'));

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function writeClaudeSession(
  baseDir: string,
  projectKey: string,
  sessionId: string,
  entries: unknown[],
): Promise<string> {
  const dir = join(baseDir, 'projects', projectKey);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await Bun.write(path, body);
  return path;
}

const NOW_ISO = new Date().toISOString();

function systemEntry(sessionId: string, cwd: string) {
  return {
    type: 'system',
    sessionId,
    slug: cwd.split('/').pop() ?? sessionId.slice(0, 8),
    cwd,
    gitBranch: 'main',
    version: '2.1.44',
    timestamp: NOW_ISO,
  };
}

function userEntry(content: string) {
  return {
    type: 'user',
    timestamp: NOW_ISO,
    message: { role: 'user', content },
  };
}

function assistantEntry(opts: {
  model?: string;
  stop_reason?: string | null;
  content?: unknown[];
  usage?: Record<string, number>;
} = {}) {
  return {
    type: 'assistant',
    timestamp: NOW_ISO,
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-4-5-20250929',
      stop_reason: opts.stop_reason ?? 'end_turn',
      content: opts.content ?? [{ type: 'text', text: 'Done.' }],
      usage: opts.usage ?? { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 50 },
    },
  };
}

const COST_PER_INPUT_TOKEN = 15 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 75 / 1_000_000;
const COST_PER_CACHED_TOKEN = 1.5 / 1_000_000;

function estimateCost(tokens: { input: number; output: number; cached: number }): number {
  return (
    (tokens.input - tokens.cached) * COST_PER_INPUT_TOKEN +
    tokens.output * COST_PER_OUTPUT_TOKEN +
    tokens.cached * COST_PER_CACHED_TOKEN
  );
}

describe('Claude JSONL pipeline (integration)', () => {
  test('parses real JSONL: file -> tailJsonl -> extractSessionInfo', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'claude-int-'));
    tempDirs.push(baseDir);

    const projectKey = '-Users-test-work-my-project';
    const sessionId = 'int-session-001';

    const path = await writeClaudeSession(baseDir, projectKey, sessionId, [
      systemEntry(sessionId, '/Users/test/work/my-project'),
      userEntry('implement the feature'),
      assistantEntry({
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: 'I will implement it.' },
          { type: 'tool_use', id: 'tool_1', name: 'Edit', input: { file: 'test.ts' } },
        ],
        usage: { input_tokens: 5000, output_tokens: 1200, cache_read_input_tokens: 800 },
      }),
      {
        type: 'user',
        timestamp: NOW_ISO,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }],
        },
      },
      assistantEntry({
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done implementing.' }],
        usage: { input_tokens: 6000, output_tokens: 200, cache_read_input_tokens: 1000 },
      }),
    ]);

    const entries = await tailJsonl(path);
    expect(entries.length).toBe(5);

    const info = extractSessionInfo(entries);

    expect(info.sessionId).toBe(sessionId);
    expect(info.slug).toBe('my-project');
    expect(info.cwd).toBe('/Users/test/work/my-project');
    expect(info.gitBranch).toBe('main');
    expect(info.version).toBe('2.1.44');
    expect(info.model).toBe('claude-opus-4-6');

    expect(info.tokens.input).toBe(11000);
    expect(info.tokens.output).toBe(1400);
    expect(info.tokens.cached).toBe(1800);

    expect(info.turnCount).toBe(2);
    expect(info.lastUserMessage).toBe('implement the feature');
    expect(info.waitReason).toBeNull();
    expect(info.waitToolNames).toEqual([]);

    const projectPath = info.cwd;
    const projectName = projectPath.split('/').pop() || projectKey;
    expect(projectName).toBe('my-project');

    const cost = estimateCost(info.tokens);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.2457, 3);
  });

  test('pending tool_use -> waiting_permission phase', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'claude-int-'));
    tempDirs.push(baseDir);

    const path = await writeClaudeSession(baseDir, '-Users-test-work-active', 'active-002', [
      systemEntry('active-002', '/Users/test/work/active'),
      userEntry('run the tests'),
      assistantEntry({
        stop_reason: null,
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'bun test' } },
        ],
      }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.waitReason).toBe('permission');
    expect(info.waitToolNames).toEqual(['Bash']);
    expect(info.currentTools).toEqual(['Bash']);

    const phase = determineActivityPhase(info);
    expect(phase).toBe('waiting_permission');
  });

  test('token usage report with real parsed data', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'claude-int-'));
    tempDirs.push(baseDir);

    const path = await writeClaudeSession(baseDir, '-Users-test-token', 'token-003', [
      systemEntry('token-003', '/Users/test/token'),
      userEntry('what is the cost?'),
      assistantEntry({
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 3000 },
      }),
    ]);

    const entries = await tailJsonl(path);
    const info = extractSessionInfo(entries);

    expect(info.tokens.input).toBe(10000);
    expect(info.tokens.output).toBe(2000);
    expect(info.tokens.cached).toBe(3000);

    const report = {
      sessionId: info.sessionId,
      projectName: info.cwd.split('/').pop() || '',
      slug: info.slug,
      model: info.model,
      tokens: { ...info.tokens },
      estimatedCostUsd: estimateCost(info.tokens),
    };

    expect(report.projectName).toBe('token');
    expect(report.model).toBe('claude-opus-4-6');
    expect(report.estimatedCostUsd).toBeCloseTo(0.2595, 3);
  });

  test('multi-turn with tool resolution and AskUserQuestion', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'claude-int-'));
    tempDirs.push(baseDir);

    const path = await writeClaudeSession(baseDir, '-Users-test-project', 'multi-004', [
      systemEntry('multi-004', '/Users/test/project'),
      userEntry('add authentication'),
      assistantEntry({
        model: 'claude-opus-4-6',
        stop_reason: null,
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'AskUserQuestion', input: { question: 'OAuth or JWT?' } },
        ],
        usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 500 },
      }),
      {
        type: 'user',
        timestamp: NOW_ISO,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'Use JWT' }],
        },
      },
      assistantEntry({
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: 'JWT auth implemented.' },
          { type: 'tool_use', id: 'tool_2', name: 'Read', input: { file_path: '/tmp/auth.ts' } },
        ],
        usage: { input_tokens: 4000, output_tokens: 800, cache_read_input_tokens: 1000 },
      }),
      {
        type: 'user',
        timestamp: NOW_ISO,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_2', content: 'file contents' }],
        },
      },
      assistantEntry({
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'All done.' }],
        usage: { input_tokens: 5000, output_tokens: 100, cache_read_input_tokens: 2000 },
      }),
    ]);

    const entries = await tailJsonl(path);
    expect(entries.length).toBe(7);

    const info = extractSessionInfo(entries);

    expect(info.tokens.input).toBe(11000);
    expect(info.tokens.output).toBe(1200);
    expect(info.tokens.cached).toBe(3500);
    expect(info.turnCount).toBe(3);
    expect(info.waitReason).toBeNull();
    expect(info.waitToolNames).toEqual([]);

    const phase = determineActivityPhase(info);
    expect(phase).toBe('interactable');
    expect(info.lastUserMessage).toBe('add authentication');
  });
});
