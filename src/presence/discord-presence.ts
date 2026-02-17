import type { PresenceGateway } from './types.ts';

/** Minimal interface for Discord typing indicator */
export interface TypingClient {
  sendTyping(channelId: string): Promise<void>;
}

const TYPING_INTERVAL_MS = 6_000;
const TYPING_TTL_MS = 120_000;

export class DiscordPresence implements PresenceGateway {
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;

  constructor(
    private readonly client: TypingClient,
    private readonly channelId: string,
  ) {}

  startWorking(_label?: string): void {
    if (this.active) return;
    this.active = true;

    this.sendTyping();
    this.intervalTimer = setInterval(() => {
      this.sendTyping();
    }, TYPING_INTERVAL_MS);
    this.resetTtl();
  }

  stopWorking(): void {
    if (!this.active) return;
    this.active = false;

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
  }

  ping(): void {
    if (!this.active) return;
    this.resetTtl();
  }

  private resetTtl(): void {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
    }
    this.ttlTimer = setTimeout(() => {
      this.stopWorking();
    }, TYPING_TTL_MS);
  }

  private sendTyping(): void {
    this.client.sendTyping(this.channelId).catch((err) => {
      console.error('[DiscordPresence] sendTyping failed:', err);
    });
  }
}
