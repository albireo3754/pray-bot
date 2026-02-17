/**
 * Discord Slash Commands (DISCORD_SPEC.md Phase 3)
 * Guild-specific command registration and interaction handling
 */

import {
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord-api-types/v10';
import type { CommandRegistry, ReplyClient } from '../command/registry.ts';

/**
 * Define all slash commands matching CommandRegistry
 */
export function buildSlashCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const commands: Array<{ toJSON: () => RESTPostAPIChatInputApplicationCommandsJSONBody }> = [
    // /help - 명령어 도움말
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('명령어 도움말'),

    // /health - Codex 쓰레드 상태 확인
    new SlashCommandBuilder()
      .setName('health')
      .setDescription('Codex 쓰레드 상태 확인'),

    // /list - 등록된 경로 목록
    new SlashCommandBuilder()
      .setName('list')
      .setDescription('등록된 경로 목록'),

    // /thread <key> - Codex 쓰레드 전환/생성
    new SlashCommandBuilder()
      .setName('thread')
      .setDescription('Codex 쓰레드 전환/생성')
      .addStringOption((option) =>
        option
          .setName('key')
          .setDescription('쓰레드 키 (예: my-project, api)')
          .setRequired(true),
      ),

    // /kill <key> - Codex 쓰레드 종료
    new SlashCommandBuilder()
      .setName('kill')
      .setDescription('Codex 쓰레드 종료')
      .addStringOption((option) =>
        option
          .setName('key')
          .setDescription('쓰레드 키 (예: my-project, api)')
          .setRequired(true),
      ),

    // /workflow <action> [args...] - 배포 워크플로우
    new SlashCommandBuilder()
      .setName('workflow')
      .setDescription('배포 워크플로우')
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription('작업')
          .setRequired(false)
          .addChoices(
            { name: 'switch', value: 'switch' },
            { name: 'test', value: 'test' },
            { name: 'simulate', value: 'simulate' },
            { name: 'status', value: 'status' },
            { name: 'list', value: 'list' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('args')
          .setDescription('추가 인자')
          .setRequired(false),
      ),

    // /codex prompt:<string> - Codex 세션형 쓰레드 진입
    new SlashCommandBuilder()
      .setName('codex')
      .setDescription('Codex 세션 쓰레드 시작')
      .addStringOption((option) =>
        option
          .setName('prompt')
          .setDescription('요청 프롬프트')
          .setRequired(true),
      ),

    // /codex-app-server prompt:<string> - Codex app-server 실험 경로
    new SlashCommandBuilder()
      .setName('codex-app-server')
      .setDescription('Codex app-server 세션 쓰레드 시작')
      .addStringOption((option) =>
        option
          .setName('prompt')
          .setDescription('요청 프롬프트')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('session')
          .setDescription('재사용할 session_id (선택)')
          .setRequired(false),
      ),

    // /claude prompt:<string> - Claude 세션형 쓰레드 진입
    new SlashCommandBuilder()
      .setName('claude')
      .setDescription('Claude 세션 쓰레드 시작')
      .addStringOption((option) =>
        option
          .setName('prompt')
          .setDescription('요청 프롬프트')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('session')
          .setDescription('재사용할 Claude session_id (선택)')
          .setRequired(false),
      ),

    // /deploy <env> <app> - 배포 요청 (별도 명령어, !deploy 별칭)
    new SlashCommandBuilder()
      .setName('deploy')
      .setDescription('배포 요청')
      .addStringOption((option) =>
        option
          .setName('env')
          .setDescription('환경')
          .setRequired(true)
          .addChoices(
            { name: 'sandbox', value: 'sandbox' },
            { name: 'stage', value: 'stage' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('app')
          .setDescription('앱 이름')
          .setRequired(true),
      ),

    // /restart - pray-bot 프로세스 재시작
    new SlashCommandBuilder()
      .setName('restart')
      .setDescription('pray-bot 프로세스 재시작'),

    // /worktree-channel <thread-name> - 워크트리 채널 생성 (Phase 4)
    new SlashCommandBuilder()
      .setName('worktree-channel')
      .setDescription('워크트리 프로젝트에 대한 Discord 채널 생성')
      .addStringOption((option) =>
        option
          .setName('thread-name')
          .setDescription('워크트리 이름 (예: my-feature)')
          .setRequired(true),
      ),

    // /worktree-cleanup <thread-name> - 워크트리 채널 정리 (Phase 4)
    new SlashCommandBuilder()
      .setName('worktree-cleanup')
      .setDescription('워크트리 채널 정리 (삭제)')
      .addStringOption((option) =>
        option
          .setName('thread-name')
          .setDescription('워크트리 이름 (예: my-feature)')
          .setRequired(true),
      ),

    // /channel-sync - 채널-폴더 동기화
    new SlashCommandBuilder()
      .setName('channel-sync')
      .setDescription('channels.yaml ↔ Discord 채널 동기화'),

    // /channel-list - 채널-폴더 매핑 목록
    new SlashCommandBuilder()
      .setName('channel-list')
      .setDescription('채널-폴더 매핑 목록'),

    // /channel-add <key> <path> [category] - 매핑 추가
    new SlashCommandBuilder()
      .setName('channel-add')
      .setDescription('채널-폴더 매핑 추가')
      .addStringOption((option) =>
        option
          .setName('key')
          .setDescription('채널명 (소문자, 하이픈)')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('path')
          .setDescription('로컬 폴더 경로')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('category')
          .setDescription('카테고리 (기본: Uncategorized)')
          .setRequired(false),
      ),

    // /channel-remove <key> - 매핑 제거
    new SlashCommandBuilder()
      .setName('channel-remove')
      .setDescription('채널-폴더 매핑 제거')
      .addStringOption((option) =>
        option
          .setName('key')
          .setDescription('제거할 채널명')
          .setRequired(true),
      ),

    // /channel-init [worktree-name] - 워크트리 스캔으로 채널 매핑 가이드
    new SlashCommandBuilder()
      .setName('channel-init')
      .setDescription('워크트리 스캔으로 채널 매핑 가이드')
      .addStringOption((option) =>
        option
          .setName('worktree')
          .setDescription('워크트리 이름 (미지정 시 목록 표시)')
          .setRequired(false),
      ),

    // /channel-cleanup-duplicates [category] [apply]
    new SlashCommandBuilder()
      .setName('channel-cleanup-duplicates')
      .setDescription('카테고리 내 중복 Discord 채널 정리')
      .addStringOption((option) =>
        option
          .setName('category')
          .setDescription('카테고리 이름 (기본: Worktrees)')
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('apply')
          .setDescription('true면 실제 삭제, false면 미리보기')
          .setRequired(false),
      ),
  ];
  return commands.map((cmd) => cmd.toJSON());
}

/**
 * Register slash commands with Discord Guild
 * @param token Bot token
 * @param clientId Bot client ID (extracted from token)
 * @param guildId Guild ID for guild-specific commands
 */
export async function registerSlashCommands(
  token: string,
  clientId: string,
  guildId: string,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = buildSlashCommands();

  try {
    console.log('[Discord] Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log(`[Discord] Registered ${commands.length} slash commands in guild ${guildId}`);
  } catch (error) {
    console.error('[Discord] Failed to register slash commands:', error);
    throw error;
  }
}

/**
 * Extract bot client ID from token
 * Token format: base64(clientId).signature.timestamp
 */
export function extractClientId(token: string): string {
  const parts = token.split('.');
  if (parts.length < 3) {
    throw new Error('Invalid Discord bot token format');
  }
  const part0 = parts[0];
  if (!part0) {
    throw new Error('Invalid Discord bot token format');
  }
  const decoded = Buffer.from(part0, 'base64').toString('utf-8');
  return decoded;
}

/**
 * Create a ReplyClient that wraps interaction responses
 */
function createInteractionReplyClient(interaction: ChatInputCommandInteraction): ReplyClient {
  let replied = false;
  let deferred = false;
  let heartbeatTimer: Timer | null = null;

  function followUp(content: string) {
    interaction.followUp({ content }).catch((err) =>
      console.error('[Discord] interaction.followUp failed:', err),
    );
  }

  return {
    sendMessage(message: string, _throttle?: boolean) {
      if (!replied && !deferred) {
        interaction.reply({ content: message }).catch((err) =>
          console.error('[Discord] interaction.reply failed:', err),
        );
        replied = true;
      } else if (deferred && !replied) {
        // deferred 상태에서 첫 응답 → editReply로 "thinking..." 대체
        interaction.editReply({ content: message }).catch((err) =>
          console.error('[Discord] interaction.editReply failed:', err),
        );
        replied = true;
      } else {
        followUp(message);
      }
    },
    sendBlockMessage(message: string) {
      this.sendMessage(message);
    },
    sendEmbed(embed: { title?: string; description?: string; url?: string; color?: number; fields?: Array<{ name: string; value: string; inline?: boolean }>; footer?: { text: string }; timestamp?: boolean }) {
      const fields = embed.fields?.map((f) => ({
        name: f.name,
        value: f.value,
        inline: f.inline ?? false,
      }));

      const discordEmbed: {
        title?: string;
        description?: string;
        url?: string;
        color?: number;
        fields?: Array<{ name: string; value: string; inline: boolean }>;
        footer?: { text: string };
        timestamp?: string;
      } = {
        title: embed.title,
        description: embed.description,
        url: embed.url,
        color: embed.color,
        fields,
        footer: embed.footer ? { text: embed.footer.text } : undefined,
        timestamp: embed.timestamp ? new Date().toISOString() : undefined,
      };

      if (!replied && !deferred) {
        interaction.reply({ embeds: [discordEmbed] }).catch((err) =>
          console.error('[Discord] interaction.reply (embed) failed:', err),
        );
        replied = true;
      } else if (deferred && !replied) {
        interaction.editReply({ embeds: [discordEmbed] }).catch((err) =>
          console.error('[Discord] interaction.editReply (embed) failed:', err),
        );
        replied = true;
      } else {
        interaction.followUp({ embeds: [discordEmbed] }).catch((err) =>
          console.error('[Discord] interaction.followUp (embed) failed:', err),
        );
      }
    },
    deferReply() {
      if (!replied && !deferred) {
        interaction.deferReply().catch((err) =>
          console.error('[Discord] interaction.deferReply failed:', err),
        );
        deferred = true;
      }
    },
    startHeartbeat(statusFn: () => string, intervalMs = 60_000) {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        followUp(statusFn());
      }, intervalMs);
    },
    stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  };
}

/**
 * Convert ChatInputCommandInteraction to fake MessageDataPayload for CommandRegistry
 */
function interactionToMessagePayload(interaction: ChatInputCommandInteraction): Record<string, unknown> & { text: string } {
  return {
    id: interaction.id,
    user: {
      id: Number(interaction.user.id) || 0,
      name: interaction.user.username,
    },
    text: '', // Will be reconstructed from command + options
    source_message_id: '',
    sent_time: Math.floor(interaction.createdTimestamp / 1000),
    extensions: {},
  };
}

/**
 * Slash command handler factory
 * Dispatches interactions to CommandRegistry
 */
export type SlashCommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

/** 3초 이상 걸릴 수 있는 명령어 → auto defer + heartbeat */
const SLOW_COMMANDS = new Set([
  'deploy',
  'workflow',
  'worktree-channel',
  'review',
  'channel-sync',
  'channel-cleanup-duplicates',
]);

export function createSlashCommandHandler(registry: CommandRegistry): SlashCommandHandler {
  return async (interaction: ChatInputCommandInteraction) => {
    let replyClient: ReturnType<typeof createInteractionReplyClient> | null = null;
    try {
      const commandName = interaction.commandName;
      replyClient = createInteractionReplyClient(interaction);

      // 느린 명령어: defer → heartbeat 자동 시작
      if (SLOW_COMMANDS.has(commandName)) {
        replyClient.deferReply?.();
        const startTime = Date.now();
        replyClient.startHeartbeat?.(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 60_000);
          return `⏳ /${commandName} 처리 중... (${elapsed + 1}분 경과)`;
        });
      }

      // Build text representation of command + options
      let text = `/${commandName}`;
      const args: string[] = [];

      // Handle /deploy specially (env + app)
      if (commandName === 'deploy') {
        const env = interaction.options.getString('env', true);
        const app = interaction.options.getString('app', true);
        args.push(env, app);
        text = `!deploy ${env} ${app}`;
      }
      // Handle /worktree-channel (thread-name)
      else if (commandName === 'worktree-channel') {
        const threadName = interaction.options.getString('thread-name', true);
        args.push(threadName);
        text = `/worktree-channel ${threadName}`;
      }
      // Handle /worktree-cleanup (thread-name)
      else if (commandName === 'worktree-cleanup') {
        const threadName = interaction.options.getString('thread-name', true);
        args.push(threadName);
        text = `/worktree-cleanup ${threadName}`;
      }
      // Handle /channel-init [worktree]
      else if (commandName === 'channel-init') {
        const worktree = interaction.options.getString('worktree') ?? '';
        if (worktree) args.push(worktree);
        text = worktree ? `/channel-init ${worktree}` : '/channel-init';
      }
      // Handle /channel-add (key, path, category)
      else if (commandName === 'channel-add') {
        const key = interaction.options.getString('key', true);
        const channelPath = interaction.options.getString('path', true);
        const category = interaction.options.getString('category') ?? 'Uncategorized';
        args.push(key, channelPath, category);
        text = `/channel-add ${key} ${channelPath} ${category}`;
      }
      // Handle /channel-remove (key)
      else if (commandName === 'channel-remove') {
        const key = interaction.options.getString('key', true);
        args.push(key);
        text = `/channel-remove ${key}`;
      }
      else {
        // Generic option extraction
        for (const option of interaction.options.data) {
          if (option.value !== null && option.value !== undefined) {
            const val = String(option.value);
            args.push(val);
            text += ` ${val}`;
          }
        }
      }

      // Resolve command (use !deploy for /deploy, /worktree-* for worktree commands, otherwise use /commandName)
      let trigger: string;
      if (commandName === 'deploy') {
        trigger = '!deploy';
      } else if (commandName === 'worktree-channel' || commandName === 'worktree-cleanup') {
        trigger = `/${commandName}`;
      } else {
        trigger = `/${commandName}`;
      }
      const cmd = registry.resolve(trigger);

      if (!cmd) {
        replyClient.sendMessage(`알 수 없는 명령어: ${trigger}`);
        return;
      }

      // Execute command
      const data = interactionToMessagePayload(interaction);
      data.text = text; // Store reconstructed text
      try {
        await cmd.execute({ client: replyClient, args, raw: text, data });
      } finally {
        replyClient.stopHeartbeat?.();
      }
    } catch (error) {
      replyClient?.stopHeartbeat?.();
      console.error('[Discord] Slash command error:', error);
      const errorMsg = `오류: ${error instanceof Error ? error.message : String(error)}`;
      if (interaction.replied || interaction.deferred) {
        interaction.followUp({ content: errorMsg, ephemeral: true }).catch(console.error);
      } else {
        interaction.reply({ content: errorMsg, ephemeral: true }).catch(console.error);
      }
    }
  };
}

/**
 * Check if interaction is a chat input command
 */
export function isChatInputCommand(interaction: Interaction): interaction is ChatInputCommandInteraction {
  return interaction.isChatInputCommand();
}
