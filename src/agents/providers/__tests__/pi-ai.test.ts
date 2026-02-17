import { expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { PiAiProvider, PiAiSession } from '../pi-ai.ts';
import type { AgentEvent } from '../../types.ts';

// -- Helpers --

/** Create a mock Thread that yields given events from runStreamed */
function createMockThread(events: any[] = []) {
  return {
    runStreamed: mock(async (_msg: string) => ({
      events: (async function* () {
        for (const e of events) yield e;
      })(),
    })),
  };
}

/** Collect all AgentEvents from an async iterable */
async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const e of iter) result.push(e);
  return result;
}

// -- PiAiProvider tests --

let savedEnv: { PIAI_API_KEY?: string; PIAI_BASE_URL?: string; PIAI_MODEL?: string };

beforeEach(() => {
  savedEnv = {
    PIAI_API_KEY: process.env.PIAI_API_KEY,
    PIAI_BASE_URL: process.env.PIAI_BASE_URL,
    PIAI_MODEL: process.env.PIAI_MODEL,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('isAvailable returns false when PIAI_API_KEY is not set', () => {
  delete process.env.PIAI_API_KEY;
  const provider = new PiAiProvider();
  expect(provider.isAvailable()).toBe(false);
});

test('isAvailable returns true when PIAI_API_KEY is set', () => {
  process.env.PIAI_API_KEY = 'test-key';
  const provider = new PiAiProvider();
  expect(provider.isAvailable()).toBe(true);
});

test('createSession throws when not initialized', async () => {
  const provider = new PiAiProvider();
  expect(provider.createSession({})).rejects.toThrow('PiAiProvider not initialized');
});

test('provider id and name', () => {
  const provider = new PiAiProvider();
  expect(provider.id).toBe('pi-ai');
  expect(provider.name).toBe('Pi-AI');
});

test('capabilities returns expected values', () => {
  const provider = new PiAiProvider();
  const caps = provider.capabilities();
  expect(caps.streaming).toBe(true);
  expect(caps.multiTurn).toBe(true);
  expect(caps.toolUse).toBe(false);
  expect(caps.sessionResume).toBe(false);
  expect(caps.mcp).toBe(false);
  expect(caps.sandbox).toBe(false);
});

// -- PiAiSession tests --

test('initial status is idle with zero counts', () => {
  const thread = createMockThread();
  const session = new PiAiSession(thread as any);

  expect(session.providerId).toBe('pi-ai');
  const status = session.getStatus();
  expect(status.state).toBe('idle');
  expect(status.turnCount).toBe(0);
  expect(status.totalTokens).toEqual({ input: 0, output: 0, cached: 0 });
  expect(status.lastActivity).toBeNull();
});

test('send converts agent_message + turn.completed events', async () => {
  const thread = createMockThread([
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hi' },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  ]);

  const session = new PiAiSession(thread as any);
  const events = await collect(session.send('hello'));

  expect(events).toEqual([
    { type: 'text', text: 'hi', partial: false },
    {
      type: 'turn_complete',
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      costUsd: null,
      turnIndex: 0,
    },
  ]);
});

test('status updates after send completes', async () => {
  const thread = createMockThread([
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ]);

  const session = new PiAiSession(thread as any);
  await collect(session.send('hello'));

  const status = session.getStatus();
  expect(status.state).toBe('idle');
  expect(status.turnCount).toBe(1);
  expect(status.totalTokens.input).toBe(10);
  expect(status.totalTokens.output).toBe(5);
});

test('close sets state to closed', async () => {
  const thread = createMockThread();
  const session = new PiAiSession(thread as any);

  await session.close();
  expect(session.getStatus().state).toBe('closed');
});

test('send converts reasoning event', async () => {
  const thread = createMockThread([
    {
      type: 'item.completed',
      item: { type: 'reasoning', text: 'thinking...' },
    },
    { type: 'turn.completed', usage: {} },
  ]);

  const session = new PiAiSession(thread as any);
  const events = await collect(session.send('test'));

  expect(events[0]).toEqual({ type: 'reasoning', text: 'thinking...' });
});

test('send converts todo_list event', async () => {
  const thread = createMockThread([
    {
      type: 'item.updated',
      item: {
        type: 'todo_list',
        items: [
          { text: 'step 1', completed: true, in_progress: false },
          { text: 'step 2', completed: false, in_progress: true },
          { text: 'step 3', completed: false, in_progress: false },
        ],
      },
    },
    { type: 'turn.completed', usage: {} },
  ]);

  const session = new PiAiSession(thread as any);
  const events = await collect(session.send('test'));

  expect(events[0]).toEqual({
    type: 'todo',
    items: [
      { content: 'step 1', status: 'completed' },
      { content: 'step 2', status: 'in_progress' },
      { content: 'step 3', status: 'pending' },
    ],
  });
});

test('send converts turn.failed to error event', async () => {
  const thread = createMockThread([
    {
      type: 'turn.failed',
      error: { message: 'API error' },
    },
  ]);

  const session = new PiAiSession(thread as any);
  const events = await collect(session.send('test'));

  expect(events[0]).toEqual({
    type: 'error',
    message: 'API error',
    recoverable: false,
  });
});

test('empty agent_message text is skipped', async () => {
  const thread = createMockThread([
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '  ' },
    },
    { type: 'turn.completed', usage: {} },
  ]);

  const session = new PiAiSession(thread as any);
  const events = await collect(session.send('test'));

  // Only turn_complete, no text event
  expect(events.length).toBe(1);
  expect(events[0]!.type).toBe('turn_complete');
});

test('token accumulation across multiple sends', async () => {
  const makeEvents = (input: number, output: number, cached: number) => [
    {
      type: 'turn.completed',
      usage: {
        input_tokens: input,
        output_tokens: output,
        input_tokens_details: { cached_tokens: cached },
      },
    },
  ];

  const thread = {
    runStreamed: mock()
      .mockResolvedValueOnce({
        events: (async function* () { for (const e of makeEvents(10, 5, 2)) yield e; })(),
      })
      .mockResolvedValueOnce({
        events: (async function* () { for (const e of makeEvents(20, 10, 3)) yield e; })(),
      }),
  };

  const session = new PiAiSession(thread as any);
  await collect(session.send('first'));
  await collect(session.send('second'));

  const status = session.getStatus();
  expect(status.turnCount).toBe(2);
  expect(status.totalTokens).toEqual({ input: 30, output: 15, cached: 5 });
});

test('send propagates runStreamed exception and still increments turnCount', async () => {
  const thread = {
    runStreamed: mock(async () => { throw new Error('Network error'); }),
  };
  const session = new PiAiSession(thread as any);

  await expect(collect(session.send('hello'))).rejects.toThrow('Network error');

  const status = session.getStatus();
  expect(status.state).toBe('idle'); // finally block ran
  expect(status.turnCount).toBe(1); // incremented in finally
});

test('getStatus returns deep copy of totalTokens', async () => {
  const thread = createMockThread([
    {
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);

  const session = new PiAiSession(thread as any);
  await collect(session.send('test'));

  const snapshot = session.getStatus();
  snapshot.totalTokens.input = 999;

  // Internal state should not be affected
  expect(session.getStatus().totalTokens.input).toBe(10);
});
