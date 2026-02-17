/**
 * Pi-AI Provider - Codex SDK wrapper for Pi-AI endpoint
 *
 * Pi-AI는 OpenAI Codex OAuth 방식으로 동작하므로,
 * 별도 Codex SDK 인스턴스를 Pi-AI 전용 설정으로 초기화.
 */

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  SessionOptions,
  SessionStatus,
  ProviderCapabilities,
  ProviderId,
} from '../types.ts';

export class PiAiProvider implements AgentProvider {
  readonly id: ProviderId = 'pi-ai';
  readonly name = 'Pi-AI';
  private codex: Codex | null = null;

  async initialize(): Promise<void> {
    this.codex = new Codex({
      apiKey: process.env.PIAI_API_KEY,
      ...(process.env.PIAI_BASE_URL && { baseURL: process.env.PIAI_BASE_URL }),
    });
  }

  isAvailable(): boolean {
    return !!process.env.PIAI_API_KEY;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      multiTurn: true,
      toolUse: false,
      systemPrompt: true,
      sessionResume: false,
      subagents: false,
      mcp: false,
      interrupt: false,
      sandbox: false,
      budgetControl: false,
      structuredOutput: false,
    };
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    if (!this.codex) throw new Error('PiAiProvider not initialized');
    const thread = this.codex.startThread({
      ...(options.workingDirectory && { workingDirectory: options.workingDirectory }),
      skipGitRepoCheck: true,
      ...(options.systemPrompt && { instructions: options.systemPrompt }),
      ...(options.model ?? process.env.PIAI_MODEL
        ? { model: options.model ?? process.env.PIAI_MODEL }
        : {}),
    });
    return new PiAiSession(thread);
  }
}

export class PiAiSession implements AgentSession {
  readonly id = crypto.randomUUID();
  readonly providerId: ProviderId = 'pi-ai';
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
    return { ...this.status, totalTokens: { ...this.status.totalTokens } };
  }

  async close(): Promise<void> {
    this.status.state = 'closed';
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
    }
  }

  private *convertItemUpdated(item: ThreadItem): Iterable<AgentEvent> {
    if (item.type === 'todo_list' && item.items) {
      yield {
        type: 'todo',
        items: item.items.map((t: any) => ({
          content: t.text ?? t.content ?? '',
          status: t.completed ? 'completed' as const
            : t.in_progress ? 'in_progress' as const
            : 'pending' as const,
        })),
      };
    }
  }
}
