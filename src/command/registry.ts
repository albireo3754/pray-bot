import type { PresenceGateway } from '../presence/types.ts';

/** 명령 실행 시 응답 전송용 (플랫폼 무관 추상 인터페이스) */
export type ReplyClient = {
  sendMessage(message: string, throttle?: boolean): void;
  sendBlockMessage(message: string): void;
  /** Embed 전송 (Discord 등에서만 구현) */
  sendEmbed?(embed: Record<string, unknown>): void;
  /** Interaction defer (3초 타임아웃 방지) */
  deferReply?(): void;
  /** 하트비트 시작 - 주기적으로 상태 메시지를 follow-up으로 전송 */
  startHeartbeat?(statusFn: () => string, intervalMs?: number): void;
  /** 하트비트 중지 */
  stopHeartbeat?(): void;
};

export type CommandContext = {
  client: ReplyClient;
  args: string[];
  raw: string;
  data: Record<string, unknown>;
};

export type ReplyContext = {
  reply: ReplyClient;
  presence: PresenceGateway;
};

export type CommandDefinition = {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute: (ctx: CommandContext) => Promise<boolean | void>;
};

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private triggerMap = new Map<string, string>(); // trigger -> command name

  register(cmd: CommandDefinition): void {
    this.commands.set(cmd.name, cmd);
    this.triggerMap.set(cmd.name, cmd.name);
    for (const alias of cmd.aliases ?? []) {
      this.triggerMap.set(alias, cmd.name);
    }
  }

  resolve(trigger: string): CommandDefinition | null {
    const name = this.triggerMap.get(trigger);
    if (!name) return null;
    return this.commands.get(name) ?? null;
  }

  listAll(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  formatHelp(): string {
    const lines = this.listAll().map((cmd) => {
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : '';
      const usage = cmd.usage ? `  ${cmd.usage}` : '';
      return `${cmd.name}${aliases} - ${cmd.description}${usage}`;
    });
    return lines.join('\n');
  }
}
