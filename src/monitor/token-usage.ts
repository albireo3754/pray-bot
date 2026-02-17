import type { ClaudeSessionMonitor } from './index.ts';
import type { SessionSnapshot, EmbedData } from './types.ts';

export interface TokenUsageSession {
  sessionId: string;
  projectName: string;
  slug: string;
  state: SessionSnapshot['state'];
  model: string | null;
  tokens: { input: number; output: number; cached: number };
  /** Estimated cost in USD (rough approximation) */
  estimatedCostUsd: number;
  lastActivity: Date;
  lastUserMessage: string | null;
  currentTools: string[];
}

export interface TokenUsageReport {
  timestamp: Date;
  sessions: TokenUsageSession[];
  totals: {
    input: number;
    output: number;
    cached: number;
    estimatedCostUsd: number;
  };
  activeCount: number;
  totalCount: number;
}

// Rough per-token pricing (Claude Opus 4.6 as reference)
const COST_PER_INPUT_TOKEN = 15 / 1_000_000;   // $15/MTok
const COST_PER_OUTPUT_TOKEN = 75 / 1_000_000;   // $75/MTok
const COST_PER_CACHED_TOKEN = 1.5 / 1_000_000;  // $1.5/MTok (cache read)

function estimateCost(tokens: { input: number; output: number; cached: number }): number {
  return (
    (tokens.input - tokens.cached) * COST_PER_INPUT_TOKEN +
    tokens.output * COST_PER_OUTPUT_TOKEN +
    tokens.cached * COST_PER_CACHED_TOKEN
  );
}

/**
 * Measure token usage across all Claude Code sessions.
 * Returns a structured report with per-session breakdown and totals.
 */
export function measureTokenUsage(monitor: ClaudeSessionMonitor): TokenUsageReport {
  const allSessions = monitor.getActive();

  const sessions: TokenUsageSession[] = allSessions.map((s) => ({
    sessionId: s.sessionId,
    projectName: s.projectName,
    slug: s.slug,
    state: s.state,
    model: s.model,
    tokens: { ...s.tokens },
    estimatedCostUsd: estimateCost(s.tokens),
    lastActivity: s.lastActivity,
    lastUserMessage: s.lastUserMessage,
    currentTools: s.currentTools,
  }));

  const totals = {
    input: 0,
    output: 0,
    cached: 0,
    estimatedCostUsd: 0,
  };

  for (const s of sessions) {
    totals.input += s.tokens.input;
    totals.output += s.tokens.output;
    totals.cached += s.tokens.cached;
    totals.estimatedCostUsd += s.estimatedCostUsd;
  }

  return {
    timestamp: new Date(),
    sessions,
    totals,
    activeCount: allSessions.filter((s) => s.state === 'active').length,
    totalCount: allSessions.length,
  };
}

const STATE_ORDER: Record<SessionSnapshot['state'], number> = {
  active: 0,
  idle: 1,
  completed: 2,
  stale: 3,
};

/** Sort by state priority first, then by most recent activity within the same state. */
function sortByStateAndActivity(a: TokenUsageSession, b: TokenUsageSession): number {
  const stateD = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (stateD !== 0) return stateD;
  return b.lastActivity.getTime() - a.lastActivity.getTime();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function sessionSummary(s: TokenUsageSession): string {
  if (s.lastUserMessage) {
    const clean = s.lastUserMessage
      .replace(/<[^>]+>/g, '')  // strip XML/HTML tags
      .replace(/\n/g, ' ')
      .trim();
    if (clean) return truncate(clean, 60);
  }
  if (s.currentTools.length > 0) return s.currentTools.join(', ');
  return '';
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Format token usage report as plain text.
 */
export function formatTokenUsageText(report: TokenUsageReport): string {
  const { totals, sessions, activeCount, totalCount } = report;

  if (sessions.length === 0) {
    return '활성 Claude 세션이 없습니다. 토큰 사용량: 0';
  }

  const lines = [
    `📊 Claude Token Usage (${activeCount} active, ${totalCount} total)`,
    `   총 토큰: ${formatNumber(totals.input)} in / ${formatNumber(totals.output)} out / ${formatNumber(totals.cached)} cached`,
    `   예상 비용: $${totals.estimatedCostUsd.toFixed(2)}`,
    '',
  ];

  // Sort by state priority (active > idle > completed), then by total tokens
  const sorted = [...sessions].sort(sortByStateAndActivity);

  for (const s of sorted.slice(0, 5)) {
    const stateIcon = s.state === 'active' ? '🟢' : s.state === 'idle' ? '🟡' : '⚪';
    const summary = sessionSummary(s);
    lines.push(`${stateIcon} ${s.projectName}`);
    lines.push(`   └ ${formatNumber(s.tokens.input)} in / ${formatNumber(s.tokens.output)} out ($${s.estimatedCostUsd.toFixed(2)})`);
    if (summary) lines.push(`   └ ${summary}`);
  }

  if (sorted.length > 5) {
    lines.push(`   ... +${sorted.length - 5} more sessions`);
  }

  return lines.join('\n');
}

/**
 * Format token usage report as Discord Embed.
 */
export function formatTokenUsageEmbed(report: TokenUsageReport): EmbedData {
  const { totals, sessions, activeCount, totalCount } = report;

  if (sessions.length === 0) {
    return {
      title: '📊 Claude Token Usage',
      description: '활성 세션 없음',
      color: 0x6b7280,
    };
  }

  const sorted = [...sessions].sort(sortByStateAndActivity);

  const fields = sorted.slice(0, 5).map((s) => {
    const stateIcon = s.state === 'active' ? '🟢' : s.state === 'idle' ? '🟡' : '⚪';
    const summary = sessionSummary(s);
    let value = `${formatNumber(s.tokens.input)} in / ${formatNumber(s.tokens.output)} out ($${s.estimatedCostUsd.toFixed(2)})`;
    if (summary) value += `\n${summary}`;
    return {
      name: `${stateIcon} ${s.projectName}`,
      value,
    };
  });

  if (sorted.length > 5) {
    fields.push({ name: '\u200b', value: `+${sorted.length - 5} more sessions` });
  }

  return {
    title: `📊 Claude Token Usage (${activeCount} active, ${totalCount} total)`,
    description: `총 토큰: ${formatNumber(totals.input)} in / ${formatNumber(totals.output)} out / ${formatNumber(totals.cached)} cached\n예상 비용: $${totals.estimatedCostUsd.toFixed(2)}`,
    color: activeCount > 0 ? 0x8b5cf6 : 0x6b7280,
    fields,
    timestamp: true,
  };
}
