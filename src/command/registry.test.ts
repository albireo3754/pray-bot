import { test, expect, describe } from 'bun:test';
import { CommandRegistry, type CommandDefinition } from './registry.ts';

function mockCmd(name: string, aliases?: string[]): CommandDefinition {
  return {
    name,
    aliases,
    description: `${name} description`,
    async execute() {},
  };
}

describe('CommandRegistry', () => {
  test('register and resolve by name', () => {
    const reg = new CommandRegistry();
    reg.register(mockCmd('/help'));
    expect(reg.resolve('/help')).toBeTruthy();
    expect(reg.resolve('/help')!.name).toBe('/help');
  });

  test('resolve by alias', () => {
    const reg = new CommandRegistry();
    reg.register(mockCmd('/example', ['example']));
    expect(reg.resolve('example')).toBeTruthy();
    expect(reg.resolve('example')!.name).toBe('/example');
  });

  test('resolve returns null for unknown', () => {
    const reg = new CommandRegistry();
    reg.register(mockCmd('/help'));
    expect(reg.resolve('/unknown')).toBeNull();
  });

  test('listAll returns all registered commands', () => {
    const reg = new CommandRegistry();
    reg.register(mockCmd('/help'));
    reg.register(mockCmd('/list'));
    reg.register(mockCmd('/thread'));
    expect(reg.listAll()).toHaveLength(3);
  });

  test('formatHelp includes all commands', () => {
    const reg = new CommandRegistry();
    reg.register(mockCmd('/help'));
    reg.register(mockCmd('/example', ['example']));
    const help = reg.formatHelp();
    expect(help).toContain('/help');
    expect(help).toContain('/example');
    expect(help).toContain('(example)');
  });
});
