import type { SessionSnapshot } from '../monitor/types.ts';
import type { EmbedData } from '../discord/types.ts';
import { extractOriginalProjectFromWorktree } from './resolver.ts';

export function formatInitialEmbed(snapshot: SessionSnapshot, worktreeTask?: string): EmbedData {
  const waiting = snapshot.waitReason
    ? `${snapshot.waitReason}${snapshot.waitToolNames.length > 0 ? ` (${snapshot.waitToolNames.join(', ')})` : ''}`
    : '-';

  const worktreeInfo = extractOriginalProjectFromWorktree(snapshot.projectPath);
  const projectDisplay = worktreeInfo
    ? `${worktreeInfo.originalName} (worktree: ${worktreeInfo.worktreeName})`
    : snapshot.projectName;

  const fields: EmbedData['fields'] = [
    { name: 'Session', value: snapshot.slug, inline: true },
    { name: 'Model', value: snapshot.model ?? 'unknown', inline: true },
    { name: 'Project', value: projectDisplay, inline: true },
    { name: 'Branch', value: snapshot.gitBranch ?? '-', inline: true },
    { name: 'State', value: snapshot.state, inline: true },
    { name: 'Turn', value: String(snapshot.turnCount), inline: true },
    { name: 'Waiting', value: waiting, inline: false },
    { name: 'Tokens', value: `in:${snapshot.tokens.input} out:${snapshot.tokens.output} cached:${snapshot.tokens.cached}`, inline: false },
  ];

  // Add Worktree field if detected
  if (worktreeInfo) {
    fields.push({
      name: 'Worktree',
      value: `\`${snapshot.projectPath}\``,
      inline: false,
    });

    // Show task if pre-extracted (from createThreadForSession worktree.task)
    if (worktreeTask) {
      const taskPreview = worktreeTask.trim().slice(0, 200);
      fields.push({
        name: 'Task',
        value: taskPreview.length >= 200 ? `${taskPreview}...` : taskPreview,
        inline: false,
      });
    }
  } else {
    fields.push({
      name: 'Path',
      value: `\`${snapshot.projectPath || '-'}\``,
      inline: false,
    });
  }

  fields.push({
    name: 'Session ID',
    value: `\`${snapshot.sessionId}\``,
    inline: false,
  });

  return {
    title: '새 Claude 세션 감지',
    color: 0x7c3aed,
    fields,
    footer: { text: 'Auto-discovered by pray-bot' },
    timestamp: true,
  };
}

export function formatStateChangeMessage(
  previous: SessionSnapshot['state'],
  current: SessionSnapshot,
): string | null {
  if (previous === current.state) return null;

  if (previous === 'active' && current.state === 'idle') {
    return '세션이 유휴 상태입니다. (5분 이상 비활성)';
  }
  if (previous === 'idle' && current.state === 'active') {
    return '세션이 다시 활성화되었습니다.';
  }
  if ((previous === 'active' || previous === 'idle') && current.state === 'completed') {
    return `세션이 종료되었습니다. 토큰 요약: in:${current.tokens.input}, out:${current.tokens.output}, cached:${current.tokens.cached}`;
  }
  if (current.state === 'stale') {
    return '세션이 stale 상태로 전환되었습니다.';
  }

  return `세션 상태 변경: ${previous} -> ${current.state}`;
}
