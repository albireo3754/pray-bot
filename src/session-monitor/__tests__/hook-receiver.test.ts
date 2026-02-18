import { describe, expect, test, mock, beforeEach } from 'bun:test';
import {
  createHookRoute,
  extractLastAssistantResponse,
  type HookAcceptingMonitor,
  type AnyHookEvent,
  type SessionStartHookEvent,
} from '../hook-receiver.ts';
import type { SessionSnapshot, ActivityPhase } from '../types.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

// ── Mock HookAcceptingMonitor ─────────────────────────────────────

function createMockMonitor() {
  const phases = new Map<string, ActivityPhase>();
  const states = new Map<string, SessionSnapshot['state']>();
  const registered: SessionStartHookEvent[] = [];

  const monitor: HookAcceptingMonitor = {
    updateActivityPhase: mock((sessionId: string, phase: ActivityPhase) => {
      phases.set(sessionId, phase);
    }),
    updateSessionState: mock((sessionId: string, state: SessionSnapshot['state']) => {
      states.set(sessionId, state);
    }),
    registerSession: mock((event: SessionStartHookEvent): SessionSnapshot => {
      registered.push(event);
      return {
        provider: 'claude',
        sessionId: event.session_id,
        projectPath: event.cwd,
        projectName: event.cwd.split('/').pop() || 'unknown',
        slug: event.session_id.slice(0, 8),
        state: 'active',
        pid: null,
        cpuPercent: null,
        memMb: null,
        model: event.model ?? null,
        gitBranch: null,
        version: null,
        turnCount: 0,
        lastUserMessage: null,
        currentTools: [],
        tokens: { input: 0, output: 0, cached: 0 },
        waitReason: null,
        waitToolNames: [],
        startedAt: new Date(),
        lastActivity: new Date(),
        activityPhase: 'busy',
        jsonlPath: event.transcript_path || '',
      };
    }),
  };

  return { monitor, phases, states, registered };
}

// ── Mock AutoThreadDiscovery ──────────────────────────────────────

function createMockAutoThread() {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    autoThread: {
      onSessionStart: mock(async (_snapshot: SessionSnapshot) => {
        calls.push({ method: 'onSessionStart', args: [_snapshot] });
      }),
      sendToSessionThread: mock(async (_provider: string, _sessionId: string, _message: string) => {
        calls.push({ method: 'sendToSessionThread', args: [_provider, _sessionId, _message] });
        return true;
      }),
    } as any,
    calls,
  };
}

// ── Helper ────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AnyHookEvent> & { hook_event_name: string }): AnyHookEvent {
  return {
    session_id: 'test-session-123',
    cwd: '/tmp/test-project',
    transcript_path: '/tmp/transcript.jsonl',
    provider: 'claude',
    ...overrides,
  } as AnyHookEvent;
}

async function postHook(route: ReturnType<typeof createHookRoute>, body: unknown): Promise<Response> {
  const req = new Request('http://localhost:4488/api/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

// ── createHookRoute Tests ─────────────────────────────────────────

describe('createHookRoute', () => {
  let providers: Map<string, HookAcceptingMonitor>;
  let mockMonitor: ReturnType<typeof createMockMonitor>;
  let mockAutoThread: ReturnType<typeof createMockAutoThread>;

  beforeEach(() => {
    mockMonitor = createMockMonitor();
    mockAutoThread = createMockAutoThread();
    providers = new Map([['claude', mockMonitor.monitor]]);
  });

  test('returns POST /api/hook route definition', () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    expect(route.method).toBe('POST');
    expect(route.path).toBe('/api/hook');
    expect(typeof route.handler).toBe('function');
  });

  test('returns 400 for invalid JSON', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    const req = new Request('http://localhost:4488/api/hook', {
      method: 'POST',
      body: 'not json{{{',
    });
    const res = await route.handler(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid JSON');
  });

  test('returns 400 for missing required fields', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    const res = await postHook(route, { foo: 42 });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('missing required fields');
  });

  test('returns 400 for missing session_id', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    const res = await postHook(route, { hook_event_name: 'Stop' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('missing required fields');
  });

  test('returns 400 for unknown provider', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    const res = await postHook(route, makeEvent({
      hook_event_name: 'Stop',
      provider: 'codex' as any,
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unknown provider');
  });

  test('returns 200 for valid Stop event', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    const res = await postHook(route, makeEvent({
      hook_event_name: 'Stop',
      transcript_path: '', // no transcript to avoid file I/O
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test('Stop event updates activityPhase to interactable', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    await postHook(route, makeEvent({
      hook_event_name: 'Stop',
      transcript_path: '',
    }));
    // Wait for fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMonitor.monitor.updateActivityPhase).toHaveBeenCalledWith('test-session-123', 'interactable');
  });

  test('UserPromptSubmit event updates activityPhase to busy', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    await postHook(route, makeEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    } as any));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMonitor.monitor.updateActivityPhase).toHaveBeenCalledWith('test-session-123', 'busy');
  });

  test('SessionStart event calls registerSession and autoThread.onSessionStart', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    await postHook(route, makeEvent({
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-4',
    } as any));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMonitor.monitor.registerSession).toHaveBeenCalled();
    expect(mockAutoThread.autoThread.onSessionStart).toHaveBeenCalled();
  });

  test('SessionEnd event updates state to completed', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    await postHook(route, makeEvent({
      hook_event_name: 'SessionEnd',
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMonitor.monitor.updateSessionState).toHaveBeenCalledWith('test-session-123', 'completed');
  });

  test('Notification permission_prompt updates to waiting_permission', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    await postHook(route, makeEvent({
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Allow Bash?',
    } as any));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMonitor.monitor.updateActivityPhase).toHaveBeenCalledWith('test-session-123', 'waiting_permission');
  });

  test('Notification idle_prompt updates to waiting_question', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    await postHook(route, makeEvent({
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'What should I do?',
    } as any));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMonitor.monitor.updateActivityPhase).toHaveBeenCalledWith('test-session-123', 'waiting_question');
  });

  test('defaults provider to claude when not specified', async () => {
    const route = createHookRoute(providers, mockAutoThread.autoThread);
    const event = makeEvent({ hook_event_name: 'Stop', transcript_path: '' });
    delete (event as any).provider;
    const res = await postHook(route, event);
    expect(res.status).toBe(200);
  });
});

// ── extractLastAssistantResponse Tests ────────────────────────────

describe('extractLastAssistantResponse', () => {
  function writeTempJsonl(lines: object[]): string {
    const path = join(tmpdir(), `test-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    writeFileSync(path, content);
    return path;
  }

  test('returns null for non-existent file', async () => {
    const result = await extractLastAssistantResponse('/tmp/nonexistent-transcript.jsonl');
    expect(result).toBeNull();
  });

  test('returns null for empty file', async () => {
    const path = writeTempJsonl([]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBeNull();
  });

  test('returns null when no assistant entries', async () => {
    const path = writeTempJsonl([
      { type: 'user', message: { role: 'user', content: 'hello' } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBeNull();
  });

  test('extracts text from last assistant message', async () => {
    const path = writeTempJsonl([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help?' }] } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBe('Hello! How can I help?');
  });

  test('ignores tool_use blocks', async () => {
    const path = writeTempJsonl([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Bash', id: 'abc' },
      ] } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBeNull();
  });

  test('extracts only text blocks, ignoring tool_use', async () => {
    const path = writeTempJsonl([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', name: 'Read', id: 'xyz' },
      ] } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBe('Let me check.');
  });

  test('returns last assistant entry (not first)', async () => {
    const path = writeTempJsonl([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] } },
      { type: 'user', message: { role: 'user', content: 'next question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }] } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBe('Second response');
  });

  test('truncates to maxLength', async () => {
    const longText = 'A'.repeat(2000);
    const path = writeTempJsonl([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
    ]);
    const result = await extractLastAssistantResponse(path, 100);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(103); // 100 + '...'
    expect(result!.endsWith('...')).toBe(true);
  });

  test('returns null when assistant has only thinking blocks', async () => {
    const path = writeTempJsonl([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', text: 'internal reasoning...' },
      ] } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBeNull();
  });

  test('skips assistant with only tool_use, finds previous with text', async () => {
    const path = writeTempJsonl([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier response' }] } },
      { type: 'user', message: { role: 'user', content: 'ok' } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Bash', id: 'abc' },
      ] } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBe('Earlier response');
  });

  test('concatenates multiple text blocks', async () => {
    const path = writeTempJsonl([
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'First part.' },
        { type: 'text', text: 'Second part.' },
      ] } },
    ]);
    const result = await extractLastAssistantResponse(path);
    expect(result).toBe('First part.\nSecond part.');
  });
});
