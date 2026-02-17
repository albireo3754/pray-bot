import type { CommandDefinition } from '../command/registry.ts';

/** HTTP route handler */
export type RouteHandler = (req: Request) => Response | Promise<Response>;

/** Route definition for plugin-provided HTTP endpoints */
export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: RouteHandler;
}

/** Cron action that plugins can register */
export interface CronActionDefinition {
  name: string;
  description?: string;
  execute: (params: Record<string, unknown>) => Promise<void>;
}

/** Context provided to plugins during lifecycle */
export interface PluginContext {
  /** Access to agent session management */
  agents: unknown; // AgentSessionManager - kept as unknown to avoid circular deps
  /** Discord client (null if not configured) */
  discord: unknown | null;
  /** HTTP server route registration */
  addRoute(route: RouteDefinition): void;
  /** Register a cron action */
  addCronAction(action: CronActionDefinition): void;
  /** Register commands */
  addCommand(command: CommandDefinition): void;
  /** Get configuration value */
  config: Record<string, unknown>;
}

/** Plugin interface - implement this to extend pray-bot */
export interface PrayBotPlugin {
  /** Unique plugin name */
  readonly name: string;
  /** Plugin version (semver) */
  readonly version?: string;
  /** Called when the bot starts - register routes, commands, cron actions */
  onStart(ctx: PluginContext): Promise<void> | void;
  /** Called when the bot stops - cleanup resources */
  onStop?(): Promise<void> | void;
}
