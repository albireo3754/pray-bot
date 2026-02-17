import { expect, test } from 'bun:test';
import { DiscordThrottleQueue } from './throttle-queue.ts';
import type { SendPayload } from './types.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('DiscordThrottleQueue merges text messages with same mergeKey', async () => {
  const sent: Array<{ channelId: string; payload: SendPayload }> = [];
  const queue = new DiscordThrottleQueue({
    executor: async (channelId, payload) => {
      sent.push({ channelId, payload });
    },
    mergeWindowMs: 300,
  });

  await Promise.all([
    queue.send('c1', { type: 'text', content: 'a' }, { mergeKey: 'm1' }),
    queue.send('c1', { type: 'text', content: 'b' }, { mergeKey: 'm1' }),
  ]);

  expect(sent.length).toBe(1);
  expect(sent[0]?.payload.type).toBe('text');
  if (sent[0]?.payload.type === 'text') {
    expect(sent[0].payload.content).toBe('a\nb');
  }
});

test('DiscordThrottleQueue prioritizes high priority within queued messages', async () => {
  const sent: string[] = [];
  const queue = new DiscordThrottleQueue({
    executor: async (_channelId, payload) => {
      if (payload.type === 'text') sent.push(payload.content);
      await sleep(20);
    },
  });

  const p1 = queue.send('c1', { type: 'text', content: 'first' });
  const p2 = queue.send('c1', { type: 'text', content: 'normal' });
  const p3 = queue.send('c1', { type: 'text', content: 'high' }, { priority: 'high' });
  await Promise.all([p1, p2, p3]);

  expect(sent).toEqual(['high', 'first', 'normal']);
});

test('DiscordThrottleQueue drops oldest queued item when channel queue overflows', async () => {
  const seen: string[] = [];
  const queue = new DiscordThrottleQueue({
    executor: async (_channelId, payload) => {
      if (payload.type === 'text') {
        seen.push(payload.content);
      }
    },
    channelMaxQueueSize: 2,
  });

  const p1 = queue.send('c1', { type: 'text', content: 'first' });
  const p2 = queue.send('c1', { type: 'text', content: 'second' });
  const p3 = queue.send('c1', { type: 'text', content: 'third' });
  const p4 = queue.send('c1', { type: 'text', content: 'fourth' });

  const [r1, r2, r3, r4] = await Promise.all([
    p1.then(() => 'ok').catch((err) => String(err?.message ?? err)),
    p2.then(() => 'ok').catch((err) => String(err?.message ?? err)),
    p3.then(() => 'ok').catch((err) => String(err?.message ?? err)),
    p4.then(() => 'ok').catch((err) => String(err?.message ?? err)),
  ]);

  expect(r1).toContain('Channel queue overflow');
  expect(r2).toContain('Channel queue overflow');
  expect(r3).toBe('ok');
  expect(r4).toBe('ok');
  expect(seen).toEqual(['third', 'fourth']);
});

test('DiscordThrottleQueue retries message on 429 errors', async () => {
  let attempts = 0;
  const queue = new DiscordThrottleQueue({
    executor: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw { status: 429, retry_after: 0.01, global: false };
      }
    },
  });

  await queue.send('c1', { type: 'text', content: 'hello' });
  expect(attempts).toBe(2);
});

test('DiscordThrottleQueue re-queues 429 message at front (before other pending)', async () => {
  const sent: string[] = [];
  let firstAttempt = true;
  const queue = new DiscordThrottleQueue({
    executor: async (_channelId, payload) => {
      if (payload.type === 'text' && payload.content === 'first' && firstAttempt) {
        firstAttempt = false;
        throw { status: 429, retry_after: 0.01, global: false };
      }
      if (payload.type === 'text') sent.push(payload.content);
    },
  });

  await Promise.all([
    queue.send('c1', { type: 'text', content: 'first' }),
    queue.send('c1', { type: 'text', content: 'second' }),
  ]);

  // 'first' should be retried before 'second'
  expect(sent).toEqual(['first', 'second']);
});

test('DiscordThrottleQueue skips merge when result exceeds 2000 chars', async () => {
  const sent: Array<{ channelId: string; payload: SendPayload }> = [];
  const queue = new DiscordThrottleQueue({
    executor: async (channelId, payload) => {
      sent.push({ channelId, payload });
    },
    mergeWindowMs: 500,
  });

  const longA = 'a'.repeat(1500);
  const longB = 'b'.repeat(600); // 1500 + 1 (\n) + 600 = 2101 > 2000

  await Promise.all([
    queue.send('c1', { type: 'text', content: longA }, { mergeKey: 'mk' }),
    queue.send('c1', { type: 'text', content: longB }, { mergeKey: 'mk' }),
  ]);

  // Should be sent as 2 separate messages, not merged
  expect(sent.length).toBe(2);
  if (sent[0]?.payload.type === 'text') {
    expect(sent[0].payload.content).toBe(longA);
  }
  if (sent[1]?.payload.type === 'text') {
    expect(sent[1].payload.content).toBe(longB);
  }
});
