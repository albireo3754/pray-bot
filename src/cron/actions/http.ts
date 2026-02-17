import type { ActionHandler } from './index.ts';

export function createHttpAction(): ActionHandler {
  return async (config) => {
    const url = String(config.url ?? '');
    if (!url) {
      return { status: 'error', error: 'No URL provided' };
    }

    const method = String(config.method ?? 'GET').toUpperCase();
    const headers = (config.headers as Record<string, string>) ?? {};
    const body = config.body;

    try {
      const init: RequestInit = { method, headers };
      if (body && method !== 'GET') {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        if (!headers['content-type'] && !headers['Content-Type']) {
          (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
      }

      const response = await fetch(url, init);
      const text = await response.text();
      const summary = `${response.status} ${response.statusText}`.trim();

      if (!response.ok) {
        return {
          status: 'error',
          error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
          summary,
        };
      }

      return { status: 'ok', summary };
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
