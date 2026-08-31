'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { categoryStyle, categoryBackground } from '@/lib/categoryStyle';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { messagePreview } from '@/lib/messagePreview';

interface CrewSummary {
  id: string;
  name: string;
  members: { user: { id: string; displayName: string | null; email: string } }[];
  latestMessage: { body: string; authorName: string; createdAt: string } | null;
  activePlan: { id: string; title: string; publicSlug: string; inCount: number; totalMembers: number; iVoted: boolean } | null;
  upcomingPlan: { id: string; title: string; publicSlug: string; startsAt: string | null; venueName: string | null } | null;
}

interface UpcomingPlan {
  id: string;
  publicSlug: string;
  title: string;
  crew: { id: string; name: string };
  startsAt: string | null;
  venueName: string | null;
  category: string | null;
  imageUrl: string | null;
  priceMinMinor: number | null;
  goingCount: number;
}

interface Experience {
  id: string;
  name: string;
  category: string;
  startsAt: string;
  priceMinMinor: number | null;
  currency: string;
  imageUrl: string | null;
  venue: { name: string };
}

const AVATAR_COLORS = ['#ffab2e', '#ff6b4a', '#8fc9a3', '#c9a0dc', '#7fb3d5'];

// Each Crew tile gets its own gradient identity — otherwise a row of same-toned cards reads
// as one grey mass instead of "different groups of different people."
const CREW_GRADIENTS = [
  'linear-gradient(150deg, #4a2f6b, #241a2e)',
  'linear-gradient(150deg, #6b3a1f, #2a1810)',
  'linear-gradient(150deg, #1f4a3f, #10241e)',
  'linear-gradient(150deg, #6b2f4a, #241626)',
  'linear-gradient(150deg, #2f3f6b, #16182a)',
];

function initials(displayName: string | null, email: string) {
  return (displayName?.trim() || email).slice(0, 1).toUpperCase();
}
function seedHash(seed: string, mod: number) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % mod;
  return hash;
}
function avatarColor(seed: string) {
  return AVATAR_COLORS[seedHash(seed, AVATAR_COLORS.length)];
}
function crewGradient(seed: string) {
  return CREW_GRADIENTS[seedHash(seed, CREW_GRADIENTS.length)];
}
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Late night';
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

/**
 * Home — "what are my people up to?", not a Crews index and not a Crew-creation form. Composed
 * from three real signals, in priority order: is something already booked and coming up (the
 * hero), does a decision specifically need me (Needs You), then what's alive across every Crew
 * and what's worth doing that Plot already knows about (the two rails below). See
 * docs/DECISIONS.md#golden-hour-redesign and #nav-restructure for how this replaced the old
 * combined Home+Crews page.
 */
export default function HomePage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingPlan[] | null>(null);
  const [ideas, setIdeas] = useState<Experience[] | null>(null);
  const [me, setMe] = useState<{ displayName: string | null; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ crews: CrewSummary[] }>('/crews')
      .then((res) => setCrews(res.crews))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your Crews.'));
    api
      .get<{ plans: UpcomingPlan[] }>('/plans/upcoming')
      .then((res) => setUpcoming(res.plans))
      .catch(() => {});
    api
      .get<{ experiences: Experience[] }>('/explore/experiences?city=London')
      .then((res) => setIdeas(res.experiences.slice(0, 6)))
      .catch(() => {});
    api
      .get<{ user: { displayName: string | null; email: string } }>('/users/me')
      .then((res) => setMe(res.user))
      .catch(() => {});
  }, []);

  const nextPlan = upcoming?.find((p) => p.startsAt && new Date(p.startsAt).getTime() > Date.now()) ?? upcoming?.[0] ?? null;

  const needsAttention = useMemo(
    () => (crews ?? []).filter((c) => c.activePlan && !c.activePlan.iVoted),
    [crews],
  );

  const recentActivity = useMemo(
    () =>
      (crews ?? [])
        .filter((c) => c.latestMessage)
        .sort((a, b) => new Date(b.latestMessage!.createdAt).getTime() - new Date(a.latestMessage!.createdAt).getTime())
        .slice(0, 3),
    [crews],
  );

  const loading = crews === null && !error;

  return (
    <>
      {/* Compact identity strip, not a masthead — the point of arriving here is the content
          below, not a wordmark. Tapping the avatar goes to You, same as the tab. */}
      <nav className="nav" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.03em' }}>{greeting()}{me ? `, ${displayNameOf(me.displayName, me.email).split(' ')[0]}` : ''}</div>
        </div>
        <Link href="/profile" aria-label="Your profile">
          <div
            className="avatar"
            style={{ width: 34, height: 34, fontSize: 13, background: me ? avatarColor(me.displayName ?? me.email) : 'var(--ink-surface-2)' }}
          >
            {me ? initials(me.displayName, me.email) : ''}
          </div>
        </Link>
      </nav>

      <div className="page" style={{ paddingTop: 18 }}>
        {error && <div className="error">{error}</div>}

        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
            <div style={{ height: 200, borderRadius: 24, background: 'var(--ink-surface)', opacity: 0.5 }} />
            <div style={{ height: 60, borderRadius: 16, background: 'var(--ink-surface)', opacity: 0.5 }} />
          </div>
        )}

        {/* The app's real empty state (brief: teach the value proposition, don't hand someone
            a form) — creating a Crew is a deliberate second step on /crews, never a text field
            sitting in the middle of the feed. */}
        {crews?.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 12px 32px' }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>🌆</div>
            <h1 style={{ fontFamily: 'Fraunces, serif', fontSize: 25, marginBottom: 8, lineHeight: 1.2 }}>
              Your weekends<br />start here.
            </h1>
            <p className="muted" style={{ marginBottom: 22, lineHeight: 1.6, maxWidth: 280, marginInline: 'auto' }}>
              Start a Crew, bring your people in, and Plot finds what you should do together.
            </p>
            <Link href="/crews?new=1" className="btn btn-primary" style={{ width: 'auto', padding: '13px 26px', marginBottom: 10 }}>
              Start a Crew
            </Link>
            <div>
              <Link href="/crews" className="muted" style={{ fontSize: 13 }}>
                Have an invite? Join a Crew
              </Link>
            </div>
          </div>
        )}

        {/* NEXT UP — a confirmed plan is the single most important thing Plot can tell someone;
            it gets the one big visual module on the page, everything else is quieter. */}
        {nextPlan && (
          <Link
            href={`/plans/${nextPlan.publicSlug}`}
            className="fade-up"
            style={{
              display: 'block',
              textDecoration: 'none',
              color: 'inherit',
              position: 'relative',
              height: 236,
              borderRadius: 26,
              overflow: 'hidden',
              marginBottom: 28,
              boxShadow: 'var(--ambient-shadow)',
              background: categoryBackground(nextPlan.imageUrl, nextPlan.category),
            }}
          >
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(15,10,6,0) 25%, rgba(15,10,6,0.6) 62%, rgba(15,10,6,0.94) 100%)' }} />
            {!nextPlan.imageUrl && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 60, opacity: 0.5 }}>
                {categoryStyle(nextPlan.category).emoji}
              </div>
            )}
            <div style={{ position: 'absolute', top: 16, left: 20 }}>
              <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#100a05', background: 'var(--ink-gold)', padding: '5px 10px', borderRadius: 8 }}>
                Next up
              </span>
            </div>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '20px 22px' }}>
              <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 25, lineHeight: 1.12, marginBottom: 6, textShadow: '0 2px 14px rgba(0,0,0,0.5)' }}>
                {nextPlan.title}
              </div>
              <div style={{ fontSize: 13.5, color: 'rgba(247,240,228,0.9)' }}>
                {nextPlan.startsAt
                  ? new Date(nextPlan.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                  : 'Time to be confirmed'}
                {nextPlan.venueName && ` · ${nextPlan.venueName}`}
              </div>
              <div style={{ fontSize: 13, color: 'rgba(247,240,228,0.7)', marginTop: 2 }}>
                {nextPlan.crew.name} · {nextPlan.goingCount} going
              </div>
            </div>
          </Link>
        )}

        {/* NEEDS YOU — plain list rhythm, no card boxing: each row is a hairline-divided,
            fully-tappable action, not a database record in a container. */}
        {needsAttention.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div className="eyebrow" style={{ marginBottom: 4 }}>Needs you</div>
            {needsAttention.map((c) => (
              <Link
                key={c.id}
                href={`/plans/${c.activePlan!.publicSlug}`}
                className="fade-up"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  textDecoration: 'none',
                  color: 'inherit',
                  padding: '14px 2px',
                  borderBottom: '1px solid var(--ink-border)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{c.activePlan!.title}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {c.name} · {c.activePlan!.inCount}/{c.activePlan!.totalMembers} voted
                  </div>
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: 'var(--ink-gold-ink)',
                    background: 'var(--ink-gold)',
                    padding: '8px 16px',
                    borderRadius: 100,
                  }}
                >
                  Vote
                </span>
              </Link>
            ))}
          </div>
        )}

        {/* YOUR CREWS — a rail, not a stack: each tile carries its own colour identity plus
            whatever's actually happening in it, so a row of several reads as different groups
            of different people, not repeats of the same row. */}
        {crews && crews.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 0 }}>Your Crews</div>
              <Link href="/crews" className="muted" style={{ fontSize: 12.5 }}>See all →</Link>
            </div>
            <div style={{ display: 'flex', gap: 12, overflowX: 'auto', margin: '0 -20px', padding: '0 20px 4px', scrollSnapType: 'x proximity' }}>
              {crews.slice(0, 6).map((crew) => (
                <Link
                  key={crew.id}
                  href={`/crews/${crew.id}`}
                  className="fade-up"
                  style={{
                    flex: '0 0 auto',
                    width: 180,
                    borderRadius: 22,
                    overflow: 'hidden',
                    textDecoration: 'none',
                    color: 'inherit',
                    background: 'var(--ink-surface)',
                    boxShadow: 'var(--ambient-shadow)',
                    scrollSnapAlign: 'start',
                  }}
                >
                  <div style={{ height: 86, background: crewGradient(crew.id), position: 'relative', padding: 10 }}>
                    <div className="stack" style={{ position: 'absolute', bottom: 10, left: 10 }}>
                      {crew.members.slice(0, 4).map((m) => (
                        <div key={m.user.id} className="avatar" style={{ width: 24, height: 24, fontSize: 9.5, background: avatarColor(m.user.displayName ?? m.user.email), boxShadow: '0 0 0 2px var(--ink-surface)' }}>
                          {initials(m.user.displayName, m.user.email)}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ padding: '11px 12px 13px' }}>
                    <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 15, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {crew.name}
                    </div>
                    {crew.latestMessage ? (
                      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        <span style={{ fontWeight: 600, color: 'var(--ink-text)' }}>{crew.latestMessage.authorName}: </span>
                        {messagePreview(crew.latestMessage.body)}
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 11.5 }}>Say hi →</div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* IDEAS FOR YOU — Explore surfaced right on Home, image-led, so discovery isn't
            something you only find by tapping into a separate tab. */}
        {ideas && ideas.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 0 }}>Ideas for you</div>
              <Link href="/explore" className="muted" style={{ fontSize: 12.5 }}>Explore →</Link>
            </div>
            <div style={{ display: 'flex', gap: 12, overflowX: 'auto', margin: '0 -20px', padding: '0 20px 4px', scrollSnapType: 'x proximity' }}>
              {ideas.map((exp) => {
                const style = categoryStyle(exp.category);
                const price = formatPriceFrom(exp.priceMinMinor, exp.currency);
                return (
                  <Link
                    key={exp.id}
                    href="/explore"
                    className="fade-up"
                    style={{
                      flex: '0 0 auto',
                      width: 156,
                      borderRadius: 20,
                      overflow: 'hidden',
                      textDecoration: 'none',
                      color: 'inherit',
                      boxShadow: 'var(--ambient-shadow)',
                      scrollSnapAlign: 'start',
                    }}
                  >
                    <div
                      style={{
                        height: 116,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 30,
                        background: categoryBackground(exp.imageUrl, exp.category),
                      }}
                    >
                      {!exp.imageUrl && style.emoji}
                    </div>
                    <div style={{ padding: '9px 10px 11px', background: 'var(--ink-surface)' }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.3, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {exp.name}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {new Date(exp.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                        {price && ` · ${price}`}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {recentActivity.length > 0 && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Recent activity</div>
            {recentActivity.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 10, padding: '9px 0', fontSize: 13, borderBottom: '1px solid var(--ink-border)' }}>
                <div className="muted" style={{ flexShrink: 0, width: 26, fontSize: 11 }}>{timeAgo(c.latestMessage!.createdAt)}</div>
                <div style={{ minWidth: 0 }}>
                  <strong>{c.latestMessage!.authorName}</strong> in {c.name}
                  <div className="muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {messagePreview(c.latestMessage!.body)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <TabBar />
    </>
  );
}
