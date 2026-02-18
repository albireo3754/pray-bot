import type { SessionSnapshot, MonitorStatus, EmbedData } from './types.ts';

import type { ActivityPhase } from './types.ts';

const STATE_ICONS: Record<SessionSnapshot['state'], string> = {
  active: '🟢',
  idle: '🟡',
  completed: '⚪',
  stale: '⚫',
};

const PHASE_LABELS: Record<ActivityPhase, string> = {
  busy: '🔄 작업 중',
  interactable: '💬 입력 대기',
  waiting_permission: '⏳ 승인 대기',
  waiting_question: '❓ 질문 대기',
};

function formatWaitReason(s: SessionSnapshot): string | null {
  if (!s.waitReason) return null;
  if (s.waitReason === 'user_question') return '❓ 사용자 응답 대기';
  // permission: show pending tool names
  const tools = s.waitToolNames.length > 0 ? s.waitToolNames.join(', ') : 'tool';
  return `⏳ 승인 대기 (${tools})`;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin > 0 ? `${hours}h${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

function formatTools(tools: string[]): string {
  if (tools.length === 0) return '';
  // Deduplicate and show unique tool names
  const unique = [...new Set(tools)];
  return unique.join(', ');
}

function shortenPath(path: string): string {
  const home = process.env.HOME ?? '';
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

/**
 * Format session list as plain text (for messaging clients).
 */
export function formatSessionsText(status: MonitorStatus): string {
  const { sessions, activeCount } = status;
  const idleCount = sessions.filter((s) => s.state === 'idle').length;

  if (sessions.length === 0) {
    return '활성 Claude 세션이 없습니다. ✨';
  }

  const header = `📋 Claude Sessions (${activeCount} active${idleCount ? `, ${idleCount} idle` : ''})`;
  const lines = [header, ''];

  for (const s of sessions) {
    const icon = STATE_ICONS[s.state];
    const elapsed = formatDuration(Date.now() - s.startedAt!?.getTime?.() || 0);
    const tools = formatTools(s.currentTools);
    const branch = s.gitBranch || 'HEAD';
    const model = s.model?.replace('claude-', '')?.replace(/-\d{8}$/, '') || '?';
    const wait = formatWaitReason(s);

    const phaseLabel = s.activityPhase ? PHASE_LABELS[s.activityPhase] : null;
    lines.push(`${icon} ${s.projectName} [${s.slug}]`);

    if (wait) {
      lines.push(`   └ ${wait} (${s.turnCount} turns, ${elapsed})`);
    } else if (phaseLabel && s.state === 'active') {
      lines.push(`   └ ${phaseLabel} (${s.turnCount} turns, ${elapsed})`);
    } else if (s.state === 'idle') {
      lines.push(`   └ 입력 대기 (${s.turnCount} turns, ${elapsed})`);
    } else if (tools) {
      lines.push(`   └ ${tools} (${s.turnCount} turns, ${elapsed})`);
    } else {
      lines.push(`   └ ${s.turnCount} turns, ${elapsed}`);
    }

    lines.push(`   └ ${model} | ${branch}${s.pid ? ` | PID ${s.pid}` : ''}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format a single session's detail as plain text.
 */
export function formatSessionDetailText(s: SessionSnapshot): string {
  const icon = STATE_ICONS[s.state];
  const elapsed = formatDuration(Date.now() - (s.startedAt?.getTime() || Date.now()));
  const tools = formatTools(s.currentTools);
  const branch = s.gitBranch || 'HEAD';
  const model = s.model?.replace('claude-', '')?.replace(/-\d{8}$/, '') || '?';
  const { input, output, cached } = s.tokens;

  const phaseInfo = s.activityPhase ? ` (${PHASE_LABELS[s.activityPhase]})` : '';
  const lines = [
    `${icon} ${s.projectName} [${s.slug}]`,
    '',
    `상태: ${s.state}${phaseInfo}`,
    `경로: ${shortenPath(s.projectPath)}`,
    `모델: ${model}`,
    `브랜치: ${branch}`,
    `버전: ${s.version || '?'}`,
    `PID: ${s.pid || '-'}`,
    `CPU: ${s.cpuPercent?.toFixed(1) || '-'}%`,
    `메모리: ${s.memMb || '-'} MB`,
    '',
    `턴: ${s.turnCount}`,
    `경과: ${elapsed}`,
    `토큰: ${input.toLocaleString()} in / ${output.toLocaleString()} out / ${cached.toLocaleString()} cached`,
  ];

  if (tools) lines.push(`도구: ${tools}`);
  const wait = formatWaitReason(s);
  if (wait) lines.push(`대기: ${wait}`);
  if (s.lastUserMessage) lines.push(`\n마지막 입력: ${s.lastUserMessage}`);

  return lines.join('\n');
}

/**
 * Format session list as Discord Embed fields.
 */
export function formatSessionsEmbed(status: MonitorStatus): EmbedData {
  const { sessions, activeCount } = status;
  const idleCount = sessions.filter((s) => s.state === 'idle').length;

  if (sessions.length === 0) {
    return {
      title: '📋 Claude Sessions',
      description: '활성 세션 없음 ✨',
      color: 0x6b7280,
    };
  }

  const fields = sessions.slice(0, 10).map((s) => {
    const icon = STATE_ICONS[s.state];
    const elapsed = formatDuration(Date.now() - (s.startedAt?.getTime() || Date.now()));
    const tools = formatTools(s.currentTools);
    const branch = s.gitBranch || 'HEAD';
    const model = s.model?.replace('claude-', '')?.replace(/-\d{8}$/, '') || '?';
    const wait = formatWaitReason(s);

    const embedPhaseLabel = s.activityPhase ? PHASE_LABELS[s.activityPhase] : null;
    let value: string;
    if (wait) {
      value = `${wait} (${s.turnCount} turns, ${elapsed})`;
    } else if (embedPhaseLabel && s.state === 'active') {
      value = `${embedPhaseLabel} (${s.turnCount} turns, ${elapsed})`;
    } else if (s.state === 'idle') {
      value = `입력 대기 (${s.turnCount} turns, ${elapsed})`;
    } else if (tools) {
      value = `${tools} (${s.turnCount} turns, ${elapsed})`;
    } else {
      value = `${s.turnCount} turns, ${elapsed}`;
    }
    value += `\n${model} | ${branch}${s.pid ? ` | PID ${s.pid}` : ''}`;

    return {
      name: `${icon} ${s.projectName} [${s.slug}]`,
      value,
    };
  });

  return {
    title: `📋 Claude Sessions (${activeCount} active${idleCount ? `, ${idleCount} idle` : ''})`,
    color: activeCount > 0 ? 0x22c55e : 0xf59e0b,
    fields,
  };
}

/**
 * Format a single session's detail as Discord Embed.
 */
export function formatSessionDetailEmbed(s: SessionSnapshot): EmbedData {
  const icon = STATE_ICONS[s.state];
  const elapsed = formatDuration(Date.now() - (s.startedAt?.getTime() || Date.now()));
  const tools = formatTools(s.currentTools);
  const model = s.model?.replace('claude-', '')?.replace(/-\d{8}$/, '') || '?';
  const { input, output, cached } = s.tokens;

  const detailPhaseInfo = s.activityPhase ? PHASE_LABELS[s.activityPhase] : null;
  const fields = [
    { name: '상태', value: detailPhaseInfo ? `${s.state} (${detailPhaseInfo})` : s.state, inline: true },
    { name: '모델', value: model, inline: true },
    { name: '브랜치', value: s.gitBranch || 'HEAD', inline: true },
    { name: '턴', value: `${s.turnCount}`, inline: true },
    { name: '경과', value: elapsed, inline: true },
    { name: 'PID', value: `${s.pid || '-'}`, inline: true },
    { name: '토큰', value: `${input.toLocaleString()} in / ${output.toLocaleString()} out` },
    { name: '경로', value: `\`${shortenPath(s.projectPath)}\`` },
  ];

  if (tools) fields.push({ name: '도구', value: tools });
  const detailWait = formatWaitReason(s);
  if (detailWait) fields.push({ name: '대기', value: detailWait });
  if (s.lastUserMessage) fields.push({ name: '마지막 입력', value: s.lastUserMessage });

  return {
    title: `${icon} ${s.projectName} [${s.slug}]`,
    color: s.state === 'active' ? 0x22c55e : s.state === 'idle' ? 0xf59e0b : 0x6b7280,
    fields,
  };
}
