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

  return (
    <div>
      <div className="pulse-flames">
        {flames.map((on, i) => (
          <div key={i} className={`pulse-flame ${on ? 'on' : ''}`} />
        ))}
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>
        {pulse.inCount}/{pulse.totalMembers} are in
        {pulse.status === 'READY' && ' — this one’s happening'}
      </p>

      {pulse.status === 'READY' || pulse.status === 'BOOKED' ? (
        <Link href={`/plans/${slug}/booking`} className="btn btn-primary">
          {pulse.status === 'BOOKED' ? 'View booking' : 'Book for the Crew'}
        </Link>
      ) : voted ? (
        <div className="card">
          <p>Thanks — you&rsquo;re in the loop.</p>
          {devMagicLinkUrl && (
            <a className="btn" style={{ marginTop: 10 }} href={devMagicLinkUrl}>
              Continue on Plot →
            </a>
          )}
        </div>
      ) : (
        <>
          {!isAuthenticated && (
            <input
              className="field"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ marginBottom: 10 }}
            />
          )}
          <button className="btn btn-primary" disabled={submitting} onClick={() => vote('in')} style={{ marginBottom: 8, fontSize: 15, padding: '15px 18px' }}>
            {submitting ? '…' : "I'm in"}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={submitting} onClick={() => vote('maybe')} style={{ flex: 1 }}>
              Maybe
            </button>
            <button className="btn btn-ghost" disabled={submitting} onClick={() => vote('out')} style={{ flex: 1 }}>
              Not for me
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}
