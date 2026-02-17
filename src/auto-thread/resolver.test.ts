import { describe, expect, test } from 'bun:test';
import { resolveMapping, resolveMappingForSession, extractOriginalProjectFromWorktree } from './resolver.ts';
import type { ChannelMapping } from '../discord/types.ts';

function registry(mappings: ChannelMapping[]) {
  return { listAll: () => mappings };
}

describe('auto-thread resolver', () => {
  test('resolves by exact and longest-prefix path match', () => {
    const mappings: ChannelMapping[] = [
      { key: 'work', path: '/Users/pray/work', category: 'misc' },
      { key: 'pray-bot', path: '/Users/pray/work/js/pray-bot', category: 'JS' },
      { key: 'js', path: '/Users/pray/work/js', category: 'JS' },
    ];

    const exact = resolveMapping('/Users/pray/work/js/pray-bot', registry(mappings));
    expect(exact?.key).toBe('pray-bot');

    const prefix = resolveMapping('/Users/pray/work/js/pray-bot/tests', registry(mappings));
    expect(prefix?.key).toBe('pray-bot');
  });

  test('falls back to project name key when path mapping is missing', () => {
    const mappings: ChannelMapping[] = [
      { key: 'pray-bot', path: '/Users/pray/work/js/pray-bot', category: 'JS' },
      { key: 'codex', path: '/Users/pray/work/js/pray-bot', category: 'JS' },
    ];

    const resolved = resolveMappingForSession(
      {
        projectPath: '/Users/pray/worktrees/work-status-v5/pray-bot',
        projectName: 'pray-bot',
      },
      registry(mappings),
    );

    expect(resolved?.key).toBe('pray-bot');
  });

  test('normalizes project name for key fallback', () => {
    const mappings: ChannelMapping[] = [
      { key: 'message-dev', path: '/Users/pray/work/js/message-dev', category: 'JS' },
    ];

    const resolved = resolveMappingForSession(
      {
        projectPath: '',
        projectName: 'Message Dev',
      },
      registry(mappings),
    );

    expect(resolved?.key).toBe('message-dev');
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
    const result = extractOriginalProjectFromWorktree('~/worktrees/ws-v5/flight-v2~hotfix');
    expect(result).toEqual({
      originalName: 'flight-v2',
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
        path: '/Users/pray/work/js/pray-bot',
        category: 'Projects',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/pray/work/js/pray-bot~api',
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
        path: '/Users/pray/work/js/other-project',
        category: 'Projects',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/pray/work/js/pray-bot~api',
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
        path: '/Users/pray/work/js/pray-bot',
        category: 'Projects',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/pray/work/js/pray-bot',
        projectName: 'pray-bot',
      },
      registry(mappings),
    );

    expect(result?.key).toBe('pray-bot');
  });

  test('worktree fallback works with normalized keys', () => {
    const mappings: ChannelMapping[] = [
      {
        key: 'flight-v2',
        path: '/Users/user/work/rust/my-flight-v2',
        category: 'Rust',
      },
    ];

    const result = resolveMappingForSession(
      {
        projectPath: '/Users/pray/worktrees/ws-v5/flight-v2~hotfix',
        projectName: 'flight-v2~hotfix',
      },
      registry(mappings),
    );

    expect(result?.key).toBe('flight-v2');
  });
});
