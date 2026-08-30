'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface PlanDetail {
  plan: {
    id: string;
    title: string;
    status: string;
    crewId: string;
    experience: { name: string; priceMinMinor: number | null; currency: string; venue: { name: string } | null } | null;
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

  if (!data) return <div className="page">{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</div>;

  const { plan } = data;
  const isBooked = plan.status === 'BOOKED' || Boolean(existingBooking && existingBooking.status === 'CONFIRMED');

  return (
    <>
      <nav className="nav">
        <Link href={`/crews/${plan.crewId}`} className="muted" style={{ fontSize: 13 }}>
          ← Crew
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page">
        <div className="eyebrow">Book for the Crew</div>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>{plan.title}</h1>
        {plan.experience?.venue && <p className="muted" style={{ marginBottom: 20 }}>{plan.experience.venue.name}</p>}

        <div className="card">
          <div className="muted" style={{ marginBottom: 4 }}>
            {inVoterIds.length} of {plan.members.length} paying now
          </div>
          {plan.experience?.priceMinMinor !== null && plan.experience?.priceMinMinor !== undefined && (
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 20 }}>
              £{((plan.experience.priceMinMinor * inVoterIds.length) / 100).toFixed(2)} total
            </div>
          )}
        </div>

        {isBooked ? (
          <div className="card" style={{ borderColor: 'var(--ink-moss)' }}>
            <div className="eyebrow" style={{ color: 'var(--ink-moss)' }}>
              Booked
            </div>
            <p>The Crew is going. Added to everyone&rsquo;s calendar.</p>
          </div>
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
