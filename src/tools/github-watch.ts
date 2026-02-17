/**
 * GitHub Watch Tools — 4 independent ToolDefinitions for GitHub REST API
 *
 * Tools: github_list_prs, github_pr_comments, github_list_issues, github_issue_comments
 * Uses fetch-based REST calls. Supports GitHub Enterprise hosts.
 */

import type { ToolDefinition, ToolExecutionResult } from '../tools.ts';

// ─── Common Types ────────────────────────────────────────

const DEFAULT_HOST = 'github.dktechin.in';

type GitHubErrorCode = 'AUTH_ERROR' | 'NOT_FOUND' | 'RATE_LIMIT' | 'UPSTREAM_ERROR';

type RateLimitInfo = {
  limit: number;
  remaining: number;
  resetAt: string; // ISO 8601
};

type GitHubResult<T> =
  | { ok: true; items: T; rateLimit?: RateLimitInfo }
  | { ok: false; error: { code: GitHubErrorCode; message: string; status?: number }; rateLimit?: RateLimitInfo };

// ─── Internal Helpers ────────────────────────────────────

function getApiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

function parseRateLimit(headers: Headers): RateLimitInfo | undefined {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (!limit || !remaining || !reset) return undefined;
  return {
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    resetAt: new Date(parseInt(reset, 10) * 1000).toISOString(),
  };
}

async function githubRequest<T>(
  host: string,
  method: string,
  endpoint: string,
): Promise<{ data: T; rateLimit?: RateLimitInfo }> {
  const token = getToken();
  if (!token) {
    throw { code: 'AUTH_ERROR' as GitHubErrorCode, message: 'GITHUB_TOKEN or GH_TOKEN not set', status: 401 };
  }

  const url = `${getApiBase(host)}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  const rateLimit = parseRateLimit(response.headers);
  if (rateLimit && rateLimit.remaining < 100) {
    console.warn(`[github-watch] Rate limit low: ${rateLimit.remaining}/${rateLimit.limit}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const code: GitHubErrorCode =
      response.status === 401 || response.status === 403 ? 'AUTH_ERROR' :
      response.status === 404 ? 'NOT_FOUND' :
      response.status === 429 ? 'RATE_LIMIT' :
      'UPSTREAM_ERROR';
    throw { code, message: errorText, status: response.status, rateLimit };
  }

  const data = (await response.json()) as T;
  return { data, rateLimit };
}

function errorResult(err: unknown): GitHubResult<never> {
  if (err && typeof err === 'object' && 'code' in err) {
    const e = err as { code: GitHubErrorCode; message: string; status?: number; rateLimit?: RateLimitInfo };
    return { ok: false, error: { code: e.code, message: e.message, status: e.status }, rateLimit: e.rateLimit };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'UPSTREAM_ERROR', message } };
}

function successResult<T>(status: string, data: Record<string, unknown>): ToolExecutionResult {
  return { status: status as ToolExecutionResult['status'], data };
}

// ─── Tool 1: github_list_prs ─────────────────────────────

type ListPRsInput = {
  host?: string;
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  sort?: 'created' | 'updated';
  direction?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
};

type PRItem = {
  number: number;
  title: string;
  state: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
};

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
}

async function listPullRequests(input: ListPRsInput): Promise<GitHubResult<PRItem[]>> {
  const host = input.host ?? DEFAULT_HOST;
  const state = input.state ?? 'open';
  const sort = input.sort ?? 'updated';
  const direction = input.direction ?? 'desc';
  const page = input.page ?? 1;
  const perPage = Math.min(input.perPage ?? 30, 100);

  try {
    const qs = `state=${state}&sort=${sort}&direction=${direction}&page=${page}&per_page=${perPage}`;
    const { data, rateLimit } = await githubRequest<GitHubPR[]>(
      host, 'GET', `/repos/${input.owner}/${input.repo}/pulls?${qs}`,
    );
    const items: PRItem[] = data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      user: pr.user.login,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      htmlUrl: pr.html_url,
    }));
    return { ok: true, items, rateLimit };
  } catch (err) {
    return errorResult(err);
  }
}

export function createGithubListPrsTool(): ToolDefinition<ListPRsInput> {
  return {
    name: 'github_list_prs',
    description: 'List pull requests for a GitHub repository. Returns PR number, title, state, author, dates, and URL.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: `GitHub host (default: "${DEFAULT_HOST}"). Use "github.com" for public GitHub.` },
        owner: { type: 'string', description: 'Repository owner (org or user)' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter (default: "open")' },
        sort: { type: 'string', enum: ['created', 'updated'], description: 'Sort field (default: "updated")' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: "desc")' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        perPage: { type: 'number', description: 'Items per page (default: 30, max: 100)' },
      },
      required: ['owner', 'repo'],
    },
    async execute(input: ListPRsInput): Promise<ToolExecutionResult> {
      const result = await listPullRequests(input);
      return {
        status: result.ok ? 'success' : 'error',
        data: result as unknown as Record<string, unknown>,
      };
    },
  };
}

// ─── Tool 2: github_pr_comments ──────────────────────────

type PRCommentsInput = {
  host?: string;
  owner: string;
  repo: string;
  prNumber: number;
  includeIssueComments?: boolean;
  includeReviewComments?: boolean;
  page?: number;
  perPage?: number;
};

type PRComment = {
  id: number;
  commentType: 'issue' | 'review';
  user: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  path?: string;
  diffHunk?: string;
};

interface GitHubIssueComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubReviewComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  path: string;
  diff_hunk: string;
}

async function listIssueCommentsForPR(
  host: string, owner: string, repo: string, prNumber: number, page: number, perPage: number,
): Promise<PRComment[]> {
  const qs = `page=${page}&per_page=${perPage}`;
  const { data } = await githubRequest<GitHubIssueComment[]>(
    host, 'GET', `/repos/${owner}/${repo}/issues/${prNumber}/comments?${qs}`,
  );
  return data.map((c) => ({
    id: c.id,
    commentType: 'issue' as const,
    user: c.user.login,
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    htmlUrl: c.html_url,
  }));
}

async function listReviewCommentsForPR(
  host: string, owner: string, repo: string, prNumber: number, page: number, perPage: number,
): Promise<PRComment[]> {
  const qs = `page=${page}&per_page=${perPage}`;
  const { data } = await githubRequest<GitHubReviewComment[]>(
    host, 'GET', `/repos/${owner}/${repo}/pulls/${prNumber}/comments?${qs}`,
  );
  return data.map((c) => ({
    id: c.id,
    commentType: 'review' as const,
    user: c.user.login,
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    htmlUrl: c.html_url,
    path: c.path,
    diffHunk: c.diff_hunk,
  }));
}

function mergePRComments(issueComments: PRComment[], reviewComments: PRComment[]): PRComment[] {
  return [...issueComments, ...reviewComments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export function createGithubPrCommentsTool(): ToolDefinition<PRCommentsInput> {
  return {
    name: 'github_pr_comments',
    description: 'Get comments on a specific pull request. Merges issue comments and review comments, sorted by creation time.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: `GitHub host (default: "${DEFAULT_HOST}")` },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        prNumber: { type: 'number', description: 'Pull request number' },
        includeIssueComments: { type: 'boolean', description: 'Include issue-style comments (default: true)' },
        includeReviewComments: { type: 'boolean', description: 'Include review comments (default: true)' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        perPage: { type: 'number', description: 'Items per page (default: 30, max: 100)' },
      },
      required: ['owner', 'repo', 'prNumber'],
    },
    async execute(input: PRCommentsInput): Promise<ToolExecutionResult> {
      const host = input.host ?? DEFAULT_HOST;
      const includeIssue = input.includeIssueComments ?? true;
      const includeReview = input.includeReviewComments ?? true;
      const page = input.page ?? 1;
      const perPage = Math.min(input.perPage ?? 30, 100);

      try {
        const [issueComments, reviewComments] = await Promise.all([
          includeIssue ? listIssueCommentsForPR(host, input.owner, input.repo, input.prNumber, page, perPage) : [],
          includeReview ? listReviewCommentsForPR(host, input.owner, input.repo, input.prNumber, page, perPage) : [],
        ]);
        const items = mergePRComments(issueComments, reviewComments);
        const result: GitHubResult<PRComment[]> = { ok: true, items };
        return { status: 'success', data: result as unknown as Record<string, unknown> };
      } catch (err) {
        const result = errorResult(err);
        return { status: 'error', data: result as unknown as Record<string, unknown> };
      }
    },
  };
}

// ─── Tool 3: github_list_issues ──────────────────────────

type ListIssuesInput = {
  host?: string;
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
};

type IssueItem = {
  number: number;
  title: string;
  state: string;
  user: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  commentCount: number;
};

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  comments: number;
  pull_request?: unknown;
}

async function listIssues(input: ListIssuesInput): Promise<GitHubResult<IssueItem[]>> {
  const host = input.host ?? DEFAULT_HOST;
  const state = input.state ?? 'open';
  const sort = input.sort ?? 'updated';
  const direction = input.direction ?? 'desc';
  const page = input.page ?? 1;
  const perPage = Math.min(input.perPage ?? 30, 100);

  try {
    const qs = `state=${state}&sort=${sort}&direction=${direction}&page=${page}&per_page=${perPage}`;
    const { data, rateLimit } = await githubRequest<GitHubIssue[]>(
      host, 'GET', `/repos/${input.owner}/${input.repo}/issues?${qs}`,
    );
    // Filter out pull requests (GitHub Issues API includes PRs)
    const items: IssueItem[] = data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        user: issue.user.login,
        labels: issue.labels.map((l) => l.name),
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        htmlUrl: issue.html_url,
        commentCount: issue.comments,
      }));
    return { ok: true, items, rateLimit };
  } catch (err) {
    return errorResult(err);
  }
}

export function createGithubListIssuesTool(): ToolDefinition<ListIssuesInput> {
  return {
    name: 'github_list_issues',
    description: 'List issues for a GitHub repository (excludes pull requests). Returns issue number, title, state, author, labels, dates, and comment count.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: `GitHub host (default: "${DEFAULT_HOST}")` },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter (default: "open")' },
        sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort field (default: "updated")' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: "desc")' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        perPage: { type: 'number', description: 'Items per page (default: 30, max: 100)' },
      },
      required: ['owner', 'repo'],
    },
    async execute(input: ListIssuesInput): Promise<ToolExecutionResult> {
      const result = await listIssues(input);
      return {
        status: result.ok ? 'success' : 'error',
        data: result as unknown as Record<string, unknown>,
      };
    },
  };
}

// ─── Tool 4: github_issue_comments ───────────────────────

type IssueCommentsInput = {
  host?: string;
  owner: string;
  repo: string;
  issueNumber: number;
  page?: number;
  perPage?: number;
};

type IssueComment = {
  id: number;
  user: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
};

async function listIssueComments(input: IssueCommentsInput): Promise<GitHubResult<IssueComment[]>> {
  const host = input.host ?? DEFAULT_HOST;
  const page = input.page ?? 1;
  const perPage = Math.min(input.perPage ?? 30, 100);

  try {
    const qs = `page=${page}&per_page=${perPage}`;
    const { data, rateLimit } = await githubRequest<GitHubIssueComment[]>(
      host, 'GET', `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}/comments?${qs}`,
    );
    const items: IssueComment[] = data.map((c) => ({
      id: c.id,
      user: c.user.login,
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      htmlUrl: c.html_url,
    }));
    return { ok: true, items, rateLimit };
  } catch (err) {
    return errorResult(err);
  }
}

export function createGithubIssueCommentsTool(): ToolDefinition<IssueCommentsInput> {
  return {
    name: 'github_issue_comments',
    description: 'Get comments on a specific issue. Returns comment id, author, body, dates, and URL.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: `GitHub host (default: "${DEFAULT_HOST}")` },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issueNumber: { type: 'number', description: 'Issue number' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        perPage: { type: 'number', description: 'Items per page (default: 30, max: 100)' },
      },
      required: ['owner', 'repo', 'issueNumber'],
    },
    async execute(input: IssueCommentsInput): Promise<ToolExecutionResult> {
      const result = await listIssueComments(input);
      return {
        status: result.ok ? 'success' : 'error',
        data: result as unknown as Record<string, unknown>,
      };
    },
  };
}

// ─── Convenience: create all 4 tools ─────────────────────

export function createGithubWatchTools(): ToolDefinition[] {
  return [
    createGithubListPrsTool(),
    createGithubPrCommentsTool(),
    createGithubListIssuesTool(),
    createGithubIssueCommentsTool(),
  ];
}
