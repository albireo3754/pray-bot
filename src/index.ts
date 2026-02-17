/**
 * pray-bot — LLM Orchestration Framework
 *
 * Standalone framework for Discord + LLM (Claude, Codex, Gemini) integration.
 * Provides agent session management, auto-threading, cron scheduling,
 * and a plugin system for extensibility.
 */

// -- Phase A modules --
export * from './agents/index.ts';
export * from './stream/index.ts';
export * from './command/index.ts';
export * from './presence/index.ts';

// -- Phase B modules --
export * from './cron/index.ts';
export * from './usage-monitor/index.ts';
export * from './codex-server/index.ts';
export * from './discord/index.ts';
export * from './auto-thread/index.ts';
export * from './server/util.ts';

// -- Phase C modules --
export { GitWatcher, type GitWatcherOptions } from './git-watcher.ts';
export { WorktreeWatcher, type WorktreeWatcherOptions } from './worktree-watcher.ts';
export * from './plugin/index.ts';
export { PrayBot } from './bot.ts';
export type { PrayBotConfig } from './bot.ts';
