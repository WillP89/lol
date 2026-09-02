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
  crewId,
  crewName,
}: {
  slug: string;
  initialPulse: Pulse;
  isAuthenticated: boolean;
  crewId: string;
  crewName: string;
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

  const inPct = pulse.totalMembers ? Math.round((pulse.inCount / pulse.totalMembers) * 100) : 0;

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
      {/* Real, reported feedback: this used to be a row of tiny 18px blocks — technically
          legible, but it read as a form-field checklist, not a live social signal. A big stat
          plus a real gradient-filled bar (the same brand→pop gradient the rest of the product's
          "momentum" moments already use) makes "who's actually in" the thing your eye lands on
          first, the way it should on the page that exists specifically to answer that question. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span className="v2-display" style={{ fontSize: 34, lineHeight: 1 }}>{pulse.inCount}</span>
        <span className="v2-muted" style={{ fontSize: 15, fontWeight: 700 }}>/{pulse.totalMembers} are in</span>
        {pulse.status === 'READY' && (
          <span style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: 'var(--v2-green)', padding: '4px 10px', borderRadius: 100, marginLeft: 2 }}>
            Happening
          </span>
        )}
      </div>
      <div style={{ height: 9, borderRadius: 100, background: 'var(--v2-bg-deep)', overflow: 'hidden', marginBottom: 22 }}>
        <div
          style={{
            height: '100%', width: `${Math.max(inPct, pulse.inCount > 0 ? 6 : 0)}%`,
            background: 'linear-gradient(90deg, var(--v2-brand), var(--v2-pop))', borderRadius: 100,
            transition: 'width 0.4s ease',
          }}
        />
      </div>

      {pulse.status === 'READY' || pulse.status === 'LOCKED' || pulse.status === 'BOOKED' ? (
        <Link href={`/plans/${slug}/booking`} className="v2-btn v2-btn-brand v2-tap-feedback" style={{ width: '100%' }}>
          {/* The booking page itself decides what's actually true (manual plan, sample data,
              real booking, already booked) — this link just needs a label that's never wrong.
              "Book for the Crew" was a lie for a READY-but-not-yet-locked plan; "See the plan"
              is accurate at every stage. */}
          {pulse.status === 'BOOKED' ? 'View booking' : 'See the plan →'}
        </Link>
      ) : voted ? (
        // A flat inset box, not another nested `.v2-card` — the page itself already wraps this
        // whole form in one card; stacking a second card treatment inside it just doubles the
        // border/shadow for no reason. Real, reported dead end this whole block still fixes: a
        // response used to land here and just stop — "Thanks, you're in the loop" with nowhere
        // to go. Every response needs a next state: an already-signed-in member goes straight
        // back to the conversation their response just changed; someone who responded from an
        // email link (no account yet) gets the honest next step for THEM, not a dead button.
        <div style={{ background: 'var(--v2-bg-deep)', borderRadius: 16, padding: '16px 18px' }}>
          <p style={{ margin: 0, marginBottom: isAuthenticated || devMagicLinkUrl ? 12 : 0, fontWeight: 600 }}>
            Thanks — {crewName} can see your response.
          </p>
          {isAuthenticated ? (
            <Link href={`/crews/${crewId}`} className="v2-btn v2-btn-brand v2-tap-feedback" style={{ width: '100%' }}>
              Back to {crewName} →
            </Link>
          ) : devMagicLinkUrl ? (
            <a className="v2-btn v2-btn-brand v2-tap-feedback" style={{ width: '100%' }} href={devMagicLinkUrl}>
              Join the conversation →
            </a>
          ) : null}
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
          <button className="v2-btn v2-btn-brand v2-tap-feedback" disabled={submitting} onClick={() => vote('in')} style={{ width: '100%', marginBottom: 8, fontSize: 15.5, fontWeight: 800, padding: '16px 18px' }}>
            {submitting ? '…' : "I'm in"}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="v2-btn v2-btn-ghost v2-tap-feedback" disabled={submitting} onClick={() => vote('maybe')} style={{ flex: 1 }}>
              Maybe
            </button>
            <button className="v2-btn v2-btn-ghost v2-tap-feedback" disabled={submitting} onClick={() => vote('out')} style={{ flex: 1, color: 'var(--v2-ink-muted)' }}>
              Not for me
            </button>
          </div>
          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginTop: 10 }}>{error}</div>}
        </>
      )}
    </div>
  );
}
