/**
 * Client-side API helper. Talks to `/api/*`, which next.config.js rewrites to the Fastify
 * backend — same-origin from the browser's point of view, so the session cookie just works
 * with no CORS or cross-site cookie configuration to get right.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: 'include',
    // Only send Content-Type: application/json when there's actually a body — Fastify's body
    // parser sees that header as a promise of JSON and errors ("Body cannot be empty when
    // content-type is set to 'application/json'") on the many POST calls that take no payload
    // (e.g. /crews/:id/find-us-something).
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(body.message ?? `Request to ${path} failed`, res.status, body.error);
  }
  return body as T;
}

/** A real binary upload (avatar/Crew image) — deliberately bypasses apiFetch's JSON handling,
 * since a multipart body must NOT get a `Content-Type: application/json` header. */
async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.message ?? `Upload to ${path} failed`, res.status, body.error);
  return body as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, data?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string, data?: unknown) =>
    apiFetch<T>(path, { method: 'DELETE', body: data ? JSON.stringify(data) : undefined }),
  upload: apiUpload,
};
