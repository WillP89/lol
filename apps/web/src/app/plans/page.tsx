'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { categoryStyle, categoryBackground } from '@/lib/categoryStyle';
import { formatPriceFrom } from '@/lib/formatPrice';

interface UpcomingPlan {
  id: string;
  publicSlug: string;
  title: string;
  crew: { id: string; name: string };
  startsAt: string | null;
  venueName: string | null;
  venueCity: string | null;
  category: string | null;
  imageUrl: string | null;
  priceMinMinor: number | null;
  currency: string;
}

function dateBadge(iso: string | null): { day: string; num: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  return { day: d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase(), num: String(d.getDate()) };
}

/**
 * Confirmed plans should not disappear inside chat once they're locked in — a standalone
 * destination for "what's actually happening", pulled from every Crew at once rather than
 * requiring you to remember which Crew booked what. See services/crew.ts#listUpcomingPlansForUser.
 */
export default function PlansPage() {
  const [plans, setPlans] = useState<UpcomingPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ plans: UpcomingPlan[] }>('/plans/upcoming')
      .then((res) => setPlans(res.plans))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your Plans.'));
  }, []);

  return (
    <>
      <nav className="nav">
        <div className="wordmark">
          Plot<span>·</span>
        </div>
      </nav>
      <div className="page">
        <div className="masthead">
          <h1 style={{ fontSize: 22 }}>Plans</h1>
          <p className="muted" style={{ marginBottom: 0 }}>What&rsquo;s actually locked in.</p>
        </div>

        {error && <div className="error">{error}</div>}

        {plans === null && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2].map((i) => (
              <div key={i} className="card" style={{ height: 96, opacity: 0.5 }} />
            ))}
          </div>
        )}

        {plans?.length === 0 && (
          <div className="banner-card" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🗓️</div>
            <p style={{ marginBottom: 4, fontWeight: 700 }}>Nothing locked in yet.</p>
            <p className="muted" style={{ marginBottom: 14 }}>Once a Crew votes something in, it shows up here.</p>
            <Link href="/explore" className="btn btn-primary" style={{ width: 'auto', padding: '10px 20px' }}>
              Find something
            </Link>
          </div>
        )}

        {plans?.map((plan) => {
          const style = categoryStyle(plan.category);
          const badge = dateBadge(plan.startsAt);
          const price = formatPriceFrom(plan.priceMinMinor, plan.currency);
          return (
            <Link
              key={plan.id}
              href={`/plans/${plan.publicSlug}`}
              className="card fade-up"
              style={{ display: 'flex', gap: 12, alignItems: 'stretch', padding: 12, textDecoration: 'none' }}
            >
              <div
                style={{
                  flexShrink: 0,
                  width: 46,
                  borderRadius: 10,
                  background: 'var(--ink-surface-2)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '8px 0',
                }}
              >
                {badge ? (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink-text-muted)', letterSpacing: '0.04em' }}>{badge.day}</div>
                    <div style={{ fontFamily: 'Fraunces, serif', fontSize: 19, fontWeight: 700 }}>{badge.num}</div>
                  </>
                ) : (
                  <div style={{ fontSize: 18 }}>{style.emoji}</div>
                )}
              </div>
              <div
                className="art-block"
                style={{
                  flexShrink: 0,
                  width: 56,
                  height: 56,
                  borderRadius: 12,
                  fontSize: 20,
                  background: categoryBackground(plan.imageUrl, plan.category),
                }}
              >
                {!plan.imageUrl && style.emoji}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 15.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {plan.title}
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{plan.crew.name}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {plan.startsAt
                    ? new Date(plan.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                    : 'Time TBC'}
                  {plan.venueName && ` · ${plan.venueName}`}
                  {price && ` · ${price}`}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      <TabBar />
    </>
  );
}
