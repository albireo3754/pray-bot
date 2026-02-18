import type { ActivityPhase } from './types.ts';

interface ActivityPhaseInput {
  waitReason: 'user_question' | 'permission' | null;
  waitToolNames: string[];
  lastAssistantStopReason: string | null;
}

/**
 * JSONL entries + 프로세스 정보에서 activityPhase를 결정한다.
 *
 * 판단 로직:
 * 1. waitReason === 'user_question' → 'waiting_question'
 * 2. waitReason === 'permission' → 'waiting_permission'
 * 3. 마지막 entry가 'assistant' + stop_reason === 'end_turn' + pending tool 없음 → 'interactable'
 * 4. 그 외 → 'busy'
 */
export function determineActivityPhase(
  info: ActivityPhaseInput,
): ActivityPhase {
  // 1. AskUserQuestion 대기
  if (info.waitReason === 'user_question') return 'waiting_question';

  // 2. Tool 승인 대기
  if (info.waitReason === 'permission') return 'waiting_permission';

  // 3. 마지막 assistant가 end_turn + pending tool 없음 → interactable
  if (
    info.lastAssistantStopReason === 'end_turn' &&
    info.waitToolNames.length === 0
  ) {
    return 'interactable';
  }

  // 4. 그 외 → busy
  return 'busy';
}
