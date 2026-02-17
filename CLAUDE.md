# pray-bot

LLM Orchestration Framework — Discord + Claude/Codex/Gemini integration engine.

## Overview

pray-bot is a standalone Bun/TypeScript framework that provides:
- **Agent abstraction**: Unified interface for Claude CLI, Codex SDK, Gemini
- **Discord integration**: Bot framework, channel routing, auto-threading
- **Session monitoring**: Claude/Codex process discovery and tracking
- **Plugin system**: Extensible via plugins (commands, routes, cron actions)
- **Cron scheduler**: SQLite-backed job scheduling
- **Worktree watcher**: Auto-discover git worktrees → Discord channels

## Runtime

- Install: `bun install`
- Type check: `npx tsc --noEmit`
- Test: `bun test`
- Run: `bun src/index.ts`

## Project Structure

```
src/
├── agents/           # LLM provider abstraction
│   ├── types.ts      # AgentProvider, AgentSession, AgentEvent
│   ├── manager.ts    # AgentSessionManager
│   ├── renderer.ts   # StreamRenderer (typing indicators)
│   └── providers/    # Claude, Codex, Gemini implementations
├── discord/          # Discord bot framework
│   ├── client.ts     # DiscordClient wrapper
│   ├── commands.ts   # Slash command registration
│   ├── channel-registry.ts  # Channel ↔ project mapping
│   ├── throttle-queue.ts    # Message rate limiter
│   └── format.ts     # Message formatting helpers
├── monitor/          # Claude session monitor
│   ├── discovery.ts  # Process/JSONL discovery
│   ├── parser.ts     # Session log parser
│   └── formatter.ts  # Text/Embed formatters
├── auto-thread/      # Session → Discord thread routing
│   ├── resolver.ts   # Project → channel resolution
│   ├── store.ts      # Thread route persistence (SQLite)
│   └── monitor-log.ts # Session activity logging
├── codex-server/     # Codex JSON-RPC client + session store
├── cron/             # SQLite-backed scheduler
│   ├── store.ts      # Job persistence
│   ├── schedule.ts   # Cron expression eval
│   ├── timer.ts      # Job runner
│   └── actions/      # Built-in action types (notify, http)
├── presence/         # Typing presence abstraction
├── command/          # Command registry (generic, provider-agnostic)
├── stream/           # Claude CLI JSON stream parser
├── plugin/           # Plugin system (PrayBotPlugin interface)
├── server/           # HTTP utilities
├── bot.ts            # PrayBot engine (use/start/stop lifecycle)
└── index.ts          # Re-exports (all modules)
```

## Key Files

| File | Description |
|------|-------------|
| `bot.ts` | `PrayBot` class — `use(plugin)`, `start()`, `stop()`, built-in HTTP server |
| `plugin/types.ts` | `PrayBotPlugin`, `PluginContext`, `RouteDefinition` interfaces |
| `command/registry.ts` | Generic `CommandRegistry` with `CommandDefinition` type |
| `agents/types.ts` | `AgentProvider`, `AgentSession`, `AgentEvent` abstractions |
| `config.ts` | Shared configuration (SQLite paths, etc.) |

## TypeScript Config

- `strict: true`, `noUncheckedIndexedAccess: true`
- `rootDir: "src"`, `moduleResolution: "bundler"`
- Target: `ESNext` with Bun types

## Engineering Rules

- Use Bun-first APIs (Bun.serve, bun:sqlite, etc.)
- No internal or organization-specific service references — this is a public repo
- Keep modules self-contained with minimal cross-dependencies
- Plugin interface is the extension point — don't add app-specific code to core
