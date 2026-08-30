'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { categoryStyle } from '@/lib/categoryStyle';

interface PlanDetail {
  plan: {
    id: string;
    title: string;
    status: string;
    crewId: string;
    experience: { name: string; category: string; priceMinMinor: number | null; currency: string; venue: { name: string } | null } | null;
    votes: { userId: string; vote: string }[];
    members: { user: { id: string; displayName: string | null; email: string } }[];
    bookings: { id: string; status: string; externalUrl: string | null }[];
  };
}

export default function BookingPage() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<PlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<{ bookingId: string; externalUrl: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [rewindRating, setRewindRating] = useState<string | null>(null);
  const [rewindSubmitting, setRewindSubmitting] = useState(false);

  function load() {
    // Resolve the public slug to a plan id first, then load the authenticated (fuller) view —
    // this is the same "public link, authenticated action" shape as voting.
    api
      .get<{ plan: { id: string } }>(`/plans/public/${slug}`)
      .then((res) => api.get<PlanDetail>(`/plans/${res.plan.id}`))
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load plan.'));
  }

  useEffect(load, [slug]);

  const inVoterIds = data?.plan.votes.filter((v) => v.vote === 'IN').map((v) => v.userId) ?? [];
  const existingBooking = data?.plan.bookings[0];

  async function startBooking() {
    if (!data) return;
    setBusy(true);
    try {
      const res = await api.post<{ bookingId: string; externalUrl: string }>(`/plans/${data.plan.id}/bookings`, {
        participantUserIds: inVoterIds,
      });
      setBooking(res);
      window.open(res.externalUrl, '_blank');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start booking.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmBooking() {
    if (!booking) return;
    setBusy(true);
    try {
      await api.post(`/bookings/${booking.bookingId}/confirm`);
      setConfirmed(true);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm booking.');
    } finally {
      setBusy(false);
    }
  }

  // Nothing anywhere in the product ever transitioned a Plan from BOOKED to COMPLETED — the
  // fully-built Rewind feature (POST /plans/:id/rewind) was consequently unreachable end to
  // end. This is the missing link: once the Crew has actually been, anyone can mark it done,
  // which unlocks the one-tap "would we do this again?" prompt.
  async function markAsDone() {
    if (!data) return;
    setMarkingDone(true);
    try {
      await api.post(`/plans/${data.plan.id}/complete`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark as done.');
    } finally {
      setMarkingDone(false);
    }
  }

  async function submitRewind(rating: 'love' | 'like' | 'meh' | 'no') {
    if (!data) return;
    setRewindSubmitting(true);
    try {
      await api.post(`/plans/${data.plan.id}/rewind`, { rating, reasons: [] });
      setRewindRating(rating);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit — try again.');
    } finally {
      setRewindSubmitting(false);
    }
  }

  if (!data) {
    return (
      <div className="page">
        {error ? (
          <div className="error">{error}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 20 }}>
            <div className="art-block" style={{ background: 'var(--ink-surface-2)', height: 88, margin: '0 -20px', opacity: 0.6 }} />
            <div className="card" style={{ height: 70, opacity: 0.5 }} />
          </div>
        )}
      </div>
    );
  }

  const { plan } = data;
  const isBooked = plan.status === 'BOOKED' || Boolean(existingBooking && existingBooking.status === 'CONFIRMED');
  const style = categoryStyle(plan.experience?.category);

  return (
    <>
      <nav className="nav">
        <Link href={`/crews/${plan.crewId}`} className="muted" style={{ fontSize: 13 }}>
          ← Crew
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page" style={{ paddingTop: 0 }}>
        <div className="art-block" style={{ background: style.bg, height: 88, fontSize: 30, borderRadius: 0, margin: '0 -20px 20px' }}>
          {style.emoji}
        </div>

        <div className="eyebrow">Book for the Crew</div>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>{plan.title}</h1>
        {plan.experience?.venue && <p className="muted" style={{ marginBottom: 20 }}>{plan.experience.venue.name}</p>}

        <div className="banner-card">
          <div className="muted" style={{ marginBottom: 4 }}>
            {inVoterIds.length} of {plan.members.length} paying now
          </div>
          {plan.experience?.priceMinMinor !== null && plan.experience?.priceMinMinor !== undefined && (
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 22, color: 'var(--ink-gold)' }}>
              £{((plan.experience.priceMinMinor * inVoterIds.length) / 100).toFixed(2)} total
            </div>
          )}
        </div>

        {plan.status === 'COMPLETED' ? (
          <div className="banner-card" style={{ textAlign: 'center' }}>
            {rewindRating ? (
              <>
                <div style={{ fontSize: 30, marginBottom: 8 }}>✓</div>
                <p style={{ margin: 0 }}>Thanks — noted for next time.</p>
              </>
            ) : (
              <>
                <div className="eyebrow">Rewind</div>
                <p style={{ margin: '4px 0 14px', fontFamily: 'Fraunces, serif', fontSize: 17 }}>Would the Crew do this again?</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  {([
                    ['love', '😍', 'Love it'],
                    ['like', '🙂', 'Liked it'],
                    ['meh', '😐', 'Meh'],
                    ['no', '👎', 'Not for us'],
                  ] as const).map(([value, emoji, label]) => (
                    <button
                      key={value}
                      onClick={() => submitRewind(value)}
                      disabled={rewindSubmitting}
                      className="chip"
                      style={{ flexDirection: 'column', gap: 4, padding: '10px 8px', flex: 1 }}
                      aria-label={label}
                    >
                      <span style={{ fontSize: 18 }}>{emoji}</span>
                      <span style={{ fontSize: 9 }}>{label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : isBooked ? (
          <>
            <div className="card" style={{ borderColor: 'var(--ink-moss)' }}>
              <div className="eyebrow" style={{ color: 'var(--ink-moss)' }}>
                ✓ Booked
              </div>
              <p style={{ margin: 0 }}>The Crew is going. Added to everyone&rsquo;s calendar.</p>
            </div>
            <button className="btn btn-ghost" onClick={markAsDone} disabled={markingDone}>
              {markingDone ? 'Marking…' : 'Already happened? Mark as done →'}
            </button>
          </>
        ) : !booking ? (
          <button className="btn btn-primary" onClick={startBooking} disabled={busy || inVoterIds.length === 0}>
            {busy ? 'Starting…' : 'Book for the Crew →'}
          </button>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 12 }}>
              We opened the provider&rsquo;s checkout in a new tab. Come back here once you&rsquo;ve completed it.
            </p>
            <button className="btn btn-primary" onClick={confirmBooking} disabled={busy || confirmed}>
              {confirmed ? 'Confirmed ✓' : busy ? 'Confirming…' : "I've completed checkout"}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}
