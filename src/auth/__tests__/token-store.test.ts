import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TokenStore, type TokenStoreEntry, type ConfigLoader } from '../token-store.ts';
import type { OAuthConfig, OAuthTokens } from '../oauth-pkce.ts';

const testDir = join(tmpdir(), `pray-bot-test-${Date.now()}`);

const mockConfig: OAuthConfig = {
  authorizeUrl: 'https://auth.example.com/oauth/authorize',
  tokenUrl: 'https://auth.example.com/oauth/token',
  clientId: 'test-client',
  scopes: ['read'],
  callbackPort: 19284,
};

function makeEntry(overrides?: Partial<OAuthTokens>): TokenStoreEntry {
  return {
    provider: 'pi-ai',
    tokens: {
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    },
    updatedAt: new Date().toISOString(),
  };
}

describe('TokenStore', () => {
  let store: TokenStore;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    store = new TokenStore(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('read/write/delete', () => {
    it('read returns null for non-existent provider', () => {
      expect(store.read('nonexistent')).toBeNull();
    });

    it('write then read returns same entry', () => {
      const entry = makeEntry();
      store.write('pi-ai', entry);
      const read = store.read('pi-ai');
      expect(read).not.toBeNull();
      expect(read!.tokens.accessToken).toBe('access-123');
      expect(read!.tokens.refreshToken).toBe('refresh-456');
    });

    it('write creates directory if missing', () => {
      const deepDir = join(testDir, 'nested', 'deep');
      const deepStore = new TokenStore(deepDir);
      deepStore.write('pi-ai', makeEntry());
      expect(existsSync(join(deepDir, 'pi-ai.json'))).toBe(true);
    });

    it('delete removes file', () => {
      store.write('pi-ai', makeEntry());
      expect(store.read('pi-ai')).not.toBeNull();
      store.delete('pi-ai');
      expect(store.read('pi-ai')).toBeNull();
    });

    it('delete on non-existent is a no-op', () => {
      expect(() => store.delete('nonexistent')).not.toThrow();
    });

    it('write overwrites existing entry', () => {
      store.write('pi-ai', makeEntry());
      store.write('pi-ai', makeEntry({ accessToken: 'new-access' }));
      const read = store.read('pi-ai');
      expect(read!.tokens.accessToken).toBe('new-access');
    });
  });

  describe('getValidToken', () => {
    it('returns null when no stored tokens', async () => {
      const token = await store.getValidToken('pi-ai');
      expect(token).toBeNull();
    });

    it('returns access token when not expired', async () => {
      store.write('pi-ai', makeEntry());
      const token = await store.getValidToken('pi-ai');
      expect(token).toBe('access-123');
    });

    it('throws when expired and no configLoader provided', async () => {
      const entry = makeEntry({ expiresAt: Math.floor(Date.now() / 1000) - 100 });
      store.write('pi-ai', entry);

      await expect(store.getValidToken('pi-ai')).rejects.toThrow(/Re-login required/);
    });

    it('throws when expired and refresh fails', async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response('{"error":"invalid_grant"}', { status: 401 });
        },
      });

      const loader: ConfigLoader = () => ({
        ...mockConfig,
        tokenUrl: `http://localhost:${server.port}/oauth/token`,
      });

      const entry = makeEntry({ expiresAt: Math.floor(Date.now() / 1000) - 100 });
      store.write('pi-ai', entry);

      await expect(store.getValidToken('pi-ai', loader)).rejects.toThrow(/Re-login required/);

      server.stop(true);
    });

    it('auto-refreshes when expired and refresh succeeds', async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return Response.json({
            access_token: 'refreshed-access',
            refresh_token: 'refreshed-refresh',
            expires_in: 7200,
          });
        },
      });

      const loader: ConfigLoader = () => ({
        ...mockConfig,
        tokenUrl: `http://localhost:${server.port}/oauth/token`,
      });

      const entry = makeEntry({ expiresAt: Math.floor(Date.now() / 1000) - 100 });
      store.write('pi-ai', entry);

      const token = await store.getValidToken('pi-ai', loader);
      expect(token).toBe('refreshed-access');

      // Verify the file was updated
      const updated = store.read('pi-ai');
      expect(updated!.tokens.refreshToken).toBe('refreshed-refresh');

      server.stop(true);
    });

    it('cleans up lock file after refresh', async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return Response.json({
            access_token: 'new',
            refresh_token: 'new-r',
            expires_in: 3600,
          });
        },
      });

      const loader: ConfigLoader = () => ({
        ...mockConfig,
        tokenUrl: `http://localhost:${server.port}/oauth/token`,
      });

      const entry = makeEntry({ expiresAt: Math.floor(Date.now() / 1000) - 100 });
      store.write('pi-ai', entry);

      await store.getValidToken('pi-ai', loader);

      const lockFile = join(testDir, 'pi-ai.lock');
      expect(existsSync(lockFile)).toBe(false);

      server.stop(true);
    });
  });
});
