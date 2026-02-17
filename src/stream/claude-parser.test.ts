import { describe, expect, it } from 'bun:test';
import {
  computeClaudeAssistantDelta,
  computeClaudeFinalRemainder,
  extractClaudeUxEventsFromLine,
} from './claude-parser.ts';

describe('computeClaudeAssistantDelta', () => {
  it('emits only incremental delta for growing assistant snapshots', () => {
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });

    const first = computeClaudeAssistantDelta(line1, '');
    expect(first.delta).toBe('Hello');
    expect(first.nextSnapshot).toBe('Hello');

    const second = computeClaudeAssistantDelta(line2, first.nextSnapshot);
    expect(second.delta).toBe('world');
    expect(second.nextSnapshot).toBe('Hello world');
  });

  it('ignores non-assistant events', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'done',
    });
    const parsed = computeClaudeAssistantDelta(line, 'Hello');
    expect(parsed.delta).toBe('');
    expect(parsed.nextSnapshot).toBe('Hello');
  });

  it('falls back to full text when snapshot is not a prefix', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Different answer' }] },
    });
    const parsed = computeClaudeAssistantDelta(line, 'Hello world');
    expect(parsed.delta).toBe('Different answer');
    expect(parsed.nextSnapshot).toBe('Different answer');
  });

  it('ignores malformed JSON lines', () => {
    const parsed = computeClaudeAssistantDelta('{not-json}', 'Hello');
    expect(parsed.delta).toBe('');
    expect(parsed.nextSnapshot).toBe('Hello');
  });
});

describe('computeClaudeFinalRemainder', () => {
  it('returns empty when streamed and final text differ only by whitespace', () => {
    const streamed = '현재 작업 디렉토리의 코드베이스를 파악하겠습니다.';
    const final = '현재  작업 디렉토리의 코드베이스를   파악하겠습니다.';
    expect(computeClaudeFinalRemainder(streamed, final)).toBe('');
  });

  it('returns only appended tail when final starts with streamed content', () => {
    const streamed = 'line1\nline2';
    const final = 'line1\nline2\nline3';
    expect(computeClaudeFinalRemainder(streamed, final)).toBe('line3');
  });

  it('returns final text when streamed snapshot does not match', () => {
    const streamed = 'A';
    const final = 'B';
    expect(computeClaudeFinalRemainder(streamed, final)).toBe('B');
  });
});

describe('extractClaudeUxEventsFromLine', () => {
  it('extracts thinking and tool_result events from assistant content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'tool_result', tool_use_id: 'toolu_1234567890', is_error: false },
        ],
      },
    });
    const events = extractClaudeUxEventsFromLine(line);
    expect(events.map((e) => e.key)).toEqual(['thinking', 'tool_result:toolu_1234567890']);
  });

  it('extracts stream lifecycle and thinking delta events', () => {
    const start = JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start' },
    });
    const delta = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: '...' },
      },
    });
    expect(extractClaudeUxEventsFromLine(start).map((e) => e.key)).toEqual(['lifecycle:message_start']);
    expect(extractClaudeUxEventsFromLine(delta).map((e) => e.key)).toEqual(['thinking:delta']);
  });

  it('extracts AskUserQuestion requirement from result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      permission_denials: [
        { tool_name: 'AskUserQuestion', tool_input: { questions: [] } },
      ],
    });
    const keys = extractClaudeUxEventsFromLine(line).map((e) => e.key);
    expect(keys).toContain('result:success');
    expect(keys).toContain('needs-user-input');
  });

  it('marks AskUserQuestion event as warn and immediate', () => {
    const line = JSON.stringify({
      type: 'result',
      permission_denials: [{ tool_name: 'AskUserQuestion' }],
    });
    const events = extractClaudeUxEventsFromLine(line);
    const ask = events.find((e) => e.key === 'needs-user-input');
    expect(ask?.severity).toBe('warn');
    expect(ask?.immediate).toBe(true);
  });

  it('marks assistant tool_result error as severity error', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_err', is_error: true }],
      },
    });
    const events = extractClaudeUxEventsFromLine(line);
    expect(events[0]?.severity).toBe('error');
  });
});
