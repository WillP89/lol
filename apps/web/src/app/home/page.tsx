'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { v2Art } from '@/lib/v2Art';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { messagePreview } from '@/lib/messagePreview';
import { IconCalendar, IconPoll, IconGathering, IconLock } from '@/components/icons';
import { PersonAvatar, CrewMark } from '@/components/Avatar';
import { identityGradient } from '@/lib/identity';
import { crewArtStyle, isCrewArtUrl } from '@/lib/crewArt';

interface CrewSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  members: { user: { id: string; displayName: string | null; email: string; avatarUrl?: string | null } }[];
  latestMessage: { body: string; authorName: string; createdAt: string; authorAvatarUrl?: string | null } | null;
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
/**
 * One Crew's current state, in priority order — a Crew waiting on your vote is not the same
 * moment as a Crew that just went quiet, and they shouldn't read identically. Real signal Plot
 * already has (a vote pending, a plan locked, an upcoming plan, the last thing said) rather than
 * unread-message tracking, which doesn't exist as a persisted "last seen" concept yet — see
 * docs/DECISIONS.md for that as a known gap, not something faked here with a random dot.
 */
type CrewStatusKind = 'calendar' | 'poll' | 'none';
function crewStatusLine(crew: CrewSummary): { text: string; urgent: boolean; kind: CrewStatusKind } {
  if (crew.activePlan && !crew.activePlan.iVoted) {
    return { text: `Vote needed · ${crew.activePlan.title}`, urgent: true, kind: 'none' };
  }
  if (crew.upcomingPlan) {
    return { text: crew.upcomingPlan.title, urgent: false, kind: 'calendar' };
  }
  if (crew.activePlan) {
    return { text: `${crew.activePlan.inCount}/${crew.activePlan.totalMembers} in · ${crew.activePlan.title}`, urgent: false, kind: 'poll' };
  }
  if (crew.latestMessage) {
    return { text: messagePreview(crew.latestMessage.body), urgent: false, kind: 'none' };
  }
  return { text: 'Say hi', urgent: false, kind: 'none' };
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Late night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The header's second line — real, live signal instead of a static "here's what your people are
 * up to" that never changes no matter what's actually happening. Same priority order as the
 * hero below it (a locked plan beats a vote pending beats general activity), so the very first
 * thing you read on Home is honest about what's true right now, not decoration.
 */
function pulseLine(crews: CrewSummary[], nextPlan: UpcomingPlan | null, needsCount: number): string {
  if (nextPlan) {
    const when = nextPlan.startsAt ? new Date(nextPlan.startsAt) : null;
    const isToday = when && when.toDateString() === new Date().toDateString();
    return isToday ? `Tonight: ${nextPlan.title} with ${nextPlan.crew.name}.` : `Next up: ${nextPlan.title} with ${nextPlan.crew.name}.`;
  }
  if (needsCount > 0) {
    return needsCount === 1 ? 'One of your Crews needs your vote.' : `${needsCount} of your Crews need your vote.`;
  }
  if (crews.length > 0) return "Here's what your people are up to.";
  return 'Start a Crew and Plot will find what you should do together.';
}

/**
 * Home — the social engine room, recomposed (not just re-decorated) around one rule: the page
 * adapts to whichever real state is strongest, and Crews are objects you look at, not a list you
 * read. A locked plan dominates the top of the page when one exists (a real photo, full-width);
 * short of that, a decision genuinely waiting on you takes the same slot. Below that, "Your
 * people" is no longer a row of small avatar circles — every Crew is its own image tile (a real
 * photo, a chosen Plot Art theme, or the identity field), because a Crew is exactly as much a
 * real social object here as a Plan is on the Plans page, and a Crew waiting on your vote links
 * straight into that vote instead of repeating itself in a second "Needs you" list underneath.
 * See docs/DECISIONS.md#plot-design-reset.
 */
export default function HomePage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingPlan[] | null>(null);
  const [ideas, setIdeas] = useState<Experience[] | null>(null);
  const [me, setMe] = useState<{ displayName: string | null; email: string; avatarUrl: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A one-off fetch on mount would mean a crewmate's vote, message, or newly-locked plan never
  // shows up unless you manually reload — Home would look "alive" on first paint and go stale
  // the moment you actually sit on it. Same lightweight-poll pattern as the Crew page: refetch
  // Crews (vote counts, latest message, "Needs you") and Upcoming (a plan someone else just
  // locked) on an interval, quietly, without disturbing scroll position or re-triggering the
  // entrance animations (state only updates the parts of the tree whose data actually changed).
  useEffect(() => {
    let cancelled = false;
    function loadCrews() {
      api
        .get<{ crews: CrewSummary[] }>('/crews')
        .then((res) => { if (!cancelled) setCrews(res.crews); })
        .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your Crews.'); });
    }
    function loadUpcoming() {
      api
        .get<{ plans: UpcomingPlan[] }>('/plans/upcoming')
        .then((res) => { if (!cancelled) setUpcoming(res.plans); })
        .catch(() => {});
    }
    loadCrews();
    loadUpcoming();
    api
      .get<{ experiences: Experience[] }>('/explore/experiences') // no hardcoded city — resolves to this viewer's own home city server-side
      .then((res) => { if (!cancelled) setIdeas(res.experiences.slice(0, 6)); })
      .catch(() => {});
    api
      .get<{ user: { displayName: string | null; email: string; avatarUrl: string | null } }>('/users/me')
      .then((res) => { if (!cancelled) setMe(res.user); })
      .catch(() => {});
    const interval = setInterval(() => { loadCrews(); loadUpcoming(); }, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const nextPlan = upcoming?.find((p) => p.startsAt && new Date(p.startsAt).getTime() > Date.now()) ?? upcoming?.[0] ?? null;

  const needsAttention = useMemo(() => (crews ?? []).filter((c) => c.activePlan && !c.activePlan.iVoted), [crews]);
  const pulse = pulseLine(crews ?? [], nextPlan, needsAttention.length);
  // The adaptive fallback hero — nothing locked yet, but a decision is genuinely waiting on you.
  // A locked plan always wins the dominant slot (the group has actually committed); short of
  // that, this is the truest "what's happening" signal Home has.
  const heroNeedsAttention = !nextPlan ? needsAttention[0] ?? null : null;

  const recentActivity = useMemo(
    () =>
      (crews ?? [])
        .filter((c) => c.latestMessage)
        .sort((a, b) => new Date(b.latestMessage!.createdAt).getTime() - new Date(a.latestMessage!.createdAt).getTime())
        .slice(0, 3),
    [crews],
  );

  const loading = crews === null && !error;
  const firstName = me ? displayNameOf(me.displayName, me.email).split(' ')[0] : '';

  return (
    <div className="v2">
      <div className="v2-shell-desktop">
        <div className="v2-home-split">
        <div className="v2-home-main">
        <div className="v2-page" style={{ paddingTop: 28 }}>
          {/* Header — a real page element, not a slim top bar. The avatar here is a mobile-only
              affordance (desktop already has one pinned to the nav rail). */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 26 }}>
            <div>
              <h1 className="v2-display" style={{ fontSize: 38, marginBottom: 6 }}>
                {greeting()}{firstName && <><br /><span style={{ fontStyle: 'italic', color: 'var(--v2-pop)' }}>{firstName}</span></>}
              </h1>
              {/* Real, live signal — see pulseLine above — not a caption that never changes. */}
              <p key={pulse} className="v2-muted v2-pop-in" style={{ fontSize: 14.5, maxWidth: 260 }}>{pulse}</p>
            </div>
            <Link href="/profile" aria-label="Your profile" style={{ flexShrink: 0, borderRadius: '50%', boxShadow: 'var(--v2-shadow-sm)' }}>
              {me ? (
                <PersonAvatar name={me.displayName} email={me.email} photoUrl={me.avatarUrl} size={42} />
              ) : (
                <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'var(--v2-ink-dim)' }} />
              )}
            </Link>
          </div>

          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginBottom: 16 }}>{error}</div>}

          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              <div className="v2-skeleton" style={{ height: 320, borderRadius: 28 }} />
              <div className="v2-skeleton" style={{ height: 88, borderRadius: 20 }} />
            </div>
          )}

          {crews?.length === 0 && (
            <div style={{ textAlign: 'center', padding: '56px 12px 32px' }}>
              <h2 className="v2-display" style={{ fontSize: 28, marginBottom: 10, lineHeight: 1.15 }}>
                Your weekends<br />start here.
              </h2>
              <p className="v2-muted" style={{ marginBottom: 22, lineHeight: 1.6, maxWidth: 280, marginInline: 'auto' }}>
                Start a Crew, bring your people in, and Plot finds what you should do together.
              </p>
              <Link href="/crews?new=1" className="v2-btn v2-btn-brand">Start a Crew</Link>
            </div>
          )}

          {/* THE DOMINANT SLOT — promoted to the very top of the page, above "Your people": the
              single biggest thing here when something's actually locked, or a decision genuinely
              waiting on you short of that. Brief: "if I have something tonight, that should
              dominate." A caption line further down the page can't dominate anything — this can. */}
          {nextPlan && (
            <Link
              href={`/plans/${nextPlan.publicSlug}`}
              className="fade-up v2-hoverable"
              style={{
                display: 'block',
                position: 'relative',
                height: 360,
                borderRadius: 'var(--v2-r-lg)',
                overflow: 'hidden',
                marginBottom: 32,
                boxShadow: 'var(--v2-shadow-lg)',
                background: v2Art(nextPlan.imageUrl, nextPlan.category),
              }}
            >
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(200deg, rgba(22,19,15,0) 30%, rgba(22,19,15,0.55) 70%, rgba(22,19,15,0.88) 100%)' }} />
              <div style={{ position: 'absolute', top: 20, left: 22 }}>
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 800,
                    letterSpacing: '-0.01em',
                    color: 'var(--v2-brand-ink)',
                    background: 'var(--v2-brand)',
                    padding: '7px 14px',
                    borderRadius: 100,
                  }}
                >
                  <IconLock size={11} style={{ marginRight: 4, verticalAlign: -1.5 }} />Next up
                </span>
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '24px 26px' }}>
                <div className="v2-display" style={{ fontSize: 32, lineHeight: 1.06, color: '#fff', marginBottom: 10, maxWidth: '90%' }}>
                  {nextPlan.title}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.92)', marginBottom: 12 }}>
                  {nextPlan.startsAt
                    ? new Date(nextPlan.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                    : 'Time to be confirmed'}
                  {nextPlan.venueName && ` · ${nextPlan.venueName}`}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.75)' }}>
                    {nextPlan.crew.name} · {nextPlan.goingCount} going
                  </span>
                </div>
              </div>
            </Link>
          )}

          {heroNeedsAttention && (
            <Link
              href={`/plans/${heroNeedsAttention.activePlan!.publicSlug}`}
              className="fade-up v2-hoverable"
              style={{
                display: 'block', position: 'relative', height: 240, borderRadius: 'var(--v2-r-lg)', overflow: 'hidden',
                marginBottom: 32, boxShadow: 'var(--v2-shadow-lg)', background: identityGradient(heroNeedsAttention.id, 155),
              }}
            >
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(200deg, rgba(22,19,15,0) 30%, rgba(22,19,15,0.5) 100%)' }} />
              <div style={{ position: 'absolute', top: 20, left: 22, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 800, letterSpacing: '-0.01em', color: '#fff', background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(6px)', padding: '7px 14px', borderRadius: 100 }}>
                <IconGathering size={12} />Still deciding
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '22px 24px' }}>
                <div className="v2-display" style={{ fontSize: 24, lineHeight: 1.1, color: '#fff', marginBottom: 8, maxWidth: '90%' }}>
                  {heroNeedsAttention.activePlan!.title}
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'rgba(255,255,255,0.85)', marginBottom: 14 }}>
                  {heroNeedsAttention.name} · {heroNeedsAttention.activePlan!.inCount}/{heroNeedsAttention.activePlan!.totalMembers} have voted
                </div>
                <span style={{ display: 'inline-block', fontSize: 12.5, fontWeight: 800, color: 'var(--v2-brand-ink)', background: '#fff', padding: '9px 18px', borderRadius: 100 }}>
                  Cast your vote →
                </span>
              </div>
            </Link>
          )}

          {/* YOUR PEOPLE — every Crew as its own image tile, not a row of small avatar circles.
              A Crew is exactly as real a social object here as a Plan is on the Plans page, so it
              gets the same treatment: a real photo, a chosen Plot Art theme, or the identity
              field as the whole tile, the Crew's own mark + name overlaid on it. A Crew waiting
              on your vote links straight into that vote (its own badge says so) instead of
              repeating itself in a separate "Needs you" list underneath — one real object, one
              real place it lives on the page, not two. */}
          {crews && crews.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
                <div className="v2-eyebrow" style={{ marginBottom: 0 }}>Your people</div>
                <Link href="/crews" className="v2-muted" style={{ fontSize: 12.5, fontWeight: 600 }}>See all</Link>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(152px, 1fr))', gap: 12 }}>
                {crews.slice(0, 6).map((crew, i) => {
                  const status = crewStatusLine(crew);
                  const artTheme = isCrewArtUrl(crew.imageUrl);
                  const realPhoto = crew.imageUrl && !artTheme ? crew.imageUrl : null;
                  const tileHref = status.urgent ? `/plans/${crew.activePlan!.publicSlug}` : `/crews/${crew.id}`;
                  return (
                    <Link
                      key={crew.id}
                      href={tileHref}
                      className="v2-card fade-up v2-stagger"
                      style={{
                        display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
                        ['--stagger-i' as string]: i,
                        boxShadow: status.urgent ? '0 0 0 1.5px var(--v2-pop), var(--v2-shadow-sm)' : undefined,
                      }}
                    >
                      <div
                        style={{
                          position: 'relative', width: '100%', aspectRatio: '4 / 3',
                          background: realPhoto ? `url("${realPhoto}") center/cover` : artTheme ? crewArtStyle(artTheme) : identityGradient(crew.name),
                        }}
                      >
                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 42%, rgba(0,0,0,0.55) 100%)' }} />
                        <div style={{ position: 'absolute', top: 8, left: 8 }}>
                          <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={26} />
                        </div>
                        {status.urgent && (
                          <div className="v2-pop-in" style={{ position: 'absolute', top: 8, right: 8, display: 'flex', alignItems: 'center', gap: 3, background: 'var(--v2-pop)', color: '#fff', fontSize: 9.5, fontWeight: 800, padding: '4px 8px', borderRadius: 100 }}>
                            Vote →
                          </div>
                        )}
                        <div style={{ position: 'absolute', bottom: 8, left: 10, right: 10 }}>
                          <div className="v2-display" style={{ fontSize: 14, color: '#fff', lineHeight: 1.15, textShadow: '0 1px 3px rgba(0,0,0,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {crew.name}
                          </div>
                        </div>
                      </div>
                      <div style={{ padding: '8px 10px 10px', display: 'flex', alignItems: 'center', gap: 4 }}>
                        {status.kind === 'calendar' && <IconCalendar size={10} style={{ flexShrink: 0, color: status.urgent ? 'var(--v2-pop)' : 'var(--v2-ink-dim)' }} />}
                        {status.kind === 'poll' && <IconPoll size={10} style={{ flexShrink: 0, color: status.urgent ? 'var(--v2-pop)' : 'var(--v2-ink-dim)' }} />}
                        <span style={{ fontSize: 11.5, fontWeight: status.urgent ? 700 : 600, color: status.urgent ? 'var(--v2-pop)' : 'var(--v2-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {status.text}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {/* IN THE GROUPS — a real activity feed (who shared/said what, and where). */}
          {recentActivity.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 10 }}>In the groups</div>
              <div className="v2-card" style={{ padding: '4px 18px' }}>
                {recentActivity.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', gap: 12, padding: '13px 0', borderBottom: i < recentActivity.length - 1 ? '1px solid var(--v2-line)' : 'none' }}>
                    <div style={{ flexShrink: 0 }}>
                      <PersonAvatar name={c.latestMessage!.authorName} email={c.latestMessage!.authorName} photoUrl={c.latestMessage!.authorAvatarUrl} size={34} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5 }}>
                        <strong>{c.latestMessage!.authorName}</strong> <span className="v2-muted">in {c.name}</span>
                      </div>
                      <div className="v2-muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                        {messagePreview(c.latestMessage!.body)}
                      </div>
                    </div>
                    <div className="v2-dim" style={{ flexShrink: 0, fontSize: 11, paddingTop: 2 }}>{timeAgo(c.latestMessage!.createdAt)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* FOR YOUR CREWS — a few genuinely useful suggestions, deliberately small and last:
              discovery feeds the social loop, it doesn't lead the page. Not an event catalogue —
              three compact rows, not a big image grid. Also doubles as the brand-new-user Home
              state's "3 nearby suggestions" (brief) when there are no Crews yet — same real,
              location-resolved data, just a heading that doesn't presuppose a Crew exists. */}
          {ideas && ideas.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="v2-eyebrow" style={{ marginBottom: 0 }}>{crews && crews.length > 0 ? 'For your Crews' : 'Worth a look nearby'}</div>
                <Link href="/explore" className="v2-muted" style={{ fontSize: 12.5, fontWeight: 600 }}>Discover</Link>
              </div>
              <div style={{ display: 'flex', gap: 10, overflowX: 'auto', margin: '0 -20px', padding: '2px 20px 8px' }}>
                {ideas.slice(0, 4).map((exp) => {
                  const price = formatPriceFrom(exp.priceMinMinor, exp.currency);
                  return (
                    <Link
                      key={exp.id}
                      href="/explore"
                      className="fade-up v2-hoverable"
                      style={{ flex: '0 0 auto', width: 140, borderRadius: 'var(--v2-r-sm)', overflow: 'hidden', boxShadow: 'var(--v2-shadow-sm)' }}
                    >
                      <div style={{ height: 84, background: v2Art(exp.imageUrl, exp.category) }} />
                      <div style={{ padding: '8px 10px', background: 'var(--v2-surface)' }}>
                        <div style={{ fontWeight: 700, fontSize: 11.5, lineHeight: 1.3, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exp.name}</div>
                        <div className="v2-dim" style={{ fontSize: 10 }}>
                          {new Date(exp.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}
                          {price && ` · ${price}`}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        </div>

        {/* DESKTOP CREWS RAIL — a persistent, glanceable list beside the feed (Slack/Discord-
            shaped), not a stretched single column with a dead void next to it. Real content,
            not decoration: every Crew, its own activity line, one tap into any of them. */}
        {crews && crews.length > 0 && (
          <div className="v2-home-rail">
            <div className="v2-card" style={{ padding: '18px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                <div className="v2-eyebrow" style={{ marginBottom: 0 }}>Your Crews</div>
                <Link href="/crews?new=1" className="v2-muted" style={{ fontSize: 12.5, fontWeight: 700 }}>+ New</Link>
              </div>
              {crews.map((crew) => {
                const status = crewStatusLine(crew);
                return (
                <Link key={crew.id} href={`/crews/${crew.id}`} className="v2-rail-crew-row">
                  <div style={{ position: 'relative', flexShrink: 0, padding: 2, borderRadius: 13, boxShadow: status.urgent ? '0 0 0 2px var(--v2-pop)' : 'none' }}>
                    <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={34} />
                    {status.urgent && (
                      <div className="v2-pop-in" style={{ position: 'absolute', top: -2, right: -2, width: 12, height: 12, borderRadius: '50%', background: 'var(--v2-pop)', border: '1.5px solid var(--v2-surface)' }} />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{crew.name}</div>
                    <div className={status.urgent ? undefined : 'v2-dim'} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, overflow: 'hidden', color: status.urgent ? 'var(--v2-pop)' : undefined, fontWeight: status.urgent ? 700 : 400 }}>
                      {status.kind === 'calendar' && <IconCalendar size={10} style={{ flexShrink: 0 }} />}
                      {status.kind === 'poll' && <IconPoll size={10} style={{ flexShrink: 0 }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.text}</span>
                    </div>
                  </div>
                </Link>
                );
              })}
            </div>
          </div>
        )}
        </div>
      </div>
      <TabBarV2 />
    </div>
  );
}
