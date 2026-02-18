import fs from 'node:fs';

export const token = process.env.GITHUB_TOKEN;
export const eventPath = process.env.GITHUB_EVENT_PATH;
export const repo = process.env.GITHUB_REPOSITORY;

if (!token) throw new Error('GITHUB_TOKEN is required');
if (!repo) throw new Error('GITHUB_REPOSITORY is required');
if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');

export const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));

export async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} ${path}: ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export async function postIssueComment(issueNumber, body) {
  return gh(`/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function fetchAllPrFiles(prNumber) {
  const out = [];
  let page = 1;
  while (true) {
    const chunk = await gh(`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    out.push(...chunk);
    if (chunk.length < 100) break;
    page += 1;
  }
  return out;
}

export async function openaiJson({ system, user, model = process.env.OPENAI_MODEL || 'gpt-4.1-mini' }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI response missing content');

  return JSON.parse(content);
}
