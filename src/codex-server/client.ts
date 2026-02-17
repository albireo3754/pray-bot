import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentMessageDeltaNotification,
  CodexNotification,
  CodexServerRequest,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  ErrorNotification,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  ItemCompletedNotification,
  JsonRpcId,
  RunCodexAppServerTurnResult,
  ThreadResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnStartResponse,
} from './types.ts';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type JsonRpcSuccessResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

interface CodexAppServerClientOptions {
  cwd: string;
  command?: string;
  args?: string[];
  spawnFn?: SpawnFn;
  logger?: (message: string) => void;
  onNotification?: (notification: CodexNotification) => void | Promise<void>;
  onServerRequest?: (request: CodexServerRequest) => Promise<unknown>;
  onExit?: (error: Error | null) => void;
}

interface PendingRpcRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessWithoutNullStreams {
  return spawn(command, args, options);
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private readonly spawnFn: SpawnFn;
  private readonly logger: (message: string) => void;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private requestSeq = 1;
  private readonly pending = new Map<JsonRpcId, PendingRpcRequest>();
  private isStopping = false;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.logger = options.logger ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const command = this.options.command ?? 'codex';
    const args = this.options.args ?? ['app-server', '--listen', 'stdio://'];
    const proc = this.spawnFn(command, args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string | Buffer) => {
      this.consumeStdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string | Buffer) => {
      const line = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const trimmed = line.trim();
      if (trimmed) {
        this.logger(`[codex-app-server][stderr] ${trimmed}`);
      }
    });

    proc.on('error', (error) => {
      this.handleExit(error instanceof Error ? error : new Error(String(error)));
    });

    proc.on('exit', (code, signal) => {
      const expected = this.isStopping && (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL');
      if (expected) {
        this.handleExit(null);
        return;
      }
      const message = `codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.handleExit(new Error(message));
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.isStopping = true;

    try {
      if (!this.proc.stdin.destroyed) {
        this.proc.stdin.end();
      }
    } catch {
      // ignore
    }

    if (!this.proc.killed) {
      this.proc.kill('SIGTERM');
    }

    await new Promise<void>((resolve) => {
      if (!this.proc) {
        resolve();
        return;
      }
      this.proc.once('exit', () => resolve());
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill('SIGKILL');
        }
      }, 1_000);
    });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.proc) {
      await this.start();
    }
    if (!this.proc) {
      throw new Error('codex app-server process is not available');
    }

    const id = this.requestSeq++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.send(payload);
    return responsePromise;
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'pray-bot',
        title: 'pray-bot',
        version: '0.1.0',
      },
      capabilities: null,
    });
  }

  private send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    if (!this.proc || this.proc.stdin.destroyed) {
      throw new Error('codex app-server stdin is not writable');
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.logger(`[codex-app-server] ignored non-JSON line: ${line.slice(0, 160)}`);
        continue;
      }

      void this.handleIncoming(parsed);
    }
  }

  private async handleIncoming(message: unknown): Promise<void> {
    if (!isRecord(message)) return;

    const hasMethod = typeof message.method === 'string';
    const hasId = isJsonRpcId(message.id);

    if (hasMethod && hasId) {
      await this.handleServerRequest({
        method: message.method as string,
        id: message.id as JsonRpcId,
        params: message.params,
      });
      return;
    }

    if (hasMethod) {
      if (this.options.onNotification) {
        await this.options.onNotification({
          method: message.method as string,
          params: message.params,
        });
      }
      return;
    }

    if (!hasId) return;

    const pending = this.pending.get(message.id as JsonRpcId);
    if (!pending) return;
    this.pending.delete(message.id as JsonRpcId);

    if (isRecord(message.error)) {
      const error = message.error;
      const code = typeof error.code === 'number' ? error.code : -1;
      const msg = typeof error.message === 'string' ? error.message : 'Unknown JSON-RPC error';
      pending.reject(new Error(`${pending.method} failed (${code}): ${msg}`));
      return;
    }

    pending.resolve((message as JsonRpcSuccessResponse).result);
  }

  private async handleServerRequest(message: {
    method: string;
    id: JsonRpcId;
    params: unknown;
  }): Promise<void> {
    const request = {
      method: message.method,
      id: message.id,
      params: message.params,
    } as CodexServerRequest;

    if (!this.options.onServerRequest) {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unhandled server request: ${message.method}`,
        },
      });
      return;
    }

    try {
      const result = await this.options.onServerRequest(request);
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        result: result ?? {},
      });
    } catch (error) {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: stringifyError(error),
        },
      });
    }
  }

  private handleExit(error: Error | null): void {
    for (const pending of this.pending.values()) {
      pending.reject(error ?? new Error('codex app-server closed'));
    }
    this.pending.clear();

    this.proc = null;
    this.stdoutBuffer = '';
    this.isStopping = false;

    if (this.options.onExit) {
      this.options.onExit(error);
    }
  }
}

export interface RunCodexAppServerTurnOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  onSessionId?: (sessionId: string) => void | Promise<void>;
  command?: string;
  args?: string[];
  logger?: (message: string) => void;
  onCommandExecutionApproval?: (params: {
    requestId: JsonRpcId;
    request: CommandExecutionRequestApprovalParams;
  }) => Promise<CommandExecutionApprovalDecision>;
  onFileChangeApproval?: (params: {
    requestId: JsonRpcId;
    request: FileChangeRequestApprovalParams;
  }) => Promise<FileChangeApprovalDecision>;
  onToolRequestUserInput?: (params: {
    requestId: JsonRpcId;
    request: ToolRequestUserInputParams;
  }) => Promise<ToolRequestUserInputResponse>;
  onNotification?: (notification: CodexNotification) => void | Promise<void>;
  onUnhandledServerRequest?: (request: CodexServerRequest) => Promise<unknown>;
}

function buildDefaultUserInputResponse(params: ToolRequestUserInputParams): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse['answers'] = {};
  for (const question of params.questions) {
    const first = question.options?.[0]?.label;
    if (first) {
      answers[question.id] = { answers: [first] };
      continue;
    }
    answers[question.id] = { answers: [''] };
  }
  return { answers };
}

function parseAgentDelta(params: unknown): AgentMessageDeltaNotification | null {
  if (!isRecord(params)) return null;
  if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return null;
  if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string') return null;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    delta: params.delta,
  };
}

function parseItemCompleted(params: unknown): ItemCompletedNotification | null {
  if (!isRecord(params)) return null;
  if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string') return null;
  if (!isRecord(params.item) || typeof params.item.id !== 'string' || typeof params.item.type !== 'string') {
    return null;
  }
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    item: {
      id: params.item.id,
      type: params.item.type,
      text: typeof params.item.text === 'string' ? params.item.text : undefined,
      status: typeof params.item.status === 'string' ? params.item.status : undefined,
    },
  };
}

function parseTurnCompleted(params: unknown): TurnCompletedNotification | null {
  if (!isRecord(params)) return null;
  if (typeof params.threadId !== 'string') return null;
  if (!isRecord(params.turn) || typeof params.turn.id !== 'string' || typeof params.turn.status !== 'string') {
    return null;
  }
  const turnError = isRecord(params.turn.error) && typeof params.turn.error.message === 'string'
    ? {
        message: params.turn.error.message,
        additionalDetails:
          typeof params.turn.error.additionalDetails === 'string'
            ? params.turn.error.additionalDetails
            : null,
      }
    : null;
  return {
    threadId: params.threadId,
    turn: {
      id: params.turn.id,
      status: params.turn.status,
      error: turnError,
    },
  };
}

function parseErrorNotification(params: unknown): ErrorNotification | null {
  if (!isRecord(params)) return null;
  if (!isRecord(params.error) || typeof params.error.message !== 'string') return null;
  if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string') return null;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    willRetry: params.willRetry === true,
    error: {
      message: params.error.message,
      additionalDetails:
        typeof params.error.additionalDetails === 'string'
          ? params.error.additionalDetails
          : null,
    },
  };
}

function extractThreadId(result: unknown): string {
  if (!isRecord(result)) return '';
  const thread = result.thread;
  if (!isRecord(thread)) return '';
  return typeof thread.id === 'string' ? thread.id : '';
}

function extractTurnId(result: unknown): string {
  if (!isRecord(result)) return '';
  const turn = result.turn;
  if (!isRecord(turn)) return '';
  return typeof turn.id === 'string' ? turn.id : '';
}

function buildTextFromItems(
  completedTextChunks: string[],
  deltasByItem: Map<string, string>,
): string {
  const completed = completedTextChunks
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (completed.length > 0) {
    return completed.join('\n\n');
  }

  const deltaText = Array.from(deltasByItem.values())
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('');
  return deltaText.trim();
}

export async function runCodexAppServerTurn(
  options: RunCodexAppServerTurnOptions,
): Promise<RunCodexAppServerTurnResult> {
  const completedTextChunks: string[] = [];
  const deltasByItem = new Map<string, string>();

  let resolvedTurnId = '';
  let resolvedSessionId = options.sessionId ?? '';
  let turnCompleted = false;
  let turnError: Error | null = null;

  let resolveTurnWaiter: (() => void) | null = null;
  let rejectTurnWaiter: ((error: Error) => void) | null = null;

  const turnWaiter = new Promise<void>((resolve, reject) => {
    resolveTurnWaiter = resolve;
    rejectTurnWaiter = reject;
  });

  const client = new CodexAppServerClient({
    cwd: options.cwd,
    command: options.command,
    args: options.args,
    logger: options.logger,
    onExit: (error) => {
      if (turnCompleted) return;
      const exitError = error ?? new Error('codex app-server exited before turn completion');
      rejectTurnWaiter?.(exitError);
    },
    onNotification: async (notification) => {
      await options.onNotification?.(notification);

      if (notification.method === 'item/agentMessage/delta') {
        const parsed = parseAgentDelta(notification.params);
        if (!parsed) return;
        const prev = deltasByItem.get(parsed.itemId) ?? '';
        deltasByItem.set(parsed.itemId, `${prev}${parsed.delta}`);
        return;
      }

      if (notification.method === 'item/completed') {
        const parsed = parseItemCompleted(notification.params);
        if (!parsed) return;
        if (parsed.item.type === 'agentMessage' && parsed.item.text?.trim()) {
          completedTextChunks.push(parsed.item.text.trim());
        }
        return;
      }

      if (notification.method === 'turn/completed') {
        const parsed = parseTurnCompleted(notification.params);
        if (!parsed) return;
        resolvedTurnId = parsed.turn.id;
        turnCompleted = true;

        if (parsed.turn.status === 'failed') {
          const detail = parsed.turn.error?.additionalDetails;
          const message = detail
            ? `${parsed.turn.error?.message ?? 'turn failed'} (${detail})`
            : parsed.turn.error?.message ?? 'turn failed';
          turnError = new Error(message);
          rejectTurnWaiter?.(turnError);
          return;
        }

        resolveTurnWaiter?.();
        return;
      }

      if (notification.method === 'error') {
        const parsed = parseErrorNotification(notification.params);
        if (!parsed) return;
        if (!parsed.willRetry) {
          turnError = new Error(parsed.error.message);
        }
      }
    },
    onServerRequest: async (request) => {
      switch (request.method) {
        case 'item/commandExecution/requestApproval': {
          const params = request.params as CommandExecutionRequestApprovalParams;
          const decision = options.onCommandExecutionApproval
            ? await options.onCommandExecutionApproval({ requestId: request.id, request: params })
            : 'decline';
          return { decision };
        }
        case 'item/fileChange/requestApproval': {
          const params = request.params as FileChangeRequestApprovalParams;
          const decision = options.onFileChangeApproval
            ? await options.onFileChangeApproval({ requestId: request.id, request: params })
            : 'decline';
          return { decision };
        }
        case 'item/tool/requestUserInput': {
          const params = request.params as ToolRequestUserInputParams;
          if (options.onToolRequestUserInput) {
            return options.onToolRequestUserInput({ requestId: request.id, request: params });
          }
          return buildDefaultUserInputResponse(params);
        }
        default:
          if (options.onUnhandledServerRequest) {
            return options.onUnhandledServerRequest(request);
          }
          return {};
      }
    },
  });

  await client.start();

  try {
    await client.initialize();

    const threadResult = options.sessionId
      ? await client.request<ThreadResponse>('thread/resume', {
          threadId: options.sessionId,
          cwd: options.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
        })
      : await client.request<ThreadResponse>('thread/start', {
          cwd: options.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
        });

    const threadId = extractThreadId(threadResult);
    if (!threadId) {
      throw new Error('Failed to obtain app-server thread id');
    }
    resolvedSessionId = threadId;
    if (options.onSessionId) {
      await options.onSessionId(resolvedSessionId);
    }

    const turnStartResult = await client.request<TurnStartResponse>('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: options.prompt,
          text_elements: [],
        },
      ],
    });
    resolvedTurnId = extractTurnId(turnStartResult) || resolvedTurnId;

    await turnWaiter;
    if (turnError) {
      throw turnError;
    }

    const text = buildTextFromItems(completedTextChunks, deltasByItem);

    return {
      text,
      sessionId: resolvedSessionId,
      turnId: resolvedTurnId,
    };
  } finally {
    await client.stop().catch((error) => {
      const message = stringifyError(error);
      options.logger?.(`[codex-app-server] stop failed: ${message}`);
    });
  }
}
