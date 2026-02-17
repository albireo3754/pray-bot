type JsonRecord = Record<string, unknown>;
export type ClaudeToolUse = {
  key: string;
  label: string;
};
export type ClaudeUxEvent = {
  key: string;
  label: string;
  severity: 'info' | 'warn' | 'error';
  immediate?: boolean;
};

function extractClaudeAssistantText(event: JsonRecord): string {
  if (event.type !== 'assistant' || !event.message || typeof event.message !== 'object') return '';
  const content = (event.message as JsonRecord).content;
  if (!Array.isArray(content)) return '';

  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as JsonRecord;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      chunks.push(b.text.trim());
    }
  }
  return chunks.join('\n\n').trim();
}

function extractClaudeToolUses(event: JsonRecord): ClaudeToolUse[] {
  if (event.type !== 'assistant' || !event.message || typeof event.message !== 'object') return [];
  const content = (event.message as JsonRecord).content;
  if (!Array.isArray(content)) return [];

  const toolUses: ClaudeToolUse[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as JsonRecord;
    if (b.type !== 'tool_use') continue;

    const rawName = typeof b.name === 'string' ? b.name.trim() : '';
    const name = rawName || 'unknown_tool';
    const id = typeof b.id === 'string' ? b.id.trim() : '';

    let detail = '';
    const input = b.input;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const inputRecord = input as JsonRecord;
      if (name === 'Bash' && typeof inputRecord.command === 'string' && inputRecord.command.trim()) {
        detail = inputRecord.command.trim();
      } else if (typeof inputRecord.file_path === 'string' && inputRecord.file_path.trim()) {
        detail = inputRecord.file_path.trim();
      }
    }

    const keySource = id || `${name}:${detail}`;
    const key = keySource.slice(0, 400);
    const label = detail ? `${name} ${detail}` : name;
    toolUses.push({ key, label });
  }
  return toolUses;
}

function parseClaudeAssistantStreamLine(
  line: string,
): { assistantText: string; toolUses: ClaudeToolUse[]; uxEvents: ClaudeUxEvent[] } {
  const trimmed = line.trim();
  if (!trimmed) {
    return { assistantText: '', toolUses: [], uxEvents: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { assistantText: '', toolUses: [], uxEvents: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { assistantText: '', toolUses: [], uxEvents: [] };
  }

  const event = parsed as JsonRecord;
  return {
    assistantText: extractClaudeAssistantText(event),
    toolUses: extractClaudeToolUses(event),
    uxEvents: extractClaudeUxEvents(event),
  };
}

export function computeClaudeAssistantDelta(
  line: string,
  previousSnapshot: string,
): { delta: string; nextSnapshot: string } {
  const { assistantText } = parseClaudeAssistantStreamLine(line);
  if (!assistantText) {
    return { delta: '', nextSnapshot: previousSnapshot };
  }

  let delta = '';
  if (assistantText.startsWith(previousSnapshot) && assistantText.length > previousSnapshot.length) {
    delta = assistantText.slice(previousSnapshot.length);
  } else if (assistantText !== previousSnapshot) {
    delta = assistantText;
  }

  const cleanDelta = delta.trim();
  const nextSnapshot = assistantText.length >= previousSnapshot.length
    ? assistantText
    : previousSnapshot;
  return { delta: cleanDelta, nextSnapshot };
}

export function extractClaudeToolUsesFromLine(line: string): ClaudeToolUse[] {
  const { toolUses } = parseClaudeAssistantStreamLine(line);
  return toolUses;
}

function extractClaudeUxEvents(event: JsonRecord): ClaudeUxEvent[] {
  const out: ClaudeUxEvent[] = [];
  const push = (
    key: string,
    label: string,
    severity: 'info' | 'warn' | 'error' = 'info',
    immediate = false,
  ) => {
    if (!key || !label) return;
    out.push({ key, label, severity, immediate });
  };

  if (event.type === 'assistant' && event.message && typeof event.message === 'object') {
    const content = (event.message as JsonRecord).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
        const b = block as JsonRecord;
        const blockType = typeof b.type === 'string' ? b.type : '';
        if (blockType === 'thinking') {
          push('thinking', '추론 중');
          continue;
        }
        if (blockType === 'redacted_thinking') {
          push('thinking:redacted', '추론 중 (비공개)');
          continue;
        }
        if (blockType === 'tool_result') {
          const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id.trim() : '';
          const isError = b.is_error === true;
          const key = toolUseId ? `tool_result:${toolUseId}` : 'tool_result';
          const shortId = toolUseId ? toolUseId.slice(0, 12) : '';
          const label = isError
            ? `도구 실행 실패${shortId ? ` (${shortId})` : ''}`
            : `도구 실행 완료${shortId ? ` (${shortId})` : ''}`;
          push(key, label, isError ? 'error' : 'info');
        }
      }
    }
  }

  if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
    const streamEvent = event.event as JsonRecord;
    const streamType = typeof streamEvent.type === 'string' ? streamEvent.type : '';
    if (streamType === 'message_start') {
      push('lifecycle:message_start', '응답 생성 시작');
    } else if (streamType === 'message_stop') {
      push('lifecycle:message_stop', '응답 생성 완료');
    } else if (streamType === 'content_block_start') {
      const block = streamEvent.content_block;
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        const blockType = typeof (block as JsonRecord).type === 'string' ? (block as JsonRecord).type : '';
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          push(`thinking:start:${blockType}`, blockType === 'thinking' ? '추론 블록 시작' : '추론 블록 시작 (비공개)');
        }
      }
    } else if (streamType === 'content_block_delta') {
      const delta = streamEvent.delta;
      if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
        const deltaType = typeof (delta as JsonRecord).type === 'string' ? (delta as JsonRecord).type : '';
        if (deltaType === 'thinking_delta') {
          push('thinking:delta', '추론 진행 중');
        }
      }
    }
  }

  if (event.type === 'result') {
    const subtype = typeof event.subtype === 'string' ? event.subtype.trim() : '';
    if (subtype) {
      const severity = subtype === 'success' ? 'info' : 'warn';
      push(`result:${subtype}`, `턴 종료 (${subtype})`, severity);
    }
    const denials = event.permission_denials;
    if (Array.isArray(denials)) {
      let askCount = 0;
      for (const denial of denials) {
        if (!denial || typeof denial !== 'object' || Array.isArray(denial)) continue;
        const toolName = (denial as JsonRecord).tool_name;
        if (toolName === 'AskUserQuestion') askCount++;
      }
      if (askCount > 0) {
        push('needs-user-input', `사용자 입력 필요 (${askCount}개 질문)`, 'warn', true);
      }
    }
  }

  if (event.type === 'error') {
    const message = typeof event.message === 'string' ? event.message.trim() : '';
    push(
      message ? `error:${message.slice(0, 120)}` : 'error',
      message ? `오류 이벤트: ${message}` : '오류 이벤트 수신',
      'error',
    );
  }

  return out;
}

export function extractClaudeUxEventsFromLine(line: string): ClaudeUxEvent[] {
  const { uxEvents } = parseClaudeAssistantStreamLine(line);
  return uxEvents;
}

function normalizeForCompare(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeClaudeFinalRemainder(streamedText: string, finalText: string): string {
  const streamedTrimmed = streamedText.trim();
  const finalTrimmed = finalText.trim();
  if (!finalTrimmed) return '';
  if (!streamedTrimmed) return finalTrimmed;

  if (normalizeForCompare(streamedTrimmed) === normalizeForCompare(finalTrimmed)) {
    return '';
  }

  if (finalTrimmed.startsWith(streamedTrimmed)) {
    return finalTrimmed.slice(streamedTrimmed.length).trim();
  }

  return finalTrimmed;
}
