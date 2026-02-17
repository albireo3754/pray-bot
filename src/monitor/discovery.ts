import { readdir, stat } from 'node:fs/promises';
import type { ClaudeProcess } from './types.ts';

const HOME = process.env.HOME ?? '';
export const CLAUDE_HOMES = [
  `${HOME}/.claude`,
  `${HOME}/.claude-silba`,
];

async function exec(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

/**
 * Get all running Claude CLI processes via `ps aux`.
 */
export async function getClaudeProcesses(): Promise<ClaudeProcess[]> {
  try {
    const result = await exec(['ps', 'aux']);
    const lines = result.split('\n');
    const processes: ClaudeProcess[] = [];

    for (const line of lines) {
      if (!line.includes('claude') || line.includes('grep')) continue;
      if (!line.match(/\bclaude\b.*--dangerously-skip-permissions|--resume|\bclaude\s*$/)) continue;
      if (line.includes('node ') || line.includes('bun ')) continue;

      const cols = line.trim().split(/\s+/);
      if (cols.length < 11) continue;

      const pid = parseInt(cols[1] ?? '', 10);
      if (isNaN(pid)) continue;

      const cpuPercent = parseFloat(cols[2] ?? '0') || 0;
      const rssKb = parseInt(cols[5] ?? '0', 10) || 0;
      const memMb = Math.round(rssKb / 1024);

      const cmdPart = cols.slice(10).join(' ');
      const resumeMatch = cmdPart.match(/--resume\s+([0-9a-f-]{36})/);
      const resumeId = resumeMatch?.[1] ?? null;

      processes.push({
        pid,
        sessionId: null,
        cwd: '',
        resumeId,
        cpuPercent,
        memMb,
      });
    }

    return processes;
  } catch {
    return [];
  }
}

/**
 * Enrich ClaudeProcess array with session IDs and cwds via lsof.
 * Runs lsof once per process for efficiency.
 */
export async function enrichProcesses(processes: ClaudeProcess[]): Promise<void> {
  await Promise.all(
    processes.map(async (proc) => {
      try {
        const result = await exec(['/usr/sbin/lsof', '-p', String(proc.pid)]);
        const lines = result.split('\n');

        for (const line of lines) {
          if (!proc.sessionId) {
            const taskMatch = line.match(/\.claude(?:-silba)?\/tasks\/([0-9a-f-]{36})/);
            if (taskMatch?.[1]) proc.sessionId = taskMatch[1];
          }
          if (!proc.cwd && line.includes('cwd') && line.includes('DIR')) {
            const pathMatch = line.match(/\s(\/\S+)$/);
            if (pathMatch?.[1]) proc.cwd = pathMatch[1];
          }
        }
      } catch {
        // Process may have exited
      }
    }),
  );
}

/**
 * Encode an absolute path to a Claude project directory key.
 * e.g., `/Users/pray/work/js/kw-chat` → `-Users-pray-work-js-kw-chat`
 */
export function encodeProjectKey(path: string): string {
  return path.replace(/\//g, '-');
}

export interface ProjectInfo {
  key: string;
  baseDir: string;  // e.g. ~/.claude or ~/.claude-silba
  path: string;
  jsonlFiles: { name: string; mtime: number }[];
}

/**
 * Scan all CLAUDE_HOMES/projects/ for project directories and their JSONL files.
 */
export async function discoverProjects(): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];

  for (const baseDir of CLAUDE_HOMES) {
    const projectsDir = `${baseDir}/projects`;

    try {
      const entries = await readdir(projectsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = `${projectsDir}/${entry.name}`;

        // List JSONL files
        const jsonlFiles: { name: string; mtime: number }[] = [];
        try {
          const files = await readdir(fullPath);
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const fstat = await stat(`${fullPath}/${f}`);
            jsonlFiles.push({ name: f, mtime: fstat.mtimeMs });
          }
        } catch {
          continue;
        }

        if (jsonlFiles.length === 0) continue;

        // Sort by mtime descending
        jsonlFiles.sort((a, b) => b.mtime - a.mtime);

        projects.push({
          key: entry.name,
          baseDir,
          path: entry.name,
          jsonlFiles,
        });
      }
    } catch {
      // directory may not exist
    }
  }

  return projects;
}
