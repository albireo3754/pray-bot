#!/usr/bin/env bun
/**
 * pray-bot CLI — OAuth login management
 *
 * Usage:
 *   pray-bot login <provider>     Login via OAuth PKCE
 *   pray-bot status <provider>    Check auth status
 *   pray-bot logout <provider>    Remove stored credentials
 *   pray-bot help                 Show help
 */

import {
  TokenStore,
  loginWithPKCE,
  DEFAULT_CALLBACK_PORT,
  type OAuthConfig,
} from './auth/index.ts';

export type CLICommand =
  | { kind: 'login'; provider: string }
  | { kind: 'status'; provider: string }
  | { kind: 'logout'; provider: string }
  | { kind: 'help' };

const HELP = `pray-bot — LLM Orchestration CLI

Commands:
  pray-bot login <provider>     Login via OAuth PKCE (opens browser)
  pray-bot status <provider>    Check authentication status
  pray-bot logout <provider>    Remove stored credentials
  pray-bot help                 Show this help message

Supported providers: pi-ai

Examples:
  pray-bot login pi-ai
  pray-bot status pi-ai
  pray-bot logout pi-ai
`;

/** Parse process.argv into a typed command. Throws on invalid input. */
export function parseArgs(argv: string[]): CLICommand {
  // argv: [bun, script, ...args]
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' };
  }

  const cmd = args[0]!;
  const provider = args[1];

  switch (cmd) {
    case 'login':
      if (!provider) throw new Error('Missing provider. Usage: pray-bot login <provider>');
      return { kind: 'login', provider };
    case 'status':
      if (!provider) throw new Error('Missing provider. Usage: pray-bot status <provider>');
      return { kind: 'status', provider };
    case 'logout':
      if (!provider) throw new Error('Missing provider. Usage: pray-bot logout <provider>');
      return { kind: 'logout', provider };
    default:
      throw new Error(`Unknown command: ${cmd}. Run "pray-bot help" for usage.`);
  }
}

function getOAuthConfig(provider: string): OAuthConfig {
  switch (provider) {
    case 'pi-ai':
      return {
        authorizeUrl: requireEnv('PIAI_OAUTH_AUTHORIZE_URL'),
        tokenUrl: requireEnv('PIAI_OAUTH_TOKEN_URL'),
        clientId: requireEnv('PIAI_OAUTH_CLIENT_ID'),
        scopes: (process.env.PIAI_OAUTH_SCOPES ?? 'openid').split(',').map(s => s.trim()),
        callbackPort: parseInt(process.env.PIAI_OAUTH_CALLBACK_PORT ?? String(DEFAULT_CALLBACK_PORT), 10),
      };
    default:
      throw new Error(`Unknown provider: ${provider}. Supported: pi-ai`);
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

/** Execute a parsed CLI command. */
export async function runCommand(cmd: CLICommand): Promise<void> {
  const store = new TokenStore();

  switch (cmd.kind) {
    case 'help':
      console.log(HELP);
      break;

    case 'login': {
      const config = getOAuthConfig(cmd.provider);
      console.log(`Logging in to ${cmd.provider}...`);
      const tokens = await loginWithPKCE(config);
      store.write(cmd.provider, {
        provider: cmd.provider,
        tokens,
        updatedAt: new Date().toISOString(),
      });
      console.log('Logged in successfully!');
      if (tokens.accountId) {
        console.log(`Account: ${tokens.accountId}`);
      }
      break;
    }

    case 'status': {
      const entry = store.read(cmd.provider);
      if (!entry) {
        console.log('Not authenticated');
        if (process.env.PIAI_API_KEY) {
          console.log('(Using API key fallback via PIAI_API_KEY)');
        }
        process.exitCode = 1;
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = entry.tokens.expiresAt - now;
      if (expiresIn > 0) {
        const mins = Math.floor(expiresIn / 60);
        const expDate = new Date(entry.tokens.expiresAt * 1000).toISOString();
        console.log(`Authenticated (expires: ${expDate}, ${mins}m remaining)`);
      } else {
        console.log('Token expired. Run `pray-bot login pi-ai` to re-authenticate.');
      }
      if (entry.tokens.accountId) {
        console.log(`Account: ${entry.tokens.accountId}`);
      }
      break;
    }

    case 'logout': {
      store.delete(cmd.provider);
      console.log('Logged out');
      break;
    }
  }
}

// ─── Main entry point ─────────────────────────────
if (import.meta.main) {
  try {
    const cmd = parseArgs(process.argv);
    await runCommand(cmd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
