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
        // An invite link (or anywhere else that sent you through sign-in) wins — go back to
        // exactly where you meant to go, e.g. /crews/join/abc123, instead of always landing
        // on /onboarding regardless of intent.
        if (next) {
          router.replace(next);
          return;
        }
        // Otherwise: returning users with a profile already built skip straight past
        // onboarding instead of being run through it again on every sign-in.
        try {
          const { user } = await api.get<{ user: { tasteProfile: unknown } }>('/users/me');
          router.replace(user.tasteProfile ? '/crews' : '/onboarding');
        } catch {
          router.replace('/onboarding');
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
