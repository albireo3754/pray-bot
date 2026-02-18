import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { removeChannelMapping, saveChannelMapping } from './config.ts';
import type { ChannelRegistry } from './discord/channel-registry.ts';
import type { DiscordClient } from './discord/client.ts';

export type WorktreeWatcherOptions = {
  /** Absolute directory to watch (default: ~/worktrees) */
  rootPath?: string;
  /** Discord guild ID */
  guildId: string;
  /** Discord client */
  discordClient: DiscordClient;
  /** Runtime channel mapping registry */
  registry: ChannelRegistry;
  /** Discord category/group name to place worktree channels */
  categoryName?: string;
  /** Debounce delay for fs events */
  debounceMs?: number;
};

type WorktreeEvent = {
  name: string;
  path: string;
};

export class WorktreeWatcher {
  private watcher: FSWatcher | null = null;
  private running = false;
  private knownWorktrees = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rootPath: string;
  private readonly guildId: string;
  private readonly discordClient: DiscordClient;
  private readonly registry: ChannelRegistry;
  private readonly categoryName: string;
  private readonly debounceMs: number;

  constructor(opts: WorktreeWatcherOptions) {
    const home = process.env.HOME ?? '/home/user';
    this.rootPath = opts.rootPath ?? join(home, 'worktrees');
    this.guildId = opts.guildId;
    this.discordClient = opts.discordClient;
    this.registry = opts.registry;
    this.categoryName = opts.categoryName ?? 'Worktrees';
    this.debounceMs = opts.debounceMs ?? 800;
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!existsSync(this.rootPath)) {
      console.warn(`[WorktreeWatcher] Root path does not exist: ${this.rootPath}`);
      return;
    }

    await this.scanNow();

    try {
      this.watcher = watch(this.rootPath, (_event, filename) => {
        if (filename && filename.startsWith('.')) return;
        this.scheduleScan();
      });
      this.watcher.on('error', (err) => {
        console.error('[WorktreeWatcher] Watch error:', err);
      });
      this.running = true;
      console.log(`[WorktreeWatcher] Watching ${this.rootPath}`);
    } catch (err) {
      this.running = false;
      console.error('[WorktreeWatcher] Failed to start watch:', err);
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.running = false;
  }

  private scheduleScan(): void {
    if (!this.running) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.scanNow().catch((err) => {
        console.error('[WorktreeWatcher] Scan failed:', err);
      });
    }, this.debounceMs);
  }

  async scanNow(): Promise<void> {
    if (!existsSync(this.rootPath)) return;

    const entries = readdirSync(this.rootPath, { withFileTypes: true });
    const discovered: WorktreeEvent[] = [];
    let shouldSync = false;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const worktreePath = join(this.rootPath, entry.name);
      if (!existsSync(worktreePath)) continue;

      if (!this.knownWorktrees.has(entry.name)) {
        const normalizedKey = this.toChannelKey(entry.name);
        const mapping = this.registry.getByKey(normalizedKey);
        if (!mapping) {
          const key = this.makeUniqueChannelKey(normalizedKey);
          this.registry.addMapping(key, worktreePath, this.categoryName);
          try {
            saveChannelMapping(key, worktreePath, this.categoryName);
          } catch {
            // best-effort persistence
          }
          discovered.push({ name: entry.name, path: worktreePath });
          shouldSync = true;
        } else if (mapping.path !== worktreePath) {
          console.warn(`[WorktreeWatcher] Key conflict for ${entry.name}: existing=${mapping.path}, new=${worktreePath}`);
        } else if (!mapping.channelId) {
          // Mapping exists but Discord channel is not linked yet.
          shouldSync = true;
        }
      }
      this.knownWorktrees.add(entry.name);
    }

    if (discovered.length > 0) {
      console.log(
        `[WorktreeWatcher] New worktree discovered: ${discovered.map((item) => item.name).join(', ')}`,
      );
    }

    if (shouldSync) {
      await this.registry.sync(this.guildId, this.discordClient, {
        categories: [this.categoryName],
      });
    }

    await this.cleanupStaleWorktrees();
  }

  async cleanupStaleWorktrees(): Promise<string[]> {
    const categories = this.registry.getCategories();
    const worktreeMappings = categories.get(this.categoryName);
    if (!worktreeMappings) return [];

    const removed: string[] = [];

    for (const mapping of worktreeMappings) {
      if (existsSync(mapping.path)) continue;

      // Path no longer exists on disk — clean up
      if (mapping.channelId) {
        try {
          await this.discordClient.deleteChannel(mapping.channelId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[WorktreeWatcher] Failed to delete channel #${mapping.key}: ${msg}`);
        }
      }

      this.registry.removeMapping(mapping.key);
      try {
        removeChannelMapping(mapping.key);
      } catch {
        // best-effort persistence
      }
      this.knownWorktrees.delete(mapping.key);

      removed.push(mapping.key);
    }

    if (removed.length > 0) {
      console.log(`[WorktreeWatcher] Cleaned up ${removed.length} stale worktrees: ${removed.join(', ')}`);
    }

    return removed;
  }

  private toChannelKey(rawName: string): string {
    const sanitized = rawName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');

    return sanitized || 'worktree';
  }

  private makeUniqueChannelKey(baseKey: string): string {
    let key = baseKey;
    let i = 1;
    while (this.registry.getByKey(key)) {
      i += 1;
      key = `${baseKey}-${i}`;
    }

    return key;
  }
}
