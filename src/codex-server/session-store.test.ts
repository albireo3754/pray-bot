import { describe, expect, test } from 'bun:test';
import { CodexSessionRegistry } from './session-store.ts';

describe('CodexSessionRegistry', () => {
  test('keeps storePath as null when explicitly disabled', () => {
    const store = new CodexSessionRegistry({ storePath: null });
    expect((store as unknown as { storePath: string | null }).storePath).toBeNull();
  });

  test('resume priority: explicit > thread > recent', () => {
    const store = new CodexSessionRegistry({ ttlMs: 10_000, storePath: null });
    const base = Date.now();

    store.upsert({
      sessionId: 'session-thread',
      ownerUserId: 'user-a',
      mappingKey: 'mg',
      cwd: '/repo/mg',
      threadChannelId: 'thread-1',
      parentChannelId: 'parent-1',
      timestamp: base,
    });
    store.upsert({
      sessionId: 'session-recent',
      ownerUserId: 'user-a',
      mappingKey: 'mg',
      cwd: '/repo/mg',
      threadChannelId: 'thread-2',
      parentChannelId: 'parent-1',
      timestamp: base + 100,
    });

    const byThread = store.resolveResumeTarget({
      threadChannelId: 'thread-1',
      ownerUserId: 'user-a',
      mappingKey: 'mg',
      now: base + 200,
    });
    expect(byThread.ok).toBe(true);
    if (byThread.ok) {
      expect(byThread.source).toBe('thread');
      expect(byThread.record.sessionId).toBe('session-thread');
    }

    const byExplicit = store.resolveResumeTarget({
      explicitSessionId: 'session-recent',
      threadChannelId: 'thread-1',
      ownerUserId: 'user-a',
      mappingKey: 'mg',
      now: base + 300,
    });
    expect(byExplicit.ok).toBe(true);
    if (byExplicit.ok) {
      expect(byExplicit.source).toBe('explicit');
      expect(byExplicit.record.sessionId).toBe('session-recent');
    }

    const byRecent = store.resolveResumeTarget({
      ownerUserId: 'user-a',
      mappingKey: 'mg',
      now: base + 300,
    });
    expect(byRecent.ok).toBe(true);
    if (byRecent.ok) {
      expect(byRecent.source).toBe('recent');
      expect(byRecent.record.sessionId).toBe('session-recent');
    }
  });

  test('excludes expired sessions by ttl', () => {
    const store = new CodexSessionRegistry({ ttlMs: 1_000, storePath: null });
    const base = Date.now();

    store.upsert({
      sessionId: 'expired-session',
      ownerUserId: 'user-a',
      mappingKey: 'mg',
      cwd: '/repo/mg',
      threadChannelId: 'thread-1',
      parentChannelId: 'parent-1',
      timestamp: base,
    });

    const result = store.resolveResumeTarget({
      explicitSessionId: 'expired-session',
      ownerUserId: 'user-a',
      mappingKey: 'mg',
      now: base + 2_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });

  test('allows explicit/thread resume regardless of owner', () => {
    const store = new CodexSessionRegistry({ ttlMs: 10_000, storePath: null });
    const base = Date.now();

    store.upsert({
      sessionId: 'owner-session',
      ownerUserId: 'owner-user',
      mappingKey: 'mg',
      cwd: '/repo/mg',
      threadChannelId: 'thread-1',
      parentChannelId: 'parent-1',
      timestamp: base,
    });

    const byOtherUserExplicit = store.resolveResumeTarget({
      explicitSessionId: 'owner-session',
      ownerUserId: 'other-user',
      mappingKey: 'mg',
      now: base + 100,
    });
    expect(byOtherUserExplicit.ok).toBe(true);
    if (byOtherUserExplicit.ok) {
      expect(byOtherUserExplicit.source).toBe('explicit');
      expect(byOtherUserExplicit.record.sessionId).toBe('owner-session');
    }

    const byOtherUserThread = store.resolveResumeTarget({
      threadChannelId: 'thread-1',
      ownerUserId: 'other-user',
      mappingKey: 'mg',
      now: base + 100,
    });
    expect(byOtherUserThread.ok).toBe(true);
    if (byOtherUserThread.ok) {
      expect(byOtherUserThread.source).toBe('thread');
      expect(byOtherUserThread.record.sessionId).toBe('owner-session');
    }
  });
});
