/**
 * Codex Provider - OpenAI Codex SDK wrapper
 *
 * 기존 Codex Thread 기반 로직을 AgentSession으로 래핑.
 * streaming.ts의 이벤트 변환 로직을 흡수.
 */

import { Codex } from '@openai/codex-sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Thread, ThreadEvent, ThreadItem, McpToolCallItem, WebSearchItem } from '@openai/codex-sdk';
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  SessionOptions,
  SessionStatus,
  ProviderCapabilities,
  ProviderId,
} from '../types.ts';

function normalizeLegacyCodexConfig(): void {
  const home = process.env.HOME;
  if (!home) return;

  const configPath = join(home, '.codex', 'config.toml');
  if (!existsSync(configPath)) return;

  let content: string;
  try {
    content = readFileSync(configPath, 'utf8');
  } catch {
    return;
  }

  if (!content.includes('model_reasoning_effort = "xhigh"')) return;
  const patchEnabled = process.env.PRAY_BOT_ENABLE_CODEX_CONFIG_FIX === '1';
  if (!patchEnabled) {
    console.warn(
      '[CodexProvider] ~/.codex/config.toml has model_reasoning_effort="xhigh". ' +
      'Auto-rewrite is disabled by default. Set PRAY_BOT_ENABLE_CODEX_CONFIG_FIX=1 to apply auto-fix.',
    );
    return;
  }

  const patched = content.replace(
    /model_reasoning_effort\s*=\s*"xhigh"/g,
    'model_reasoning_effort = "high"',
  );

  try {
    writeFileSync(configPath, patched, 'utf8');
    console.warn(
      '[CodexProvider] ~/.codex/config.toml model_reasoning_effort를 xhigh -> high로 보정했습니다.',
    );
  } catch (err) {
    console.warn(
      '[CodexProvider] Failed to patch ~/.codex/config.toml:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export class CodexProvider implements AgentProvider {
  readonly id: ProviderId = 'codex';
  readonly name = 'OpenAI Codex';
  private codex: Codex | null = null;

  async initialize(): Promise<void> {
    normalizeLegacyCodexConfig();
    this.codex = new Codex();
  }

  isAvailable(): boolean {
    return !!process.env.CODEX_API_KEY || !!process.env.OPENAI_API_KEY;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      multiTurn: true,
      toolUse: true,
      systemPrompt: true,
      sessionResume: true,
      subagents: false,
      mcp: true,
      interrupt: false,
      sandbox: true,
      budgetControl: false,
      structuredOutput: true,
    };
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    if (!this.codex) throw new Error('CodexProvider not initialized');
    const thread = this.codex.startThread({
      workingDirectory: options.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      ...(options.systemPrompt && { instructions: options.systemPrompt }),
    });
    return new CodexSession(thread);
  }
}

const INPUT_TOKEN_LIMIT = 228792;
const CACHED_INPUT_TOKEN_LIMIT = 202752;
const OUTPUT_TOKEN_LIMIT = 2464;
const formatter = new Intl.NumberFormat('en-US');

const formatPercent = (used: number, limit: number): string => {
  if (limit <= 0) return '0%';
  const percent = Math.max(0, Number.isFinite(used / limit) ? (used / limit) * 100 : 0);
  return `${percent.toFixed(1)}%`;
};

export class CodexSession implements AgentSession {
  readonly id = crypto.randomUUID();
  readonly providerId: ProviderId = 'codex';
  private status: SessionStatus = {
    state: 'idle',
    turnCount: 0,
    totalTokens: { input: 0, output: 0, cached: 0 },
    lastActivity: null,
  };

  constructor(private thread: Thread) {}

  async *send(message: string): AsyncIterable<AgentEvent> {
    this.status.state = 'processing';
    this.status.lastActivity = new Date();

    try {
      const { events } = await this.thread.runStreamed(message);
      for await (const event of events) {
        yield* this.convertEvent(event);
      }
    } finally {
      this.status.state = 'idle';
      this.status.turnCount++;
    }
  }

  async interrupt(): Promise<void> {
    // Codex SDK doesn't support interrupt - noop
  }

  getStatus(): SessionStatus {
    return { ...this.status };
  }

  async close(): Promise<void> {
    this.status.state = 'closed';
  }

  /** 토큰 사용량 포맷 문자열 */
  formatUsage(): string {
    const t = this.status.totalTokens;
    return [
      `입력 ${formatPercent(t.input, INPUT_TOKEN_LIMIT)} (${formatter.format(t.input)}/${formatter.format(INPUT_TOKEN_LIMIT)})`,
      `캐시 ${formatPercent(t.cached, CACHED_INPUT_TOKEN_LIMIT)} (${formatter.format(t.cached)}/${formatter.format(CACHED_INPUT_TOKEN_LIMIT)})`,
      `출력 ${formatPercent(t.output, OUTPUT_TOKEN_LIMIT)} (${formatter.format(t.output)}/${formatter.format(OUTPUT_TOKEN_LIMIT)})`,
    ].join(', ');
  }

  private *convertEvent(event: ThreadEvent): Iterable<AgentEvent> {
    switch (event.type) {
      case 'item.completed':
        yield* this.convertItemCompleted(event.item);
        break;
      case 'item.updated':
      case 'item.started':
        yield* this.convertItemUpdated(event.item);
        break;
      case 'turn.completed': {
        const usage = (event as any).usage;
        const tokens = {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
        };
        this.status.totalTokens.input += tokens.inputTokens;
        this.status.totalTokens.output += tokens.outputTokens;
        this.status.totalTokens.cached += tokens.cachedTokens;
        yield {
          type: 'turn_complete',
          usage: tokens,
          costUsd: null,
          turnIndex: this.status.turnCount,
        };
        break;
      }
      case 'turn.failed':
        yield {
          type: 'error',
          message: (event as any).error?.message ?? 'Turn failed',
          recoverable: false,
        };
        break;
    }
  }

  private *convertItemCompleted(item: ThreadItem): Iterable<AgentEvent> {
    switch (item.type) {
      case 'agent_message':
        if (item.text?.trim()) {
          yield { type: 'text', text: item.text, partial: false };
        }
        break;
      case 'reasoning':
        yield { type: 'reasoning', text: item.text ?? '' };
        break;
      case 'command_execution': {
        const exitCode = (item as any).exit_code;
        yield {
          type: 'command',
          command: `${item.command} ${item.status}`,
          status: exitCode === 0 ? 'completed' : 'failed',
          exitCode: exitCode ?? undefined,
        };
        const cmdChanges = (item as any).file_changes ?? (item as any).changes;
        if (cmdChanges) {
          for (const change of cmdChanges) {
            yield {
              type: 'file_change',
              kind: (change.kind ?? change.type) as any,
              path: change.path ?? change.file,
            };
          }
        }
        break;
      }
      case 'file_change':
        if ((item as any).changes) {
          for (const change of (item as any).changes) {
            yield {
              type: 'file_change',
              kind: (change.kind ?? change.type) as any,
              path: change.path ?? change.file,
            };
          }
        }
        break;
      case 'mcp_tool_call': {
        const mcp = item as McpToolCallItem;
        yield {
          type: 'tool_call',
          toolName: `mcp__${mcp.server}__${mcp.tool}`,
          toolInput: {},
          toolCallId: `mcp-${mcp.server}-${mcp.tool}`,
        };
        if (mcp.status === 'failed') {
          yield {
            type: 'error',
            message: `MCP tool failed: ${mcp.server}/${mcp.tool}`,
            recoverable: true,
          };
        }
        break;
      }
      case 'web_search': {
        const ws = item as WebSearchItem;
        yield {
          type: 'tool_call',
          toolName: 'web_search',
          toolInput: { query: (ws as any).query ?? '' },
          toolCallId: `ws-${Date.now()}`,
        };
        break;
      }
    }
  }

  private *convertItemUpdated(item: ThreadItem): Iterable<AgentEvent> {
    if (item.type === 'todo_list' && item.items) {
      yield {
        type: 'todo',
        items: item.items.map((t: any) => ({
          content: t.text ?? t.content ?? '',
          status: t.completed ? 'completed' as const : t.in_progress ? 'in_progress' as const : 'pending' as const,
        })),
      };
    }
  }
}
