/**
 * Discord 연동 타입 (DISCORD_SPEC.md)
 * discord.js를 직접 노출하지 않고 내부 모듈에서 사용하는 타입만 정의.
 */

export type DiscordMessageData = {
  id: string;
  content: string;
  author: {
    id: string;
    username: string;
    bot: boolean;
  };
  channelId: string;
  guildId: string | null;
  isThread: boolean;
  parentChannelId?: string | null;
  reference?: {
    messageId: string;
  };
};

export type DiscordEventListener = (data: DiscordMessageData) => void;

export type DiscordComponentData = {
  type: 'button' | 'select';
  customId: string;
  values: string[];
  channelId: string;
  guildId: string | null;
  user: {
    id: string;
    username: string;
  };
  acknowledge: () => Promise<void>;
  replyEphemeral: (content: string) => Promise<void>;
};

export type DiscordComponentListener = (data: DiscordComponentData) => void | Promise<void>;

export interface DiscordClientConfig {
  token: string;
  channelId?: string;
  guildId?: string;
  ownerId?: string;
  intents?: number[];
}

/** Embed 필드 (discord.js EmbedBuilder 대신 공통 구조) */
export type EmbedData = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: boolean;
};

export type DiscordQuestionPrompt = {
  header: string;
  question: string;
  mode: 'buttons' | 'select';
  customId: string;
  options: Array<{
    label: string;
    description?: string;
    value: string;
    customId?: string;
  }>;
  minValues?: number;
  maxValues?: number;
};

export type SendPayload =
  | { type: 'text'; content: string }
  | { type: 'embed'; embed: EmbedData }
  | { type: 'components'; content: string; components: unknown[] }
  | { type: 'reply'; messageId: string; content: string };

export type SendPriority = 'normal' | 'high';

export type SendOptions = {
  mergeKey?: string;
  priority?: SendPriority;
};

export type QueueStats = {
  totalQueued: number;
  channelQueues: Map<string, number>;
  globalRequestsInLastSecond: number;
  channelCooldowns: Record<string, number>;
};

/** Channel-Folder 매핑 항목 */
export type ChannelMapping = {
  key: string;           // 채널명 (e.g. "mg")
  path: string;          // 파일시스템 경로
  category: string;      // Discord 카테고리 (e.g. "Kotlin")
  channelId?: string;    // Discord 채널 ID (생성 후)
};

/** channels.yaml 파싱 결과 */
export type ChannelsConfig = {
  categories?: Record<string, Record<string, string>>;
  worktree?: string;  // worktree name → auto-scan ~/work/worktrees/{name}/
};

/** /channel-sync 결과 */
export type SyncResult = {
  created: string[];     // 생성된 채널 key
  existing: string[];    // 이미 존재하던 채널 key
  errors: string[];      // 에러 발생 key
};
