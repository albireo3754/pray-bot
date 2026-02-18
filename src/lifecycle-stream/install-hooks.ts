/**
 * install-hooks.ts
 *
 * Installs lifecycle-logger.sh as a symlink under ~/.claude/hooks/
 * and registers it in ~/.claude/settings.json for hook events.
 *
 * v2 changes vs v1:
 *   - Stop → turn.end (v1 오류: Stop은 매 턴 완료, 세션 종료가 아님)
 *   - SessionEnd → session.lifecycle ended (실제 세션 종료)
 *   - UserPromptSubmit → turn.start (prompt 캡처)
 *   - Notification → session.activity (activityType 캡처)
 *
 * Usage: bun run src/lifecycle-stream/install-hooks.ts
 */

import { existsSync, mkdirSync, symlinkSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ── Paths ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '';
const HOOKS_DIR = resolve(HOME, '.claude', 'hooks');
const SETTINGS_PATH = resolve(HOME, '.claude', 'settings.json');

const SCRIPT_SRC = resolve(import.meta.dir, 'lifecycle-logger.sh');
const SCRIPT_DEST = resolve(HOOKS_DIR, 'lifecycle-logger.sh');

// ── Hook definitions (v2) ─────────────────────────────────────────────────

const LIFECYCLE_HOOKS = [
  {
    event: 'SessionStart',
    matcher: undefined,
    command: `EVENT_TYPE=session.lifecycle PHASE=started ${SCRIPT_DEST}`,
    label: 'SessionStart: lifecycle-logger',
  },
  {
    event: 'SessionEnd',
    matcher: undefined,
    command: `EVENT_TYPE=session.lifecycle PHASE=ended ${SCRIPT_DEST}`,
    label: 'SessionEnd: lifecycle-logger',
  },
  {
    event: 'Stop',
    matcher: undefined,
    command: `EVENT_TYPE=turn.end ${SCRIPT_DEST}`,
    label: 'Stop: lifecycle-logger (turn.end)',
  },
  {
    event: 'UserPromptSubmit',
    matcher: undefined,
    command: `EVENT_TYPE=turn.start ${SCRIPT_DEST}`,
    label: 'UserPromptSubmit: lifecycle-logger (turn.start)',
  },
  {
    event: 'Notification',
    matcher: undefined,
    command: `EVENT_TYPE=session.activity ${SCRIPT_DEST}`,
    label: 'Notification: lifecycle-logger (session.activity)',
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

  chmodSync(SCRIPT_SRC, 0o755);
}

/**
 * 해당 이벤트의 groups에서 lifecycle-logger.sh를 포함하는 그룹을 제거한다.
 * v1 → v2 migration 시 구 command를 정리하는 데 사용.
 */
function removeLifecycleGroups(groups: HookGroup[]): HookGroup[] {
  return groups.filter(
    (group) => !group.hooks.some((h) => h.command.includes('lifecycle-logger.sh')),
  );
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
  const migrated: string[] = [];

  for (const hookDef of LIFECYCLE_HOOKS) {
    let groups: HookGroup[] = settings.hooks[hookDef.event] ?? [];

    // 이미 정확한 v2 command가 등록되어 있으면 skip
    const alreadyRegistered = groups.some((group) =>
      group.hooks.some((h) => h.command === hookDef.command),
    );
    if (alreadyRegistered) {
      console.log(`  (skip) already registered: ${hookDef.label}`);
      continue;
    }

    // v1 lifecycle-logger 그룹 제거 (migration)
    const cleaned = removeLifecycleGroups(groups);
    if (cleaned.length < groups.length) {
      migrated.push(hookDef.event);
      groups = cleaned;
    }

    // 새 hook group 추가
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

  if (migrated.length > 0) {
    console.log(`  migrated old lifecycle hooks: ${migrated.join(', ')}`);
  }
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
