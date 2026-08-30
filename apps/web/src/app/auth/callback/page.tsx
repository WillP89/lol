'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
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
