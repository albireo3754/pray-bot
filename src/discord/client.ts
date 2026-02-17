/**
 * DiscordClient - discord.js 래퍼 (DISCORD_SPEC.md Phase 0)
 * Generic client pattern: connect(), on('message'), sendMessage(), disconnect()
 */

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Message,
  type TextChannel,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type {
  DiscordClientConfig,
  DiscordMessageData,
  DiscordEventListener,
  DiscordComponentData,
  DiscordComponentListener,
  DiscordQuestionPrompt,
  EmbedData,
  QueueStats,
  SendOptions,
  SendPayload,
} from './types.ts';
import { DiscordThrottleQueue } from './throttle-queue.ts';

const DEFAULT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
];

function toMessageData(msg: Message): DiscordMessageData {
  const isThread = msg.channel.isThread();
  return {
    id: msg.id,
    content: msg.content,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      bot: msg.author.bot,
    },
    channelId: msg.channelId,
    guildId: msg.guildId,
    isThread,
    parentChannelId: isThread ? msg.channel.parentId : null,
    reference: msg.reference ? { messageId: msg.reference.messageId ?? '' } : undefined,
  };
}

function buildEmbed(data: EmbedData): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (data.title) embed.setTitle(data.title);
  if (data.description) embed.setDescription(data.description);
  if (data.url) embed.setURL(data.url);
  if (data.color != null) embed.setColor(data.color);
  if (data.fields?.length) embed.addFields(data.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? false })));
  if (data.footer) embed.setFooter({ text: data.footer.text });
  if (data.timestamp) embed.setTimestamp();
  return embed;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

export class DiscordClient {
  private client: Client;
  private config: DiscordClientConfig;
  private queue: DiscordThrottleQueue;
  private listeners: Set<DiscordEventListener> = new Set();
  private interactionHandler: ((interaction: ChatInputCommandInteraction) => void) | null = null;
  private componentHandler: DiscordComponentListener | null = null;
  private allowedChannelIds = new Set<string>();

  constructor(config: DiscordClientConfig) {
    this.config = config;
    const intents = config.intents ?? DEFAULT_INTENTS;
    this.client = new Client({ intents });
    this.queue = new DiscordThrottleQueue({
      executor: (channelId, payload) => this.executeSend(channelId, payload),
    });

    // Message handling
    this.client.on('messageCreate', (msg: Message) => {
      if (msg.author.bot) return;
      if (this.config.ownerId && msg.author.id !== this.config.ownerId) return;
      // channelId 필터: 메인 채널 + 등록된 채널 + 등록된 채널의 thread 허용
      if (this.config.channelId) {
        const directAllowed = msg.channelId === this.config.channelId
          || this.allowedChannelIds.has(msg.channelId);
        const threadParentId = msg.channel.isThread() ? msg.channel.parentId : null;
        const threadAllowed = !!threadParentId
          && (threadParentId === this.config.channelId || this.allowedChannelIds.has(threadParentId));
        if (!directAllowed && !threadAllowed) return;
      }
      const data = toMessageData(msg);
      for (const fn of this.listeners) fn(data);
    });

    // Interaction handling (slash commands)
    this.client.on('interactionCreate', (interaction: Interaction) => {
      if (this.config.ownerId && interaction.user.id !== this.config.ownerId) return;

      if (interaction.isChatInputCommand()) {
        if (this.interactionHandler) {
          this.interactionHandler(interaction);
        }
        return;
      }

      if ((interaction.isButton() || interaction.isStringSelectMenu()) && this.componentHandler) {
        Promise.resolve(this.componentHandler(this.toComponentData(interaction))).catch((err) =>
          console.error('[Discord] component handler failed:', err),
        );
        return;
      }
    });
  }

  private toComponentData(interaction: ButtonInteraction | StringSelectMenuInteraction): DiscordComponentData {
    return {
      type: interaction.isButton() ? 'button' : 'select',
      customId: interaction.customId,
      values: interaction.isStringSelectMenu() ? interaction.values : [],
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      user: {
        id: interaction.user.id,
        username: interaction.user.username,
      },
      acknowledge: async () => {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferUpdate();
        }
      },
      replyEphemeral: async (content: string) => {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      },
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.once('clientReady', () => {
        console.log('[Discord] Client ready');
        resolve();
      });
      this.client.login(this.config.token).catch(reject);
    });
  }

  disconnect(): void {
    this.queue.destroy();
    this.client.destroy();
    this.listeners.clear();
  }

  on(_event: 'message', listener: DiscordEventListener): void {
    this.listeners.add(listener);
  }

  off(_event: 'message', listener: DiscordEventListener): void {
    this.listeners.delete(listener);
  }

  /** ChannelRegistry에서 발견/동기화된 채널 ID를 메시지 필터에 등록 */
  addAllowedChannel(channelId: string): void {
    this.allowedChannelIds.add(channelId);
  }

  onSlashCommand(handler: (interaction: ChatInputCommandInteraction) => void): void {
    this.interactionHandler = handler;
  }

  onComponentInteraction(handler: DiscordComponentListener): void {
    this.componentHandler = handler;
  }

  private async resolveSendableChannel(channelId: string): Promise<TextChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased() || ch.type === ChannelType.DM) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    return ch as TextChannel;
  }

  async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<void> {
    const chunks = splitMessage(content, 2000);
    for (const chunk of chunks) {
      await this.queue.send(channelId, { type: 'text', content: chunk }, options);
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel && typeof channel.sendTyping === 'function') {
      await channel.sendTyping();
    }
  }

  async sendQuestionPrompt(channelId: string, prompt: DiscordQuestionPrompt, options?: SendOptions): Promise<void> {
    const content = `**${truncate(prompt.header || '질문', 80)}**\n${truncate(prompt.question, 1800)}`;
    let components: unknown[] = [];

    if (prompt.mode === 'buttons') {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const option of prompt.options.slice(0, 5)) {
        if (!option.customId) continue;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(option.customId)
            .setLabel(truncate(option.label, 80))
            .setStyle(ButtonStyle.Primary),
        );
      }
      components = [row];
      await this.queue.send(channelId, { type: 'components', content, components }, options);
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(prompt.customId)
      .setPlaceholder(truncate(prompt.header || '선택하세요', 150))
      .setMinValues(prompt.minValues ?? 1)
      .setMaxValues(prompt.maxValues ?? 1)
      .addOptions(
        prompt.options.slice(0, 25).map((option) => ({
          label: truncate(option.label, 100),
          description: option.description ? truncate(option.description, 100) : undefined,
          value: truncate(option.value, 100),
        })),
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    components = [row];
    await this.queue.send(channelId, { type: 'components', content, components }, options);
  }

  async sendEmbed(channelId: string, embed: EmbedData, options?: SendOptions): Promise<void> {
    // Discord Embed 제한: 최대 25 fields, 256 chars/field name, 1024 chars/field value
    if (embed.fields && embed.fields.length > 25) {
      const overflow = embed.fields.length - 24;
      embed = { ...embed, fields: [
        ...embed.fields.slice(0, 24),
        { name: `... +${overflow}개 더`, value: '(생략됨)' },
      ]};
    }
    await this.queue.send(channelId, { type: 'embed', embed }, options);
  }

  async replyTo(messageId: string, channelId: string, content: string, options?: SendOptions): Promise<void> {
    await this.queue.send(channelId, { type: 'reply', messageId, content }, options);
  }

  async createThread(channelId: string, name: string, content?: string): Promise<string> {
    const ch = await this.resolveSendableChannel(channelId);
    const thread = await ch.threads.create({
      name,
      type: ChannelType.PublicThread,
      reason: 'pray-bot thread',
    });
    if (content) {
      await thread.send({ content });
    }
    return thread.id;
  }

  async sendToThread(threadId: string, content: string, options?: SendOptions): Promise<void> {
    await this.queue.send(threadId, { type: 'text', content }, options);
  }

  getQueueStats(): QueueStats {
    return this.queue.stats();
  }

  flushQueue(channelId: string): void {
    this.queue.flush(channelId);
  }

  /** 기본 응답 채널 ID (config에서) */
  get defaultChannelId(): string | undefined {
    return this.config.channelId;
  }

  /** 봇이 준비되었는지 */
  get isReady(): boolean {
    return this.client.isReady();
  }

  /** Guild ID 반환 */
  getGuildId(): string | undefined {
    return this.config.guildId;
  }

  /** Create or find existing category */
  async createCategory(guildId: string, name: string): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId);

    // Check if category already exists
    const existing = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name === name,
    );
    if (existing) {
      return existing.id;
    }

    // Create new category
    const category = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
    });
    return category.id;
  }

  /** Create text channel under category */
  async createChannelInCategory(guildId: string, categoryId: string, name: string): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    return channel.id;
  }

  /** Find existing channel in category or create new one */
  async findOrCreateChannelInCategory(guildId: string, categoryId: string, name: string): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId);

    // Check if channel already exists under this category
    const existing = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.parentId === categoryId && ch.name === name,
    );
    if (existing) {
      return existing.id;
    }

    // Create new channel
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: categoryId,
    });
    return channel.id;
  }

  /** List all text channels in guild (read-only, no permissions needed) */
  async listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string; parentId: string | null }>> {
    const channels = await this.listGuildChannelsDetailed(guildId);
    return channels
      .filter((ch) => ch.type === ChannelType.GuildText)
      .map((ch) => ({ id: ch.id, name: ch.name, parentId: ch.parentId }));
  }

  /** List all guild channels with type/parent info */
  async listGuildChannelsDetailed(guildId: string): Promise<Array<{ id: string; name: string; type: number; parentId: string | null }>> {
    const guild = await this.client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    return channels
      .filter((ch) => ch !== null)
      .map((ch) => ({ id: ch!.id, name: ch!.name, type: ch!.type, parentId: ch!.parentId }));
  }

  /** Set channel topic */
  async setChannelTopic(channelId: string, topic: string): Promise<void> {
    const ch = await this.client.channels.fetch(channelId);
    if (ch && ch.type === ChannelType.GuildText && 'setTopic' in ch) {
      await (ch as TextChannel).setTopic(topic);
    }
  }

  /** Delete a channel */
  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && 'delete' in channel) {
      await channel.delete();
    }
  }

  private async executeSend(channelId: string, payload: SendPayload): Promise<void> {
    const ch = await this.resolveSendableChannel(channelId);
    switch (payload.type) {
      case 'text':
        await ch.send({ content: payload.content });
        break;
      case 'embed':
        await ch.send({ embeds: [buildEmbed(payload.embed)] });
        break;
      case 'components':
        await ch.send({ content: payload.content, components: payload.components as any[] });
        break;
      case 'reply': {
        const ref = await ch.messages.fetch(payload.messageId).catch(() => null);
        if (ref) {
          await ref.reply({ content: payload.content });
        } else {
          await ch.send({ content: payload.content });
        }
        break;
      }
      default:
        throw new Error('Unsupported send payload type');
    }
  }
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}
