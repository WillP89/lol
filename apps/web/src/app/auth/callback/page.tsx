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
    if (!token) {
      setError('Missing token.');
      return;
    }
    api
      .post('/auth/callback', { token })
      .then(() => router.replace('/onboarding'))
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
