/**
 * File-based token store at ~/.pray-bot/auth/<provider>.json
 *
 * Features:
 * - Atomic writes (write to temp file, then rename)
 * - File locking during refresh (prevents race conditions)
 * - Stale lock auto-cleanup (5s timeout)
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { OAuthConfig, OAuthTokens } from './oauth-pkce.ts';
import { refreshAccessToken } from './oauth-pkce.ts';

/** Callback to load OAuthConfig from env vars (not from stored file). */
export type ConfigLoader = (provider: string) => OAuthConfig | null;

export const AUTH_DIR = join(homedir(), '.pray-bot', 'auth');

export interface TokenStoreEntry {
  provider: string;
  tokens: OAuthTokens;
  updatedAt: string; // ISO 8601
}

const LOCK_TIMEOUT_MS = 5_000;
const REFRESH_BUFFER_SECONDS = 60; // refresh 60s before expiry

export class TokenStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? AUTH_DIR;
  }

  /** Read stored tokens. Returns null if not found. */
  read(provider: string): TokenStoreEntry | null {
    const filePath = this.filePath(provider);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as TokenStoreEntry;
    } catch {
      return null;
    }
  }

  /** Write tokens atomically. Creates directory if needed. */
  write(provider: string, entry: TokenStoreEntry): void {
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(provider);
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  }

  /** Delete stored tokens. */
  delete(provider: string): void {
    const filePath = this.filePath(provider);
    try {
      unlinkSync(filePath);
    } catch {
      // file didn't exist — ok
    }
    // Also clean up lock file if present
    try {
      unlinkSync(this.lockPath(provider));
    } catch {
      // ok
    }
  }

  /**
   * Get valid access token. Auto-refreshes if expired.
   * Uses file lock during refresh to prevent race conditions.
   * Returns null if no stored tokens.
   * Throws if refresh fails (re-login required).
   *
   * @param configLoader — loads OAuthConfig from env vars (never from stored file)
   */
  async getValidToken(provider: string, configLoader?: ConfigLoader): Promise<string | null> {
    const entry = this.read(provider);
    if (!entry) return null;

    const now = Math.floor(Date.now() / 1000);
    if (entry.tokens.expiresAt > now + REFRESH_BUFFER_SECONDS) {
      return entry.tokens.accessToken;
    }

    // Token expired or about to expire — need config to refresh
    const config = configLoader?.(provider) ?? null;
    if (!config) {
      throw new Error(`Re-login required: run \`pray-bot login ${provider}\``);
    }

    // Refresh with lock
    await this.acquireLock(provider);
    try {
      // Re-read: another process may have refreshed while we waited
      const fresh = this.read(provider);
      if (fresh && fresh.tokens.expiresAt > now + REFRESH_BUFFER_SECONDS) {
        return fresh.tokens.accessToken;
      }

      const newTokens = await refreshAccessToken(config, entry.tokens.refreshToken);
      const newEntry: TokenStoreEntry = {
        provider,
        tokens: newTokens,
        updatedAt: new Date().toISOString(),
      };
      this.write(provider, newEntry);
      return newTokens.accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TokenStore] Refresh failed for ${provider}: ${msg}`);
      throw new Error(`Re-login required: run \`pray-bot login ${provider}\``);
    } finally {
      this.releaseLock(provider);
    }
  }

  // ─── Internal ──────────────────────────────────────

  private static validateProvider(provider: string): void {
    if (!/^[a-z0-9-]+$/.test(provider)) {
      throw new Error(`Invalid provider name: "${provider}". Must match [a-z0-9-]+.`);
    }
  }

  private filePath(provider: string): string {
    TokenStore.validateProvider(provider);
    return join(this.baseDir, `${provider}.json`);
  }

  private lockPath(provider: string): string {
    TokenStore.validateProvider(provider);
    return join(this.baseDir, `${provider}.lock`);
  }

  private async acquireLock(provider: string): Promise<void> {
    const lockFile = this.lockPath(provider);
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });

    const start = Date.now();
    while (true) {
      try {
        // O_CREAT | O_EXCL — atomic: fails if file already exists
        writeFileSync(lockFile, String(Date.now()), { flag: 'wx' });
        return; // lock acquired
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw e;

        // Lock exists — check if stale
        this.cleanStaleLock(lockFile);

        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          // Force break after timeout
          rmSync(lockFile, { force: true });
          continue;
        }
        await Bun.sleep(50); // async sleep — does not block the event loop
      }
    }
  }

  private cleanStaleLock(lockFile: string): void {
    try {
      const content = readFileSync(lockFile, 'utf-8');
      const lockTime = parseInt(content, 10);
      if (Date.now() - lockTime > LOCK_TIMEOUT_MS) {
        rmSync(lockFile, { force: true });
      }
    } catch {
      // Lock file disappeared or unreadable — ok
    }
  }

  private releaseLock(provider: string): void {
    try {
      unlinkSync(this.lockPath(provider));
    } catch {
      // ok
    }
  }
}
