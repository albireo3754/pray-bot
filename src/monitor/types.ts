/**
 * Active 세션 내 세부 활동 단계.
 * state === 'active' 일 때만 의미 있음.
 * completed/stale/idle에서는 항상 null.
 */
export type ActivityPhase =
  | 'busy'                // LLM 응답 생성 중 또는 Tool 실행 중
  | 'interactable'        // Turn 완료, 사용자 입력 대기 중
  | 'waiting_permission'  // Tool 승인 대기
  | 'waiting_question';   // AskUserQuestion 응답 대기

export interface ClaudeProcess {
  pid: number;
  sessionId: string | null;
  cwd: string;
  resumeId: string | null;
  cpuPercent: number;
  memMb: number;
}

export interface SessionSnapshot {
  provider?: 'claude' | 'codex';
  sessionId: string;
  projectPath: string;
  projectName: string;
  slug: string;
  state: 'active' | 'idle' | 'completed' | 'stale';

  // Process
  pid: number | null;
  cpuPercent: number | null;
  memMb: number | null;

  // Conversation context
  model: string | null;
  gitBranch: string | null;
  version: string | null;
  turnCount: number;
  lastUserMessage: string | null;
  currentTools: string[];

  // Tokens
  tokens: { input: number; output: number; cached: number };

  // Waiting state
  waitReason: 'user_question' | 'permission' | null;
  waitToolNames: string[];

  // Timing
  startedAt: Date | null;
  lastActivity: Date;

  // Activity phase (active sessions only)
  activityPhase: ActivityPhase | null;

  // JSONL path
  jsonlPath: string;

  // Codex-only metadata
  originator?: string | null;
  source?: string | null;
}

export interface MonitorStatus {
  sessions: SessionSnapshot[];
  activeCount: number;
  totalCount: number;
  lastRefresh: Date;
}

// EmbedData type for formatter compatibility
export type EmbedData = Record<string, unknown>;
