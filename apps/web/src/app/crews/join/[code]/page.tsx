'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

const AVATAR_COLORS = ['#ff3d5a', '#5b3df0', '#1c7a52', '#ffb238', '#ff6fae'];

interface Preview {
  name: string;
  memberCount: number;
  memberInitials: string[];
}

/**
 * The invite moment — Plot's most important growth surface (brief). Shows who/what you're
 * joining BEFORE forcing sign-in, not a generic login wall: this is the "[avatars] Will invited
 * you to WEEKEND CREW — 6 people are already here" screen from the brief, backed by the public
 * `/crews/preview/:code` endpoint (name + member count + initials only — never message content,
 * never emails). Tapping "Join Crew" is the one thing that requires auth; getting there and
 * back preserves this invite code via `next`, so authentication never loses the invite's
 * context. See docs/DECISIONS.md#invite-preview.
 */
export default function JoinCrewPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null | 'error'>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    api
      .get<{ preview: Preview }>(`/crews/preview/${code}`)
      .then((res) => setPreview(res.preview))
      .catch(() => setPreview('error'));
  }, [code]);

  // Auto-join once we land back here already signed in — the case right after finishing auth
  // (and onboarding, for a brand-new user) via this invite's own `next`. Someone arriving here
  // for the first time, not yet signed in, still sees the preview and taps "Join Crew"
  // themselves; this only fires for the return trip, so the brief's "they automatically join,
  // no second tap" holds without skipping the pre-auth preview for a first-time visitor.
  useEffect(() => {
    api
      .get<{ user: { id: string } }>('/users/me')
      .then(() => join())
      .catch(() => {});
  }, [code]);

  const join = useCallback(async () => {
    setJoining(true);
    setError(null);
    try {
      const res = await api.post<{ crew: { id: string; name: string } }>('/crews/join', { inviteCode: code });
      setJoined(true);
      setTimeout(() => router.push(`/crews/${res.crew.id}`), 600);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push(`/auth?next=/crews/join/${code}`);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not join Crew.');
      setJoining(false);
    }
  }, [code, router]);

  return (
    <div className="v2" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div
        aria-hidden
        style={{
          position: 'fixed', inset: '-20%', zIndex: 0,
          background: 'radial-gradient(50% 40% at 50% 0%, rgba(255,61,90,0.14), transparent 60%), radial-gradient(55% 45% at 50% 100%, rgba(91,61,240,0.12), transparent 62%)',
        }}
      />
      <div className="v2-page" style={{ paddingTop: 0, paddingBottom: 0, textAlign: 'center', position: 'relative', zIndex: 1 }}>
        {preview === null && (
          <div style={{ height: 200, borderRadius: 24, background: 'var(--v2-bg-deep)' }} />
        )}

        {preview === 'error' && (
          <div className="fade-up">
            <div style={{ fontSize: 40, marginBottom: 14 }}>🔗</div>
            <h1 className="v2-display" style={{ fontSize: 22, marginBottom: 8 }}>That invite has expired</h1>
            <p className="v2-muted">Ask whoever sent it for a fresh link.</p>
          </div>
        )}

        {preview && preview !== 'error' && !joined && (
          <div className="fade-up">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
              {preview.memberInitials.slice(0, 5).map((initial, i) => (
                <div
                  key={i}
                  style={{
                    width: 52, height: 52, borderRadius: '50%', marginLeft: i === 0 ? 0 : -14,
                    background: AVATAR_COLORS[i % AVATAR_COLORS.length], color: '#fff', fontWeight: 800, fontSize: 18,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', border: '3px solid var(--v2-bg)',
                  }}
                >
                  {initial}
                </div>
              ))}
            </div>
            <div className="v2-eyebrow" style={{ marginBottom: 6 }}>You&rsquo;re invited to</div>
            <h1 className="v2-display" style={{ fontSize: 30, marginBottom: 10 }}>{preview.name}</h1>
            <p className="v2-muted" style={{ marginBottom: 30 }}>
              {preview.memberCount} {preview.memberCount === 1 ? 'person is' : 'people are'} already here.
            </p>
            <button className="v2-btn v2-btn-brand" onClick={join} disabled={joining} style={{ width: '100%', padding: '16px 22px', fontSize: 15.5 }}>
              {joining ? 'Joining…' : 'Join Crew'}
            </button>
            {error && <div style={{ color: 'var(--v2-brand)', fontSize: 13, marginTop: 12 }}>{error}</div>}
          </div>
        )}

        {joined && (
          <div className="fade-up">
            <div style={{ fontSize: 44, marginBottom: 10 }}>🎉</div>
            <h1 className="v2-display" style={{ fontSize: 22 }}>You&rsquo;re in — taking you there…</h1>
          </div>
        )}
      </div>
    </div>
  );
}
