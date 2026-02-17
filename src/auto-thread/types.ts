import type { SessionSnapshot } from '../monitor/types.ts';

export interface AutoThreadConfig {
  /** 활성화 여부 (기본 true) */
  enabled: boolean;
  /** 자동 생성 대상 상태 (기본 ['active', 'idle']) */
  targetStates: SessionSnapshot['state'][];
  /** 매칭 실패 시 fallback 채널 ID */
  fallbackChannelId: string | null;
  /** 영속화 파일 경로 목록 */
  storePaths: string[];
  /** 10분 모니터링 로그 활성화 */
  monitorLogEnabled: boolean;
  /** 모니터링 로그 주기(ms) */
  monitorIntervalMs: number;
  /** 세션별 마지막 file-watch 시각 저장 파일 */
  monitorStatePath: string;
  /** 자동 스레드/모니터 로그에서 제외할 projectPath prefix 목록 */
  excludedProjectPathPrefixes: string[];
  /** 쓰레드 생성 시 초기 메시지 전송 여부 */
  sendInitialEmbed: boolean;
  /** 세션 종료(completed) 시 쓰레드 아카이브 여부 */
  archiveOnComplete: boolean;
}

export interface DiscoveredThread {
  sessionId: string;
  threadId: string;
  parentChannelId: string;
  mappingKey: string;
  provider: 'claude';
  cwd: string;
  model: string | null;
  slug: string;
  createdAt: number;
  updatedAt: number;
  autoDiscovered: true;
  worktree?: {
    originalProject: string;
    worktreeName: string;
    task?: string;
  };
}
