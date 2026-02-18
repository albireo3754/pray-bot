/**
 * Claude Code Provider - CLI JSON wrapper
 *
 * `claude -p --output-format stream-json --verbose`를 사용해 headless 실행.
 * 결과의 permission_denials(AskUserQuestion)을 AgentEvent(question)으로 변환한다.
 */

import type { Subprocess } from 'bun';
import type {
  AgentProvider,
  AgentSession,
  AgentEvent,
  AgentQuestion,
  SessionOptions,
  SessionStatus,
  ProviderCapabilities,
  ProviderId,
} from '../types.ts';
import {
  computeClaudeAssistantDelta,
  computeClaudeFinalRemainder,
  extractClaudeToolUsesFromLine,
  extractClaudeUxEventsFromLine,
} from '../../stream/claude-parser.ts';

type ClaudeJson = Record<string, unknown>;

const OUTPUT_FORMAT = process.env.OUTPUT_FORMAT ?? 'stream-json';

type ClaudeResultEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  permission_denials?: Array<{
    tool_name?: string;
    tool_input?: {
      questions?: unknown;
    };
  }>;
  errors?: string[];
};

class ConcurrencyGate {
  private activeCount = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async acquire(): Promise<() => void> {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const claudeGate = new ConcurrencyGate(
  parsePositiveInt(process.env.CLAUDE_MAX_CONCURRENT, 3),
);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseQuestions(result: ClaudeResultEvent): AgentQuestion[] {
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials
    : [];
  const parsed: AgentQuestion[] = [];

  for (const denial of denials) {
    if (denial.tool_name !== 'AskUserQuestion') continue;
    const questions = Array.isArray(denial.tool_input?.questions)
      ? denial.tool_input?.questions
      : [];
    for (const q of questions) {
      const qRecord = asRecord(q);
      if (!qRecord) continue;

      const optionsRaw = Array.isArray(qRecord.options) ? qRecord.options : [];
      const options = optionsRaw
        .map((opt) => {
          const o = asRecord(opt);
          if (!o) return null;
          const label = asString(o.label).trim();
          if (!label) return null;
          const description = asString(o.description).trim();
          return description ? { label, description } : { label };
        })
        .filter((opt): opt is NonNullable<typeof opt> => !!opt);

      const question = asString(qRecord.question).trim();
      const header = asString(qRecord.header).trim() || '질문';
      if (!question || options.length === 0) continue;

      parsed.push({
        question,
        header,
        options,
        multiSelect: asBoolean(qRecord.multiSelect, false),
      });
    }
  }

  return parsed;
}

function parseClaudeJsonOutput(stdout: string): ClaudeJson[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((e) => !!asRecord(e)) as ClaudeJson[];
    }
    const obj = asRecord(parsed);
    if (!obj) return [];
    if (Array.isArray(obj.events)) {
      return obj.events.filter((e) => !!asRecord(e)) as ClaudeJson[];
    }
    return [obj];
  } catch {
    const events: ClaudeJson[] = [];
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (asRecord(entry)) events.push(entry as ClaudeJson);
          }
          continue;
        }
        const obj = asRecord(parsed);
        if (!obj) continue;
        if (Array.isArray(obj.events)) {
          for (const entry of obj.events) {
            if (asRecord(entry)) events.push(entry as ClaudeJson);
          }
          continue;
        }
        events.push(obj);
      } catch {
        // ignore non-JSON line
      }
    }
    return events;
  }
}

function parseStreamJsonLines(stdout: string): ClaudeJson[] {
  const events: ClaudeJson[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as ClaudeJson);
      }
    } catch {
      if (trimmed.startsWith('{')) {
        console.warn('[claude-provider] unparseable JSONL line:', trimmed.slice(0, 100));
      }
    }
  }
  return events;
}

function extractSessionIdFromEvent(event: Record<string, unknown>): string {
  const direct = event.session_id ?? event.sessionId ?? event.thread_id;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const nested = event.session;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return '';
}

function parseSessionIdFromJsonLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    return extractSessionIdFromEvent(parsed as Record<string, unknown>);
  } catch {
    return '';
  }
}

async function *readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}

function looksLikeJsonPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
  const lines = trimmed.split(/\r?\n/).slice(0, 5);
  return lines.some((line) => {
    const t = line.trim();
    return t.startsWith('{') || t.startsWith('[');
  });
}

function findResultEvent(events: ClaudeJson[]): ClaudeResultEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i] as ClaudeResultEvent;
    if (evt.type === 'result') return evt;
    if (!evt.type && typeof evt.result === 'string') return evt;
  }
  return null;
}

function extractAssistantTexts(events: ClaudeJson[]): string[] {
  const chunks: string[] = [];
  for (const evt of events) {
    if (evt.type !== 'assistant') continue;
    const message = asRecord(evt.message);
    const content = Array.isArray(message?.content) ? message?.content : [];
    for (const block of content) {
      const b = asRecord(block);
      if (!b || b.type !== 'text') continue;
      const text = asString(b.text).trim();
      if (text) chunks.push(text);
    }
  }
  return chunks;
}

export class ClaudeProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly name = 'Claude Code';

  async initialize(): Promise<void> {
    const proc = Bun.spawn(['which', 'claude'], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error('Claude Code CLI not installed');
    }
  }

  isAvailable(): boolean {
    return !!process.env.ANTHROPIC_API_KEY
      || !!process.env.CLAUDE_CODE_USE_BEDROCK
      || !!process.env.CLAUDE_CODE_USE_VERTEX;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: OUTPUT_FORMAT === 'stream-json',
      multiTurn: true,
      toolUse: true,
      systemPrompt: true,
      sessionResume: true,
      subagents: true,
      mcp: true,
      interrupt: true,
      sandbox: true,
      budgetControl: true,
      structuredOutput: true,
    };
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    return new ClaudeSession(options);
  }
}

export class ClaudeSession implements AgentSession {
  readonly id = crypto.randomUUID();
  readonly providerId: ProviderId = 'claude';

  private sessionId: string | null = null;
  private activeProc: Subprocess | null = null;
  private status: SessionStatus = {
    state: 'idle',
    turnCount: 0,
    totalTokens: { input: 0, output: 0, cached: 0 },
    lastActivity: null,
  };
  private totalCostUsd = 0;

  constructor(private options: SessionOptions) {}

  async *send(message: string): AsyncIterable<AgentEvent> {
    if (this.status.state === 'processing') {
      yield {
        type: 'error',
        message: 'Claude 세션이 이미 처리 중입니다. 잠시 후 다시 시도해주세요.',
        recoverable: true,
      };
      return;
    }

    this.status.state = 'processing';
    this.status.lastActivity = new Date();

    const release = await claudeGate.acquire();
    try {
      const cwd = this.options.workingDirectory ?? process.cwd();
      const args = this.buildArgs(message);
      this.activeProc = Bun.spawn(['claude', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          ...this.options.env,
        },
      });

      const stdoutStream = this.activeProc.stdout as ReadableStream<Uint8Array>;
      const stderrPromise = new Response(this.activeProc.stderr as ReadableStream).text();
      let stdout = '';
      let streamedText = '';
      let lastAssistantSnapshot = '';
      let latestSessionId = this.sessionId?.trim() ?? '';
      const seenToolUseKeys = new Set<string>();
      const seenUxEventKeys = new Set<string>();

      for await (const line of readLines(stdoutStream)) {
        stdout = stdout ? `${stdout}\n${line}` : line;

        const sid = parseSessionIdFromJsonLine(line);
        if (sid && sid !== latestSessionId) {
          latestSessionId = sid;
          this.sessionId = sid;
          yield {
            type: 'session',
            sessionId: sid,
          };
        }

        if (OUTPUT_FORMAT !== 'stream-json') continue;

        const toolUses = extractClaudeToolUsesFromLine(line);
        for (const toolUse of toolUses) {
          if (seenToolUseKeys.has(toolUse.key)) continue;
          seenToolUseKeys.add(toolUse.key);
          yield {
            type: 'tool_call',
            toolName: toolUse.label,
            toolInput: {},
            toolCallId: toolUse.key || `claude-tool-${Date.now()}`,
          };
        }

        const uxEvents = extractClaudeUxEventsFromLine(line);
        for (const uxEvent of uxEvents) {
          if (seenUxEventKeys.has(uxEvent.key)) continue;
          seenUxEventKeys.add(uxEvent.key);
          yield {
            type: 'ux_event',
            key: uxEvent.key,
            label: uxEvent.label,
            severity: uxEvent.severity,
            immediate: uxEvent.immediate,
          };
        }

        const { delta, nextSnapshot } = computeClaudeAssistantDelta(line, lastAssistantSnapshot);
        lastAssistantSnapshot = nextSnapshot;
        if (!delta) continue;
        streamedText = streamedText ? `${streamedText}\n\n${delta}` : delta;
        yield {
          type: 'text',
          text: delta,
          partial: true,
        };
      }

      const [stderr, exitCode] = await Promise.all([
        stderrPromise,
        this.activeProc.exited,
      ]);

      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim() || `Claude exited with code ${exitCode}`;
        yield { type: 'error', message: detail, recoverable: true };
        return;
      }

      const events = OUTPUT_FORMAT === 'stream-json'
        ? parseStreamJsonLines(stdout)
        : parseClaudeJsonOutput(stdout);
      if (events.length === 0) {
        const fallbackText = stdout.trim();
        if (fallbackText && !looksLikeJsonPayload(fallbackText)) {
          const remainder = computeClaudeFinalRemainder(streamedText, fallbackText);
          if (remainder) {
            yield { type: 'text', text: remainder, partial: false };
          }
          yield {
            type: 'turn_complete',
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            costUsd: null,
            turnIndex: this.status.turnCount,
          };
        } else if (streamedText) {
          yield {
            type: 'turn_complete',
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            costUsd: null,
            turnIndex: this.status.turnCount,
          };
        } else {
          yield {
            type: 'error',
            message: 'Claude JSON 응답 파싱에 실패했습니다.',
            recoverable: true,
          };
        }
        return;
      }

      for (const evt of events) {
        const sid = extractSessionIdFromEvent(evt);
        if (!sid || sid === latestSessionId) continue;
        latestSessionId = sid;
        this.sessionId = sid;
        yield {
          type: 'session',
          sessionId: sid,
        };
      }

      const result = findResultEvent(events);
      const assistantTexts = extractAssistantTexts(events);

      if (result?.session_id && result.session_id !== latestSessionId) {
        latestSessionId = result.session_id;
        this.sessionId = result.session_id;
        yield {
          type: 'session',
          sessionId: result.session_id,
        };
      }

      const primaryText = asString(result?.result).trim();
      const fallbackText = assistantTexts.join('\n\n').trim();
      const finalText = primaryText || fallbackText;
      if (finalText) {
        const remainder = computeClaudeFinalRemainder(streamedText, finalText);
        if (remainder) {
          yield { type: 'text', text: remainder, partial: false };
        }
      }

      const usage = {
        inputTokens: asNumber(result?.usage?.input_tokens),
        outputTokens: asNumber(result?.usage?.output_tokens),
        cachedTokens: asNumber(result?.usage?.cache_read_input_tokens),
      };
      this.status.totalTokens.input += usage.inputTokens;
      this.status.totalTokens.output += usage.outputTokens;
      this.status.totalTokens.cached += usage.cachedTokens;

      const turnCost = asNumber(result?.total_cost_usd);
      this.totalCostUsd += turnCost;

      const questions = result ? parseQuestions(result) : [];
      if (questions.length > 0) {
        yield {
          type: 'question',
          sessionId: this.sessionId ?? latestSessionId ?? '',
          questions,
        };
      }

      yield {
        type: 'turn_complete',
        usage,
        costUsd: turnCost > 0 ? turnCost : null,
        turnIndex: typeof result?.num_turns === 'number' ? result.num_turns : this.status.turnCount,
      };

      if (result && result.subtype && result.subtype !== 'success') {
        const errorText = Array.isArray(result.errors) && result.errors.length > 0
          ? result.errors.join('; ')
          : `Claude error: ${result.subtype}`;
        yield {
          type: 'error',
          message: errorText,
          recoverable: true,
        };
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      yield { type: 'error', message: messageText, recoverable: true };
    } finally {
      release();
      this.activeProc = null;
      this.status.state = 'idle';
      this.status.turnCount++;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeProc) return;
    this.activeProc.kill();
  }

  getStatus(): SessionStatus {
    return { ...this.status };
  }

  setResumeSessionId(sessionId: string | null | undefined): void {
    const normalized = sessionId?.trim();
    if (!normalized) return;
    this.sessionId = normalized;
  }

  /** 누적 비용 (USD) */
  getCostUsd(): number {
    return this.totalCostUsd;
  }

  /** 토큰 사용량 포맷 문자열 */
  formatUsage(): string {
    const t = this.status.totalTokens;
    const formatter = new Intl.NumberFormat('en-US');
    const parts = [
      `입력 ${formatter.format(t.input)}`,
      `출력 ${formatter.format(t.output)}`,
    ];
    if (t.cached > 0) parts.push(`캐시 ${formatter.format(t.cached)}`);
    if (this.totalCostUsd > 0) parts.push(`$${this.totalCostUsd.toFixed(4)}`);
    return parts.join(', ');
  }

  async close(): Promise<void> {
    if (this.activeProc) {
      this.activeProc.kill();
      this.activeProc = null;
    }
    this.status.state = 'closed';
  }

  // -- Private --

  private buildArgs(prompt: string): string[] {
    const args: string[] = [];
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    args.push('-p', prompt, '--output-format', OUTPUT_FORMAT, '--verbose', '--dangerously-skip-permissions');

    const model = this.options.model ?? process.env.CLAUDE_DEFAULT_MODEL;
    if (model) args.push('--model', model);
    if (this.options.maxTurns != null) args.push('--max-turns', String(this.options.maxTurns));
    if (this.options.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
    }
    if (this.options.systemPrompt) {
      args.push('--append-system-prompt', this.options.systemPrompt);
    }

    return args;
  }
}
