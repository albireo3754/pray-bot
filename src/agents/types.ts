/**
 * Unified Agent Abstraction Layer
 *
 * Provider-agnostic interfaces for LLM sessions.
 * Codex, Claude Code, Gemini CLI 등을 동일한 인터페이스로 사용.
 */

// -- Provider ID --

export type ProviderId = 'codex' | 'claude' | 'gemini';

// -- Agent Events (unified output) --

export type AgentEvent =
  | AgentTextEvent
  | AgentSessionEvent
  | AgentUxEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentFileChangeEvent
  | AgentCommandEvent
  | AgentTodoEvent
  | AgentReasoningEvent
  | AgentQuestionEvent
  | AgentTurnCompleteEvent
  | AgentErrorEvent;

export interface AgentTextEvent {
  type: 'text';
  text: string;
  partial: boolean;
}

export interface AgentSessionEvent {
  type: 'session';
  sessionId: string;
}

export interface AgentUxEvent {
  type: 'ux_event';
  key: string;
  label: string;
  severity: 'info' | 'warn' | 'error';
  immediate?: boolean;
}

export interface AgentToolCallEvent {
  type: 'tool_call';
  toolName: string;
  toolInput: Record<string, unknown>;
  toolCallId: string;
}

export interface AgentToolResultEvent {
  type: 'tool_result';
  toolCallId: string;
  result: string;
  isError: boolean;
}

export interface AgentFileChangeEvent {
  type: 'file_change';
  kind: 'create' | 'edit' | 'delete' | 'rename';
  path: string;
  diff?: string;
}

export interface AgentCommandEvent {
  type: 'command';
  command: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  output?: string;
}

export interface AgentTodoEvent {
  type: 'todo';
  items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
}

export interface AgentReasoningEvent {
  type: 'reasoning';
  text: string;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
}

export interface AgentQuestionEvent {
  type: 'question';
  sessionId: string;
  questions: AgentQuestion[];
}

export interface AgentTurnCompleteEvent {
  type: 'turn_complete';
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  costUsd: number | null;
  turnIndex: number;
}

export interface AgentErrorEvent {
  type: 'error';
  message: string;
  recoverable: boolean;
}

// -- Session --

export type SessionStatus = {
  state: 'idle' | 'processing' | 'closed';
  turnCount: number;
  totalTokens: { input: number; output: number; cached: number };
  lastActivity: Date | null;
};

export interface AgentSession {
  readonly id: string;
  readonly providerId: ProviderId;

  /** 메시지 전송 + 스트리밍 응답 */
  send(message: string): AsyncIterable<AgentEvent>;

  /** 실행 중단 (미지원 Provider는 noop) */
  interrupt(): Promise<void>;

  /** 세션 상태 */
  getStatus(): SessionStatus;

  /** 세션 종료 */
  close(): Promise<void>;
}

// -- Session Options --

export interface SessionOptions {
  workingDirectory?: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  provider?: ProviderId;
}

// -- Provider --

export interface ProviderCapabilities {
  streaming: boolean;
  multiTurn: boolean;
  toolUse: boolean;
  systemPrompt: boolean;
  sessionResume: boolean;
  subagents: boolean;
  mcp: boolean;
  interrupt: boolean;
  sandbox: boolean;
  budgetControl: boolean;
  structuredOutput: boolean;
}

export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;

  initialize(): Promise<void>;
  createSession(options: SessionOptions): Promise<AgentSession>;
  isAvailable(): boolean;
  capabilities(): ProviderCapabilities;
}
