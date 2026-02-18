/**
 * install-hooks.ts
 *
 * Installs lifecycle-logger.sh as a symlink under ~/.claude/hooks/
 * and registers it in ~/.claude/settings.json for 4 hook events.
 *
 * Usage: bun run src/lifecycle-stream/install-hooks.ts
 */

import { existsSync, mkdirSync, symlinkSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ── Paths ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '';
const HOOKS_DIR = resolve(HOME, '.claude', 'hooks');
const SETTINGS_PATH = resolve(HOME, '.claude', 'settings.json');

// Absolute path to the source script (relative to this file)
const SCRIPT_SRC = resolve(import.meta.dir, 'lifecycle-logger.sh');
const SCRIPT_DEST = resolve(HOOKS_DIR, 'lifecycle-logger.sh');

// ── Hook definitions ──────────────────────────────────────────────────────

const LIFECYCLE_HOOKS = [
  {
    event: 'SessionStart',
    matcher: undefined,
    command: `EVENT_TYPE=session.lifecycle PHASE=started ${SCRIPT_DEST}`,
    label: 'SessionStart: lifecycle-logger',
  },
  {
    event: 'Stop',
    matcher: undefined,
    command: `EVENT_TYPE=session.lifecycle PHASE=ended ${SCRIPT_DEST}`,
    label: 'Stop: lifecycle-logger',
  },
  {
    event: 'PreToolUse',
    matcher: 'Skill',
    command: `EVENT_TYPE=skill.lifecycle PHASE=in_progress ${SCRIPT_DEST}`,
    label: 'PreToolUse[Skill]: lifecycle-logger',
  },
  {
    event: 'PostToolUse',
    matcher: 'Skill',
    command: `EVENT_TYPE=skill.lifecycle PHASE=completed ${SCRIPT_DEST}`,
    label: 'PostToolUse[Skill]: lifecycle-logger',
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────

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

// ── Install ───────────────────────────────────────────────────────────────

function installSymlink(): void {
  if (!existsSync(SCRIPT_SRC)) {
    throw new Error(`Source script not found: ${SCRIPT_SRC}`);
  }

  mkdirSync(HOOKS_DIR, { recursive: true });

  if (existsSync(SCRIPT_DEST)) {
    console.log(`  (skip) symlink already exists: ${SCRIPT_DEST}`);
  } else {
    symlinkSync(SCRIPT_SRC, SCRIPT_DEST);
    console.log(`✓ symlink: ${SCRIPT_DEST} → ${SCRIPT_SRC}`);
  }

  // Ensure executable
  chmodSync(SCRIPT_SRC, 0o755);
}

function mergeHooks(): void {
  let settings: ClaudeSettings = {};

  const dir = dirname(SETTINGS_PATH);
  mkdirSync(dir, { recursive: true });

  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as ClaudeSettings;
    } catch {
      console.warn('  Warning: could not parse existing settings.json, starting fresh');
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const added: string[] = [];

  for (const hookDef of LIFECYCLE_HOOKS) {
    const groups: HookGroup[] = settings.hooks[hookDef.event] ?? [];

    // Check if already registered (by command string)
    const alreadyRegistered = groups.some((group) =>
      group.hooks.some((h) => h.command === hookDef.command),
    );

    if (alreadyRegistered) {
      console.log(`  (skip) already registered: ${hookDef.label}`);
      continue;
    }

    // Add new hook group
    const newGroup: HookGroup = {
      hooks: [{ type: 'command', command: hookDef.command }],
    };
    if (hookDef.matcher) {
      newGroup.matcher = hookDef.matcher;
    }

    groups.push(newGroup);
    settings.hooks[hookDef.event] = groups;
    added.push(hookDef.label);
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

  if (added.length > 0) {
    console.log(`✓ hooks merged into ${SETTINGS_PATH}`);
    for (const label of added) {
      console.log(`  - ${label}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

installSymlink();
mergeHooks();

console.log('');
console.log('Run to verify:');
console.log('  claude --dangerously-skip-permissions -p "snowflake 스킬 1 테스트"');
console.log('  cat ~/.kw-chat/streams/lifecycle.jsonl');
