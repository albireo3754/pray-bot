import { describe, expect, test } from 'bun:test';
import { determineActivityPhase } from '../activity-phase.ts';
import type { SessionInfo } from '../claude-parser.ts';

function makeInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'test-session',
    slug: 'test',
    cwd: '/tmp/project',
    gitBranch: 'main',
    version: '1.0.0',
    model: 'claude-sonnet-4',
    turnCount: 1,
    lastUserMessage: null,
    currentTools: [],
    tokens: { input: 0, output: 0, cached: 0 },
    startedAt: new Date(),
    lastActivity: new Date(),
    waitReason: null,
    waitToolNames: [],
    activityPhase: null,
    lastAssistantStopReason: null,
    ...overrides,
  };
}

describe('determineActivityPhase', () => {
  test('returns waiting_question when waitReason is user_question', () => {
    const info = makeInfo({ waitReason: 'user_question', waitToolNames: ['AskUserQuestion'] });
    expect(determineActivityPhase(info)).toBe('waiting_question');
  });

  test('returns waiting_permission when waitReason is permission', () => {
    const info = makeInfo({ waitReason: 'permission', waitToolNames: ['Bash', 'Edit'] });
    expect(determineActivityPhase(info)).toBe('waiting_permission');
  });

  test('returns interactable when last assistant stop_reason is end_turn with no pending tools', () => {
    const info = makeInfo({
      lastAssistantStopReason: 'end_turn',
      waitToolNames: [],
    });
    expect(determineActivityPhase(info)).toBe('interactable');
  });

  test('returns busy when last assistant has no stop_reason (streaming)', () => {
    const info = makeInfo({
      lastAssistantStopReason: null,
      waitToolNames: [],
    });
    expect(determineActivityPhase(info)).toBe('busy');
  });

  test('returns busy when last entry is user (tool_result)', () => {
    // After user sends tool_result, next turn hasn't started yet
    // lastAssistantStopReason would be from previous assistant, but Claude is processing
    const info = makeInfo({
      lastAssistantStopReason: null,
      waitToolNames: [],
    });
    expect(determineActivityPhase(info)).toBe('busy');
  });

  test('waiting_question takes priority over end_turn', () => {
    // Edge case: waitReason set but also end_turn
    const info = makeInfo({
      waitReason: 'user_question',
      waitToolNames: ['AskUserQuestion'],
      lastAssistantStopReason: 'end_turn',
    });
    expect(determineActivityPhase(info)).toBe('waiting_question');
  });

  test('waiting_permission takes priority over end_turn', () => {
    const info = makeInfo({
      waitReason: 'permission',
      waitToolNames: ['Bash'],
      lastAssistantStopReason: 'end_turn',
    });
    expect(determineActivityPhase(info)).toBe('waiting_permission');
  });

  test('returns busy when stop_reason is tool_use', () => {
    const info = makeInfo({
      lastAssistantStopReason: 'tool_use',
      waitToolNames: [],
    });
    expect(determineActivityPhase(info)).toBe('busy');
  });
});
