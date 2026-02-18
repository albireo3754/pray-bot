// ── v1 types ─────────────────────────────────────────────────────────────

export type SessionLifecyclePhase = 'started' | 'ended' | 'waiting_permission' | 'waiting_question';
export type SkillLifecyclePhase = 'in_progress' | 'completed';

export type SessionLifecycleEvent = {
  id: string;
  eventType: 'session.lifecycle';
  phase: SessionLifecyclePhase;
  occurredAtIso: string;
  sessionId: string;
  provider: 'claude' | 'codex' | 'unknown';
  projectPath: string | null;
  cwd: string | null;
};

export type SkillLifecycleEvent = {
  id: string;
  eventType: 'skill.lifecycle';
  phase: SkillLifecyclePhase;
  occurredAtIso: string;
  sessionId: string;
  provider: 'claude' | 'codex' | 'unknown';
  projectPath: string | null;
  skillName: string;
  triggerCommand: string | null;
  turnSeq: number | null;
  targetDocPath: string | null;
};

// ── v2 types ─────────────────────────────────────────────────────────────

/**
 * 매 Claude 턴 완료 시 발동 (Stop hook).
 * consumer가 transcriptPath를 읽어 rich data를 DB에 추가 저장한다.
 */
export type TurnEndEvent = {
  id: string;
  eventType: 'turn.end';
  occurredAtIso: string;
  sessionId: string;
  provider: 'claude' | 'codex' | 'unknown';
  projectPath: string | null;
  /** Claude Code Stop hook stdin의 transcript_path. consumer가 tailJsonl에 사용. */
  transcriptPath: string | null;
};

/**
 * 사용자 입력 전송 시 발동 (UserPromptSubmit hook).
 */
export type TurnStartEvent = {
  id: string;
  eventType: 'turn.start';
  occurredAtIso: string;
  sessionId: string;
  provider: 'claude' | 'codex' | 'unknown';
  projectPath: string | null;
  /** UserPromptSubmit hook stdin의 prompt 필드. */
  prompt: string | null;
};


// ── Union ─────────────────────────────────────────────────────────────────

export type LifecycleEvent =
  | SessionLifecycleEvent
  | SkillLifecycleEvent
  | TurnEndEvent
  | TurnStartEvent;
