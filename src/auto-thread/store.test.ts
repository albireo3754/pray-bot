import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoThreadStore } from './store.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'auto-thread-store-'));
  tempDirs.push(dir);
  return dir;
}

describe('AutoThreadStore', () => {
  test('loads and merges mappings from multiple store paths', async () => {
    const root = await createTempRoot();
    const pathA = join(root, '.claude', 'auto-threads.json');
    const pathB = join(root, '.claude-silba', 'auto-threads.json');

    await mkdir(join(root, '.claude'), { recursive: true });
    await mkdir(join(root, '.claude-silba'), { recursive: true });

    await Bun.write(pathA, JSON.stringify({
      version: 1,
      mappings: [
        {
          sessionId: 's-1',
          threadId: 't-old',
          parentChannelId: 'p-1',
          mappingKey: 'k',
          provider: 'claude',
          cwd: '/tmp/a',
          model: 'opus',
          slug: 'slug-1',
          createdAt: 1,
          updatedAt: 100,
          autoDiscovered: true,
        },
      ],
    }, null, 2));

    await Bun.write(pathB, JSON.stringify({
      version: 1,
      mappings: [
        {
          sessionId: 's-1',
          threadId: 't-new',
          parentChannelId: 'p-1',
          mappingKey: 'k',
          provider: 'claude',
          cwd: '/tmp/a',
          model: 'opus',
          slug: 'slug-1',
          createdAt: 1,
          updatedAt: 200,
          autoDiscovered: true,
        },
        {
          sessionId: 's-2',
          threadId: 't-2',
          parentChannelId: 'p-2',
          mappingKey: 'k2',
          provider: 'claude',
          cwd: '/tmp/b',
          model: null,
          slug: 'slug-2',
          createdAt: 2,
          updatedAt: 150,
          autoDiscovered: true,
        },
      ],
    }, null, 2));

    const store = new AutoThreadStore([pathA, pathB]);
    const loaded = await store.load();

    expect(loaded).toHaveLength(2);
    const bySession = new Map(loaded.map((item) => [item.sessionId, item]));
    expect(bySession.get('s-1')?.threadId).toBe('t-new');
    expect(bySession.get('s-2')?.threadId).toBe('t-2');
  });

  test('merges by provider+sessionId (no cross-provider overwrite)', async () => {
    const root = await createTempRoot();
    const pathA = join(root, '.claude', 'auto-threads.json');
    const pathB = join(root, '.claude-silba', 'auto-threads.json');

    await mkdir(join(root, '.claude'), { recursive: true });
    await mkdir(join(root, '.claude-silba'), { recursive: true });

    await Bun.write(pathA, JSON.stringify({
      version: 1,
      mappings: [
        {
          sessionId: 'same-id',
          threadId: 't-claude',
          parentChannelId: 'p-1',
          mappingKey: 'k-claude',
          provider: 'claude',
          cwd: '/tmp/claude',
          model: 'sonnet',
          slug: 'same-id',
          createdAt: 1,
          updatedAt: 100,
          autoDiscovered: true,
        },
      ],
    }, null, 2));

    await Bun.write(pathB, JSON.stringify({
      version: 1,
      mappings: [
        {
          sessionId: 'same-id',
          threadId: 't-codex',
          parentChannelId: 'p-2',
          mappingKey: 'k-codex',
          provider: 'codex',
          cwd: '/tmp/codex',
          model: 'gpt-5.3-codex',
          slug: 'same-id',
          createdAt: 2,
          updatedAt: 120,
          autoDiscovered: true,
        },
      ],
    }, null, 2));

    const store = new AutoThreadStore([pathA, pathB]);
    const loaded = await store.load();

    expect(loaded).toHaveLength(2);
    expect(loaded.some((item) => item.provider === 'claude' && item.threadId === 't-claude')).toBe(true);
    expect(loaded.some((item) => item.provider === 'codex' && item.threadId === 't-codex')).toBe(true);
  });

  test('saves mappings to all configured store paths', async () => {
    const root = await createTempRoot();
    const pathA = join(root, '.claude', 'auto-threads.json');
    const pathB = join(root, '.claude-silba', 'auto-threads.json');

    const store = new AutoThreadStore([pathA, pathB]);
    await store.save([
      {
        sessionId: 's-10',
        threadId: 't-10',
        parentChannelId: 'p-10',
        mappingKey: 'k10',
        provider: 'claude',
        cwd: '/tmp/c',
        model: 'sonnet',
        slug: 'slug-10',
        createdAt: 10,
        updatedAt: 10,
        autoDiscovered: true,
      },
    ]);

    const payloadA = JSON.parse(await Bun.file(pathA).text()) as { version: number; mappings: unknown[] };
    const payloadB = JSON.parse(await Bun.file(pathB).text()) as { version: number; mappings: unknown[] };

    expect(payloadA.version).toBe(1);
    expect(payloadB.version).toBe(1);
    expect(payloadA.mappings).toHaveLength(1);
    expect(payloadB.mappings).toHaveLength(1);
  });
});
