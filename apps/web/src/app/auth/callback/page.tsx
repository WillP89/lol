'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

// The magic-link token is single-use — this page's effect can genuinely run more than once for
// the exact same token: React 18 dev-mode StrictMode double-invokes effects, AND clicking a
// plain `<a>` into this route from elsewhere in the app (e.g. the "sent" state on /auth) is a
// Next.js App Router client-side transition that mounts a fresh component instance, so a
// component-scoped guard (useRef/useState) doesn't survive it — a *second*, genuinely new
// instance still fires its own first call. Only something that survives across mounts within
// the same page load works: a module-level record of tokens already requested. The first call
// consumes the token; without this, any repeat call legitimately 401s ("already used") and the
// whole sign-in stalls here. See docs/DECISIONS.md#auth-callback-dedup.
const requestedTokens = new Set<string>();

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (token) {
      if (requestedTokens.has(token)) return;
      requestedTokens.add(token);
    }
    const next = params.get('next');
    if (!token) {
      setError('Missing token.');
      return;
    }
    api
      .post('/auth/callback', { token })
      .then(async () => {
        const destination = next || '/home';
        // A brand-new user (no profile yet) always completes onboarding first — including
        // when they arrived via an invite link. Onboarding itself carries `next` through
        // (?next=/crews/join/abc123) so finishing it lands them exactly back on the invite,
        // not on the generic Home feed. A returning user with a profile already skips
        // straight to `destination` — the invite, or Home by default.
        try {
          const { user } = await api.get<{ user: { tasteProfile: unknown } }>('/users/me');
          router.replace(user.tasteProfile ? destination : `/onboarding?next=${encodeURIComponent(destination)}`);
        } catch {
          router.replace(`/onboarding?next=${encodeURIComponent(destination)}`);
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Sign-in failed.'));
  }, [params, router]);

  return (
    <>
      {error ? (
        <>
          <div className="error">{error}</div>
          <a className="btn" href="/auth" style={{ marginTop: 16 }}>
            Try again
          </a>
        </>
      ) : (
        <p className="muted">Signing you in…</p>
      )}
    </>
  );
}

export default function AuthCallbackPage() {
  return (
    <div className="page" style={{ paddingTop: 60 }}>
      <Suspense fallback={<p className="muted">Signing you in…</p>}>
        <CallbackInner />
      </Suspense>
    </div>
  );
}
