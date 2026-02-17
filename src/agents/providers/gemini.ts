/**
 * Gemini CLI Provider - CLI process spawn wrapper
 *
 * `gemini -p` 헤드리스 모드를 AgentSession으로 래핑.
 * 멀티턴 미지원, 단발성 쿼리 전용 (배치 분석, 코드 리뷰 등).
 */

import type { Subprocess } from 'bun';
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  SessionOptions,
  SessionStatus,
  ProviderCapabilities,
  ProviderId,
} from '../types.ts';

export class GeminiProvider implements AgentProvider {
  readonly id: ProviderId = 'gemini';
  readonly name = 'Gemini CLI';

  async initialize(): Promise<void> {
    const proc = Bun.spawn(['which', 'gemini'], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error('Gemini CLI not installed');
    }
  }

  isAvailable(): boolean {
    return !!process.env.GOOGLE_API_KEY || !!process.env.GOOGLE_CLOUD_PROJECT;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: false,
      multiTurn: false,
      toolUse: false,
      systemPrompt: false,
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
    return new GeminiSession(options);
  }
}

export class GeminiSession implements AgentSession {
  readonly id = crypto.randomUUID();
  readonly providerId: ProviderId = 'gemini';

  private proc: Subprocess | null = null;
  private status: SessionStatus = {
    state: 'idle',
    turnCount: 0,
    totalTokens: { input: 0, output: 0, cached: 0 },
    lastActivity: null,
  };

  constructor(private options: SessionOptions) {}

  async *send(message: string): AsyncIterable<AgentEvent> {
    this.status.state = 'processing';
    this.status.lastActivity = new Date();

    try {
      const cwd = this.options.workingDirectory ?? process.cwd();
      const args = ['-p', message, '--output-format', 'json'];

      if (this.options.model) args.push('-m', this.options.model);

      this.proc = Bun.spawn(['gemini', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const text = await new Response(this.proc.stdout as ReadableStream).text();
      const exitCode = await this.proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(this.proc.stderr as ReadableStream).text();
        yield {
          type: 'error',
          message: stderr || `Gemini exited with code ${exitCode}`,
          recoverable: false,
        };
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        // JSON 파싱 실패 시 raw text를 응답으로 사용
        yield { type: 'text', text, partial: false };
        yield {
          type: 'turn_complete',
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          costUsd: null,
          turnIndex: this.status.turnCount,
        };
        return;
      }

      // 응답 텍스트
      if (parsed.response) {
        yield { type: 'text', text: parsed.response, partial: false };
      }

      // 사용량 (JSON stats에서 추출)
      const modelKeys = Object.keys(parsed.stats?.models ?? {});
      const modelStats = modelKeys[0] != null ? parsed.stats?.models?.[modelKeys[0]] : undefined;
      const tokens = {
        inputTokens: modelStats?.tokens?.prompt ?? 0,
        outputTokens: modelStats?.tokens?.response ?? 0,
        cachedTokens: modelStats?.tokens?.cacheRead ?? 0,
      };
      this.status.totalTokens.input += tokens.inputTokens;
      this.status.totalTokens.output += tokens.outputTokens;
      this.status.totalTokens.cached += tokens.cachedTokens;

      // 파일 변경 (stats.files에서)
      const files = parsed.stats?.files;
      if (files && (files.totalLinesAdded > 0 || files.totalLinesRemoved > 0)) {
        yield {
          type: 'file_change',
          kind: 'edit',
          path: `(${files.totalLinesAdded}+ / ${files.totalLinesRemoved}-)`,
        };
      }

      yield {
        type: 'turn_complete',
        usage: tokens,
        costUsd: null,
        turnIndex: this.status.turnCount,
      };
    } finally {
      this.proc = null;
      this.status.state = 'idle';
      this.status.turnCount++;
    }
  }

  async interrupt(): Promise<void> {
    this.proc?.kill();
  }

  getStatus(): SessionStatus {
    return { ...this.status };
  }

  async close(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.status.state = 'closed';
  }
}
