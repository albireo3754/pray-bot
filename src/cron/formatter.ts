import type { CronJob, CronStatusSummary } from './types.ts';

function formatSchedule(job: CronJob): string {
  const s = job.schedule;
  if (s.kind === 'at') return `at ${new Date(s.atMs).toISOString()}`;
  if (s.kind === 'every') {
    const ms = s.everyMs;
    if (ms >= 3600_000) return `every ${(ms / 3600_000).toFixed(0)}h`;
    if (ms >= 60_000) return `every ${(ms / 60_000).toFixed(0)}m`;
    return `every ${(ms / 1000).toFixed(0)}s`;
  }
  const tz = s.tz ? ` (${s.tz})` : '';
  return `${s.expr}${tz}`;
}

function formatNextRun(nextMs?: number): string {
  if (!nextMs) return '-';
  const now = Date.now();
  const diff = nextMs - now;
  if (diff < 0) return 'overdue';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  return new Date(nextMs).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatJobListText(jobs: CronJob[]): string {
  const enabled = jobs.filter((j) => j.enabled);
  const disabled = jobs.filter((j) => !j.enabled);

  if (jobs.length === 0) return 'Cron Job 없음 ✨';

  const lines = [`⏰ Cron Jobs (${enabled.length} active${disabled.length ? `, ${disabled.length} disabled` : ''})`, ''];

  for (const job of enabled) {
    lines.push(`🟢 ${job.name} [${job.id}]`);
    lines.push(`   └ ${formatSchedule(job)} | next: ${formatNextRun(job.state.nextRunAtMs)}`);
    lines.push(`   └ action: ${job.action.type} ${formatActionSummary(job)}`);
    if (job.state.lastStatus) {
      lines.push(`   └ last: ${job.state.lastStatus} (${formatDuration(job.state.lastDurationMs)})`);
    }
    lines.push('');
  }

  for (const job of disabled) {
    lines.push(`⚪ ${job.name} [${job.id}]`);
    lines.push(`   └ ${formatSchedule(job)} | disabled`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatActionSummary(job: CronJob): string {
  const c = job.action.config;
  switch (job.action.type) {
    case 'notify':
      return `"${String(c.message ?? '').slice(0, 40)}"`;
    case 'http':
      return `${String(c.method ?? 'GET')} ${String(c.url ?? '')}`;
    case 'command':
      return `"${String(c.text ?? '')}"`;
    case 'shell':
      return Array.isArray(c.cmd) ? c.cmd.join(' ') : '';
    default:
      return '';
  }
}

export function formatStatusText(status: CronStatusSummary): string {
  return [
    `⏰ Cron Scheduler`,
    `   상태: ${status.running ? '🟢 실행 중' : '🔴 중지'}`,
    `   전체: ${status.jobCount} jobs (${status.enabledCount} enabled)`,
    `   다음 실행: ${status.nextWakeAtMs ? new Date(status.nextWakeAtMs).toLocaleString('ko-KR') : '-'}`,
  ].join('\n');
}
