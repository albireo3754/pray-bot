/**
 * StreamRenderer - AgentEvent → ReplyClient 출력
 *
 * Provider-agnostic한 이벤트 스트림을 사용자에게 렌더링.
 */

import type { AgentEvent, AgentQuestionEvent } from './types.ts';
import type { PresenceGateway } from '../presence/types.ts';

type ReplyTarget = {
  sendMessage(message: string, throttle?: boolean): void;
  sendBlockMessage(message: string): void;
};

export type RenderOptions = {
  showUsage?: boolean;
  showReasoning?: boolean;
  showToolCalls?: boolean;
  completionMessage?: string;
  failureMessage?: string;
};

export type RenderResult = {
  turnCount: number;
  hadError: boolean;
};

export type RenderHooks = {
  onQuestion?: (event: AgentQuestionEvent) => Promise<void> | void;
  onSession?: (sessionId: string) => Promise<void> | void;
};

export class StreamRenderer {
  private readonly completionMessage: string;
  private readonly failureMessage: string;

  constructor(private options: RenderOptions = {}) {
    this.completionMessage = options.completionMessage ?? 'Agent 응답이 완료되었습니다.';
    this.failureMessage = options.failureMessage ?? 'Agent 응답 처리 중 오류가 발생했습니다.';
  }

  async render(
    events: AsyncIterable<AgentEvent>,
    target: ReplyTarget,
    hooks: RenderHooks = {},
    presence?: PresenceGateway,
  ): Promise<RenderResult> {
    let turnCount = 0;
    let hadError = false;
    const pendingTexts: string[] = [];
    let waitingForUserInput = false;

    presence?.startWorking();
    try {
      for await (const event of events) {
        switch (event.type) {
          case 'text':
            presence?.ping();
            if (event.partial) {
              target.sendMessage(`Assistant: ${event.text}`, true);
            } else {
              pendingTexts.push(event.text);
            }
            break;

          case 'session':
            if (hooks.onSession) {
              await hooks.onSession(event.sessionId);
            }
            break;

          case 'ux_event':
            presence?.ping();
            if (event.immediate) {
              target.sendMessage(`입력 대기: ${event.label}`);
            } else if (event.severity === 'error') {
              target.sendMessage(`오류 이벤트: ${event.label}`, true);
            }
            break;

          case 'reasoning':
            presence?.ping();
            if (this.options.showReasoning) {
              target.sendMessage(`Reasoning: ${event.text}`, true);
            }
            break;

          case 'command':
            presence?.ping();
            target.sendMessage(
              `Command ${event.command}` +
              (event.exitCode != null ? ` Exit code ${event.exitCode}.` : ''),
              true,
            );
            break;

          case 'file_change':
            presence?.ping();
            target.sendMessage(`File ${event.kind} ${event.path}`, true);
            break;

          case 'todo': {
            presence?.ping();
            const text = event.items
              .map((i) => `\t ${i.status === 'completed' ? 'x' : ' '} ${i.content}`)
              .join('\n');
            target.sendMessage(`Todo:\n${text}`, true);
            break;
          }

          case 'tool_call':
            presence?.ping();
            if (this.options.showToolCalls) {
              target.sendMessage(`Tool: ${event.toolName}`, true);
            }
            break;

          case 'tool_result':
            presence?.ping();
            break; // Provider 내부 처리

          case 'question':
            waitingForUserInput = true;
            if (hooks.onQuestion) {
              await hooks.onQuestion(event);
            } else {
              const lines: string[] = [];
              for (const [index, q] of event.questions.entries()) {
                lines.push(`질문 ${index + 1}: ${q.header}`);
                lines.push(q.question);
                for (const opt of q.options) {
                  lines.push(`- ${opt.label}${opt.description ? `: ${opt.description}` : ''}`);
                }
              }
              target.sendMessage(lines.join('\n'));
            }
            break;

          case 'turn_complete': {
            presence?.stopWorking();
            const content = pendingTexts.splice(0).join('\n\n');
            const usageParts: string[] = [];
            if (this.options.showUsage) {
              usageParts.push(
                `${event.usage.inputTokens}/${event.usage.outputTokens} tokens`,
              );
              if (event.costUsd) usageParts.push(`$${event.costUsd.toFixed(4)}`);
            }
            const usageSuffix = usageParts.length > 0 ? `\n\n${usageParts.join(' | ')}` : '';
            if (content.length > 0) {
              target.sendMessage(`Assistant: ${content}${usageSuffix}`, true);
            } else if (usageSuffix) {
              target.sendMessage(usageSuffix.trim(), true);
            }
            if (!waitingForUserInput) {
              target.sendBlockMessage(this.completionMessage);
            }
            waitingForUserInput = false;
            turnCount++;
            break;
          }

          case 'error':
            presence?.stopWorking();
            hadError = true;
            target.sendBlockMessage(`${this.failureMessage}\n${event.message}`);
            break;
        }
      }
    } finally {
      presence?.stopWorking();
    }

    // turn_complete 없이 끝난 경우 (에러 등) pending texts flush
    if (pendingTexts.length > 0) {
      target.sendMessage(`Assistant: ${pendingTexts.join('\n\n')}`, true);
    }

    return { turnCount, hadError };
  }
}
