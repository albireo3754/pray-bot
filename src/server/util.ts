export interface ApiResponse<T = unknown> {
  status: 'success' | 'error';
  data?: T;
  error?: string;
  message?: string;
}

export function jsonResponse<T>(
  body: ApiResponse<T>,
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}
