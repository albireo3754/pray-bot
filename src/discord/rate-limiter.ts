type ChannelBucket = {
  timestamps: number[];
  pausedUntil: number;
};

export class ChannelRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  private readonly buckets = new Map<string, ChannelBucket>();

  constructor(options?: { maxRequests?: number; windowMs?: number }) {
    this.maxRequests = options?.maxRequests ?? 5;
    this.windowMs = options?.windowMs ?? 5_000;
  }

  async acquire(channelId: string): Promise<void> {
    const waitMs = this.waitTime(channelId);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  record(channelId: string): void {
    const now = Date.now();
    const bucket = this.getOrCreateBucket(channelId);
    bucket.timestamps = this.prune(bucket.timestamps, now);
    bucket.timestamps.push(now);
  }

  waitTime(channelId: string): number {
    const now = Date.now();
    const bucket = this.getOrCreateBucket(channelId);
    bucket.timestamps = this.prune(bucket.timestamps, now);

    const pauseWait = Math.max(0, bucket.pausedUntil - now);
    if (pauseWait > 0) return pauseWait;

    if (bucket.timestamps.length < this.maxRequests) return 0;

    const first = bucket.timestamps[0];
    if (first === undefined) return 0;
    const remaining = this.windowMs - (now - first);
    return Math.max(0, remaining);
  }

  pause(channelId: string, retryAfterMs: number): void {
    const bucket = this.getOrCreateBucket(channelId);
    bucket.pausedUntil = Math.max(bucket.pausedUntil, Date.now() + Math.max(0, retryAfterMs));
  }

  getCooldowns(now = Date.now()): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [channelId, bucket] of this.buckets.entries()) {
      const remaining = bucket.pausedUntil - now;
      if (remaining > 0) {
        result[channelId] = remaining;
      }
    }
    return result;
  }

  private getOrCreateBucket(channelId: string): ChannelBucket {
    let bucket = this.buckets.get(channelId);
    if (!bucket) {
      bucket = { timestamps: [], pausedUntil: 0 };
      this.buckets.set(channelId, bucket);
    }
    return bucket;
  }

  private prune(timestamps: number[], now: number): number[] {
    const threshold = now - this.windowMs;
    return timestamps.filter((ts) => ts > threshold);
  }
}

export class GlobalRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  private timestamps: number[] = [];
  private pausedUntil = 0;

  constructor(options?: { maxRequests?: number; windowMs?: number }) {
    this.maxRequests = options?.maxRequests ?? 50;
    this.windowMs = options?.windowMs ?? 1_000;
  }

  async acquire(): Promise<void> {
    const waitMs = this.waitTime();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  record(): void {
    const now = Date.now();
    this.timestamps = this.prune(this.timestamps, now);
    this.timestamps.push(now);
  }

  pause(retryAfterMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.max(0, retryAfterMs));
  }

  requestsInWindow(now = Date.now()): number {
    this.timestamps = this.prune(this.timestamps, now);
    return this.timestamps.length;
  }

  private waitTime(now = Date.now()): number {
    this.timestamps = this.prune(this.timestamps, now);
    const pauseWait = Math.max(0, this.pausedUntil - now);
    if (pauseWait > 0) return pauseWait;
    if (this.timestamps.length < this.maxRequests) return 0;
    const first = this.timestamps[0];
    if (first === undefined) return 0;
    const remaining = this.windowMs - (now - first);
    return Math.max(0, remaining);
  }

  private prune(timestamps: number[], now: number): number[] {
    const threshold = now - this.windowMs;
    return timestamps.filter((ts) => ts > threshold);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
