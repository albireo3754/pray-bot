import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ── Types ────────────────────────────────────────────────────────

interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

// ── Constants ────────────────────────────────────────────────────

const HOOK_EVENTS = [
  'Stop',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Notification',
] as const;

const DEFAULT_SETTINGS_PATH = resolve(
  process.env['HOME'] ?? '~',
  '.claude',
  'settings.json',
);

function resolveHookCommand(): string {
  // import.meta.dir = src/hooks/ → ../../hooks/pray-bot-hook.sh
  return resolve(import.meta.dir, '..', '..', 'hooks', 'pray-bot-hook.sh');
}

// ── Main ─────────────────────────────────────────────────────────

export interface EnsureHooksResult {
  added: string[];
  alreadyRegistered: string[];
}

/**
 * Ensure pray-bot hook script is registered in Claude Code settings.json
 * for all supported hook events.
 *
 * Idempotent — safe to call on every startup.
 */
export function ensureHooksRegistered(opts?: {
  settingsPath?: string;
  hookCommand?: string;
}): EnsureHooksResult {
  const settingsPath = opts?.settingsPath ?? DEFAULT_SETTINGS_PATH;
  const hookCommand = opts?.hookCommand ?? resolveHookCommand();

  // Read or create settings
  let settings: ClaudeSettings;
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw) as ClaudeSettings;
  } else {
    settings = {};
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const added: string[] = [];
  const alreadyRegistered: string[] = [];

  for (const event of HOOK_EVENTS) {
    const groups: HookGroup[] = settings.hooks[event] ?? [];

    // Check if pray-bot hook already registered in any group
    const hasHook = groups.some((group) =>
      group.hooks.some((h) => h.command.includes('pray-bot-hook.sh')),
    );

    if (hasHook) {
      alreadyRegistered.push(event);
      continue;
    }

    // Add new hook group
    groups.push({
      hooks: [{ type: 'command', command: hookCommand, timeout: 5 }],
    });
    settings.hooks[event] = groups;
    added.push(event);
  }

  // Write only if something changed
  if (added.length > 0) {
    const dir = dirname(settingsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return { added, alreadyRegistered };
}
