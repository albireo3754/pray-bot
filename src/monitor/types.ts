export interface ClaudeProcess {
  pid: number;
  sessionId: string | null;
  cwd: string;
  resumeId: string | null;
  cpuPercent: number;
  memMb: number;
}

export interface SessionSnapshot {
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

  // JSONL path
  jsonlPath: string;
}

export interface MonitorStatus {
  sessions: SessionSnapshot[];
  activeCount: number;
  totalCount: number;
  lastRefresh: Date;
}

// EmbedData type for formatter compatibility
export type EmbedData = Record<string, unknown>;
