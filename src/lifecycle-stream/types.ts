export type SessionLifecyclePhase = 'started' | 'ended';
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

export type LifecycleEvent = SessionLifecycleEvent | SkillLifecycleEvent;
