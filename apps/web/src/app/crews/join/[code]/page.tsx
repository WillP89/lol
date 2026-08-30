'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export default function JoinCrewPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  const join = useCallback(async () => {
    setJoining(true);
    setError(null);
    try {
      const res = await api.post<{ crew: { id: string; name: string } }>('/crews/join', { inviteCode: code });
      setJoined(true);
      // Brief confirmation beat before landing in the Crew — long enough to register "you're
      // in", short enough not to feel like a delay. Auto-navigating with zero pause reads as a
      // flash of nothing; a modal "Continue" tap is one more step than this needs.
      setTimeout(() => router.push(`/crews/${res.crew.id}`), 500);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push(`/auth?next=/crews/join/${code}`);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not join Crew.');
      setJoining(false);
    }
  }, [code, router]);

  // Auto-join the moment this page can act — an invite should take at most one tap (signing
  // in, if that's needed at all) to land you in the Crew, not a second manual confirmation.
  useEffect(() => {
    join();
  }, []);

  return (
    <div className="page" style={{ paddingTop: 80, textAlign: 'center' }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 28, justifyContent: 'center' }}>
        Plot<span>·</span>
      </div>
      <div className="eyebrow">You&rsquo;re invited</div>
      {joined ? (
        <div className="fade-up">
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
          <h1 style={{ fontSize: 22 }}>You&rsquo;re in — taking you there…</h1>
        </div>
      ) : error ? (
        <>
          <h1 style={{ fontSize: 22, marginBottom: 16 }}>Couldn&rsquo;t join this Crew</h1>
          <div className="error" style={{ marginBottom: 16 }}>{error}</div>
          <button className="btn btn-primary" onClick={join} disabled={joining}>
            {joining ? 'Trying again…' : 'Try again'}
          </button>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Joining your Crew…</h1>
          <p className="muted">One second.</p>
        </>
      )}
    </div>
  );
}
