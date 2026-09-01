'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { v2Art } from '@/lib/v2Art';
import { formatPriceFrom } from '@/lib/formatPrice';
import { useScrollReveal } from '@/lib/useScrollReveal';
import { IconFlame, IconPlace, IconLock } from '@/components/icons';
import { CrewMark, PersonAvatar } from '@/components/Avatar';

interface PlanMemberLite {
  id: string;
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
}

interface UpcomingPlan {
  id: string;
  publicSlug: string;
  title: string;
  crew: { id: string; name: string; imageUrl: string | null };
  startsAt: string | null;
  venueName: string | null;
  venueCity: string | null;
  category: string | null;
  imageUrl: string | null;
  priceMinMinor: number | null;
  currency: string;
  goingCount: number;
  goingMembers: PlanMemberLite[];
}

/**
 * A Plan tonight should not read identically to one six weeks out — the group's felt urgency is
 * real information, not decoration. Buckets are computed off `startsAt` alone (no per-plan
 * "is this happening now" flag exists server-side, and doesn't need to — this is pure date math),
 * ordered by actual proximity so "Tonight" always leads.
 */
type TimeBucket = 'Tonight' | 'Tomorrow' | 'This weekend' | 'Upcoming' | 'Date TBC';
const BUCKET_ORDER: TimeBucket[] = ['Tonight', 'Tomorrow', 'This weekend', 'Upcoming', 'Date TBC'];

function timeBucket(iso: string | null): TimeBucket {
  if (!iso) return 'Date TBC';
  const now = new Date();
  const target = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAway = Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / 86400000);
  if (daysAway <= 0) return 'Tonight';
  if (daysAway === 1) return 'Tomorrow';
  // "This weekend" — the next Friday/Saturday/Sunday within the coming week, not literally
  // Sat/Sun only (a Friday-night plan is "this weekend" in how people actually talk about it).
  if (daysAway <= 6 && [5, 6, 0].includes(target.getDay())) return 'This weekend';
  return 'Upcoming';
}

/** "In 4 days", "In 2 weeks" — the countdown that makes a far-out Plan still feel real and
 * anchored, not just a bucket label repeated on every row in it. */
function countdownLabel(iso: string | null): string | null {
  if (!iso) return null;
  const now = new Date();
  const target = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAway = Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / 86400000);
  if (daysAway <= 0) return null;
  if (daysAway === 1) return null;
  if (daysAway < 7) return `In ${daysAway} days`;
  const weeks = Math.round(daysAway / 7);
  return weeks === 1 ? 'In 1 week' : `In ${weeks} weeks`;
}

function dateLine(iso: string | null): string {
  if (!iso) return 'Time TBC';
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const daysAway = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (daysAway <= 1) return time;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${time}`;
}

/**
 * Plans V2 — same data/logic as v1 (confirmed plans, pulled from every Crew at once rather than
 * requiring you to remember which Crew booked what — see
 * services/crew.ts#listUpcomingPlansForUser). Redesigned so a Plan reads as a real thing your
 * Crew is doing rather than a data row: a full-width photo, the Crew's own mark, the actual
 * faces of who's in, a countdown, and a one-tap action — not a 56px thumbnail and three lines of
 * text (see docs/DECISIONS.md#plot-brand-system).
 */
export default function PlansPage() {
  useScrollReveal();
  const [plans, setPlans] = useState<UpcomingPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ plans: UpcomingPlan[] }>('/plans/upcoming')
      .then((res) => setPlans(res.plans))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your Plans.'));
  }, []);

  return (
    <div className="v2 v2-app-shell">
      <div className="v2-shell-desktop">
        <div className="v2-page v2-page-wide" style={{ paddingTop: 28 }}>
          <div style={{ marginBottom: 26 }}>
            <h1 className="v2-display" style={{ fontSize: 30, lineHeight: 1.06, marginBottom: 4 }}>Plans</h1>
            <p className="v2-muted" style={{ fontSize: 14.5 }}>What&rsquo;s actually locked in.</p>
          </div>

          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginBottom: 16 }}>{error}</div>}

          {plans === null && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[1, 2].map((i) => (
                <div key={i} className="v2-skeleton" style={{ height: 220, borderRadius: 'var(--v2-r-lg)' }} />
              ))}
            </div>
          )}

          {plans?.length === 0 && (
            <div style={{ textAlign: 'center', padding: '56px 12px 32px' }}>
              <h2 className="v2-display" style={{ fontSize: 26, marginBottom: 10, lineHeight: 1.15 }}>Nothing locked in yet.</h2>
              <p className="v2-muted" style={{ marginBottom: 22, lineHeight: 1.6, maxWidth: 280, marginInline: 'auto' }}>
                Once a Crew votes something in, it shows up here.
              </p>
              <Link href="/explore" className="v2-btn v2-btn-brand">Find something</Link>
            </div>
          )}

          {plans && plans.length > 0 && (() => {
            const grouped = new Map<TimeBucket, UpcomingPlan[]>();
            for (const plan of plans) {
              const bucket = timeBucket(plan.startsAt);
              if (!grouped.has(bucket)) grouped.set(bucket, []);
              grouped.get(bucket)!.push(plan);
            }
            let rowIndex = 0;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
                {BUCKET_ORDER.filter((b) => grouped.has(b)).map((bucket) => {
                  const tonight = bucket === 'Tonight';
                  return (
                    <div key={bucket}>
                      <div className="v2-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 12, color: tonight ? 'var(--v2-pop)' : undefined }}>
                        {tonight && <IconFlame size={12} />}
                        {tonight ? 'Tonight' : bucket}
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                          gap: 14,
                        }}
                      >
                        {grouped.get(bucket)!.map((plan) => {
                          const price = formatPriceFrom(plan.priceMinMinor, plan.currency);
                          const countdown = !tonight && bucket !== 'Tomorrow' ? countdownLabel(plan.startsAt) : null;
                          const i = rowIndex++;
                          return (
                            <Link
                              key={plan.id}
                              href={`/plans/${plan.publicSlug}`}
                              className="v2-card v2-reveal v2-plan-card"
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                padding: 0,
                                overflow: 'hidden',
                                ['--reveal-i' as string]: i % 4,
                                boxShadow: tonight ? '0 0 0 1.5px var(--v2-pop), var(--v2-shadow-sm)' : undefined,
                              }}
                            >
                              {/* The plan IS the image — a real event photo, or Plot's own
                                  editorial art per category. Never a small thumbnail beside the
                                  real content; here it IS the content, same treatment as the
                                  EventCard this reuses (v2Art). */}
                              <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: v2Art(plan.imageUrl, plan.category) }}>
                                <div
                                  style={{
                                    position: 'absolute', inset: 0,
                                    background: 'linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)',
                                  }}
                                />
                                {/* The Crew's own mark, top-left — whose Plan this is, at a glance,
                                    across a page that deliberately mixes every Crew together. */}
                                <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(20,17,14,0.55)', backdropFilter: 'blur(6px)', borderRadius: 100, padding: '4px 10px 4px 4px' }}>
                                  <CrewMark name={plan.crew.name} imageUrl={plan.crew.imageUrl} size={22} />
                                  <span style={{ fontSize: 11.5, fontWeight: 800, color: '#fff' }}>{plan.crew.name}</span>
                                </div>
                                {/* Locked-in signature: same IconLock badge as the Crew-chat
                                    EventCard once a Plan is locked — this page's Plans are all
                                    LOCKED/BOOKED by definition, so every card carries it. */}
                                <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(20,17,14,0.55)', backdropFilter: 'blur(6px)', borderRadius: 100, padding: '5px 10px' }}>
                                  <IconLock size={11} style={{ color: '#fff' }} />
                                  <span style={{ fontSize: 10.5, fontWeight: 800, color: '#fff', letterSpacing: '0.02em' }}>LOCKED IN</span>
                                </div>
                                <div style={{ position: 'absolute', bottom: 10, left: 12, right: 12 }}>
                                  <div className="v2-display" style={{ fontSize: 18, color: '#fff', lineHeight: 1.15, textShadow: '0 1px 4px rgba(0,0,0,0.4)' }}>
                                    {plan.title}
                                  </div>
                                </div>
                              </div>

                              <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div className="v2-dim" style={{ fontSize: 12.5, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                                  <span style={{ fontWeight: 700, color: tonight ? 'var(--v2-pop)' : 'var(--v2-ink)' }}>{dateLine(plan.startsAt)}</span>
                                  {countdown && <span>&nbsp;· {countdown}</span>}
                                  {plan.venueName && <span>&nbsp;· {plan.venueName}</span>}
                                  {price && <span>&nbsp;· {price}</span>}
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                                  {/* Real faces of who's actually in — not a bare "3 going" count. */}
                                  <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <div style={{ display: 'flex' }}>
                                      {plan.goingMembers.slice(0, 4).map((m, mi) => (
                                        <div key={m.id} style={{ marginLeft: mi === 0 ? 0 : -8, position: 'relative', zIndex: 4 - mi }}>
                                          <PersonAvatar name={m.displayName} email={m.email} photoUrl={m.avatarUrl} size={26} ring />
                                        </div>
                                      ))}
                                    </div>
                                    <span className="v2-muted" style={{ fontSize: 12, marginLeft: 8 }}>
                                      {plan.goingCount} {plan.goingCount === 1 ? 'going' : 'going'}
                                    </span>
                                  </div>

                                  {tonight && plan.venueName ? (
                                    <a
                                      href={`https://maps.google.com/?q=${encodeURIComponent(`${plan.venueName}${plan.venueCity ? `, ${plan.venueCity}` : ''}`)}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="v2-tap-feedback"
                                      style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11.5, fontWeight: 800, color: '#fff', background: 'var(--v2-pop)', padding: '8px 12px', borderRadius: 100 }}
                                    >
                                      <IconPlace size={12} />Directions
                                    </a>
                                  ) : (
                                    <span className="v2-tap-feedback" style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--v2-brand)', background: 'var(--v2-bg-deep)', padding: '8px 12px', borderRadius: 100, flexShrink: 0 }}>
                                      View plan
                                    </span>
                                  )}
                                </div>
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>
      <TabBarV2 />
    </div>
  );
}
