import { PluginManager } from './plugin/loader.ts';
import type { PrayBotPlugin, PluginContext, RouteDefinition, CronActionDefinition } from './plugin/types.ts';
import type { CommandDefinition } from './command/registry.ts';
import { CommandRegistry } from './command/registry.ts';
import { AgentSessionManager } from './agents/manager.ts';
import { createHookRoute, type HookAcceptingMonitor } from './usage-monitor/hook-receiver.ts';
import type { AutoThreadDiscovery } from './auto-thread/index.ts';
import type { Server } from 'bun';

type WebSocketData = Record<string, unknown>;

export interface PrayBotConfig {
  /** HTTP server port (default: 4488) */
  port?: number;
  /** Hostname to bind (default: '0.0.0.0') */
  hostname?: string;
  /** Set to false to skip built-in HTTP server (when using external server) */
  startServer?: boolean;
  /** Auth token for /api/* routes (optional) */
  authToken?: string;
  /** Discord bot token (null = no Discord) */
  discordToken?: string | null;
  /** Additional config passed to plugins */
  [key: string]: unknown;
}

export class PrayBot {
  private pluginManager = new PluginManager();
  private commands = new CommandRegistry();
  private agents = new AgentSessionManager();
  private routes: RouteDefinition[] = [];
  private cronActions: CronActionDefinition[] = [];
  private server: Server<WebSocketData> | null = null;
  private config: PrayBotConfig;

  constructor(config: PrayBotConfig = {}) {
    this.config = { port: 4488, hostname: '0.0.0.0', ...config };
  }

  /** Register a plugin */
  use(plugin: PrayBotPlugin): this {
    this.pluginManager.register(plugin);
    return this;
  }

  /** Add a route directly (outside plugin lifecycle) */
  addRoute(route: RouteDefinition): void {
    this.routes.push(route);
  }

  /** Register the hook receiver route (POST /api/hook) for activity phase detection. */
  registerHookRoute(
    providers: Map<string, HookAcceptingMonitor>,
    autoThread: AutoThreadDiscovery,
  ): void {
    this.routes.push(createHookRoute(providers, autoThread));
  }

  /** Start the bot: initialize plugins, start server */
  async start(): Promise<void> {
    // Build plugin context
    const ctx: PluginContext = {
      agents: this.agents,
      discord: null, // TODO: initialize Discord client if token provided
      addRoute: (route) => this.routes.push(route),
      addCronAction: (action) => this.cronActions.push(action),
      addCommand: (cmd) => this.commands.register(cmd),
      config: this.config,
    };

    // Initialize all plugins
    await this.pluginManager.startAll(ctx);

    // Start HTTP server (unless disabled)
    if (this.config.startServer !== false) {
      this.server = Bun.serve({
        port: this.config.port ?? 4488,
        hostname: this.config.hostname ?? '0.0.0.0',
        fetch: (req) => this.handleRequest(req),
      });
    }
  }

  /** Stop the bot gracefully */
  async stop(): Promise<void> {
    await this.pluginManager.stopAll();
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  /** Get registered commands */
  getCommands(): CommandRegistry {
    return this.commands;
  }

  /** Get registered routes */
  getRoutes(): ReadonlyArray<RouteDefinition> {
    return this.routes;
  }

  /** Get registered cron actions */
  getCronActions(): ReadonlyArray<CronActionDefinition> {
    return this.cronActions;
  }

  /** Get registered plugins */
  getPlugins() {
    return this.pluginManager.list();
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // Health check
    if (method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }

    // Match registered routes
    for (const route of this.routes) {
      if (route.method === method && matchPath(route.path, url.pathname)) {
        try {
          const result = route.handler(req);
          return result instanceof Promise ? await result : result;
        } catch (err) {
          return Response.json(
            { status: 'error', error: String(err) },
            { status: 500 },
          );
        }
      }
    }

    return Response.json({ status: 'error', error: 'Not found' }, { status: 404 });
  }
}

/**
 * Match a route path pattern against an actual URL pathname.
 * Supports :param segments (e.g. /api/workflow/status/:service).
 */
function matchPath(pattern: string, pathname: string): boolean {
  if (pattern === pathname) return true;
  if (!pattern.includes(':')) return false;

  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    if (pp.startsWith(':')) continue;
    if (pp !== pathParts[i]) return false;
  }
  return true;
}
