import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureHooksRegistered } from '../claude-settings.ts';

const HOOK_CMD = '/mock/hooks/pray-bot-hook.sh';
const ALL_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Notification'];

let tmpDir: string;
let settingsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'claude-settings-test-'));
  settingsPath = join(tmpDir, 'settings.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readSettings() {
  return JSON.parse(readFileSync(settingsPath, 'utf-8'));
}

describe('ensureHooksRegistered', () => {
  test('creates settings file when it does not exist', () => {
    const result = ensureHooksRegistered({ settingsPath, hookCommand: HOOK_CMD });

    expect(result.added).toEqual(ALL_EVENTS);
    expect(result.alreadyRegistered).toEqual([]);

    const settings = readSettings();
    expect(Object.keys(settings.hooks)).toEqual(ALL_EVENTS);

    for (const event of ALL_EVENTS) {
      const groups = settings.hooks[event];
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks[0].command).toBe(HOOK_CMD);
      expect(groups[0].hooks[0].timeout).toBe(5);
    }
  });

  test('adds hooks to empty settings object', () => {
    writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet' }));

    const result = ensureHooksRegistered({ settingsPath, hookCommand: HOOK_CMD });

    expect(result.added).toEqual(ALL_EVENTS);
    const settings = readSettings();
    expect(settings.model).toBe('sonnet'); // existing fields preserved
    expect(Object.keys(settings.hooks).length).toBe(5);
  });

  test('preserves existing hooks and only adds pray-bot', () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: '/other/hook.sh', timeout: 10 },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing));

    const result = ensureHooksRegistered({ settingsPath, hookCommand: HOOK_CMD });

    expect(result.added).toEqual(ALL_EVENTS);
    expect(result.alreadyRegistered).toEqual([]);

    const settings = readSettings();
    // Stop should now have 2 groups: existing + pray-bot
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('/other/hook.sh');
    expect(settings.hooks.Stop[1].hooks[0].command).toBe(HOOK_CMD);
  });

  test('does not duplicate when already registered', () => {
    // First call registers
    ensureHooksRegistered({ settingsPath, hookCommand: HOOK_CMD });

    // Second call should be no-op
    const result = ensureHooksRegistered({ settingsPath, hookCommand: HOOK_CMD });

    expect(result.added).toEqual([]);
    expect(result.alreadyRegistered).toEqual(ALL_EVENTS);

    const settings = readSettings();
    for (const event of ALL_EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
  });

  test('detects pray-bot-hook.sh by filename in command path', () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: '/different/path/pray-bot-hook.sh', timeout: 3 },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing));

    const result = ensureHooksRegistered({ settingsPath, hookCommand: HOOK_CMD });

    expect(result.alreadyRegistered).toContain('Stop');
    expect(result.added).not.toContain('Stop');
    // Stop should still have only 1 group
    const settings = readSettings();
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  test('preserves non-hook fields in settings', () => {
    const existing = {
      env: { FOO: 'bar' },
      statusLine: { type: 'command', command: 'test.sh' },
      model: 'opus',
    };
    writeFileSync(settingsPath, JSON.stringify(existing));

    ensureHooksRegistered({ settingsPath, hookCommand: HOOK_CMD });

    const settings = readSettings();
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.statusLine).toEqual({ type: 'command', command: 'test.sh' });
    expect(settings.model).toBe('opus');
  });
});
