import type { ChannelMapping } from '../discord/types.ts';

export interface WorktreeInfo {
  originalName: string;
  worktreeName: string;
}

/**
 * 워크트리 디렉토리 basename에서 원본 프로젝트 이름과 워크트리 이름을 추출한다.
 * 형식: {originalName}~{worktreeName}
 * 예: pray-bot~api → {originalName: "pray-bot", worktreeName: "api"}
 *
 * @param projectPath 프로젝트 경로 (예: ~/work/js/pray-bot~api)
 * @returns WorktreeInfo 또는 null (tilde 없으면 null)
 */
export function extractOriginalProjectFromWorktree(projectPath: string): WorktreeInfo | null {
  const trimmed = projectPath.trim();
  if (!trimmed) return null;

  const basename = basenameFromPath(trimmed);
  if (!basename) return null;

  const tildeIndex = basename.indexOf('~');
  if (tildeIndex === -1) return null;

  const originalName = basename.slice(0, tildeIndex);
  const worktreeName = basename.slice(tildeIndex + 1);

  if (!originalName || !worktreeName) return null;

  return { originalName, worktreeName };
}

/**
 * 프로젝트 경로를 ChannelRegistry 매핑으로 역산한다.
 * 우선순위: exact match -> prefix match -> longest prefix match
 */
export function resolveMapping(
  projectPath: string,
  channelRegistry: { listAll(): ChannelMapping[] },
): ChannelMapping | null {
  const normalizedProjectPath = normalizePath(projectPath);
  if (!normalizedProjectPath) return null;
  const mappings = channelRegistry.listAll();

  // 1) exact match
  for (const mapping of mappings) {
    const mappingPath = normalizePath(mapping.path);
    if (mappingPath && normalizedProjectPath === mappingPath) {
      return mapping;
    }
  }

  // 2) prefix match + 3) longest prefix match
  let best: ChannelMapping | null = null;
  for (const mapping of mappings) {
    const mappingPath = normalizePath(mapping.path);
    if (!mappingPath) continue;
    const prefix = mappingPath.endsWith('/') ? mappingPath : `${mappingPath}/`;
    if (!normalizedProjectPath.startsWith(prefix)) continue;
    if (!best || mappingPath.length > normalizePath(best.path).length) {
      best = mapping;
    }
  }

  return best;
}

/**
 * 세션 스냅샷 기준 채널 매핑.
 * 우선순위:
 * 1) projectPath 기반 resolveMapping
 * 2) projectName / path basename 기반 key 매칭
 * 3) worktree 역매핑 fallback (originalName으로 재시도)
 */
export function resolveMappingForSession(
  snapshot: { projectPath: string; projectName: string },
  channelRegistry: { listAll(): ChannelMapping[] },
): ChannelMapping | null {
  const byPath = resolveMapping(snapshot.projectPath, channelRegistry);
  if (byPath) return byPath;

  const candidates = new Set<string>();
  const projectName = snapshot.projectName?.trim();
  if (projectName) {
    candidates.add(projectName);
    candidates.add(normalizeChannelKey(projectName));
  }

  const pathBasename = basenameFromPath(snapshot.projectPath);
  if (pathBasename) {
    candidates.add(pathBasename);
    candidates.add(normalizeChannelKey(pathBasename));
  }

  if (candidates.size === 0) return null;

  const mappings = channelRegistry.listAll();

  // Direct key matching
  for (const mapping of mappings) {
    if (candidates.has(mapping.key) || candidates.has(normalizeChannelKey(mapping.key))) {
      return mapping;
    }
  }

  // Worktree fallback: try matching with original project name
  const worktreeInfo = extractOriginalProjectFromWorktree(snapshot.projectPath);
  if (worktreeInfo) {
    const originalCandidates = new Set<string>();
    originalCandidates.add(worktreeInfo.originalName);
    originalCandidates.add(normalizeChannelKey(worktreeInfo.originalName));

    for (const mapping of mappings) {
      if (
        originalCandidates.has(mapping.key) ||
        originalCandidates.has(normalizeChannelKey(mapping.key))
      ) {
        return mapping;
      }
    }
  }

  // Case-insensitive fallback
  const allKeys = mappings.map((m) => ({ mapping: m, normalized: normalizeChannelKey(m.key) }));
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeChannelKey(candidate);
    for (const { mapping, normalized } of allKeys) {
      if (normalized === normalizedCandidate) {
        return mapping;
      }
    }
  }

  return null;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

function basenameFromPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

function normalizeChannelKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
