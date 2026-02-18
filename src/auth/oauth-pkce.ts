/**
 * OAuth PKCE flow for Pi-AI authentication.
 *
 * Implements RFC 7636 (PKCE) with S256 challenge method:
 * 1. Generate verifier + challenge + state
 * 2. Start localhost callback server
 * 3. Open browser to authorize URL
 * 4. Exchange auth code for tokens
 */

import { randomBytes, createHash } from 'crypto';

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  callbackPort: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix epoch seconds
  accountId?: string;
}

export interface PKCEChallenge {
  verifier: string;
  challenge: string;
  state: string;
}

export const DEFAULT_CALLBACK_PORT = 19284;

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** Generate PKCE verifier + challenge + state (RFC 7636) */
export function generatePKCE(): PKCEChallenge {
  const verifier = base64url(randomBytes(32)); // 43 chars
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));
  return { verifier, challenge, state };
}

/**
 * Full OAuth PKCE login flow:
 * 1. Generate PKCE challenge
 * 2. Start localhost callback server
 * 3. Open browser to authorize URL
 * 4. Wait for redirect with auth code
 * 5. Exchange code for tokens
 */
export async function loginWithPKCE(config: OAuthConfig): Promise<OAuthTokens> {
  const pkce = generatePKCE();
  const redirectUri = `http://localhost:${config.callbackPort}/callback`;

  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    scope: config.scopes.join(' '),
  });

  const authorizeUrl = `${config.authorizeUrl}?${authorizeParams}`;

  const { code } = await startCallbackServer(config.callbackPort, pkce.state, authorizeUrl);
  return exchangeCodeForTokens(config, code, pkce.verifier, redirectUri);
}

/** Exchange refresh token for new access token */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return parseTokenResponse(data, refreshToken);
}

// ─── Internal ────────────────────────────────────────────

async function startCallbackServer(
  port: number,
  expectedState: string,
  authorizeUrl: string,
): Promise<{ code: string }> {
  return new Promise<{ code: string }>((resolve, reject) => {
    let server: ReturnType<typeof Bun.serve> | null = null;

    const timeout = setTimeout(() => {
      server?.stop(true);
      reject(new Error('Login timed out (5 minutes). Please try again.'));
    }, 5 * 60 * 1000);

    try {
      server = Bun.serve({
        port,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== '/callback') {
            return new Response('Not found', { status: 404 });
          }

          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            const desc = url.searchParams.get('error_description') ?? error;
            clearTimeout(timeout);
            server?.stop(true);
            reject(new Error(`OAuth error: ${desc}`));
            return new Response(html('Login failed', desc), {
              headers: { 'Content-Type': 'text/html' },
            });
          }

          if (state !== expectedState) {
            clearTimeout(timeout);
            server?.stop(true);
            reject(new Error('State mismatch — possible CSRF attack'));
            return new Response(html('Error', 'State mismatch'), {
              headers: { 'Content-Type': 'text/html' },
            });
          }

          if (!code) {
            clearTimeout(timeout);
            server?.stop(true);
            reject(new Error('No authorization code received'));
            return new Response(html('Error', 'No code received'), {
              headers: { 'Content-Type': 'text/html' },
            });
          }

          clearTimeout(timeout);
          // Defer stop to next tick so response can be sent
          setTimeout(() => server?.stop(true), 100);
          resolve({ code });

          return new Response(
            html('Login successful!', 'You can close this tab and return to the terminal.'),
            { headers: { 'Content-Type': 'text/html' } },
          );
        },
      });
    } catch (e: unknown) {
      clearTimeout(timeout);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('EADDRINUSE') || msg.includes('address already in use')) {
        reject(new Error(`Port ${port} already in use. Close the other process and try again.`));
      } else {
        reject(e);
      }
      return;
    }

    // Open browser (cross-platform)
    console.log(`\nOpening browser for authorization...`);
    console.log(`If the browser doesn't open automatically, visit:\n${authorizeUrl}\n`);
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    const proc = Bun.spawn([openCmd, authorizeUrl], { stdout: 'ignore', stderr: 'ignore' });
    proc.unref();
    console.log('Waiting for authorization... (press Ctrl+C to cancel)\n');
  });
}

async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return parseTokenResponse(data);
}

function parseTokenResponse(data: Record<string, unknown>, fallbackRefresh?: string): OAuthTokens {
  const accessToken = typeof data.access_token === 'string' ? data.access_token : undefined;
  const refreshToken = (typeof data.refresh_token === 'string' ? data.refresh_token : undefined) ?? fallbackRefresh;
  const rawExpiresIn = data.expires_in;
  const expiresIn = typeof rawExpiresIn === 'number' ? rawExpiresIn
    : typeof rawExpiresIn === 'string' ? parseInt(rawExpiresIn, 10)
    : undefined;

  if (!accessToken) throw new Error('No access_token in token response');
  if (!refreshToken) throw new Error('No refresh_token in token response');
  if (expiresIn !== undefined && isNaN(expiresIn)) {
    throw new Error('Invalid expires_in in token response');
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (expiresIn ?? 3600),
    accountId: typeof data.account_id === 'string' ? data.account_id : undefined,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function html(title: string, body: string): string {
  const t = escapeHtml(title);
  const b = escapeHtml(body);
  return `<!DOCTYPE html><html><head><title>${t}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:80vh;margin:0;color:#333}
.c{text-align:center}h1{font-size:1.5rem}p{color:#666}</style>
</head><body><div class="c"><h1>${t}</h1><p>${b}</p></div></body></html>`;
}
