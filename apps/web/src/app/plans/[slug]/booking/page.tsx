'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { v2Art } from '@/lib/v2Art';

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
  // Whether a real ticketing provider is connected at all (a deployment-wide fact, not a
  // per-plan one — see routes/plans.ts's own comment). Without this, tapping "Book" on a
  // sample-data plan silently opened a dead `.invalid` tab with zero explanation — this is what
  // lets the page tell the difference and say so honestly instead.
  dataSource: 'live' | 'mock';
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
      <div className="v2">
        <div className="v2-page" style={{ paddingTop: 28 }}>
          {error ? (
            <div style={{ color: 'var(--v2-error)' }}>{error}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ height: 88, borderRadius: 'var(--v2-r-lg)', background: 'var(--v2-bg-deep)' }} />
              <div style={{ height: 70, borderRadius: 'var(--v2-r-lg)', background: 'var(--v2-bg-deep)', opacity: 0.6 }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const { plan, dataSource } = data;
  const reallyBooked = plan.status === 'BOOKED' || Boolean(existingBooking && existingBooking.status === 'CONFIRMED');
  // Real fix for the actual bug reported: Lock It In used to set status straight to BOOKED,
  // which made this page claim "✓ Booked — Added to everyone's calendar" for a plan nobody had
  // paid for or booked anywhere, AND made real ticketed booking unreachable (see
  // docs/DECISIONS.md#booking-status-split). Now three genuinely different situations get three
  // genuinely different, honest screens:
  const hasRealTicket = Boolean(plan.experience) && dataSource === 'live';
  const isManualOrSample = !reallyBooked && !hasRealTicket;

  return (
    <div className="v2">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 0' }}>
        <Link href={`/crews/${plan.crewId}`} className="v2-muted" style={{ fontSize: 13, fontWeight: 700 }}>
          ← Crew
        </Link>
      </div>
      <div className="v2-page" style={{ paddingTop: 12, maxWidth: 480 }}>
        <div style={{ height: 100, margin: '0 -20px 22px', background: v2Art(null, plan.experience?.category), borderRadius: 0 }} />

        <div className="v2-eyebrow">{hasRealTicket && !reallyBooked ? 'Book for the Crew' : 'The plan'}</div>
        <h1 className="v2-display" style={{ fontSize: 24, marginBottom: 8 }}>{plan.title}</h1>
        {plan.experience?.venue && <p className="v2-muted" style={{ marginBottom: 20, fontSize: 14 }}>{plan.experience.venue.name}</p>}

        <div className="v2-card" style={{ padding: '16px 18px', marginBottom: 16 }}>
          <div className="v2-muted" style={{ marginBottom: 4, fontSize: 13 }}>
            {inVoterIds.length} of {plan.members.length} {hasRealTicket ? 'paying now' : 'going'}
          </div>
          {/* The price/total framing only makes sense when there's a real transaction to total
              up — showing "£140 total" above a plan nobody is actually being charged for reads
              as a lie the product is telling, not a feature. */}
          {hasRealTicket && plan.experience?.priceMinMinor !== null && plan.experience?.priceMinMinor !== undefined && (
            <div className="v2-display" style={{ fontSize: 22, color: 'var(--v2-brand)' }}>
              £{((plan.experience.priceMinMinor * inVoterIds.length) / 100).toFixed(2)} total
            </div>
          )}
        </div>

        {plan.status === 'COMPLETED' ? (
          <div className="v2-card" style={{ padding: '20px 18px', textAlign: 'center' }}>
            {rewindRating ? (
              <>
                <div style={{ fontSize: 30, marginBottom: 8 }}>✓</div>
                <p style={{ margin: 0 }}>Thanks — noted for next time.</p>
              </>
            ) : (
              <>
                <div className="v2-eyebrow">Rewind</div>
                <p className="v2-display" style={{ margin: '4px 0 14px', fontSize: 17 }}>Would the Crew do this again?</p>
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
                      style={{
                        display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 8px', flex: 1,
                        border: 'none', borderRadius: 14, background: 'var(--v2-bg-deep)', cursor: 'pointer',
                      }}
                      aria-label={label}
                    >
                      <span style={{ fontSize: 18 }}>{emoji}</span>
                      <span style={{ fontSize: 9, fontWeight: 700 }}>{label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : reallyBooked ? (
          <>
            <div className="v2-card" style={{ padding: '16px 18px', marginBottom: 10 }}>
              <div className="v2-eyebrow" style={{ color: 'var(--v2-green)' }}>✓ Booked</div>
              <p style={{ margin: '4px 0 0' }}>The Crew&rsquo;s tickets are confirmed.</p>
            </div>
            <button className="v2-btn v2-btn-ghost" style={{ width: '100%' }} onClick={markAsDone} disabled={markingDone}>
              {markingDone ? 'Marking…' : 'Already happened? Mark as done →'}
            </button>
          </>
        ) : isManualOrSample ? (
          !plan.experience ? (
            // A manual plan ("Pub Saturday") — this is the CORRECT, final state, not a lesser
            // one. There's genuinely nothing to book; the Crew already decided.
            <div className="v2-card" style={{ padding: '20px 18px', textAlign: 'center' }}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>✓</div>
              <p className="v2-display" style={{ margin: '0 0 4px', fontSize: 16 }}>You&rsquo;re confirmed</p>
              <p className="v2-muted" style={{ margin: 0, fontSize: 13.5 }}>No ticket needed for this one — just show up.</p>
            </div>
          ) : (
            // A real Experience, but Plot has no live ticketing provider connected — the
            // honest reason "Book" used to silently open a dead `.invalid` tab. Say so, rather
            // than pretending a real checkout exists.
            <div className="v2-card" style={{ padding: '18px 18px', textAlign: 'left' }}>
              <div className="v2-eyebrow" style={{ marginBottom: 6 }}>Sample event</div>
              <p style={{ margin: '0 0 4px', fontSize: 14, lineHeight: 1.5 }}>
                This is demo data — Plot isn&rsquo;t connected to a real ticket provider yet, so there&rsquo;s no real checkout to send you to.
              </p>
              <p className="v2-muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                Once a live provider (Ticketmaster/Eventbrite) is connected, this becomes a real &ldquo;Book for the Crew&rdquo; button.
              </p>
            </div>
          )
        ) : !booking ? (
          <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={startBooking} disabled={busy || inVoterIds.length === 0}>
            {busy ? 'Starting…' : 'Book for the Crew →'}
          </button>
        ) : (
          <>
            <p className="v2-muted" style={{ marginBottom: 12, fontSize: 13.5 }}>
              We opened the provider&rsquo;s checkout in a new tab. Come back here once you&rsquo;ve completed it.
            </p>
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={confirmBooking} disabled={busy || confirmed}>
              {confirmed ? 'Confirmed ✓' : busy ? 'Confirming…' : "I've completed checkout"}
            </button>
          </>
        )}
        {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginTop: 12 }}>{error}</div>}
      </div>
    </div>
  );
}
