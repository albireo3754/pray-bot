import type { ActivityPhase, SessionSnapshot } from './types.ts';
import type { RouteDefinition } from '../plugin/types.ts';
import type { AutoThreadDiscovery } from '../auto-thread/index.ts';
import { tailJsonl } from './claude-parser.ts';

// ── Hook Event Types ──────────────────────────────────────────────

/** Hook stdin의 공통 필드 — provider-agnostic */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  provider: 'claude' | 'codex';
  permission_mode?: string;
}

export interface StopHookEvent extends HookEvent {
  hook_event_name: 'Stop';
  stop_hook_active?: boolean;
}

export interface UserPromptSubmitHookEvent extends HookEvent {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface SessionStartHookEvent extends HookEvent {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  model?: string;
  agent_type?: string;
}

export interface SessionEndHookEvent extends HookEvent {
  hook_event_name: 'SessionEnd';
  reason?: string;
}

export interface NotificationHookEvent extends HookEvent {
  hook_event_name: 'Notification';
  notification_type: 'permission_prompt' | 'idle_prompt' | 'elicitation_dialog' | 'auth_success';
  message: string;
  title?: string;
}

export type AnyHookEvent =
  | StopHookEvent
  | UserPromptSubmitHookEvent
  | SessionStartHookEvent
  | SessionEndHookEvent
  | NotificationHookEvent;

// ── HookAcceptingMonitor Interface ────────────────────────────────

/**
 * Hook 이벤트를 수용할 수 있는 monitor의 인터페이스.
 * SessionMonitorProvider와 별도 — 기존 인터페이스를 오염시키지 않는다.
 */
export interface HookAcceptingMonitor {
  updateActivityPhase(sessionId: string, phase: ActivityPhase): void;
  updateSessionState(sessionId: string, state: SessionSnapshot['state']): void;
  registerSession(event: SessionStartHookEvent): SessionSnapshot;
}

// ── extractLastAssistantResponse ──────────────────────────────────

/**
 * Transcript JSONL tail에서 마지막 assistant 텍스트 응답을 추출.
 * tailJsonl()로 마지막 256KB를 읽은 뒤, 역순으로 type === 'assistant' entry를 탐색.
 * message.content[]에서 type === 'text' 블록만 추출 (tool_use 블록 무시).
 *
 * @param maxLength - Discord 메시지 길이 제한 (default: 1900)
 * @returns 텍스트 또는 null (assistant 메시지 없음 / text 블록 없음)
 */
export async function extractLastAssistantResponse(
  transcriptPath: string,
  maxLength = 1900,
): Promise<string | null> {
  let entries;
  try {
    entries = await tailJsonl(transcriptPath, 256_000);
  } catch {
    return null;
  }

  if (entries.length === 0) return null;

  // 역순으로 마지막 assistant entry 탐색
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== 'assistant') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    // text 블록만 추출 (tool_use, thinking 등 무시)
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      }
    }

    if (textParts.length === 0) continue;

    const fullText = textParts.join('\n').trim();
    if (fullText.length === 0) continue;

    if (fullText.length > maxLength) {
      return fullText.slice(0, maxLength) + '...';
    }
    return fullText;
  }

  return null;
}

// ── createHookRoute ───────────────────────────────────────────────

/**
 * Hook HTTP route factory.
 * provider 필드로 라우팅: providers Map에서 해당 monitor를 찾아 위임.
 *
 * HTTP handler는 200을 즉시 반환한 후, 응답 포워딩 등 부가 작업은
 * fire-and-forget (.catch(console.error))으로 처리한다.
 *
 * HTTP Responses:
 *   200 { ok: true }                    — 정상 처리
 *   400 { error: "invalid JSON" }       — body 파싱 실패
 *   400 { error: "unknown provider" }   — providers Map에 없는 provider
 */
export function createHookRoute(
  providers: Map<string, HookAcceptingMonitor>,
  autoThread: AutoThreadDiscovery,
): RouteDefinition {
  return {
    method: 'POST',
    path: '/api/hook',
    handler: async (req: Request): Promise<Response> => {
      let event: AnyHookEvent;
      try {
        event = await req.json() as AnyHookEvent;
      } catch {
        return Response.json({ error: 'invalid JSON' }, { status: 400 });
      }

      if (!event.hook_event_name || !event.session_id) {
        return Response.json({ error: 'missing required fields' }, { status: 400 });
      }

      const provider = event.provider ?? 'claude';
      const monitor = providers.get(provider);
      if (!monitor) {
        return Response.json({ error: 'unknown provider' }, { status: 400 });
      }

      // 200 즉시 반환 — 이후 처리는 fire-and-forget
      handleHookEvent(event, monitor, autoThread).catch(console.error);

      return Response.json({ ok: true });
    },
  };
}

// ── Internal Event Handler ────────────────────────────────────────

async function handleHookEvent(
  event: AnyHookEvent,
  monitor: HookAcceptingMonitor,
  autoThread: AutoThreadDiscovery,
): Promise<void> {
  const sid = event.session_id;

  switch (event.hook_event_name) {
    case 'Stop': {
      monitor.updateActivityPhase(sid, 'interactable');
      // Fire-and-forget: transcript에서 마지막 assistant 응답 추출 → Discord 포워딩
      if (event.transcript_path) {
        const response = await extractLastAssistantResponse(event.transcript_path);
        if (response) {
          await autoThread.sendToSessionThread(event.provider, sid, response);
        }
      }
      break;
    }
    case 'UserPromptSubmit': {
      monitor.updateActivityPhase(sid, 'busy');
      break;
    }
    case 'SessionStart': {
      const snapshot = monitor.registerSession(event as SessionStartHookEvent);
      await autoThread.onSessionStart(snapshot);
      break;
    }
    case 'SessionEnd': {
      monitor.updateSessionState(sid, 'completed');
      break;
    }
    case 'Notification': {
      const notif = event as NotificationHookEvent;
      if (notif.notification_type === 'permission_prompt') {
        monitor.updateActivityPhase(sid, 'waiting_permission');
      } else if (notif.notification_type === 'idle_prompt' || notif.notification_type === 'elicitation_dialog') {
        monitor.updateActivityPhase(sid, 'waiting_question');
      }
      break;
    }
    default:
      console.debug(`[HookReceiver] unhandled hook event: ${(event as HookEvent).hook_event_name}`);
  }
}
