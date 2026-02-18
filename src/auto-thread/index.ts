import type { SessionSnapshot, ActivityPhase } from '../session-monitor/types.ts';
import type { SessionMonitorProvider } from '../session-monitor/index.ts';
import type { ChannelRegistry } from '../discord/channel-registry.ts';
import type { DiscordClient } from '../discord/client.ts';
import type { ChannelMapping } from '../discord/types.ts';
import { resolveMappingForSession, extractOriginalProjectFromWorktree } from './resolver.ts';
import { AutoThreadStore } from './store.ts';
import { AutoThreadMonitorStateStore } from './monitor-state-store.ts';
import { buildMonitorLogMessage } from './monitor-log.ts';
import { formatInitialEmbed, formatStateChangeMessage, formatActivityPhaseChangeMessage } from './formatter.ts';
import type { AutoThreadConfig, DiscoveredThread } from './types.ts';

type DiscordThreadRoute = {
  threadId: string;
  parentChannelId: string;
  mappingKey: string;
  provider: 'codex' | 'codex-app-server' | 'claude';
  providerSessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  autoDiscovered?: boolean;
};

type AutoThreadProvider = 'claude' | 'codex';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotProvider(snapshot: SessionSnapshot, fallback: AutoThreadProvider = 'claude'): AutoThreadProvider {
  return snapshot.provider === 'codex' ? 'codex' : fallback;
}

function discoveredProvider(item: DiscoveredThread): AutoThreadProvider {
  return item.provider === 'codex' ? 'codex' : 'claude';
}

function buildSessionKey(provider: AutoThreadProvider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

function buildSnapshotKey(snapshot: SessionSnapshot, fallback: AutoThreadProvider = 'claude'): string {
  return buildSessionKey(snapshotProvider(snapshot, fallback), snapshot.sessionId);
}

function buildDiscoveredKey(item: DiscoveredThread): string {
  return buildSessionKey(discoveredProvider(item), item.sessionId);
}

function buildThreadName(snapshot: SessionSnapshot): string {
  const provider = snapshotProvider(snapshot);
  const model = (snapshot.model ?? provider).toLowerCase().replace(/[^a-z0-9-]/g, '-') || provider;

  const worktreeInfo = extractOriginalProjectFromWorktree(snapshot.projectPath);
  if (worktreeInfo) {
    // Worktree: {model}-{originalProject}-{worktreeName}
    const originalProject = worktreeInfo.originalName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const worktreeName = worktreeInfo.worktreeName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `${model}-${originalProject}-${worktreeName}`.slice(0, 90);
  }

  // Non-worktree: {model}-{project}-{slug}
  const project = snapshot.projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'project';
  const slug = snapshot.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-') || snapshot.sessionId.slice(0, 8);
  return `${model}-${project}-${slug}`.slice(0, 90);
}

export class AutoThreadDiscovery {
  /** provider:sessionId -> DiscoveredThread */
  private discoveredMap = new Map<string, DiscoveredThread>();
  /** Guard against concurrent createThreadForSession for same session */
  private pendingCreations = new Set<string>();
  /** provider:sessionId set from previous refresh */
  private knownSessionIds = new Set<string>();
  /** provider:sessionId -> state */
  private knownStates = new Map<string, SessionSnapshot['state']>();
  /** provider:sessionId -> activityPhase */
  private previousActivityPhases = new Map<string, ActivityPhase | null>();
  private store: AutoThreadStore;
  private monitorStateStore: AutoThreadMonitorStateStore;
  private lastWatchAtBySession = new Map<string, number>();
  constructor(
    private config: AutoThreadConfig,
    private monitor: SessionMonitorProvider,
    private channelRegistry: ChannelRegistry,
    private discordClient: DiscordClient,
    private getThreadRoutes: () => Map<string, DiscordThreadRoute>,
  ) {
    this.store = new AutoThreadStore(config.storePaths);
    this.monitorStateStore = new AutoThreadMonitorStateStore(config.monitorStatePath);
  }

  async init(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[AutoThread] disabled');
      return;
    }

    await this.load();
    if (this.config.monitorLogEnabled) {
      await this.loadMonitorState();
    }

    this.monitor.onRefresh((sessions) => this.onMonitorRefresh(sessions));
    console.log('[AutoThread] initialized');
  }

  async onMonitorRefresh(sessions: SessionSnapshot[]): Promise<void> {
    if (!this.config.enabled) return;

    const currentIds = new Set(sessions.map((snapshot) => buildSnapshotKey(snapshot)));

    // 기존 세션 상태 변화 알림 + activityPhase 변화 알림
    for (const snapshot of sessions) {
      if (this.isExcludedSnapshot(snapshot)) continue;
      const key = buildSnapshotKey(snapshot);
      const discovered = this.discoveredMap.get(key);
      if (!discovered) continue;

      // State change notification
      const previousState = this.knownStates.get(key);
      if (previousState && previousState !== snapshot.state) {
        const message = formatStateChangeMessage(previousState, snapshot);
        if (message) {
          this.discordClient.sendMessage(discovered.threadId, message).catch((error) => {
            console.error(`[AutoThread] state change notify failed: ${snapshot.sessionId}`, error);
          });
        }
      }

      // Activity phase change notification
      const previousPhase = this.previousActivityPhases.get(key) ?? null;
      if (previousPhase !== snapshot.activityPhase) {
        const phaseMessage = formatActivityPhaseChangeMessage(previousPhase, snapshot.activityPhase, snapshot);
        if (phaseMessage) {
          this.discordClient.sendMessage(discovered.threadId, phaseMessage).catch((error) => {
            console.error(`[AutoThread] phase change notify failed: ${snapshot.sessionId}`, error);
          });
        }
      }
    }

    // 새 세션 감지: current - known - alreadyMapped
    const newSessions = sessions.filter((snapshot) => {
      const provider = snapshotProvider(snapshot);
      return !this.knownSessionIds.has(buildSnapshotKey(snapshot))
        && this.config.targetStates.includes(snapshot.state)
        && !this.isExcludedSnapshot(snapshot)
        && !this.isAlreadyMapped(snapshot.sessionId, provider);
    });

    for (const snapshot of newSessions) {
      try {
        const created = await this.createThreadForSession(snapshot);
        if (created) {
          this.discoveredMap.set(buildDiscoveredKey(created), created);
          await this.save();
        }
      } catch (error) {
        console.error(`[AutoThread] create thread failed: ${snapshot.sessionId}`, error);
      }
      // Discord rate limit 완화
      await sleep(100);
    }

    await this.sendPeriodicMonitorLogs(sessions);

    this.knownSessionIds = currentIds;
    this.knownStates.clear();
    this.previousActivityPhases.clear();
    for (const snapshot of sessions) {
      const key = buildSnapshotKey(snapshot);
      this.knownStates.set(key, snapshot.state);
      this.previousActivityPhases.set(key, snapshot.activityPhase);
    }
  }

  resolveMapping(projectPath: string): ChannelMapping | null {
    return resolveMappingForSession(
      {
        projectPath,
        projectName: projectPath.split('/').filter(Boolean).at(-1) ?? '',
      },
      this.channelRegistry,
    );
  }

  isAlreadyMapped(sessionId: string, provider: AutoThreadProvider = 'claude'): boolean {
    if (this.discoveredMap.has(buildSessionKey(provider, sessionId))) return true;

    for (const route of this.getThreadRoutes().values()) {
      if (route.provider === provider && route.providerSessionId === sessionId) {
        return true;
      }
    }

    return false;
  }

  private async createThreadForSession(snapshot: SessionSnapshot): Promise<DiscoveredThread | null> {
    const provider = snapshotProvider(snapshot);
    const key = buildSnapshotKey(snapshot);

    // Guard: prevent concurrent creation for the same session
    if (this.pendingCreations.has(key)) return null;

    const routeMap = this.getThreadRoutes();
    if (this.isAlreadyMapped(snapshot.sessionId, provider)) {
      return null;
    }

    this.pendingCreations.add(key);
    try {
      const mapping = resolveMappingForSession(
        { projectPath: snapshot.projectPath, projectName: snapshot.projectName },
        this.channelRegistry,
      );
      const parentChannelId = mapping?.channelId ?? this.config.fallbackChannelId;
      if (!parentChannelId) {
        console.log(`[AutoThread] skip no channel mapping: ${snapshot.projectPath}`);
        return null;
      }

      const threadName = buildThreadName(snapshot);
      const threadId = await this.discordClient.createThread(parentChannelId, threadName);
      this.discordClient.addAllowedChannel(threadId);

      // Extract worktree metadata
      const worktreeInfo = extractOriginalProjectFromWorktree(snapshot.projectPath);
      let worktreeMetadata: DiscoveredThread['worktree'] | undefined;
      if (worktreeInfo) {
        worktreeMetadata = {
          originalProject: worktreeInfo.originalName,
          worktreeName: worktreeInfo.worktreeName,
        };

        // Try to extract Task from CLAUDE.md
        try {
          const claudeMdPath = `${snapshot.projectPath}/CLAUDE.md`;
          const file = Bun.file(claudeMdPath);
          if (await file.exists()) {
            const content = await file.text();
            const taskMatch = content.match(/^## Task\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/im);
            if (taskMatch) {
              const taskContent = taskMatch[1];
              if (taskContent) {
                worktreeMetadata.task = taskContent.trim();
              }
            }
          }
        } catch (error) {
          // Graceful failure — worktree metadata is still valid without task
          console.warn(`[AutoThread] failed to extract task from CLAUDE.md: ${error}`);
        }
      }

      const discovered: DiscoveredThread = {
        sessionId: snapshot.sessionId,
        threadId,
        parentChannelId,
        mappingKey: mapping?.key ?? 'fallback',
        provider,
        cwd: snapshot.projectPath,
        model: snapshot.model,
        slug: snapshot.slug,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        autoDiscovered: true,
        worktree: worktreeMetadata,
      };

      const route: DiscordThreadRoute = {
        threadId,
        parentChannelId,
        mappingKey: discovered.mappingKey,
        provider,
        providerSessionId: snapshot.sessionId,
        cwd: snapshot.projectPath,
        createdAt: discovered.createdAt,
        updatedAt: discovered.updatedAt,
        autoDiscovered: true,
      };
      routeMap.set(threadId, route);

      if (this.config.sendInitialEmbed) {
        await this.discordClient.sendEmbed(threadId, formatInitialEmbed(snapshot, worktreeMetadata?.task));
      }

      console.log(
        `[AutoThread] discovered provider=${provider} session=${snapshot.sessionId} thread=${threadId}`,
      );
      return discovered;
    } finally {
      this.pendingCreations.delete(key);
    }
  }

  private async save(): Promise<void> {
    await this.store.save(this.list());
  }

  private async load(): Promise<void> {
    const loaded = await this.store.load();
    const routeMap = this.getThreadRoutes();

    this.discoveredMap.clear();
    for (const item of loaded) {
      const provider = discoveredProvider(item);
      this.discoveredMap.set(buildDiscoveredKey(item), item);

      // 재시작 복구: 기존 route 맵 복원
      let exists = false;
      for (const route of routeMap.values()) {
        if (route.provider === provider && route.providerSessionId === item.sessionId) {
          exists = true;
          break;
        }
      }
      if (!exists && !routeMap.has(item.threadId)) {
        routeMap.set(item.threadId, {
          threadId: item.threadId,
          parentChannelId: item.parentChannelId,
          mappingKey: item.mappingKey,
          provider,
          providerSessionId: item.sessionId,
          cwd: item.cwd,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          autoDiscovered: true,
        });
      }
      this.discordClient.addAllowedChannel(item.threadId);
    }

    console.log(`[AutoThread] loaded ${loaded.length} mappings`);
  }

  private async loadMonitorState(): Promise<void> {
    const loaded = await this.monitorStateStore.load();
    this.lastWatchAtBySession.clear();

    const now = Date.now();
    for (const [key, item] of this.discoveredMap.entries()) {
      const legacyKey = item.provider === 'claude' ? item.sessionId : null;
      const lastWatchAt = loaded.get(key) ?? (legacyKey ? loaded.get(legacyKey) : undefined) ?? now;
      this.lastWatchAtBySession.set(key, lastWatchAt);
    }
    await this.saveMonitorState();
  }

  private async saveMonitorState(): Promise<void> {
    await this.monitorStateStore.save(this.lastWatchAtBySession);
  }

  private async sendPeriodicMonitorLogs(sessions: SessionSnapshot[]): Promise<void> {
    if (!this.config.monitorLogEnabled) return;

    const intervalMs = this.config.monitorIntervalMs > 0
      ? this.config.monitorIntervalMs
      : 10 * 60_000;
    const now = Date.now();
    const sessionMap = new Map(sessions.map((session) => [buildSnapshotKey(session), session]));
    let stateUpdated = false;

    for (const [key, discovered] of this.discoveredMap.entries()) {
      const snapshot = sessionMap.get(key);
      if (!snapshot) continue;
      if (this.isExcludedSnapshot(snapshot)) continue;

      const lastWatchAt = this.lastWatchAtBySession.get(key);
      if (!lastWatchAt) {
        this.lastWatchAtBySession.set(key, now);
        stateUpdated = true;
        continue;
      }

      if (now - lastWatchAt < intervalMs) continue;

      try {
        const message = await buildMonitorLogMessage(snapshot, lastWatchAt);
        if (message) {
          await this.discordClient.sendMessage(discovered.threadId, message);
        }
      } catch (error) {
        console.error(`[AutoThread] monitor log notify failed: ${discovered.sessionId}`, error);
      }

      this.lastWatchAtBySession.set(key, now);
      stateUpdated = true;
    }

    for (const key of [...this.lastWatchAtBySession.keys()]) {
      if (this.discoveredMap.has(key)) continue;
      this.lastWatchAtBySession.delete(key);
      stateUpdated = true;
    }

    if (stateUpdated) {
      await this.saveMonitorState();
    }
  }

  /**
   * SessionStart hook에서 즉시 thread 생성.
   * 기존 onMonitorRefresh() 기반 발견의 즉시 버전.
   */
  async onSessionStart(snapshot: SessionSnapshot): Promise<void> {
    if (!this.config.enabled) return;
    if (this.isExcludedSnapshot(snapshot)) return;

    const provider = snapshotProvider(snapshot);
    if (this.isAlreadyMapped(snapshot.sessionId, provider)) return;

    try {
      const created = await this.createThreadForSession(snapshot);
      if (created) {
        this.discoveredMap.set(buildDiscoveredKey(created), created);
        await this.save();
      }
    } catch (error) {
      console.error(`[AutoThread] onSessionStart create thread failed: ${snapshot.sessionId}`, error);
    }
  }

  /**
   * 세션의 Discord thread에 메시지 전송.
   * discoveredMap에서 buildSessionKey(provider, sessionId)로 thread 조회 →
   * discordClient.sendMessage().
   *
   * @returns true = 전송 성공, false = thread 미존재 또는 Discord API 실패
   */
  async sendToSessionThread(provider: string, sessionId: string, message: string): Promise<boolean> {
    const p: AutoThreadProvider = provider === 'codex' ? 'codex' : 'claude';
    const key = buildSessionKey(p, sessionId);
    const discovered = this.discoveredMap.get(key);
    if (!discovered) return false;

    try {
      await this.discordClient.sendMessage(discovered.threadId, message);
      return true;
    } catch (error) {
      console.error(`[AutoThread] sendToSessionThread failed: ${key}`, error);
      return false;
    }
  }

  list(): DiscoveredThread[] {
    return Array.from(this.discoveredMap.values());
  }

  private isExcludedSnapshot(snapshot: SessionSnapshot): boolean {
    const path = snapshot.projectPath?.trim();
    if (!path) return false;

    for (const prefixRaw of this.config.excludedProjectPathPrefixes) {
      const prefix = prefixRaw.trim();
      if (!prefix) continue;
      if (path === prefix || path.startsWith(`${prefix}/`)) return true;
    }
    return false;
  }
}

// Public exports
export type { AutoThreadConfig, DiscoveredThread } from './types.ts';
export { AutoThreadStore } from './store.ts';
export { resolveMapping, resolveMappingForSession, extractOriginalProjectFromWorktree } from './resolver.ts';
export { formatInitialEmbed, formatStateChangeMessage, formatActivityPhaseChangeMessage } from './formatter.ts';
