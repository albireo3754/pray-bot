import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorktreeWatcher } from './worktree-watcher.ts';
import type { ChannelMapping, SyncResult } from './discord/types.ts';

class FakeRegistry {
  private readonly mappings = new Map<string, ChannelMapping>();
  readonly syncCalls: Array<{ guildId: string; options?: { categories?: string[] } }> = [];
  readonly addCalls: Array<{ key: string; path: string; category: string }> = [];

  getByKey(key: string): ChannelMapping | undefined {
    return this.mappings.get(key);
  }

  addMapping(key: string, path: string, category: string): void {
    this.addCalls.push({ key, path, category });
    this.mappings.set(key, { key, path, category });
  }

  seedMapping(mapping: ChannelMapping): void {
    this.mappings.set(mapping.key, mapping);
  }

  async sync(_guildId: string, _discordClient: unknown, options?: { categories?: string[] }): Promise<SyncResult> {
    this.syncCalls.push({ guildId: _guildId, options });
    return { created: [], existing: [], errors: [] };
  }
}

const originalChannelsFile = process.env.PRAY_BOT_CHANNELS_FILE;
const testRoots: string[] = [];

afterEach(() => {
  process.env.PRAY_BOT_CHANNELS_FILE = originalChannelsFile;
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): { root: string; channelsFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'wt-watcher-'));
  testRoots.push(root);
  const channelsFile = join(root, 'channels.test.yaml');
  writeFileSync(channelsFile, 'categories: {}\n', 'utf8');
  return { root, channelsFile };
}

describe('WorktreeWatcher', () => {
  it('auto-adds new worktree mapping and triggers Discord sync', async () => {
    const { root, channelsFile } = createTempRoot();
    const worktreeName = 'usage-monitor-v2';
    mkdirSync(join(root, worktreeName));
    process.env.PRAY_BOT_CHANNELS_FILE = channelsFile;

    const registry = new FakeRegistry();
    const watcher = new WorktreeWatcher({
      guildId: 'guild-1',
      discordClient: {} as never,
      registry: registry as never,
      categoryName: 'Worktrees',
      rootPath: root,
    });

    await watcher.scanNow();

    const mapping = registry.getByKey(worktreeName);
    expect(mapping).toBeDefined();
    expect(mapping?.path).toBe(join(root, worktreeName));
    expect(mapping?.category).toBe('Worktrees');
    expect(registry.syncCalls).toHaveLength(1);
    const firstCall = registry.syncCalls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.options?.categories).toEqual(['Worktrees']);
  });

  it('triggers sync when mapping exists but channelId is missing', async () => {
    const { root, channelsFile } = createTempRoot();
    const worktreeName = 'usage-monitor-v2';
    const worktreePath = join(root, worktreeName);
    mkdirSync(worktreePath);
    process.env.PRAY_BOT_CHANNELS_FILE = channelsFile;

    const registry = new FakeRegistry();
    registry.seedMapping({ key: worktreeName, path: worktreePath, category: 'Worktrees' });

    const watcher = new WorktreeWatcher({
      guildId: 'guild-2',
      discordClient: {} as never,
      registry: registry as never,
      categoryName: 'Worktrees',
      rootPath: root,
    });

    await watcher.scanNow();

    expect(registry.addCalls).toHaveLength(0);
    expect(registry.syncCalls).toHaveLength(1);
  });

  it('does not sync when mapping is already linked to Discord channel', async () => {
    const { root, channelsFile } = createTempRoot();
    const worktreeName = 'usage-monitor-v2';
    const worktreePath = join(root, worktreeName);
    mkdirSync(worktreePath);
    process.env.PRAY_BOT_CHANNELS_FILE = channelsFile;

    const registry = new FakeRegistry();
    registry.seedMapping({
      key: worktreeName,
      path: worktreePath,
      category: 'Worktrees',
      channelId: 'discord-channel-1',
    });

    const watcher = new WorktreeWatcher({
      guildId: 'guild-3',
      discordClient: {} as never,
      registry: registry as never,
      categoryName: 'Worktrees',
      rootPath: root,
    });

    await watcher.scanNow();

    expect(registry.syncCalls).toHaveLength(0);
  });
});
