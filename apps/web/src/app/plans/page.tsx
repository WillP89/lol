'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { v2Art } from '@/lib/v2Art';
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
 * Plans V2 — same data/logic as v1 (confirmed plans, pulled from every Crew at once rather than
 * requiring you to remember which Crew booked what — see
 * services/crew.ts#listUpcomingPlansForUser), brought onto the same v2 primitives as Home/Crews.
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
    <div className="v2">
      <div className="v2-shell-desktop">
        <div className="v2-page" style={{ paddingTop: 28 }}>
          <div style={{ marginBottom: 26 }}>
            <h1 className="v2-display" style={{ fontSize: 30, lineHeight: 1.06, marginBottom: 4 }}>Plans</h1>
            <p className="v2-muted" style={{ fontSize: 14.5 }}>What&rsquo;s actually locked in.</p>
          </div>

          {error && <div style={{ color: 'var(--v2-brand)', fontSize: 13, marginBottom: 16 }}>{error}</div>}

          {plans === null && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[1, 2].map((i) => (
                <div key={i} style={{ height: 80, borderRadius: 'var(--v2-r-lg)', background: 'var(--v2-bg-deep)' }} />
              ))}
            </div>
          )}

          {plans?.length === 0 && (
            <div style={{ textAlign: 'center', padding: '56px 12px 32px' }}>
              <div style={{ fontSize: 34, marginBottom: 10 }}>🗓️</div>
              <h2 className="v2-display" style={{ fontSize: 26, marginBottom: 10, lineHeight: 1.15 }}>Nothing locked in yet.</h2>
              <p className="v2-muted" style={{ marginBottom: 22, lineHeight: 1.6, maxWidth: 280, marginInline: 'auto' }}>
                Once a Crew votes something in, it shows up here.
              </p>
              <Link href="/explore" className="v2-btn v2-btn-brand">Find something</Link>
            </div>
          )}

          {plans && plans.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {plans.map((plan) => {
                const badge = dateBadge(plan.startsAt);
                const price = formatPriceFrom(plan.priceMinMinor, plan.currency);
                return (
                  <Link key={plan.id} href={`/plans/${plan.publicSlug}`} className="v2-card fade-up" style={{ display: 'flex', gap: 12, alignItems: 'stretch', padding: 10 }}>
                    <div
                      style={{
                        flexShrink: 0,
                        width: 44,
                        borderRadius: 12,
                        background: 'var(--v2-bg-deep)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '6px 0',
                      }}
                    >
                      {badge ? (
                        <>
                          <div style={{ fontSize: 9.5, fontWeight: 800, color: 'var(--v2-ink-muted)', letterSpacing: '0.03em' }}>{badge.day}</div>
                          <div className="v2-display" style={{ fontSize: 18 }}>{badge.num}</div>
                        </>
                      ) : (
                        <div style={{ fontSize: 16 }}>📌</div>
                      )}
                    </div>
                    <div style={{ flexShrink: 0, width: 56, height: 56, borderRadius: 12, background: v2Art(plan.imageUrl, plan.category) }} />
                    <div style={{ flex: 1, minWidth: 0, alignSelf: 'center' }}>
                      <div className="v2-display" style={{ fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {plan.title}
                      </div>
                      <div className="v2-muted" style={{ fontSize: 12.5, marginTop: 2 }}>{plan.crew.name}</div>
                      <div className="v2-dim" style={{ fontSize: 12 }}>
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
          )}
        </div>
      </div>
      <TabBarV2 />
    </div>
  );
}
