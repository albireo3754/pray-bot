import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoThreadMonitorStateStore } from './monitor-state-store.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('AutoThreadMonitorStateStore', () => {
  test('saves and loads lastWatchAt map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auto-thread-watch-state-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'watch-state.json');

    const store = new AutoThreadMonitorStateStore(statePath);
    const source = new Map<string, number>([
      ['s-1', 1000],
      ['s-2', 2000],
    ]);
    await store.save(source);

    const loaded = await store.load();
    expect(loaded.get('s-1')).toBe(1000);
    expect(loaded.get('s-2')).toBe(2000);
  });
});
