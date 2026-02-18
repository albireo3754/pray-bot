import type { DiscordComponentData, DiscordQuestionPrompt } from '../discord/types.ts';
import type {
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  JsonRpcId,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from '../codex-server/types.ts';

const CUSTOM_PREFIX = 'codexapp';
const DEFAULT_MAX_PENDING = 1_000;

type PendingKind = 'commandExecution' | 'fileChange' | 'toolUserInput';

type SendableDiscordClient = {
  sendMessage(channelId: string, content: string): Promise<void>;
  sendQuestionPrompt(channelId: string, prompt: DiscordQuestionPrompt): Promise<void>;
};

interface PendingBase {
  pendingId: string;
  requestId: JsonRpcId;
  kind: PendingKind;
  threadId: string;
  turnId: string;
  itemId: string;
  channelId: string;
  threadChannelId: string;
  ownerUserId: string;
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  decision?: string;
}

interface PendingCommandApproval extends PendingBase {
  kind: 'commandExecution';
  resolve: (decision: CommandExecutionApprovalDecision) => void;
  reject: (error: Error) => void;
  command: string | null;
  cwd: string | null;
  reason: string | null;
}

interface PendingFileApproval extends PendingBase {
  kind: 'fileChange';
  resolve: (decision: FileChangeApprovalDecision) => void;
  reject: (error: Error) => void;
  reason: string | null;
  grantRoot: string | null;
}

interface PendingToolUserInput extends PendingBase {
  kind: 'toolUserInput';
  resolve: (response: ToolRequestUserInputResponse) => void;
  reject: (error: Error) => void;
  questions: ToolRequestUserInputParams['questions'];
  answers: Map<string, string[]>;
  responderUserId: string | null;
}

type PendingRequest = PendingCommandApproval | PendingFileApproval | PendingToolUserInput;

export interface CodexPendingRequestSummary {
  pendingId: string;
  requestId: JsonRpcId;
  kind: PendingKind;
  threadId: string;
  turnId: string;
  itemId: string;
  channelId: string;
  threadChannelId: string;
  ownerUserId: string;
  createdAt: number;
  ageMs: number;
  decision?: string;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface CodexPendingStatus {
  count: number;
  requests: CodexPendingRequestSummary[];
}

export interface ResolveCodexPendingParams {
  pendingId: string;
  decision?: string;
  actorUserId?: string;
}

export type ResolveCodexPendingResult =
  | {
      ok: true;
      pendingId: string;
      kind: PendingKind;
      decision: string;
      resolvedBy: string;
      resolvedAt: number;
    }
  | {
      ok: false;
      reason: 'not_found' | 'invalid_request' | 'invalid_decision';
      message: string;
    };

interface CodexApprovalUIOptions {
  discordClient: SendableDiscordClient;
  maxPending?: number;
}

interface ApprovalRequestContext {
  requestId: JsonRpcId;
  channelId: string;
  threadChannelId: string;
  ownerUserId: string;
}

function now(): number {
  return Date.now();
}

function makePendingId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function formatSessionDecisionToken(raw: string): CommandExecutionApprovalDecision | FileChangeApprovalDecision | null {
  switch (raw) {
    case 'accept':
    case 'acceptForSession':
    case 'decline':
    case 'cancel':
      return raw;
    default:
      return null;
  }
}

function formatQuestionLabel(questionId: string, index: number): string {
  const text = questionId.trim();
  if (text) return `${index + 1}. ${text}`;
  return `${index + 1}번 질문`;
}

export class CodexApprovalUI {
  private readonly client: SendableDiscordClient;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly maxPending: number;

  constructor(options: CodexApprovalUIOptions) {
    this.client = options.discordClient;
    this.maxPending = Math.max(10, options.maxPending ?? DEFAULT_MAX_PENDING);
  }

  async requestCommandApproval(
    ctx: ApprovalRequestContext & {
      request: CommandExecutionRequestApprovalParams;
    },
  ): Promise<CommandExecutionApprovalDecision> {
    this.pruneOverflow();

    const pendingId = makePendingId();
    const createdAt = now();

    return new Promise<CommandExecutionApprovalDecision>(async (resolve, reject) => {
      const pending: PendingCommandApproval = {
        pendingId,
        requestId: ctx.requestId,
        kind: 'commandExecution',
        threadId: ctx.request.threadId,
        turnId: ctx.request.turnId,
        itemId: ctx.request.itemId,
        channelId: ctx.channelId,
        threadChannelId: ctx.threadChannelId,
        ownerUserId: ctx.ownerUserId,
        command: ctx.request.command ?? null,
        cwd: ctx.request.cwd ?? null,
        reason: ctx.request.reason ?? null,
        createdAt,
        resolve,
        reject,
      };

      this.pending.set(pendingId, pending);

      try {
        const reason = pending.reason ? `\n사유: ${pending.reason}` : '';
        const command = pending.command ? `\n명령: \`${pending.command}\`` : '';
        const cwd = pending.cwd ? `\n경로: \`${pending.cwd}\`` : '';
        await this.client.sendMessage(
          ctx.channelId,
          `⚠️ Codex 명령 실행 승인 요청${reason}${command}${cwd}`,
        );
        await this.client.sendQuestionPrompt(ctx.channelId, {
          header: '명령 승인',
          question: '명령 실행을 허용할까요?',
          mode: 'buttons',
          customId: this.buildActionCustomId('cmd', pendingId, 'noop'),
          options: [
            {
              label: '승인',
              value: 'accept',
              customId: this.buildActionCustomId('cmd', pendingId, 'accept'),
            },
            {
              label: '세션동안 승인',
              value: 'acceptForSession',
              customId: this.buildActionCustomId('cmd', pendingId, 'acceptForSession'),
            },
            {
              label: '거부',
              value: 'decline',
              customId: this.buildActionCustomId('cmd', pendingId, 'decline'),
            },
          ],
        });
      } catch (error) {
        this.pending.delete(pendingId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async requestFileChangeApproval(
    ctx: ApprovalRequestContext & {
      request: FileChangeRequestApprovalParams;
    },
  ): Promise<FileChangeApprovalDecision> {
    this.pruneOverflow();

    const pendingId = makePendingId();
    const createdAt = now();

    return new Promise<FileChangeApprovalDecision>(async (resolve, reject) => {
      const pending: PendingFileApproval = {
        pendingId,
        requestId: ctx.requestId,
        kind: 'fileChange',
        threadId: ctx.request.threadId,
        turnId: ctx.request.turnId,
        itemId: ctx.request.itemId,
        channelId: ctx.channelId,
        threadChannelId: ctx.threadChannelId,
        ownerUserId: ctx.ownerUserId,
        reason: ctx.request.reason ?? null,
        grantRoot: ctx.request.grantRoot ?? null,
        createdAt,
        resolve,
        reject,
      };

      this.pending.set(pendingId, pending);

      try {
        const reason = pending.reason ? `\n사유: ${pending.reason}` : '';
        const grantRoot = pending.grantRoot ? `\n요청 루트: \`${pending.grantRoot}\`` : '';
        await this.client.sendMessage(
          ctx.channelId,
          `📝 Codex 파일 변경 승인 요청${reason}${grantRoot}`,
        );
        await this.client.sendQuestionPrompt(ctx.channelId, {
          header: '파일 변경 승인',
          question: '파일 변경을 허용할까요?',
          mode: 'buttons',
          customId: this.buildActionCustomId('file', pendingId, 'noop'),
          options: [
            {
              label: '승인',
              value: 'accept',
              customId: this.buildActionCustomId('file', pendingId, 'accept'),
            },
            {
              label: '거부',
              value: 'decline',
              customId: this.buildActionCustomId('file', pendingId, 'decline'),
            },
          ],
        });
      } catch (error) {
        this.pending.delete(pendingId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async requestToolUserInput(
    ctx: ApprovalRequestContext & {
      request: ToolRequestUserInputParams;
    },
  ): Promise<ToolRequestUserInputResponse> {
    this.pruneOverflow();

    const pendingId = makePendingId();
    const createdAt = now();

    return new Promise<ToolRequestUserInputResponse>(async (resolve, reject) => {
      const pending: PendingToolUserInput = {
        pendingId,
        requestId: ctx.requestId,
        kind: 'toolUserInput',
        threadId: ctx.request.threadId,
        turnId: ctx.request.turnId,
        itemId: ctx.request.itemId,
        channelId: ctx.channelId,
        threadChannelId: ctx.threadChannelId,
        ownerUserId: ctx.ownerUserId,
        createdAt,
        resolve,
        reject,
        questions: ctx.request.questions,
        answers: new Map<string, string[]>(),
        responderUserId: null,
      };

      this.pending.set(pendingId, pending);

      try {
        await this.client.sendMessage(
          ctx.channelId,
          '❓ Codex가 추가 사용자 입력을 요청했습니다.',
        );

        for (const [questionIndex, question] of pending.questions.entries()) {
          const options = Array.isArray(question.options) ? question.options : [];

          if (options.length === 0) {
            await this.client.sendMessage(
              ctx.channelId,
              `질문 ${questionIndex + 1}: ${question.question}\n` +
              `텍스트 입력: \`/codex-input ${pendingId} ${questionIndex + 1} <답변>\``,
            );
            continue;
          }

          const includeOther = question.isOther;
          const mode = options.length <= 4 && !includeOther ? 'buttons' : 'select';

          if (mode === 'buttons') {
            await this.client.sendQuestionPrompt(ctx.channelId, {
              header: question.header || '질문',
              question: question.question,
              mode: 'buttons',
              customId: this.buildQuestionCustomId('btn', pendingId, questionIndex),
              options: options.slice(0, 5).map((option, optionIndex) => ({
                label: option.label,
                description: option.description,
                value: String(optionIndex),
                customId: this.buildQuestionButtonCustomId(pendingId, questionIndex, optionIndex),
              })),
            });
            continue;
          }

          const selectOptions = options.slice(0, 24).map((option, optionIndex) => ({
            label: option.label,
            description: option.description,
            value: String(optionIndex),
          }));

          if (includeOther) {
            selectOptions.push({
              label: '기타 입력',
              description: '텍스트로 직접 입력',
              value: '__other__',
            });
          }

          await this.client.sendQuestionPrompt(ctx.channelId, {
            header: question.header || '질문',
            question: `${question.question}${includeOther ? '\n(기타 입력 선택 시 /codex-input 사용)' : ''}`,
            mode: 'select',
            customId: this.buildQuestionCustomId('sel', pendingId, questionIndex),
            options: selectOptions,
            minValues: 1,
            maxValues: 1,
          });

          if (includeOther) {
            await this.client.sendMessage(
              ctx.channelId,
              `기타 텍스트 입력: \`/codex-input ${pendingId} ${questionIndex + 1} <답변>\``,
            );
          }
        }
      } catch (error) {
        this.pending.delete(pendingId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async handleInteraction(data: DiscordComponentData): Promise<boolean> {
    const parsedAction = this.parseActionCustomId(data.customId);
    if (parsedAction) {
      const pending = this.pending.get(parsedAction.pendingId);
      if (!pending) {
        await data.replyEphemeral('이미 처리되었거나 만료된 요청입니다.');
        return true;
      }

      if (pending.kind === 'toolUserInput') {
        await data.replyEphemeral('이 요청은 질문 응답 UI를 사용해주세요.');
        return true;
      }

      if (pending.resolvedAt) {
        await data.replyEphemeral('이미 처리된 요청입니다.');
        return true;
      }

      const decision = formatSessionDecisionToken(parsedAction.decisionToken);
      if (!decision) {
        await data.replyEphemeral('알 수 없는 동작입니다.');
        return true;
      }

      if (pending.kind === 'fileChange' && decision === 'acceptForSession') {
        await data.replyEphemeral('파일 변경은 세션 승인 모드를 지원하지 않습니다.');
        return true;
      }

      pending.resolvedAt = now();
      pending.resolvedBy = data.user.id;
      pending.decision = decision;
      this.pending.delete(pending.pendingId);

      if (pending.kind === 'commandExecution') {
        pending.resolve(decision as CommandExecutionApprovalDecision);
      } else {
        pending.resolve(decision as FileChangeApprovalDecision);
      }

      await data.replyEphemeral(`요청을 처리했습니다: ${decision}`);
      return true;
    }

    const parsedQuestion = this.parseQuestionCustomId(data.customId);
    if (!parsedQuestion) {
      return false;
    }

    const pending = this.pending.get(parsedQuestion.pendingId);
    if (!pending || pending.kind !== 'toolUserInput') {
      await data.replyEphemeral('이미 처리되었거나 만료된 질문입니다.');
      return true;
    }

    if (pending.channelId !== data.channelId) {
      await data.replyEphemeral('해당 채널에서만 응답할 수 있습니다.');
      return true;
    }

    if (pending.responderUserId && pending.responderUserId !== data.user.id) {
      await data.replyEphemeral('처음 응답한 사용자만 이어서 답변할 수 있습니다.');
      return true;
    }

    const question = pending.questions[parsedQuestion.questionIndex];
    if (!question) {
      await data.replyEphemeral('질문 인덱스를 찾지 못했습니다.');
      return true;
    }

    const options = Array.isArray(question.options) ? question.options : [];
    const selectedAnswers: string[] = [];

    if (parsedQuestion.kind === 'btn') {
      const option = options[parsedQuestion.optionIndex];
      if (!option) {
        await data.replyEphemeral('옵션을 찾지 못했습니다.');
        return true;
      }
      selectedAnswers.push(option.label);
    } else {
      for (const value of data.values) {
        if (value === '__other__') {
          await data.replyEphemeral(
            `텍스트 입력: /codex-input ${pending.pendingId} ${parsedQuestion.questionIndex + 1} <답변>`,
          );
          return true;
        }
        const idx = Number.parseInt(value, 10);
        if (!Number.isFinite(idx) || idx < 0) continue;
        const option = options[idx];
        if (option) selectedAnswers.push(option.label);
      }
    }

    if (selectedAnswers.length === 0) {
      await data.replyEphemeral('선택값을 해석하지 못했습니다.');
      return true;
    }

    pending.responderUserId = pending.responderUserId ?? data.user.id;
    pending.answers.set(question.id, selectedAnswers);

    const done = this.tryFinalizeToolUserInput(pending, data.user.id);
    if (done) {
      await data.replyEphemeral('응답을 Codex에 전달했습니다.');
      return true;
    }

    await data.replyEphemeral(
      `응답 저장됨: ${formatQuestionLabel(question.id, parsedQuestion.questionIndex)} ` +
      `(${pending.answers.size}/${pending.questions.length})`,
    );
    return true;
  }

  async handleTextInputCommand(params: {
    text: string;
    channelId: string;
    guildId: string | null;
    userId: string;
  }): Promise<{ handled: boolean; message?: string }> {
    const match = params.text.trim().match(/^\/codex-input\s+([a-zA-Z0-9]+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) {
      return { handled: false };
    }

    const pendingId = match[1];
    const questionToken = match[2];
    const answerToken = match[3];
    if (!pendingId || !questionToken || !answerToken) {
      return {
        handled: true,
        message: '사용법: /codex-input <pending_id> <question_index(1-base)> <답변>',
      };
    }
    const questionNumber = Number.parseInt(questionToken, 10);
    const answer = answerToken.trim();

    if (!Number.isFinite(questionNumber) || questionNumber <= 0 || !answer) {
      return {
        handled: true,
        message: '사용법: /codex-input <pending_id> <question_index(1-base)> <답변>',
      };
    }

    const pending = this.pending.get(pendingId);
    if (!pending || pending.kind !== 'toolUserInput') {
      return {
        handled: true,
        message: '해당 pending 질문을 찾지 못했습니다. 이미 처리되었을 수 있습니다.',
      };
    }

    if (pending.channelId !== params.channelId) {
      return {
        handled: true,
        message: '해당 질문이 생성된 채널에서만 답변할 수 있습니다.',
      };
    }

    if (pending.responderUserId && pending.responderUserId !== params.userId) {
      return {
        handled: true,
        message: '처음 응답한 사용자만 이어서 답변할 수 있습니다.',
      };
    }

    const questionIndex = questionNumber - 1;
    const question = pending.questions[questionIndex];
    if (!question) {
      return {
        handled: true,
        message: `질문 ${questionNumber} 를 찾지 못했습니다.`,
      };
    }

    pending.responderUserId = pending.responderUserId ?? params.userId;
    pending.answers.set(question.id, [answer]);

    const done = this.tryFinalizeToolUserInput(pending, params.userId);
    if (done) {
      return {
        handled: true,
        message: '응답을 Codex에 전달했습니다.',
      };
    }

    return {
      handled: true,
      message:
        `응답 저장됨: ${formatQuestionLabel(question.id, questionIndex)} ` +
        `(${pending.answers.size}/${pending.questions.length})`,
    };
  }

  getPendingStatus(): CodexPendingStatus {
    const nowMs = now();
    const requests = Array.from(this.pending.values())
      .map((pending) => ({
        pendingId: pending.pendingId,
        requestId: pending.requestId,
        kind: pending.kind,
        threadId: pending.threadId,
        turnId: pending.turnId,
        itemId: pending.itemId,
        channelId: pending.channelId,
        threadChannelId: pending.threadChannelId,
        ownerUserId: pending.ownerUserId,
        createdAt: pending.createdAt,
        ageMs: Math.max(0, nowMs - pending.createdAt),
        decision: pending.decision,
        resolvedBy: pending.resolvedBy,
        resolvedAt: pending.resolvedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);

    return {
      count: requests.length,
      requests,
    };
  }

  resolvePending(params: ResolveCodexPendingParams): ResolveCodexPendingResult {
    const pendingId = params.pendingId.trim();
    if (!pendingId) {
      return {
        ok: false,
        reason: 'invalid_request',
        message: 'pending_id가 필요합니다.',
      };
    }

    const pending = this.pending.get(pendingId);
    if (!pending) {
      return {
        ok: false,
        reason: 'not_found',
        message: '해당 pending 요청을 찾지 못했습니다.',
      };
    }

    const resolvedBy = params.actorUserId?.trim() || 'api';
    const resolvedAt = now();

    if (pending.kind === 'toolUserInput') {
      const token = (params.decision ?? 'cancel').trim();
      if (token && token !== 'cancel' && token !== 'decline') {
        return {
          ok: false,
          reason: 'invalid_decision',
          message: 'toolUserInput은 cancel/decline만 허용됩니다.',
        };
      }

      const response: ToolRequestUserInputResponse = { answers: {} };
      for (const question of pending.questions) {
        response.answers[question.id] = { answers: [] };
      }

      pending.resolvedAt = resolvedAt;
      pending.resolvedBy = resolvedBy;
      pending.decision = 'cancel';
      this.pending.delete(pending.pendingId);
      pending.resolve(response);
      return {
        ok: true,
        pendingId,
        kind: pending.kind,
        decision: pending.decision,
        resolvedBy,
        resolvedAt,
      };
    }

    const token = (params.decision ?? 'decline').trim();
    const decision = formatSessionDecisionToken(token);
    if (!decision) {
      return {
        ok: false,
        reason: 'invalid_decision',
        message: `허용되지 않은 decision: ${token || '(empty)'}`,
      };
    }
    if (pending.kind === 'fileChange' && decision === 'acceptForSession') {
      return {
        ok: false,
        reason: 'invalid_decision',
        message: 'fileChange는 acceptForSession을 지원하지 않습니다.',
      };
    }

    pending.resolvedAt = resolvedAt;
    pending.resolvedBy = resolvedBy;
    pending.decision = decision;
    this.pending.delete(pending.pendingId);

    if (pending.kind === 'commandExecution') {
      pending.resolve(decision as CommandExecutionApprovalDecision);
    } else {
      pending.resolve(decision as FileChangeApprovalDecision);
    }

    return {
      ok: true,
      pendingId,
      kind: pending.kind,
      decision,
      resolvedBy,
      resolvedAt,
    };
  }

  private tryFinalizeToolUserInput(pending: PendingToolUserInput, resolverUserId: string): boolean {
    for (const question of pending.questions) {
      if (!pending.answers.has(question.id)) {
        return false;
      }
    }

    const response: ToolRequestUserInputResponse = { answers: {} };
    for (const question of pending.questions) {
      response.answers[question.id] = {
        answers: pending.answers.get(question.id) ?? [],
      };
    }

    pending.resolvedAt = now();
    pending.resolvedBy = resolverUserId;
    pending.decision = 'answered';
    this.pending.delete(pending.pendingId);
    pending.resolve(response);
    return true;
  }

  private buildActionCustomId(kind: 'cmd' | 'file', pendingId: string, decision: string): string {
    return `${CUSTOM_PREFIX}:a:${kind}:${pendingId}:${decision}`;
  }

  private buildQuestionCustomId(kind: 'btn' | 'sel', pendingId: string, questionIndex: number): string {
    return `${CUSTOM_PREFIX}:q:${kind}:${pendingId}:${questionIndex}`;
  }

  private buildQuestionButtonCustomId(pendingId: string, questionIndex: number, optionIndex: number): string {
    return `${CUSTOM_PREFIX}:qb:${pendingId}:${questionIndex}:${optionIndex}`;
  }

  private parseActionCustomId(customId: string): {
    pendingId: string;
    decisionToken: string;
  } | null {
    const parts = customId.split(':');
    if (parts.length !== 5) return null;
    if (parts[0] !== CUSTOM_PREFIX || parts[1] !== 'a') return null;
    const pendingId = parts[3];
    const decisionToken = parts[4];
    if (!pendingId || !decisionToken) return null;
    return { pendingId, decisionToken };
  }

  private parseQuestionCustomId(customId: string):
    | {
        kind: 'btn';
        pendingId: string;
        questionIndex: number;
        optionIndex: number;
      }
    | {
        kind: 'sel';
        pendingId: string;
        questionIndex: number;
      }
    | null {
    const buttonParts = customId.split(':');
    if (buttonParts.length === 5
      && buttonParts[0] === CUSTOM_PREFIX
      && buttonParts[1] === 'qb') {
      const pendingId = buttonParts[2];
      const questionToken = buttonParts[3];
      const optionToken = buttonParts[4];
      if (!pendingId || !questionToken || !optionToken) return null;
      const questionIndex = Number.parseInt(questionToken, 10);
      const optionIndex = Number.parseInt(optionToken, 10);
      if (!Number.isFinite(questionIndex) || !Number.isFinite(optionIndex)) return null;
      return {
        kind: 'btn',
        pendingId,
        questionIndex,
        optionIndex,
      };
    }

    if (buttonParts.length === 5
      && buttonParts[0] === CUSTOM_PREFIX
      && buttonParts[1] === 'q'
      && buttonParts[2] === 'sel') {
      const pendingId = buttonParts[3];
      const questionToken = buttonParts[4];
      if (!pendingId || !questionToken) return null;
      const questionIndex = Number.parseInt(questionToken, 10);
      if (!Number.isFinite(questionIndex)) return null;
      return {
        kind: 'sel',
        pendingId,
        questionIndex,
      };
    }

    return null;
  }

  private pruneOverflow(): void {
    if (this.pending.size < this.maxPending) return;

    console.warn(
      `[CodexApprovalUI] pending size exceeded (${this.pending.size}/${this.maxPending});` +
      ' existing requests are kept until explicit resolve.',
    );
  }
}
