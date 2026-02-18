import { describe, it, expect } from 'bun:test';
import { createHash } from 'crypto';
import { generatePKCE, refreshAccessToken, type OAuthConfig } from '../oauth-pkce.ts';

const mockConfig: OAuthConfig = {
  authorizeUrl: 'https://auth.example.com/oauth/authorize',
  tokenUrl: 'https://auth.example.com/oauth/token',
  clientId: 'test-client',
  scopes: ['read', 'write'],
  callbackPort: 19284,
};

describe('generatePKCE', () => {
  it('should produce verifier of length 43-128', () => {
    const pkce = generatePKCE();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.verifier.length).toBeLessThanOrEqual(128);
  });

  it('should produce challenge = base64url(SHA-256(verifier))', () => {
    const pkce = generatePKCE();
    const expected = createHash('sha256').update(pkce.verifier).digest('base64url');
    expect(pkce.challenge).toBe(expected);
  });

  it('should produce non-empty state', () => {
    const pkce = generatePKCE();
    expect(pkce.state.length).toBeGreaterThan(0);
  });

  it('should produce unique values on each call', () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });

  it('verifier should be base64url (no +, /, =)', () => {
    const pkce = generatePKCE();
    expect(pkce.verifier).not.toMatch(/[+/=]/);
    expect(pkce.challenge).not.toMatch(/[+/=]/);
  });
});

describe('refreshAccessToken', () => {
  it('should throw on HTTP error', async () => {
    // Start a mock server that returns 401
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('{"error":"invalid_grant"}', { status: 401 });
      },
    });

    const config: OAuthConfig = {
      ...mockConfig,
      tokenUrl: `http://localhost:${server.port}/oauth/token`,
    };

    await expect(refreshAccessToken(config, 'bad-refresh')).rejects.toThrow(
      /Token refresh failed \(401\)/,
    );

    server.stop(true);
  });

  it('should return tokens on success', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 7200,
        });
      },
    });

    const config: OAuthConfig = {
      ...mockConfig,
      tokenUrl: `http://localhost:${server.port}/oauth/token`,
    };

    const tokens = await refreshAccessToken(config, 'old-refresh');
    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.refreshToken).toBe('new-refresh');
    expect(tokens.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    server.stop(true);
  });

  it('should keep old refresh token if server does not return new one', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          access_token: 'new-access',
          expires_in: 3600,
        });
      },
    });

    const config: OAuthConfig = {
      ...mockConfig,
      tokenUrl: `http://localhost:${server.port}/oauth/token`,
    };

    const tokens = await refreshAccessToken(config, 'keep-this-refresh');
    expect(tokens.refreshToken).toBe('keep-this-refresh');

    server.stop(true);
  });
});
