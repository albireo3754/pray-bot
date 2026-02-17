import { ChannelRateLimiter, GlobalRateLimiter } from './rate-limiter.ts';
import type { QueueStats, SendOptions, SendPayload, SendPriority } from './types.ts';

type QueueExecutor = (channelId: string, payload: SendPayload) => Promise<void>;

type QueuedMessage = {
  channelId: string;
  payload: SendPayload;
  mergeKey?: string;
  priority: SendPriority;
  enqueuedAt: number;
  resolvers: Array<() => void>;
  rejectors: Array<(err: Error) => void>;
};

export type ThrottleQueueOptions = {
  executor: QueueExecutor;
  channelMaxPerWindow?: number;
  channelWindowMs?: number;
  globalMaxPerSecond?: number;
  mergeWindowMs?: number;
  channelMaxQueueSize?: number;
};

const DEFAULT_MERGE_WINDOW_MS = 300;
const DEFAULT_CHANNEL_MAX_QUEUE_SIZE = 100;
const DISCORD_MAX_CONTENT_LENGTH = 2_000;

export class DiscordThrottleQueue {
  private readonly executor: QueueExecutor;
  private readonly channelLimiter: ChannelRateLimiter;
  private readonly globalLimiter: GlobalRateLimiter;
  private readonly mergeWindowMs: number;
  private readonly channelMaxQueueSize: number;

  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly channelOrder: string[] = [];

  private processing = false;
  private processingScheduled = false;
  private rrIndex = 0;
  private destroyed = false;

  constructor(options: ThrottleQueueOptions) {
    this.executor = options.executor;
    this.mergeWindowMs = options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;
    this.channelMaxQueueSize = options.channelMaxQueueSize ?? DEFAULT_CHANNEL_MAX_QUEUE_SIZE;
    this.channelLimiter = new ChannelRateLimiter({
      maxRequests: options.channelMaxPerWindow,
      windowMs: options.channelWindowMs,
    });
    this.globalLimiter = new GlobalRateLimiter({
      maxRequests: options.globalMaxPerSecond,
      windowMs: 1_000,
    });
  }

  send(channelId: string, payload: SendPayload, options?: SendOptions): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('DiscordThrottleQueue is destroyed'));
    }

    return new Promise<void>((resolve, reject) => {
      const now = Date.now();
      const mergeKey = options?.mergeKey;
      const priority = options?.priority ?? 'normal';
      const queue = this.ensureQueue(channelId);
      const mergeTarget = this.findMergeTarget(queue, payload, mergeKey, now);

      if (mergeTarget && payload.type === 'text' && mergeTarget.payload.type === 'text') {
        const merged = `${mergeTarget.payload.content}\n${payload.content}`;
        if (merged.length <= DISCORD_MAX_CONTENT_LENGTH) {
          mergeTarget.payload = { type: 'text', content: merged };
          if (priority === 'high' && mergeTarget.priority === 'normal') {
            mergeTarget.priority = 'high';
            const idx = queue.indexOf(mergeTarget);
            if (idx > 0) {
              queue.splice(idx, 1);
              queue.unshift(mergeTarget);
            }
          }
          mergeTarget.resolvers.push(resolve);
          mergeTarget.rejectors.push(reject);
          this.ensureProcessing();
          return;
        }
        // Exceeds 2000 chars — fall through to enqueue as separate item
      }

      const item: QueuedMessage = {
        channelId,
        payload,
        mergeKey,
        priority,
        enqueuedAt: now,
        resolvers: [resolve],
        rejectors: [reject],
      };

      if (priority === 'high') {
        queue.unshift(item);
      } else {
        queue.push(item);
      }

      if (queue.length > this.channelMaxQueueSize) {
        const dropped = this.dropOldest(queue);
        if (dropped) {
          this.rejectMessage(dropped, new Error(`Channel queue overflow: ${channelId}`));
          console.warn(`[DiscordThrottleQueue] Dropped oldest queued message: ${channelId}`);
        }
      }

      this.ensureProcessing();
    });
  }

  stats(): QueueStats {
    const channelQueues = new Map<string, number>();
    let totalQueued = 0;
    for (const [channelId, queue] of this.queues.entries()) {
      if (queue.length > 0) {
        channelQueues.set(channelId, queue.length);
        totalQueued += queue.length;
      }
    }

    return {
      totalQueued,
      channelQueues,
      globalRequestsInLastSecond: this.globalLimiter.requestsInWindow(),
      channelCooldowns: this.channelLimiter.getCooldowns(),
    };
  }

  flush(channelId: string): void {
    const queue = this.queues.get(channelId);
    if (!queue) return;
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) this.rejectMessage(item, new Error(`Channel queue flushed: ${channelId}`));
    }
    this.removeChannelIfEmpty(channelId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [channelId, queue] of this.queues.entries()) {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) this.rejectMessage(item, new Error(`Queue destroyed: ${channelId}`));
      }
    }
    this.queues.clear();
    this.channelOrder.length = 0;
  }

  private ensureQueue(channelId: string): QueuedMessage[] {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = [];
      this.queues.set(channelId, queue);
      this.channelOrder.push(channelId);
    }
    return queue;
  }

  private findMergeTarget(
    queue: QueuedMessage[],
    payload: SendPayload,
    mergeKey: string | undefined,
    now: number,
  ): QueuedMessage | null {
    if (!mergeKey || payload.type !== 'text') return null;
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i];
      if (!item || item.mergeKey !== mergeKey) continue;
      if (item.payload.type !== 'text') continue;
      if (now - item.enqueuedAt >= this.mergeWindowMs) continue;
      return item;
    }
    return null;
  }

  private ensureProcessing(): void {
    if (this.processing || this.processingScheduled || this.destroyed) return;
    this.processingScheduled = true;
    queueMicrotask(() => {
      if (this.processing || this.destroyed) {
        this.processingScheduled = false;
        return;
      }
      this.processingScheduled = false;
      this.processing = true;
      void this.processLoop();
    });
  }

  private async processLoop(): Promise<void> {
    try {
      while (!this.destroyed) {
        await this.globalLimiter.acquire();

        const channelId = await this.pickReadyChannel();
        if (!channelId) break;

        const queue = this.queues.get(channelId);
        if (!queue || queue.length === 0) {
          this.removeChannelIfEmpty(channelId);
          continue;
        }

        const message = queue.shift();
        if (!message) continue;

        await this.channelLimiter.acquire(channelId);

        try {
          await this.executor(channelId, message.payload);
          this.globalLimiter.record();
          this.channelLimiter.record(channelId);
          for (const resolve of message.resolvers) resolve();
        } catch (error) {
          const rateLimit = toRateLimitInfo(error);
          if (rateLimit) {
            if (rateLimit.global) {
              this.globalLimiter.pause(rateLimit.retryAfterMs);
            } else {
              this.channelLimiter.pause(channelId, rateLimit.retryAfterMs);
            }
            queue.unshift(message);
          } else {
            this.rejectMessage(message, toError(error));
          }
        } finally {
          this.removeChannelIfEmpty(channelId);
        }
      }
    } finally {
      this.processing = false;
      if (!this.destroyed && this.channelOrder.length > 0) {
        this.ensureProcessing();
      }
    }
  }

  /** Pick next channel that is not rate-limited. Sleeps if all channels are throttled. */
  private async pickReadyChannel(): Promise<string | null> {
    const len = this.channelOrder.length;
    if (len === 0) return null;

    let minWait = Infinity;
    for (let i = 0; i < len; i++) {
      if (this.rrIndex >= this.channelOrder.length) this.rrIndex = 0;
      const id = this.channelOrder[this.rrIndex];
      this.rrIndex = (this.rrIndex + 1) % this.channelOrder.length;

      if (!id) continue;

      const queue = this.queues.get(id);
      if (!queue || queue.length === 0) {
        this.removeChannelIfEmpty(id);
        return this.pickReadyChannel(); // retry after removal
      }

      const wait = this.channelLimiter.waitTime(id);
      if (wait === 0) return id;
      if (wait < minWait) minWait = wait;
    }

    // All channels rate-limited — sleep until earliest unblock
    if (Number.isFinite(minWait) && minWait > 0) {
      await sleep(minWait);
      return this.pickReadyChannel();
    }
    return null;
  }

  private removeChannelIfEmpty(channelId: string): void {
    const queue = this.queues.get(channelId);
    if (!queue || queue.length > 0) return;

    this.queues.delete(channelId);
    const index = this.channelOrder.indexOf(channelId);
    if (index === -1) return;
    this.channelOrder.splice(index, 1);

    if (this.channelOrder.length === 0) {
      this.rrIndex = 0;
    } else {
      this.rrIndex = Math.min(this.rrIndex, this.channelOrder.length - 1);
    }
  }

  private rejectMessage(message: QueuedMessage, error: Error): void {
    for (const reject of message.rejectors) reject(error);
  }

  private dropOldest(queue: QueuedMessage[]): QueuedMessage | null {
    if (queue.length === 0) return null;
    let oldestIndex = 0;
    const firstItem = queue[0];
    if (!firstItem) return null;
    let oldestAt = firstItem.enqueuedAt;
    for (let i = 1; i < queue.length; i++) {
      const item = queue[i];
      if (item && item.enqueuedAt < oldestAt) {
        oldestAt = item.enqueuedAt;
        oldestIndex = i;
      }
    }
    const [dropped] = queue.splice(oldestIndex, 1);
    return dropped ?? null;
  }
}

type RateLimitInfo = {
  retryAfterMs: number;
  global: boolean;
};

function toRateLimitInfo(error: unknown): RateLimitInfo | null {
  if (!error || typeof error !== 'object') return null;
  const data = error as Record<string, unknown>;
  const status = numberFromUnknown(data.status) ?? numberFromUnknown(data.code);
  if (status !== 429) return null;

  const retryAfterMs = parseRetryAfterMs(data);
  const global = Boolean(data.global || (isRecord(data.rawError) && data.rawError.global));
  return { retryAfterMs, global };
}

function parseRetryAfterMs(data: Record<string, unknown>): number {
  const directMs = numberFromUnknown(data.retryAfterMs);
  if (directMs != null && directMs >= 0) return directMs;

  const retryAfter = numberFromUnknown(data.retry_after ?? data.retryAfter);
  if (retryAfter != null && retryAfter >= 0) {
    if (retryAfter > 1000) return retryAfter;
    return Math.ceil(retryAfter * 1000);
  }

  const rawError = isRecord(data.rawError) ? data.rawError : null;
  const rawRetryAfter = rawError ? numberFromUnknown(rawError.retry_after ?? rawError.retryAfter) : null;
  if (rawRetryAfter != null && rawRetryAfter >= 0) {
    if (rawRetryAfter > 1000) return rawRetryAfter;
    return Math.ceil(rawRetryAfter * 1000);
  }

  return 1_000;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
