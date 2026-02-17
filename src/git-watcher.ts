import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';

export interface GitWatcherOptions {
  /** Path to the git repo root (default: cwd) */
  repoPath?: string;
  /** Branch to watch (default: main) */
  branch?: string;
  /** Delay before restart in ms (default: 1000) */
  restartDelayMs?: number;
  /** Callback before restart */
  onBeforeRestart?: (oldSha: string, newSha: string) => void | Promise<void>;
}

export class GitWatcher {
  private watcher: FSWatcher | null = null;
  private currentSha: string = '';
  private refPath: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private branch: string;
  private restartDelayMs: number;
  private onBeforeRestart?: (oldSha: string, newSha: string) => void | Promise<void>;

  constructor(opts: GitWatcherOptions = {}) {
    const repoPath = opts.repoPath ?? process.cwd();
    this.branch = opts.branch ?? 'main';
    this.restartDelayMs = opts.restartDelayMs ?? 1000;
    this.onBeforeRestart = opts.onBeforeRestart;
    this.refPath = resolve(repoPath, '.git', 'refs', 'heads', this.branch);
  }

  async start(): Promise<void> {
    // Read initial SHA
    try {
      this.currentSha = await this.readSha();
      console.log(`[GitWatcher] Watching ${this.branch} (${this.currentSha.slice(0, 8)})`);
    } catch (err) {
      console.error(`[GitWatcher] Failed to read ref ${this.refPath}:`, err);
      return;
    }

    // Watch the ref file
    try {
      this.watcher = watch(this.refPath, (_event) => {
        this.handleChange();
      });
      this.watcher.on('error', (err) => {
        console.error('[GitWatcher] Watch error:', err);
      });
    } catch (err) {
      console.error('[GitWatcher] Failed to start watcher:', err);
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private handleChange(): void {
    // Debounce: git may write multiple times during a merge
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.checkAndRestart(), 500);
  }

  private async checkAndRestart(): Promise<void> {
    try {
      const newSha = await this.readSha();
      if (newSha === this.currentSha) return;

      const oldSha = this.currentSha;
      this.currentSha = newSha;

      console.log(`[GitWatcher] ${this.branch} updated: ${oldSha.slice(0, 8)} → ${newSha.slice(0, 8)}`);
      console.log(`[GitWatcher] Restarting in ${this.restartDelayMs}ms...`);

      if (this.onBeforeRestart) {
        await this.onBeforeRestart(oldSha, newSha);
      }

      setTimeout(() => process.exit(0), this.restartDelayMs);
    } catch (err) {
      console.error('[GitWatcher] Failed to read updated ref:', err);
    }
  }

  private async readSha(): Promise<string> {
    const file = Bun.file(this.refPath);
    const content = await file.text();
    return content.trim();
  }
}
