export interface JsonlEntry {
  type: string;
  sessionId?: string;
  slug?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  uuid?: string;
  userType?: string;
  message?: {
    role?: string;
    model?: string;
    stop_reason?: string | null;
    content?: string | ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface ContentBlock {
  type: string;
  name?: string;
  text?: string;
  id?: string;
}

export interface SessionInfo {
  sessionId: string;
  slug: string;
  cwd: string;
  gitBranch: string | null;
  version: string | null;
  model: string | null;
  turnCount: number;
  lastUserMessage: string | null;
  currentTools: string[];
  tokens: { input: number; output: number; cached: number };
  startedAt: Date | null;
  lastActivity: Date;
  waitReason: 'user_question' | 'permission' | null;
  waitToolNames: string[];
}

/**
 * Tail-read a JSONL file, reading the last `bytes` of the file.
 * Parses each line as JSON, skipping invalid lines.
 */
export async function tailJsonl(path: string, bytes = 256_000): Promise<JsonlEntry[]> {
  const file = Bun.file(path);
  const size = file.size;

  if (size === 0) return [];

  const start = Math.max(0, size - bytes);
  const slice = file.slice(start, size);
  const text = await slice.text();

  const lines = text.split('\n');
  // If we sliced mid-line, skip the first partial line
  if (start > 0) lines.shift();

  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Extract session metadata from parsed JSONL entries.
 */
export function extractSessionInfo(entries: JsonlEntry[]): SessionInfo {
  let sessionId = '';
  let slug = '';
  let cwd = '';
  let gitBranch: string | null = null;
  let version: string | null = null;
  let model: string | null = null;
  let turnCount = 0;
  let lastUserMessage: string | null = null;
  const currentTools: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let startedAt: Date | null = null;
  let lastActivity = new Date(0);

  for (const entry of entries) {
    // Update metadata from any entry that has these fields
    if (entry.sessionId) sessionId = entry.sessionId;
    if (entry.slug) slug = entry.slug;
    if (entry.cwd) cwd = entry.cwd;
    if (entry.gitBranch) gitBranch = entry.gitBranch;
    if (entry.version) version = entry.version;

    // Track timestamps
    if (entry.timestamp) {
      const ts = new Date(entry.timestamp);
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (ts > lastActivity) lastActivity = ts;
    }

    if (entry.type === 'user') {
      turnCount++;
      // Extract user message content (skip tool results)
      const content = entry.message?.content;
      if (typeof content === 'string' && content.length > 0) {
        lastUserMessage = content.length > 100 ? content.slice(0, 100) + '…' : content;
      } else if (Array.isArray(content)) {
        const textBlock = content.find(
          (b) => b.type === 'text' && b.text,
        );
        if (textBlock?.text) {
          const text = textBlock.text;
          lastUserMessage = text.length > 100 ? text.slice(0, 100) + '…' : text;
        }
      }
    }

    if (entry.type === 'assistant') {
      const msg = entry.message;
      if (msg?.model) model = msg.model;

      // Accumulate tokens
      const usage = msg?.usage;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cachedTokens += usage.cache_read_input_tokens ?? 0;
      }

      // Extract tool names from the most recent assistant message
      if (Array.isArray(msg?.content)) {
        const tools = msg.content
          .filter((b) => b.type === 'tool_use' && b.name)
          .map((b) => b.name!);
        if (tools.length > 0) {
          currentTools.length = 0;
          currentTools.push(...tools);
        }
      }
    }
  }

  // Detect waiting state: find the last assistant message with tool_use
  // and check if all tool_use IDs have matching tool_results
  let waitReason: SessionInfo['waitReason'] = null;
  const waitToolNames: string[] = [];

  // Walk backwards to find the last assistant message with tool_use
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== 'assistant') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) break;

    const toolUses = content.filter((b) => b.type === 'tool_use' && b.id);
    if (toolUses.length === 0) break;

    // Collect tool_result IDs from entries after this assistant message
    const resolvedIds = new Set<string>();
    for (let j = i + 1; j < entries.length; j++) {
      const sub = entries[j];
      if (!sub || sub.type !== 'user') continue;
      const subContent = sub.message?.content;
      if (!Array.isArray(subContent)) continue;
      for (const block of subContent) {
        if ((block as any).type === 'tool_result' && (block as any).tool_use_id) {
          resolvedIds.add((block as any).tool_use_id);
        }
      }
    }

    // Check which tool_uses are still pending
    const pending = toolUses.filter((t) => !resolvedIds.has(t.id!));
    if (pending.length > 0) {
      const hasAskUser = pending.some((t) => t.name === 'AskUserQuestion');
      waitReason = hasAskUser ? 'user_question' : 'permission';
      waitToolNames.push(...pending.map((t) => t.name!).filter(Boolean));
    }
    break;
  }

  return {
    sessionId,
    slug,
    cwd,
    gitBranch,
    version,
    model,
    turnCount,
    lastUserMessage,
    currentTools,
    tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens },
    startedAt,
    lastActivity: lastActivity.getTime() === 0 ? new Date() : lastActivity,
    waitReason,
    waitToolNames,
  };
}
