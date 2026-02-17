import { describe, expect, test } from 'bun:test';
import { resolveMapping, resolveMappingForSession, extractOriginalProjectFromWorktree } from './resolver.ts';
import type { ChannelMapping } from '../discord/types.ts';

function registry(mappings: ChannelMapping[]) {
  return { listAll: () => mappings };
}

describe('auto-thread resolver', () => {
  test('resolves by exact and longest-prefix path match', () => {
    const mappings: ChannelMapping[] = [
      { key: 'work', path: '/Users/user/work', category: 'misc' },
      { key: 'pray-bot', path: '/Users/user/work/js/pray-bot', category: 'JS' },
      { key: 'js', path: '/Users/user/work/js', category: 'JS' },
    ];

    const exact = resolveMapping('/Users/user/work/js/pray-bot', registry(mappings));
    expect(exact?.key).toBe('pray-bot');

    const prefix = resolveMapping('/Users/user/work/js/pray-bot/tests', registry(mappings));
    expect(prefix?.key).toBe('pray-bot');
  });

  test('falls back to project name key when path mapping is missing', () => {
    const mappings: ChannelMapping[] = [
      { key: 'pray-bot', path: '/Users/user/work/js/pray-bot', category: 'JS' },
      { key: 'codex', path: '/Users/user/work/js/pray-bot', category: 'JS' },
    ];

    const resolved = resolveMappingForSession(
      {
        projectPath: '/Users/user/worktrees/feature-branch/pray-bot',
        projectName: 'pray-bot',
      },
      registry(mappings),
    );

    expect(resolved?.key).toBe('pray-bot');
  });

  test('normalizes project name for key fallback', () => {
    const mappings: ChannelMapping[] = [
      { key: 'my-tool', path: '/Users/user/work/js/my-tool', category: 'JS' },
    ];

    const resolved = resolveMappingForSession(
      {
        projectPath: '',
        projectName: 'My Tool',
      },
      registry(mappings),
    );

    expect(resolved?.key).toBe('my-tool');
  });
});

describe('extractOriginalProjectFromWorktree', () => {
  test('extracts worktree info from tilde-separated basename', () => {
    const result = extractOriginalProjectFromWorktree('~/work/js/pray-bot~api');
    expect(result).toEqual({
      originalName: 'pray-bot',
      worktreeName: 'api',
    });
  });

  test('extracts worktree info from nested path with tilde', () => {
    const result = extractOriginalProjectFromWorktree('~/worktrees/dev-thread/my-service~hotfix');
    expect(result).toEqual({
      originalName: 'my-service',
      worktreeName: 'hotfix',
    });
  });

  test('returns null for path without tilde', () => {
    const result = extractOriginalProjectFromWorktree('~/work/js/pray-bot');
    expect(result).toBeNull();
  });

  test('only uses first tilde as delimiter', () => {
    const result = extractOriginalProjectFromWorktree('~/work/js/repo~name~extra');
    expect(result).toEqual({
      originalName: 'repo',
      worktreeName: 'name~extra',
    });
  });

  test('returns null for empty path', () => {
    const result = extractOriginalProjectFromWorktree('');
    expect(result).toBeNull();
  });

  test('returns null for root path', () => {
    const result = extractOriginalProjectFromWorktree('/');
    expect(result).toBeNull();
  });

  test('returns null if originalName is empty', () => {
    const result = extractOriginalProjectFromWorktree('~/work/~api');
    expect(result).toBeNull();
  });

  test('returns null if worktreeName is empty', () => {
    const result = extractOriginalProjectFromWorktree('~/work/pray-bot~');
    expect(result).toBeNull();
  });
});

describe('resolveMappingForSession with worktree fallback', () => {
  test('worktree path with existing mapping for original project returns mapping', () => {
    const mappings: ChannelMapping[] = [
      {
        key: 'pray-bot',
        path: '/Users/user/work/js/pray-bot',
        category: 'Projects',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/user/work/js/pray-bot~api',
        projectName: 'pray-bot~api',
      },
      registry(mappings),
    );

    expect(result?.key).toBe('pray-bot');
  });

  test('worktree path with no mapping at all returns null', () => {
    const mappings: ChannelMapping[] = [
      {
        key: 'other-project',
        path: '/Users/user/work/js/other-project',
        category: 'Projects',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/user/work/js/pray-bot~api',
        projectName: 'pray-bot~api',
      },
      registry(mappings),
    );

    expect(result).toBeNull();
  });

  test('non-worktree path has unchanged behavior', () => {
    const mappings: ChannelMapping[] = [
      {
        key: 'pray-bot',
        path: '/Users/user/work/js/pray-bot',
        category: 'Projects',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/user/work/js/pray-bot',
        projectName: 'pray-bot',
      },
      registry(mappings),
    );

    expect(result?.key).toBe('pray-bot');
  });

  test('worktree fallback works with normalized keys', () => {
    const mappings: ChannelMapping[] = [
      {
        key: 'my-service',
        path: '/Users/user/work/rust/my-service',
        category: 'Rust',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/user/worktrees/dev-thread/my-service~hotfix',
        projectName: 'my-service~hotfix',
      },
      registry(mappings),
    );

    expect(result?.key).toBe('my-service');
  });
});
