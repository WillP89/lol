import { cookies } from 'next/headers';

/**
 * Server-side API helper — used only by the public Plan Card page, which is server-rendered
 * (see app/plans/[slug]/page.tsx) so it carries real OpenGraph/rich-preview metadata (brief
 * §16) when shared into WhatsApp/iMessage. Forwards the session cookie so a logged-in viewer
 * still sees a personalised view even though the page itself requires no auth.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export async function apiFetchServer<T>(path: string, options: RequestInit = {}): Promise<{ status: number; body: T }> {
  const cookieStore = cookies();
  const cookieHeader = cookieStore.toString();

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });

  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}
