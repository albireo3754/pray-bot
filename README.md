# pray-bot

LLM Orchestration Framework for Discord + Claude/Codex/Gemini integration.

## Features

- **Agent Abstraction** — Unified session management for Claude CLI, Codex SDK, and Gemini
- **Discord Integration** — Bot framework with channel routing, auto-threading, and rate limiting
- **Session Monitoring** — Real-time Claude/Codex process discovery and status tracking
- **Plugin System** — Extend via `PrayBotPlugin` interface (commands, routes, cron actions)
- **Cron Scheduler** — SQLite-backed job scheduling with lock management
- **Worktree Watcher** — Auto-discover git worktrees and map to Discord channels

## Requirements

- [Bun](https://bun.sh) v1.2+
- TypeScript 5+

## Quick Start

```bash
# Install dependencies
bun install

# Copy environment variables
cp .env.example .env

# Run
bun src/index.ts
```

## Usage

```typescript
import { PrayBot } from 'pray-bot';

const bot = new PrayBot({
  port: 4488,
  discordToken: process.env.DISCORD_BOT_TOKEN,
});

// Register a plugin
bot.use({
  name: 'my-plugin',
  version: '1.0.0',
  async onStart(ctx) {
    ctx.addCommand({
      name: 'hello',
      description: 'Say hello',
      execute: async (context) => {
        await context.reply('Hello!');
      },
    });

    ctx.addRoute({
      method: 'GET',
      path: '/api/hello',
      handler: () => Response.json({ message: 'Hello!' }),
    });
  },
});

await bot.start();
```

## Project Structure

```
src/
├── agents/           # LLM provider abstraction (Claude, Codex, Gemini)
│   ├── types.ts      # AgentProvider, AgentSession, AgentEvent
│   ├── manager.ts    # AgentSessionManager
│   ├── renderer.ts   # StreamRenderer (typing indicators)
│   └── providers/    # Provider implementations
├── discord/          # Discord bot framework
│   ├── client.ts     # DiscordClient wrapper
│   ├── commands.ts   # Slash command registration
│   ├── channel-registry.ts  # Channel mapping
│   ├── throttle-queue.ts    # Message rate limiter
│   └── format.ts     # Message formatting
├── monitor/          # Claude session monitor
│   ├── discovery.ts  # Process/JSONL file discovery
│   ├── parser.ts     # Session log parser
│   └── formatter.ts  # Status formatters (text/embed)
├── auto-thread/      # Session → Discord thread routing
│   ├── resolver.ts   # Project → channel mapping
│   ├── store.ts      # Thread route persistence
│   └── monitor-log.ts # Session activity log
├── codex-server/     # Codex JSON-RPC client
├── cron/             # SQLite-backed scheduler
│   ├── store.ts      # Job persistence
│   ├── schedule.ts   # Cron expression evaluation
│   ├── timer.ts      # Job runner
│   └── actions/      # Built-in action types
├── presence/         # Typing presence abstraction
├── command/          # Command registry
├── stream/           # Claude CLI JSON stream parser
├── plugin/           # Plugin system
│   ├── types.ts      # PrayBotPlugin, PluginContext interfaces
│   └── loader.ts     # PluginManager lifecycle
├── server/           # HTTP utilities
├── bot.ts            # PrayBot engine class
└── index.ts          # Re-exports
```

## Plugin System

Implement `PrayBotPlugin` to extend pray-bot:

```typescript
import type { PrayBotPlugin, PluginContext } from 'pray-bot';

export function createMyPlugin(): PrayBotPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',

    async onStart(ctx: PluginContext) {
      // Register commands
      ctx.addCommand({ name: 'ping', description: 'Pong', execute: async (c) => c.reply('Pong') });

      // Register HTTP routes
      ctx.addRoute({ method: 'GET', path: '/api/status', handler: () => Response.json({ ok: true }) });

      // Register cron actions
      ctx.addCronAction({ name: 'cleanup', execute: async () => { /* ... */ } });
    },

    async onStop() {
      // Cleanup resources
    },
  };
}
```

## Configuration

| Env Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord server ID |
| `DISCORD_CHANNEL_ID` | Default channel ID |
| `DISCORD_OWNER_ID` | Bot owner user ID |
| `ANTHROPIC_API_KEY` | Anthropic API key (Claude) |
| `OPENAI_API_KEY` | OpenAI API key (Codex) |
| `GEMINI_API_KEY` | Google Gemini API key |
| `PORT` | HTTP server port (default: 4488) |

## Development

```bash
# Type check
npx tsc --noEmit

# Run tests
bun test

# Run specific test file
bun test src/monitor/
```

## License

MIT
