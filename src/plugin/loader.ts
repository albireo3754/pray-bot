import type { PrayBotPlugin, PluginContext } from './types.ts';

export class PluginManager {
  private plugins: PrayBotPlugin[] = [];
  private started = false;

  /** Register a plugin. Must be called before start(). */
  register(plugin: PrayBotPlugin): void {
    if (this.started) {
      throw new Error(`Cannot register plugin "${plugin.name}" after start()`);
    }
    if (this.plugins.some(p => p.name === plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }
    this.plugins.push(plugin);
  }

  /** Initialize all plugins with the given context */
  async startAll(ctx: PluginContext): Promise<void> {
    this.started = true;
    for (const plugin of this.plugins) {
      await plugin.onStart(ctx);
    }
  }

  /** Stop all plugins in reverse order */
  async stopAll(): Promise<void> {
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const plugin = this.plugins[i];
      if (plugin?.onStop) {
        await plugin.onStop();
      }
    }
    this.started = false;
  }

  /** List registered plugins */
  list(): ReadonlyArray<{ name: string; version?: string }> {
    return this.plugins.map(p => ({ name: p.name, version: p.version }));
  }
}
