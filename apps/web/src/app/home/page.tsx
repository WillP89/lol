'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { v2Art } from '@/lib/v2Art';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { messagePreview } from '@/lib/messagePreview';
import { IconGathering, IconLock } from '@/components/icons';
import { PersonAvatar, CrewMark } from '@/components/Avatar';
import { identityGradient } from '@/lib/identity';
import { useScrollReveal } from '@/lib/useScrollReveal';

// A small local label map, not a shared helper — this is the one place Home shows a category as
// a short tag chip; Explore has its own richer category treatment.
const CATEGORY_TAG: Record<string, string> = {
  LIVE_MUSIC: 'Live music', CLUBBING: 'Clubbing', RESTAURANT: 'Restaurant', BAR: 'Bar',
  COMEDY: 'Comedy', THEATRE: 'Theatre', CINEMA: 'Cinema', ART_CULTURE: 'Art & culture',
  SPORT: 'Sport', FITNESS: 'Fitness', FESTIVAL: 'Festival', DAY_ACTIVITY: 'Day out', COMMUNITY: 'Community',
};

interface CrewSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  members: { user: { id: string; displayName: string | null; email: string; avatarUrl?: string | null } }[];
  // Real, persisted unread state — see apps/api/src/services/crew.ts#crewSummaryExtras. Never
  // computed client-side; the server is the only place that knows what's actually been read.
  unreadCount: number;
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
 * Home — HARD RESET (see docs/DECISIONS.md#plot-design-reset-3), not a restyle of the previous
 * attempt. That version was a dashboard: a bounded hero card, a grid of Crew tiles, a sticky
 * desktop right-rail — three separate places a Crew's people/state could live, one column/panel
 * per concept. Deleted outright. This version is ONE column at every viewport, built around a
 * single rule: the page adapts to whichever real state is strongest, and PEOPLE lead — a story
 * rail of large Crew identity marks is the very first thing on the page, above the greeting, not
 * a caption under a photo. Below it, one dominant edge-to-edge moment (a locked plan, or a
 * decision genuinely waiting on you), then a plain editorial feed with no card chrome.
 */
export default function HomePage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingPlan[] | null>(null);
  const [ideas, setIdeas] = useState<Experience[] | null>(null);
  const [me, setMe] = useState<{ displayName: string | null; email: string; avatarUrl: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useScrollReveal();

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
    <div className="v2 v2-app-shell">
      <div className="v2-shell-desktop">
        <div className="v2-page v2-home-page" style={{ paddingTop: 24 }}>
          {/* Header — small and secondary now; the story rail below it carries the page's real
              opening statement. The avatar here is a mobile-only affordance (desktop already has
              one pinned to the nav rail). */}
          <div className="fade-up" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <div>
              <div className="v2-display" style={{ fontSize: 23 }}>
                {greeting()}{firstName && <>, <span style={{ fontStyle: 'italic', color: 'var(--v2-pop)' }}>{firstName}</span></>}
              </div>
              <p key={pulse} className="v2-muted v2-pop-in" style={{ fontSize: 13, margin: '2px 0 0' }}>{pulse}</p>
            </div>
            <Link href="/profile" aria-label="Your profile" className="v2-tap-feedback" style={{ flexShrink: 0, borderRadius: '50%', boxShadow: 'var(--v2-shadow-sm)' }}>
              {me ? (
                <PersonAvatar name={me.displayName} email={me.email} photoUrl={me.avatarUrl} size={38} />
              ) : (
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--v2-ink-dim)' }} />
              )}
            </Link>
          </div>

          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginBottom: 16 }}>{error}</div>}

          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              <div style={{ display: 'flex', gap: 14 }}>
                {[1, 2, 3, 4].map((i) => <div key={i} className="v2-skeleton" style={{ width: 64, height: 64, borderRadius: 22, flexShrink: 0 }} />)}
              </div>
              <div className="v2-skeleton" style={{ height: 300, borderRadius: 0 }} />
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

          {/* THE STORY RAIL — people first. Every Crew as one large identity mark with a live-
              state ring (a bright pulsing ring means a vote's waiting on you; a green ring means
              a plan's locked; a plain ring means it's quiet) — the same one component at every
              viewport, not a grid of photo tiles on mobile and a different list on desktop. This
              replaces BOTH the old tile grid and the old desktop-only "Your Crews" rail. */}
          {crews && crews.length > 0 && (
            <div className="v2-story-rail" style={{ marginBottom: 28 }}>
              {crews.map((crew, i) => {
                const status = crewStatusLine(crew);
                const hasUnread = crew.unreadCount > 0;
                const tileHref = status.urgent ? `/plans/${crew.activePlan!.publicSlug}` : `/crews/${crew.id}`;
                // Priority order for the ring: a vote genuinely waiting on you beats unread
                // messages beats a locked plan beats nothing — the same "what's actually true
                // right now, most-important-first" rule the rest of Home's hero uses.
                const ringClass = status.urgent ? ' urgent' : hasUnread ? ' unread' : crew.upcomingPlan ? ' plan' : '';
                return (
                  <Link
                    key={crew.id}
                    href={tileHref}
                    className="v2-tap-feedback fade-up v2-stagger"
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0, width: 76, ['--stagger-i' as string]: i }}
                  >
                    <div style={{ position: 'relative' }}>
                      <div className={`v2-story-ring${ringClass}`}>
                        <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={68} />
                      </div>
                      {/* Real, persisted unread state (never faked client-side) — see
                          apps/api/src/services/crew.ts#crewSummaryExtras. A count up to 9, then
                          "9+" rather than a badge that keeps growing wider than the avatar. */}
                      {hasUnread && (
                        <div
                          className="v2-pop-in"
                          style={{
                            position: 'absolute', top: -2, right: -2, minWidth: 20, height: 20, padding: '0 5px', borderRadius: 10,
                            background: 'var(--v2-pop)', color: '#fff', fontSize: 10.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 0 0 2.5px var(--v2-bg)',
                          }}
                        >
                          {crew.unreadCount > 9 ? '9+' : crew.unreadCount}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 11, fontWeight: status.urgent || hasUnread ? 800 : 600, color: status.urgent ? 'var(--v2-pop)' : 'var(--v2-ink-muted)',
                        maxWidth: 76, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {crew.name}
                    </span>
                  </Link>
                );
              })}
              <Link href="/crews?new=1" className="v2-tap-feedback fade-up v2-stagger" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0, width: 76, ['--stagger-i' as string]: crews.length }}>
                <div style={{ width: 68, height: 68, borderRadius: 24, border: '1.5px dashed var(--v2-ink-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: 'var(--v2-ink-dim)', fontWeight: 300 }}>+</div>
                <span className="v2-dim" style={{ fontSize: 11, fontWeight: 600 }}>New</span>
              </Link>
            </div>
          )}

          {/* THE DOMINANT MOMENT — edge-to-edge, not a card floating in visible margin. The single
              biggest thing on the page when something's actually locked, or a decision genuinely
              waiting on you short of that. */}
          {nextPlan && (
            <Link
              href={`/plans/${nextPlan.publicSlug}`}
              className="fade-up v2-bleed"
              // Real bug found screenshotting this on an actual phone viewport (not just desktop
              // devtools): at 420px, this card's own pinned-bottom title sat close enough to the
              // physical bottom edge that on a real iPhone viewport (chrome visible, the DEFAULT
              // state — not the taller one you only get after scrolling) it rendered partly
              // underneath the floating nav pill, on first paint, with nothing scrolled yet. 340
              // keeps this "the dominant moment" (still by far the biggest thing on the page) while
              // clearing the fold on real hardware, not just a taller desktop-emulated viewport.
              style={{ display: 'block', position: 'relative', height: 340, overflow: 'hidden', marginBottom: 6 }}
            >
              <div
                className="v2-ken-burns"
                style={{ position: 'absolute', inset: 0, background: v2Art(nextPlan.imageUrl, nextPlan.category) }}
              />
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(200deg, rgba(22,19,15,0) 25%, rgba(22,19,15,0.6) 72%, rgba(22,19,15,0.9) 100%)' }} />
              <div style={{ position: 'absolute', top: 20, left: 20 }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--v2-brand-ink)', background: 'var(--v2-brand)', padding: '7px 14px', borderRadius: 100 }}>
                  <IconLock size={11} style={{ marginRight: 4, verticalAlign: -1.5 }} />Next up
                </span>
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '24px 20px' }}>
                <div className="v2-display" style={{ fontSize: 36, lineHeight: 1.02, color: '#fff', marginBottom: 10, maxWidth: '92%' }}>
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
              className="fade-up v2-bleed v2-hoverable"
              style={{ display: 'block', position: 'relative', height: 280, overflow: 'hidden', marginBottom: 6 }}
            >
              <div
                className="v2-ken-burns"
                style={{ position: 'absolute', inset: 0, background: identityGradient(heroNeedsAttention.id, 155) }}
              />
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(200deg, rgba(22,19,15,0) 25%, rgba(22,19,15,0.55) 100%)' }} />
              <div style={{ position: 'absolute', top: 20, left: 20, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 800, letterSpacing: '-0.01em', color: '#fff', background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(6px)', padding: '7px 14px', borderRadius: 100 }}>
                <IconGathering size={12} />Still deciding
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '22px 20px' }}>
                <div className="v2-display" style={{ fontSize: 26, lineHeight: 1.08, color: '#fff', marginBottom: 8, maxWidth: '92%' }}>
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

          {/* IN THE GROUPS — a plain editorial list (large face, real quote), no card chrome, no
              repeated white rectangle. */}
          {recentActivity.length > 0 && (
            <div style={{ marginTop: 26, marginBottom: 8 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 2 }}>In the groups</div>
              {recentActivity.map((c, i) => (
                <Link
                  key={c.id}
                  href={`/crews/${c.id}`}
                  className={`v2-editorial-row v2-reveal${c.unreadCount > 0 ? ' unread' : ''}`}
                  style={{ ['--reveal-i' as string]: i, textDecoration: 'none', color: 'inherit' }}
                >
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <PersonAvatar name={c.latestMessage!.authorName} email={c.latestMessage!.authorName} photoUrl={c.latestMessage!.authorAvatarUrl} size={44} />
                    {c.unreadCount > 0 && (
                      <div className="v2-pop-in" style={{ position: 'absolute', bottom: -1, right: -1, width: 12, height: 12, borderRadius: '50%', background: 'var(--v2-pop)', boxShadow: '0 0 0 2.5px var(--v2-bg)' }} />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="v2-display" style={{ fontSize: 16, lineHeight: 1.3, marginBottom: 2, fontWeight: c.unreadCount > 0 ? 700 : undefined }}>
                      &ldquo;{messagePreview(c.latestMessage!.body)}&rdquo;
                    </div>
                    <div className="v2-muted" style={{ fontSize: 12.5 }}>
                      <strong style={{ color: 'var(--v2-ink)' }}>{c.latestMessage!.authorName}</strong> in {c.name} · {timeAgo(c.latestMessage!.createdAt)}
                    </div>
                  </div>
                  {c.unreadCount > 0 && (
                    <span style={{ flexShrink: 0, alignSelf: 'center', fontSize: 10.5, fontWeight: 800, color: '#fff', background: 'var(--v2-pop)', borderRadius: 100, minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>
                      {c.unreadCount > 9 ? '9+' : c.unreadCount}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          )}

          {/* FOR YOUR CREWS — a few genuinely useful suggestions, deliberately small and last:
              discovery feeds the social loop, it doesn't lead the page. */}
          {ideas && ideas.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="v2-eyebrow" style={{ marginBottom: 0 }}>{crews && crews.length > 0 ? 'For your Crews' : 'Worth a look nearby'}</div>
                <Link href="/explore" className="v2-muted" style={{ fontSize: 12.5, fontWeight: 600 }}>Discover</Link>
              </div>
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto', margin: '0 -20px', padding: '2px 20px 8px' }}>
                {ideas.slice(0, 4).map((exp, i) => {
                  const price = formatPriceFrom(exp.priceMinMinor, exp.currency);
                  return (
                    <Link
                      key={exp.id}
                      href="/explore"
                      className="v2-reveal v2-hoverable"
                      style={{ flex: '0 0 auto', width: 172, borderRadius: 'var(--v2-r-md)', overflow: 'hidden', boxShadow: 'var(--v2-shadow-sm)', ['--reveal-i' as string]: i }}
                    >
                      <div style={{ position: 'relative', height: 110, background: v2Art(exp.imageUrl, exp.category) }}>
                        {CATEGORY_TAG[exp.category] && (
                          <span style={{ position: 'absolute', top: 8, left: 8, fontSize: 9.5, fontWeight: 800, letterSpacing: '0.02em', textTransform: 'uppercase', color: '#fff', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', padding: '4px 8px', borderRadius: 100 }}>
                            {CATEGORY_TAG[exp.category]}
                          </span>
                        )}
                      </div>
                      <div style={{ padding: '10px 12px', background: 'var(--v2-surface)' }}>
                        <div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.3, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exp.name}</div>
                        <div className="v2-dim" style={{ fontSize: 10.5 }}>
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
      <TabBarV2 />
    </div>
  );
}
