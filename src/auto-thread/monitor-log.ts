import type { SessionSnapshot } from '../usage-monitor/types.ts';

const DEFAULT_PREVIEW_LIMIT = 220;

interface JsonlEntry {
  type: string;
  timestamp?: string;
  message?: {
    content?: string | Array<{ type: string; text?: string }>;
  };
}

type TextEvent = {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
};

/** Read tail of JSONL file directly (avoids shared module mock leaks in tests). */
async function readJsonlTail(path: string, bytes = 256_000): Promise<JsonlEntry[]> {
  const file = Bun.file(path);
  const size = file.size;
  if (size === 0) return [];

  const start = Math.max(0, size - bytes);
  const text = await file.slice(start, size).text();
  const lines = text.split('\n');
  if (start > 0) lines.shift();

  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return entries;
}

export async function buildMonitorLogMessage(
  snapshot: SessionSnapshot,
  sinceMs: number,
): Promise<string | null> {
  const entries = await readJsonlTail(snapshot.jsonlPath);
  const textEvents = collectTextEventsSince(entries, sinceMs);
  if (textEvents.length === 0) return null;

  const lastUser = findLastByRole(textEvents, 'user');
  const lastAssistant = findLastByRole(textEvents, 'assistant');
  const latest = textEvents[textEvents.length - 1];

  const lines = [
    '📝 auto-thread monitor (10m)',
    `State: ${snapshot.state} | Turns: ${snapshot.turnCount}`,
  ];

  if (lastUser && lastAssistant && lastAssistant.ts >= lastUser.ts) {
    lines.push(`Q: ${lastUser.text}`);
    lines.push(`A: ${lastAssistant.text}`);
  } else if (latest) {
    lines.push(`${latest.role === 'user' ? 'Q' : 'A'}: ${latest.text}`);
  }

  return lines.join('\n');
}

function collectTextEventsSince(entries: JsonlEntry[], sinceMs: number): TextEvent[] {
  const events: TextEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const ts = parseTimestampMs(entry.timestamp);
    if (ts == null || ts <= sinceMs) continue;

    const text = extractText(entry);
    if (!text) continue;

    events.push({
      role: entry.type,
      text: textPreview(text),
      ts,
    });
  }
  return events;
}

function parseTimestampMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function extractText(entry: JsonlEntry): string | null {
  const content = entry.message?.content;
  if (typeof content === 'string') {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) return null;

  const textBlocks = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text ?? '').trim())
    .filter((value) => value.length > 0);

  if (textBlocks.length === 0) return null;
  return textBlocks.join(' ');
}

function textPreview(text: string, max = DEFAULT_PREVIEW_LIMIT): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function findLastByRole(events: TextEvent[], role: TextEvent['role']): TextEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && event.role === role) return event;
  }
  return null;
}
