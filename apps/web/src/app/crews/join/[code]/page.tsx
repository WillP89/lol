'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export default function JoinCrewPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function join() {
    setJoining(true);
    try {
      const res = await api.post<{ crew: { id: string } }>('/crews/join', { inviteCode: code });
      router.push(`/crews/${res.crew.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push(`/auth?next=/crews/join/${code}`);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not join Crew.');
      setJoining(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: 60, textAlign: 'center' }}>
      <div className="eyebrow">You&rsquo;re invited</div>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Join this Crew on Plot</h1>
      <button className="btn btn-primary" onClick={join} disabled={joining}>
        {joining ? 'Joining…' : 'Join Crew'}
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
