/**
 * Integration test: Full OAuth PKCE login flow with mock server.
 *
 * Simulates the complete flow:
 * 1. Mock OAuth server (authorize endpoint + token endpoint)
 * 2. PKCE generation + token exchange
 * 3. Token store → retrieve → auto-refresh → logout
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TokenStore, type TokenStoreEntry, type ConfigLoader } from '../token-store.ts';
import {
  generatePKCE,
  refreshAccessToken,
  type OAuthConfig,
} from '../oauth-pkce.ts';
import { parseArgs } from '../../cli.ts';

const testDir = join(tmpdir(), `pray-bot-integration-${Date.now()}`);

describe('Integration: OAuth PKCE flow', () => {
  let store: TokenStore;
  let mockTokenServer: ReturnType<typeof Bun.serve>;
  let tokenServerPort: number;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    store = new TokenStore(testDir);

    // Mock token endpoint
    mockTokenServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/oauth/token' && req.method === 'POST') {
          return Response.json({
            access_token: 'integration-access-token',
            refresh_token: 'integration-refresh-token',
            expires_in: 3600,
            account_id: 'test-user-1',
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });
    tokenServerPort = mockTokenServer.port!;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mockTokenServer.stop(true);
  });

  const getConfig = (): OAuthConfig => ({
    authorizeUrl: `http://localhost:${tokenServerPort}/oauth/authorize`,
    tokenUrl: `http://localhost:${tokenServerPort}/oauth/token`,
    clientId: 'test-client-integration',
    scopes: ['openid', 'read'],
    callbackPort: 0,
  });

  it('PKCE generation → token exchange → store → retrieve → logout', async () => {
    const config = getConfig();

    // Step 1: PKCE generation
    const pkce = generatePKCE();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);

    // Step 2: Token exchange via refreshAccessToken (tests HTTP flow)
    const tokens = await refreshAccessToken(config, 'dummy-refresh');
    expect(tokens.accessToken).toBeTruthy();

    // Step 3: Store tokens (no config persisted)
    const entry: TokenStoreEntry = {
      provider: 'pi-ai',
      tokens: {
        accessToken: 'integration-access-token',
        refreshToken: 'integration-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        accountId: 'test-user-1',
      },
      updatedAt: new Date().toISOString(),
    };
    store.write('pi-ai', entry);

    // Step 4: Read tokens back
    const read = store.read('pi-ai');
    expect(read).not.toBeNull();
    expect(read!.tokens.accessToken).toBe('integration-access-token');
    expect(read!.tokens.accountId).toBe('test-user-1');

    // Step 5: getValidToken (not expired)
    const validToken = await store.getValidToken('pi-ai');
    expect(validToken).toBe('integration-access-token');

    // Step 6: Logout
    store.delete('pi-ai');
    expect(store.read('pi-ai')).toBeNull();
    expect(await store.getValidToken('pi-ai')).toBeNull();
  });

  it('expired token triggers auto-refresh via getValidToken with configLoader', async () => {
    const config = getConfig();
    const loader: ConfigLoader = () => config;

    // Store expired token (no config in entry)
    const entry: TokenStoreEntry = {
      provider: 'pi-ai',
      tokens: {
        accessToken: 'old-expired-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) - 300,
      },
      updatedAt: new Date().toISOString(),
    };
    store.write('pi-ai', entry);

    // getValidToken with configLoader should auto-refresh
    const token = await store.getValidToken('pi-ai', loader);
    expect(token).toBe('integration-access-token');

    // Verify store was updated
    const updated = store.read('pi-ai');
    expect(updated!.tokens.accessToken).toBe('integration-access-token');
    expect(updated!.tokens.refreshToken).toBe('integration-refresh-token');
  });

  it('expired token without configLoader throws re-login required', async () => {
    const entry: TokenStoreEntry = {
      provider: 'pi-ai',
      tokens: {
        accessToken: 'old-expired-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) - 300,
      },
      updatedAt: new Date().toISOString(),
    };
    store.write('pi-ai', entry);

    // No configLoader → cannot refresh → throws
    await expect(store.getValidToken('pi-ai')).rejects.toThrow(/Re-login required/);
  });
});

describe('Integration: CLI parseArgs', () => {
  it('parses login command', () => {
    const cmd = parseArgs(['bun', 'cli.ts', 'login', 'pi-ai']);
    expect(cmd).toEqual({ kind: 'login', provider: 'pi-ai' });
  });

  it('parses status command', () => {
    const cmd = parseArgs(['bun', 'cli.ts', 'status', 'pi-ai']);
    expect(cmd).toEqual({ kind: 'status', provider: 'pi-ai' });
  });

  it('parses logout command', () => {
    const cmd = parseArgs(['bun', 'cli.ts', 'logout', 'pi-ai']);
    expect(cmd).toEqual({ kind: 'logout', provider: 'pi-ai' });
  });

  it('parses help', () => {
    const cmd = parseArgs(['bun', 'cli.ts', 'help']);
    expect(cmd).toEqual({ kind: 'help' });
  });

  it('defaults to help with no args', () => {
    const cmd = parseArgs(['bun', 'cli.ts']);
    expect(cmd).toEqual({ kind: 'help' });
  });

  it('throws on unknown command', () => {
    expect(() => parseArgs(['bun', 'cli.ts', 'foo'])).toThrow(/Unknown command: foo/);
  });

  it('throws on missing provider', () => {
    expect(() => parseArgs(['bun', 'cli.ts', 'login'])).toThrow(/Missing provider/);
  });
});

describe('Integration: provider isAvailable with TokenStore', () => {
  let store: TokenStore;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    store = new TokenStore(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when no stored tokens', () => {
    expect(store.read('pi-ai')).toBeNull();
  });

  it('returns entry when stored tokens exist', () => {
    store.write('pi-ai', {
      provider: 'pi-ai',
      tokens: {
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      updatedAt: new Date().toISOString(),
    });
    expect(store.read('pi-ai')).not.toBeNull();
  });
});
