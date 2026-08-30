'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { categoryStyle } from '@/lib/categoryStyle';

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
}

const AVATAR_COLORS = ['#f2a93b', '#7fb79a', '#ea5b3d', '#9c97ae', '#6b8ef2'];

function initials(displayName: string | null, email: string) {
  return (displayName?.trim() || email).slice(0, 1).toUpperCase();
}
function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Late night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Good evening';
}

/**
 * Home — "what are my people up to?" (brief: Home ≠ Crews). Not a database view of the Crew
 * table; a feed built from the same enriched /crews response the Crew previews already used,
 * plus /plans/upcoming for a real global "what's next", read in priority order: is something
 * booked and coming up, does a decision need me specifically, then what's alive in each Crew.
 */
export default function HomePage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingPlan[] | null>(null);
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
  }, []);

  const nextPlan = upcoming?.find((p) => p.startsAt && new Date(p.startsAt).getTime() > Date.now()) ?? upcoming?.[0] ?? null;

  const needsAttention = useMemo(
    () => (crews ?? []).filter((c) => c.activePlan && !c.activePlan.iVoted),
    [crews],
  );

  // A lightweight, real activity feed — no separate event log to maintain, just the same
  // per-Crew "what's the latest" data already on the page, re-sorted across every Crew
  // instead of siloed one-per-card, newest first.
  const recentActivity = useMemo(
    () =>
      (crews ?? [])
        .filter((c) => c.latestMessage)
        .sort((a, b) => new Date(b.latestMessage!.createdAt).getTime() - new Date(a.latestMessage!.createdAt).getTime())
        .slice(0, 4),
    [crews],
  );

  const loading = crews === null && !error;

  return (
    <>
      <nav className="nav">
        <div className="wordmark">
          Plot<span>·</span>
        </div>
        <Link href="/profile" className="muted" style={{ fontSize: 13 }}>
          You
        </Link>
      </nav>
      <div className="page">
        <div style={{ marginBottom: 22 }}>
          <div className="muted" style={{ fontSize: 13 }}>{greeting()}</div>
          <h1 style={{ fontSize: 24, marginTop: 2 }}>Here&rsquo;s what your people are up to.</h1>
        </div>

        {error && <div className="error">{error}</div>}

        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
            <div className="card" style={{ height: 96, opacity: 0.5 }} />
            <div className="card" style={{ height: 64, opacity: 0.5 }} />
          </div>
        )}

        {/* Nothing on Home at all yet — the app's actual empty state (brief: "teach the value
            proposition", not a bare form). Creating a Crew lives on /crews; this just gets you
            there with intent already established. */}
        {crews?.length === 0 && (
          <div className="banner-card" style={{ textAlign: 'center', padding: '36px 22px' }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>🌆</div>
            <h2 style={{ fontFamily: 'Fraunces, serif', fontSize: 20, marginBottom: 6 }}>Plans are better with people.</h2>
            <p className="muted" style={{ marginBottom: 18, lineHeight: 1.6 }}>
              Create a Crew, invite your friends, and start finding something worth doing.
            </p>
            <Link href="/crews?new=1" className="btn btn-primary" style={{ marginBottom: 8 }}>
              Create your first Crew
            </Link>
            <Link href="/crews" className="muted" style={{ fontSize: 13 }}>
              Have an invite? Join a Crew
            </Link>
          </div>
        )}

        {nextPlan && (
          <Link href={`/plans/${nextPlan.publicSlug}`} className="banner-card fade-up" style={{ display: 'block', textDecoration: 'none', padding: 0, overflow: 'hidden' }}>
            <div
              className="art-block"
              style={{
                height: 88,
                borderRadius: 0,
                ...(nextPlan.imageUrl
                  ? { backgroundImage: `url(${nextPlan.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : { background: categoryStyle(nextPlan.category).bg }),
              }}
            >
              {!nextPlan.imageUrl && categoryStyle(nextPlan.category).emoji}
            </div>
            <div style={{ padding: 16 }}>
              <div className="eyebrow">Your next plan</div>
              <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 18, margin: '2px 0 3px' }}>{nextPlan.title}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {nextPlan.startsAt
                  ? new Date(nextPlan.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                  : 'Time to be confirmed'}
                {nextPlan.venueName && ` · ${nextPlan.venueName}`}
                {' · '}
                {nextPlan.crew.name}
              </div>
            </div>
          </Link>
        )}

        {needsAttention.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Needs your attention</div>
            {needsAttention.map((c) => (
              <Link
                key={c.id}
                href={`/plans/${c.activePlan!.publicSlug}`}
                className="card fade-up"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textDecoration: 'none' }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>{c.name}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {c.activePlan!.title} · {c.activePlan!.inCount}/{c.activePlan!.totalMembers} voted
                  </div>
                </div>
                <span className="chip gold static" style={{ flexShrink: 0 }}>Vote</span>
              </Link>
            ))}
          </div>
        )}

        {crews && crews.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="eyebrow" style={{ marginBottom: 0 }}>Your Crews</div>
              <Link href="/crews" className="muted" style={{ fontSize: 12.5 }}>See all →</Link>
            </div>
            {crews.slice(0, 4).map((crew) => (
              <Link key={crew.id} href={`/crews/${crew.id}`} className="card fade-up" style={{ display: 'block', textDecoration: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                  <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 16 }}>{crew.name}</div>
                  <div className="stack" style={{ flexShrink: 0 }}>
                    {crew.members.slice(0, 4).map((m) => (
                      <div key={m.user.id} className="avatar" style={{ width: 22, height: 22, fontSize: 9, background: avatarColor(m.user.displayName ?? m.user.email) }}>
                        {initials(m.user.displayName, m.user.email)}
                      </div>
                    ))}
                  </div>
                </div>
                {crew.latestMessage ? (
                  <div className="muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 600, color: 'var(--ink-text)' }}>{crew.latestMessage.authorName}: </span>
                    {crew.latestMessage.body}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12.5 }}>No activity yet — say hi.</div>
                )}
              </Link>
            ))}
          </div>
        )}

        {recentActivity.length > 0 && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Activity</div>
            {recentActivity.map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 10, padding: '8px 0', fontSize: 13 }}>
                <div className="muted" style={{ flexShrink: 0, width: 52, fontSize: 11 }}>{timeAgo(c.latestMessage!.createdAt)}</div>
                <div>
                  <strong>{c.latestMessage!.authorName}</strong> in {c.name}
                  <div className="muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.latestMessage!.body}
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
