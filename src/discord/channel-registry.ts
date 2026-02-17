/**
 * ChannelRegistry - Discord 채널 <-> 프로젝트 폴더 매핑 레지스트리
 *
 * channels.yaml 기반으로 채널-폴더 매핑을 관리하고,
 * Discord 카테고리/채널 생성 및 Agent 세션 라우팅을 담당.
 */

import type { AgentSessionManager, AgentSession } from '../agents/index.ts';
import type { DiscordClient } from './client.ts';
import type { ChannelMapping, SyncResult } from './types.ts';

type SyncOptions = {
  categories?: string[];
};

export class ChannelRegistry {
  /** key -> ChannelMapping */
  private mappings = new Map<string, ChannelMapping>();
  /** Discord channelId -> key (sync 후 채워짐) */
  private channelMap = new Map<string, string>();
  /** category name -> Discord category ID */
  private categoryIds = new Map<string, string>();

  constructor(mappings: ChannelMapping[]) {
    for (const m of mappings) {
      this.mappings.set(m.key, { ...m });
    }
  }

  /** channelId로 매핑 조회 (라우팅에서 사용) */
  getByChannelId(channelId: string): ChannelMapping | undefined {
    const key = this.channelMap.get(channelId);
    if (!key) return undefined;
    return this.mappings.get(key);
  }

  /** key로 매핑 조회 */
  getByKey(key: string): ChannelMapping | undefined {
    return this.mappings.get(key);
  }

  /** 카테고리별 매핑 그룹 */
  getCategories(): Map<string, ChannelMapping[]> {
    const result = new Map<string, ChannelMapping[]>();
    for (const m of this.mappings.values()) {
      const list = result.get(m.category) ?? [];
      list.push(m);
      result.set(m.category, list);
    }
    return result;
  }

  /** 전체 매핑 목록 */
  listAll(): ChannelMapping[] {
    return Array.from(this.mappings.values());
  }

  /** 매핑 추가 */
  addMapping(key: string, path: string, category: string): void {
    this.mappings.set(key, { key, path, category });
  }

  /** 매핑 제거 */
  removeMapping(key: string): boolean {
    const mapping = this.mappings.get(key);
    if (!mapping) return false;

    // channelMap에서도 제거
    if (mapping.channelId) {
      this.channelMap.delete(mapping.channelId);
    }
    this.mappings.delete(key);
    return true;
  }

  /**
   * 기존 Discord 채널을 이름으로 찾아서 매핑만 연결 (채널 생성 안 함).
   * 시작 시 자동 호출. Manage Channels 권한 불필요.
   */
  async discoverExistingChannels(guildId: string, discord: DiscordClient): Promise<number> {
    let mapped = 0;
    try {
      const channels = await discord.listGuildChannels(guildId);
      for (const ch of channels) {
        const mapping = this.mappings.get(ch.name);
        if (mapping && !mapping.channelId) {
          mapping.channelId = ch.id;
          this.channelMap.set(ch.id, mapping.key);
          discord.addAllowedChannel(ch.id);
          mapped++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ChannelRegistry] discoverExistingChannels failed: ${msg}`);
    }
    return mapped;
  }

  /**
   * Discord 길드와 동기화: 카테고리/채널 생성 (/channel-sync에서 호출)
   * Manage Channels 권한 필요.
   */
  async sync(guildId: string, discord: DiscordClient, options?: SyncOptions): Promise<SyncResult> {
    const result: SyncResult = { created: [], existing: [], errors: [] };
    const categories = this.getCategories();
    const categoryFilter = options?.categories?.length
      ? new Set(options.categories)
      : null;

    for (const [categoryName, mappings] of categories) {
      if (categoryFilter && !categoryFilter.has(categoryName)) continue;

      // 카테고리 생성/조회
      let categoryId: string;
      try {
        categoryId = await discord.createCategory(guildId, categoryName);
        this.categoryIds.set(categoryName, categoryId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ChannelRegistry] Category ${categoryName}: ${msg}`);
        for (const m of mappings) result.errors.push(m.key);
        continue;
      }

      // 채널 생성/조회
      for (const mapping of mappings) {
        try {
          const channelId = await discord.findOrCreateChannelInCategory(
            guildId,
            categoryId,
            mapping.key,
          );
          mapping.channelId = channelId;
          this.channelMap.set(channelId, mapping.key);
          discord.addAllowedChannel(channelId);
          result.existing.push(mapping.key);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[ChannelRegistry] Channel #${mapping.key}: ${msg}`);
          result.errors.push(mapping.key);
        }
      }
    }

    console.log(
      `[ChannelRegistry] Sync: ${result.existing.length} ok, ${result.errors.length} errors`,
    );
    return result;
  }

  /**
   * Agent 세션 lazy 생성/재사용
   */
  async getOrCreateSession(key: string, manager: AgentSessionManager): Promise<AgentSession | null> {
    const existing = manager.getSession(`ch:${key}`);
    if (existing) return existing;

    const mapping = this.getByKey(key);
    if (!mapping) return null;

    return manager.createSession(`ch:${key}`, {
      workingDirectory: mapping.path,
    });
  }

  /** Agent 세션 종료 */
  async killSession(key: string, manager: AgentSessionManager): Promise<boolean> {
    if (!manager.hasSession(`ch:${key}`)) return false;
    await manager.removeSession(`ch:${key}`);
    return true;
  }

  /** 특정 채널의 Agent 세션 존재 여부 */
  hasSession(key: string, manager: AgentSessionManager): boolean {
    return manager.hasSession(`ch:${key}`);
  }

  /** 활성 세션 목록 */
  activeSessionKeys(manager: AgentSessionManager): string[] {
    return manager.activeKeys().filter((k) => k.startsWith('ch:')).map((k) => k.slice(3));
  }
}
