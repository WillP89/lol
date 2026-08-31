'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface Pulse {
  inCount: number;
  maybeCount: number;
  outCount: number;
  totalMembers: number;
  level: number;
  status: string;
}

export function VoteForm({
  slug,
  initialPulse,
  isAuthenticated,
}: {
  slug: string;
  initialPulse: Pulse;
  isAuthenticated: boolean;
}) {
  const [pulse, setPulse] = useState(initialPulse);
  const [email, setEmail] = useState('');
  const [voted, setVoted] = useState(false);
  const [devMagicLinkUrl, setDevMagicLinkUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function vote(choice: 'in' | 'maybe' | 'out') {
    if (!isAuthenticated && !email) {
      setError('Enter your email to respond.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { vote: choice };
      if (!isAuthenticated) body.email = email;
      const res = await api.post<{ pulse: Pulse; devMagicLinkUrl?: string }>(`/plans/public/${slug}/vote`, body);
      setPulse(res.pulse);
      setVoted(true);
      if (res.devMagicLinkUrl) setDevMagicLinkUrl(res.devMagicLinkUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit your response.');
    } finally {
      setSubmitting(false);
    }
  }

  const flames = Array.from({ length: pulse.totalMembers || 1 }, (_, i) => i < pulse.inCount);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '13px 16px',
    borderRadius: 14,
    border: 'none',
    outline: 'none',
    background: 'var(--v2-bg-deep)',
    fontSize: 14.5,
    fontFamily: 'inherit',
    color: 'var(--v2-ink)',
    marginBottom: 10,
  };

  return (
    <div>
      <div className="v2-pulse-flames">
        {flames.map((on, i) => (
          <div key={i} className={`v2-pulse-flame ${on ? 'on' : ''}`} />
        ))}
      </div>
      <p className="v2-muted" style={{ marginBottom: 18, fontSize: 13.5 }}>
        {pulse.inCount}/{pulse.totalMembers} are in
        {pulse.status === 'READY' && ' — this one’s happening'}
      </p>

      {pulse.status === 'READY' || pulse.status === 'LOCKED' || pulse.status === 'BOOKED' ? (
        <Link href={`/plans/${slug}/booking`} className="v2-btn v2-btn-brand" style={{ width: '100%' }}>
          {/* The booking page itself decides what's actually true (manual plan, sample data,
              real booking, already booked) — this link just needs a label that's never wrong.
              "Book for the Crew" was a lie for a READY-but-not-yet-locked plan; "See the plan"
              is accurate at every stage. */}
          {pulse.status === 'BOOKED' ? 'View booking' : 'See the plan →'}
        </Link>
      ) : voted ? (
        <div className="v2-card" style={{ padding: '16px 18px' }}>
          <p style={{ margin: 0 }}>Thanks — you&rsquo;re in the loop.</p>
          {devMagicLinkUrl && (
            <a className="v2-btn v2-btn-brand" style={{ marginTop: 12 }} href={devMagicLinkUrl}>
              Continue on Plot →
            </a>
          )}
        </div>
      ) : (
        <>
          {!isAuthenticated && (
            <input
              style={inputStyle}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          <button className="v2-btn v2-btn-brand" disabled={submitting} onClick={() => vote('in')} style={{ width: '100%', marginBottom: 8, fontSize: 15, padding: '15px 18px' }}>
            {submitting ? '…' : "I'm in"}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="v2-btn v2-btn-ghost" disabled={submitting} onClick={() => vote('maybe')} style={{ flex: 1 }}>
              Maybe
            </button>
            <button className="v2-btn v2-btn-ghost" disabled={submitting} onClick={() => vote('out')} style={{ flex: 1, color: 'var(--v2-ink-muted)' }}>
              Not for me
            </button>
          </div>
          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginTop: 10 }}>{error}</div>}
        </>
      )}
    </div>
  );
}
