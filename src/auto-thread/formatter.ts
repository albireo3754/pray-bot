import type { SessionSnapshot, ActivityPhase } from '../monitor/types.ts';
import type { EmbedData } from '../discord/types.ts';
import { extractOriginalProjectFromWorktree } from './resolver.ts';

export function formatInitialEmbed(snapshot: SessionSnapshot, worktreeTask?: string): EmbedData {
  const provider = snapshot.provider === 'codex' ? 'Codex' : 'Claude';
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

  if (snapshot.provider === 'codex') {
    if (snapshot.originator) {
      fields.push({
        name: 'Originator',
        value: snapshot.originator,
        inline: true,
      });
    }
    if (snapshot.source) {
      fields.push({
        name: 'Source',
        value: snapshot.source,
        inline: true,
      });
    }
  }

  return {
    title: `새 ${provider} 세션 감지`,
    color: snapshot.provider === 'codex' ? 0x10a37f : 0x7c3aed,
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

export function formatActivityPhaseChangeMessage(
  previousPhase: ActivityPhase | null,
  currentPhase: ActivityPhase | null,
  current: SessionSnapshot,
): string | null {
  if (previousPhase === currentPhase) return null;

  if (currentPhase === 'interactable') {
    return '세션이 대기 중입니다. Discord에서 메시지를 보낼 수 있습니다.';
  }
  if (currentPhase === 'busy' && previousPhase === 'interactable') {
    return '세션이 작업을 시작했습니다.';
  }
  if (currentPhase === 'waiting_question') {
    return '세션이 질문에 대한 답변을 기다리고 있습니다.';
  }
  if (currentPhase === 'waiting_permission') {
    const tools = current.waitToolNames.length > 0 ? current.waitToolNames.join(', ') : 'tool';
    return `세션이 도구 승인을 기다리고 있습니다: ${tools}`;
  }

  return null;
}
