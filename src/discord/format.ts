/**
 * Discord 메시지 포맷 유틸 (DISCORD_SPEC.md Phase 0)
 * Embed 빌더, 텍스트 → Discord 마크다운 변환 등.
 */

import type { EmbedData } from './types.ts';

const COLORS = {
  success: 0x22c55e,
  error: 0xef4444,
  info: 0x3b82f6,
  warning: 0xf59e0b,
} as const;

/** 배포 알림용 Embed (Phase 5) */
export function deployNotificationEmbed(params: {
  title: string;
  service: string;
  imageTag: string;
  env: string;
  prUrl?: string;
  argocdUrl?: string;
  phase?: number;
  targetSlot?: string;
}): EmbedData {
  const fields = [
    { name: '서비스', value: params.service, inline: true },
    { name: '이미지', value: params.imageTag, inline: true },
    { name: '환경', value: params.env, inline: true },
  ];

  if (params.targetSlot) {
    fields.push({ name: '타겟 슬롯', value: params.targetSlot, inline: true });
  }

  if (params.prUrl) {
    fields.push({ name: 'PR', value: `[PR 보기](${params.prUrl})`, inline: false });
  }

  let description = '';
  if (params.argocdUrl) {
    description = `[🔄 ArgoCD Sync](${params.argocdUrl})`;
  }

  return {
    title: params.title,
    description: description || undefined,
    color: COLORS.success,
    fields,
    timestamp: true,
  };
}

/** 빌드 감지 알림 Embed */
export function buildDetectedEmbed(
  service: string,
  branch: string,
  imageTag: string,
  actor: string,
  queueSize: number
): EmbedData {
  return {
    title: '🔍 빌드 감지',
    description: `**${service}** 빌드가 완료되었습니다.`,
    color: COLORS.info,
    fields: [
      { name: '서비스', value: service, inline: true },
      { name: '브랜치', value: branch, inline: true },
      { name: '이미지', value: imageTag, inline: false },
      { name: 'Actor', value: actor, inline: true },
      { name: '대기 중', value: `${queueSize - 1}개`, inline: true },
    ],
    timestamp: true,
  };
}

/** 배포 에러 알림 Embed */
export function deployErrorEmbed(service: string, imageTag: string, error: string): EmbedData {
  return {
    title: '❌ 배포 실패',
    description: `**${service}** 배포 중 오류가 발생했습니다.`,
    color: COLORS.error,
    fields: [
      { name: '서비스', value: service, inline: true },
      { name: '이미지', value: imageTag, inline: true },
      { name: 'Error', value: error.substring(0, 1024), inline: false }, // Discord 1024 char limit
    ],
    timestamp: true,
  };
}

/** 트래픽 전환 알림 Embed */
export function trafficSwitchEmbed(
  service: string,
  targetSlot: string,
  prUrl?: string,
  argocdUrl?: string
): EmbedData {
  const fields = [
    { name: '서비스', value: service, inline: true },
    { name: '활성 슬롯', value: `**${targetSlot}**`, inline: true },
  ];

  if (prUrl) {
    fields.push({ name: 'PR', value: `[PR 보기](${prUrl})`, inline: false });
  }

  let description = '';
  if (argocdUrl) {
    description = `[🔄 ArgoCD Sync](${argocdUrl})`;
  }

  return {
    title: '✅ Phase 2 트래픽 전환 완료',
    description: description || undefined,
    color: COLORS.success,
    fields,
    timestamp: true,
  };
}

/** 일반 정보 Embed */
export function infoEmbed(title: string, description: string, fields?: { name: string; value: string }[]): EmbedData {
  return {
    title,
    description,
    color: COLORS.info,
    fields: fields ?? [],
    timestamp: true,
  };
}

/** 에러 Embed */
export function errorEmbed(title: string, message: string): EmbedData {
  return {
    title,
    description: message,
    color: COLORS.error,
    timestamp: true,
  };
}

/** Generic @mention(USER_ID:xxx) → Discord text (no mention conversion) */
export function kwTextToDiscord(text: string): string {
  return text.replace(/@([^\s(]+)\(USER_ID:(\d+)\)/g, (_, name) => `@${name}`).trim();
}
