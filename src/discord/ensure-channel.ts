import type { DiscordClient } from './client.ts';

export interface EnsureChannelOptions {
  guildId: string;
  categoryName: string;
  channelName: string;
  topic?: string;
  seedMessage?: string;
}

export interface EnsureChannelResult {
  categoryId: string;
  channelId: string;
  categoryCreated: boolean;
  channelCreated: boolean;
}

/**
 * Ensure a Discord category/channel pair exists.
 * Reuses existing category/channel if already present.
 */
export async function ensureDiscordChannel(
  discordClient: DiscordClient,
  options: EnsureChannelOptions,
): Promise<EnsureChannelResult> {
  const { guildId, categoryName, channelName, topic, seedMessage } = options;

  const before = await discordClient.listGuildChannels(guildId);
  const existingCategory = before.find(
    (ch) => ch.parentId === null && ch.name === categoryName,
  );

  const categoryId = await discordClient.createCategory(guildId, categoryName);
  const categoryCreated = !existingCategory;

  const existingChannel = before.find(
    (ch) => ch.parentId === categoryId && ch.name === channelName,
  );
  const channelId = await discordClient.findOrCreateChannelInCategory(
    guildId,
    categoryId,
    channelName,
  );
  const channelCreated = !existingChannel;

  if (topic) {
    await discordClient.setChannelTopic(channelId, topic);
  }

  if (seedMessage) {
    await discordClient.sendMessage(channelId, seedMessage);
  }

  return { categoryId, channelId, categoryCreated, channelCreated };
}
