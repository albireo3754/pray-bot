/**
 * Hook Approval Bridge
 *
 * Claude Code의 PreToolUse hook 승인 요청을 처리하는 모듈
 * CLI yes/no와 Kakaowork 버튼 양쪽에서 승인 가능
 */

import type { DiscordComponentData, DiscordQuestionPrompt } from '../discord/types.ts';

const DEFAULT_TIMEOUT_MS = 0; // 무제한
const MAX_TIMEOUT_MS = 24 * 60 * 60_000; // 24시간
const HOOK_APPROVAL_INTERACTION_PREFIX = 'hookapr';
const SESSION_CHANNEL_TTL_MS = 12 * 60 * 60_000; // 12시간

type HookRequestBody = {
  id: string;
  command: string;
  description: string;
  severity?: 'ask' | 'deny';
  timeoutSeconds?: number;
  sessionId?: string;
};

function isHookRequestBody(value: unknown): value is HookRequestBody {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string') return false;
  if (typeof candidate.command !== 'string') return false;
  if (typeof candidate.description !== 'string') return false;
  if (
    candidate.severity !== undefined
    && candidate.severity !== 'ask'
    && candidate.severity !== 'deny'
  ) {
    return false;
  }
  if (
    candidate.timeoutSeconds !== undefined
    && (typeof candidate.timeoutSeconds !== 'number' || !Number.isFinite(candidate.timeoutSeconds))
  ) {
    return false;
  }
  if (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string') {
    return false;
  }
  return true;
}

export interface HookApprovalRequest {
  id: string;
  command: string;
  description: string;
  severity: 'ask' | 'deny';
  createdAt: Date;
  timeoutMs: number;
  sessionId?: string;
}

interface PendingApproval {
  request: HookApprovalRequest;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HookApprovalBridgeOptions {
  client: HookApprovalClient;
  callbackBaseUrl: string;
  defaultTimeoutMs?: number;
  discordClient?: SendableDiscordClient;
  defaultDiscordChannelId?: string | null;
}

export type HookApprovalClient = {
  sendWorkflowNotification(message: string): void | Promise<void>;
  sendWorkflowBlockKit(text: string, blocks: unknown[]): void | Promise<void>;
};

type SendableDiscordClient = {
  sendMessage(channelId: string, content: string): Promise<void>;
  sendQuestionPrompt(channelId: string, prompt: DiscordQuestionPrompt): Promise<void>;
};

export class HookApprovalBridge {
  private readonly client: HookApprovalClient;
  private readonly callbackBaseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  // 처리 완료된 요청의 결과를 잠시 보관
  private readonly resolvedResults = new Map<string, boolean>();
  private discordClient: SendableDiscordClient | null;
  private defaultDiscordChannelId: string | null;
  private readonly sessionToChannel = new Map<string, { channelId: string; updatedAt: number }>();

  constructor(options: HookApprovalBridgeOptions) {
    this.client = options.client;
    this.callbackBaseUrl = options.callbackBaseUrl.replace(/\/$/, '');
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.discordClient = options.discordClient ?? null;
    this.defaultDiscordChannelId = options.defaultDiscordChannelId ?? null;
  }

  setDiscordClient(discordClient: SendableDiscordClient | null, defaultChannelId?: string | null): void {
    this.discordClient = discordClient;
    if (defaultChannelId !== undefined) {
      this.defaultDiscordChannelId = defaultChannelId;
    }
  }

  registerSessionChannel(sessionId: string, channelId: string): void {
    if (!sessionId || !channelId) return;
    this.pruneSessionChannels();
    this.sessionToChannel.set(sessionId, { channelId, updatedAt: Date.now() });
  }

  /**
   * 승인 요청 등록 및 Kakaowork 알림 전송
   */
  async requestApproval(request: Omit<HookApprovalRequest, 'createdAt'>): Promise<boolean> {
    const fullRequest: HookApprovalRequest = {
      ...request,
      createdAt: new Date(),
      timeoutMs: Math.min(request.timeoutMs || this.defaultTimeoutMs, MAX_TIMEOUT_MS),
    };

    return new Promise<boolean>((resolve) => {
      const timer = fullRequest.timeoutMs > 0
        ? setTimeout(() => {
            this.pendingApprovals.delete(request.id);
            console.log(`[HookApproval] Request ${request.id} timed out`);
            resolve(false); // 타임아웃 시 거부
          }, fullRequest.timeoutMs)
        : null;

      this.pendingApprovals.set(request.id, {
        request: fullRequest,
        resolve,
        timer,
      });

      // Kakaowork BlockKit 알림 전송
      this.sendApprovalNotification(fullRequest);
    });
  }

  /**
   * 승인/거부 응답 처리
   */
  handleResponse(id: string, approved: boolean): { ok: boolean; message?: string } {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return { ok: false, message: `Approval request ${id} not found or expired` };
    }

    this.pendingApprovals.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(approved);

    // 결과 보관 (2분간)
    this.resolvedResults.set(id, approved);
    setTimeout(() => this.resolvedResults.delete(id), 120_000);

    // 결과 알림
    const status = approved ? '✅ 승인됨' : '❌ 거부됨';
    this.client.sendWorkflowNotification(
      `[Hook] ${pending.request.description}\n${status}`
    );

    console.log(`[HookApproval] Request ${id} ${approved ? 'approved' : 'denied'}`);

    return { ok: true };
  }

  /**
   * Kakaowork BlockKit 알림 전송
   */
  private sendApprovalNotification(request: HookApprovalRequest): void {
    const discordChannelId = this.resolveDiscordChannelId(request);
    if (this.discordClient && discordChannelId) {
      this.sendDiscordApprovalNotification(request, discordChannelId).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[HookApproval] Failed to send Discord notification: ${msg}`);
      });
      return;
    }

    const approveUrl = `${this.callbackBaseUrl}/api/hook/respond?id=${request.id}&approved=true`;
    const denyUrl = `${this.callbackBaseUrl}/api/hook/respond?id=${request.id}&approved=false`;

    // 명령어 미리보기 (길면 자르기)
    const cmdPreview = request.command.length > 200
      ? request.command.slice(0, 197) + '...'
      : request.command;

    const blocks = [
      {
        type: 'header',
        text: '⚠️ 명령어 승인 요청',
        style: 'yellow',
      },
      {
        type: 'text',
        text: request.description,
      },
      {
        type: 'description',
        term: '명령어',
        content: {
          type: 'text',
          text: cmdPreview,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'action',
        elements: [
          {
            type: 'button',
            text: '✅ 승인',
            style: 'primary',
            action: {
              type: 'open_system_browser',
              value: approveUrl,
            },
          },
          {
            type: 'button',
            text: '❌ 거부',
            style: 'danger',
            action: {
              type: 'open_system_browser',
              value: denyUrl,
            },
          },
        ],
      },
      {
        type: 'context',
        content: {
          type: 'text',
          text: request.timeoutMs > 0
            ? `ID: ${request.id} | ${Math.round(request.timeoutMs / 1000)}초 후 자동 거부`
            : `ID: ${request.id} | 무제한 대기`,
        },
      },
    ];

    this.client.sendWorkflowBlockKit(
      `⚠️ 명령어 승인 요청: ${request.description}`,
      blocks
    );

    console.log(`[HookApproval] Sent approval notification for ${request.id}`);
  }

  private async sendDiscordApprovalNotification(
    request: HookApprovalRequest,
    channelId: string,
  ): Promise<void> {
    if (!this.discordClient) return;
    const commandPreview = request.command.length > 350
      ? `${request.command.slice(0, 347)}...`
      : request.command;
    const timeoutText = request.timeoutMs > 0
      ? `${Math.round(request.timeoutMs / 1000)}초 후 자동 거부`
      : '무제한 대기';
    await this.discordClient.sendMessage(
      channelId,
      [
        '⚠️ Hook 승인 요청',
        `요청: ${request.description}`,
        `명령: \`${commandPreview}\``,
        `ID: ${request.id} (${timeoutText})`,
      ].join('\n'),
    );
    await this.discordClient.sendQuestionPrompt(channelId, {
      header: 'Hook 승인',
      question: '이 명령 실행을 허용할까요?',
      mode: 'buttons',
      customId: this.buildInteractionId(request.id, 'noop'),
      options: [
        {
          label: '승인',
          value: 'approve',
          customId: this.buildInteractionId(request.id, 'approve'),
        },
        {
          label: '거부',
          value: 'deny',
          customId: this.buildInteractionId(request.id, 'deny'),
        },
      ],
    });
    console.log(`[HookApproval] Sent approval notification for ${request.id}`);
  }

  async handleDiscordInteraction(data: DiscordComponentData): Promise<boolean> {
    if (data.type !== 'button') return false;
    const parts = data.customId.split(':');
    if (parts.length !== 4 || parts[0] !== HOOK_APPROVAL_INTERACTION_PREFIX || parts[1] !== 'act') {
      return false;
    }
    const requestId = parts[2];
    const decision = parts[3];
    if (!requestId) return false;
    if (decision !== 'approve' && decision !== 'deny') return false;

    await data.acknowledge();
    const approved = decision === 'approve';
    const result = this.handleResponse(requestId, approved);
    if (!result.ok) {
      await data.replyEphemeral(`요청을 처리할 수 없습니다: ${result.message ?? 'unknown error'}`);
      return true;
    }
    await data.replyEphemeral(approved ? '승인 처리했습니다.' : '거부 처리했습니다.');
    return true;
  }

  private buildInteractionId(requestId: string, action: 'approve' | 'deny' | 'noop'): string {
    return `${HOOK_APPROVAL_INTERACTION_PREFIX}:act:${requestId}:${action}`;
  }

  private resolveDiscordChannelId(request: HookApprovalRequest): string | null {
    const sessionId = request.sessionId ?? this.extractSessionId(request.description);
    if (sessionId) {
      const route = this.sessionToChannel.get(sessionId);
      if (route) return route.channelId;
    }
    return this.defaultDiscordChannelId;
  }

  private extractSessionId(description: string): string | null {
    const match = description.match(/^\[([^\]]+)\]/);
    if (!match) return null;
    return match[1] || null;
  }

  private pruneSessionChannels(): void {
    const now = Date.now();
    this.sessionToChannel.forEach((meta, sessionId) => {
      if (now - meta.updatedAt > SESSION_CHANNEL_TTL_MS) {
        this.sessionToChannel.delete(sessionId);
      }
    });
  }

  /**
   * 대기 중인 승인 요청 목록
   */
  getPendingStatus(): {
    count: number;
    requests: Array<{
      id: string;
      command: string;
      description: string;
      createdAt: Date;
      remainingMs: number;
    }>;
  } {
    const now = Date.now();
    const requests = Array.from(this.pendingApprovals.values()).map((pending) => {
      const elapsed = now - pending.request.createdAt.getTime();
      return {
        id: pending.request.id,
        command: pending.request.command.slice(0, 100),
        description: pending.request.description,
        createdAt: pending.request.createdAt,
        remainingMs: Math.max(0, pending.request.timeoutMs - elapsed),
      };
    });

    return { count: requests.length, requests };
  }

  /**
   * 처리 완료된 요청의 결과 조회 (2분 TTL)
   */
  getResolvedResult(id: string): boolean | undefined {
    return this.resolvedResults.get(id);
  }
}

/**
 * API 핸들러: 승인 요청 등록
 */
export async function handleHookRequest(
  request: Request,
  bridge: HookApprovalBridge
): Promise<Response> {
  let body: HookRequestBody;

  try {
    const parsed = await request.json();
    if (!isHookRequestBody(parsed)) {
      return new Response(
        JSON.stringify({ status: 'error', error: 'id, command, description are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    body = parsed;
  } catch {
    return new Response(JSON.stringify({ status: 'error', error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.id || !body.command || !body.description) {
    return new Response(
      JSON.stringify({ status: 'error', error: 'id, command, description are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[HookApproval] Received request ${body.id}: ${body.description}`);

  // 비동기로 승인 대기 (응답은 즉시 반환)
  const timeoutMs = body.timeoutSeconds ? body.timeoutSeconds * 1000 : undefined;

  // Promise를 반환하지 않고, 승인 결과는 별도 폴링으로 확인
  bridge.requestApproval({
    id: body.id,
    command: body.command,
    description: body.description,
    severity: body.severity || 'ask',
    timeoutMs: timeoutMs || 60000,
    sessionId: body.sessionId,
  }).then((approved) => {
    console.log(`[HookApproval] Request ${body.id} resolved: ${approved}`);
  });

  return new Response(
    JSON.stringify({
      status: 'success',
      data: {
        id: body.id,
        message: 'Approval request registered',
        pollUrl: `/api/hook/status/${body.id}`,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * API 핸들러: 승인/거부 응답 (버튼 클릭 시)
 */
export function handleHookResponse(
  url: URL,
  bridge: HookApprovalBridge
): Response {
  const id = url.searchParams.get('id');
  const approved = url.searchParams.get('approved') === 'true';

  if (!id) {
    return new Response('Missing id parameter', { status: 400 });
  }

  const result = bridge.handleResponse(id, approved);

  if (!result.ok) {
    // 만료된 요청이면 사용자에게 안내 페이지
    return new Response(
      `<html>
        <head><title>Hook Approval</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h2>⏰ 요청이 만료되었거나 이미 처리되었습니다</h2>
          <p>${result.message}</p>
          <p style="color: gray;">이 창을 닫아도 됩니다.</p>
        </body>
      </html>`,
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // 성공 페이지
  const statusEmoji = approved ? '✅' : '❌';
  const statusText = approved ? '승인되었습니다' : '거부되었습니다';

  return new Response(
    `<html>
      <head><title>Hook Approval</title></head>
      <body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>${statusEmoji} ${statusText}</h2>
        <p>요청 ID: ${id}</p>
        <p style="color: gray;">이 창을 닫아도 됩니다.</p>
        <script>setTimeout(() => window.close(), 2000);</script>
      </body>
    </html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/**
 * API 핸들러: 승인 상태 확인 (Long polling)
 */
export async function handleHookStatus(
  id: string,
  bridge: HookApprovalBridge,
  waitMs: number = 30000
): Promise<Response> {
  // resolved 먼저 확인
  const resolvedResult = bridge.getResolvedResult(id);
  if (resolvedResult !== undefined) {
    return new Response(
      JSON.stringify({
        status: 'resolved',
        approved: resolvedResult,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 기존 long-poll 로직
  const startTime = Date.now();
  const pollInterval = 500; // 0.5초마다 체크

  while (Date.now() - startTime < waitMs) {
    const status = bridge.getPendingStatus();
    const pending = status.requests.find((r) => r.id === id);

    if (!pending) {
      // pending에서 사라짐 = 방금 처리됨 → resolvedResults 다시 확인
      const justResolved = bridge.getResolvedResult(id);
      if (justResolved !== undefined) {
        return new Response(
          JSON.stringify({ status: 'resolved', approved: justResolved }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          message: 'Request has been processed or expired',
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // 여전히 대기 중
  return new Response(
    JSON.stringify({
      status: 'pending',
      message: 'Still waiting for approval',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
