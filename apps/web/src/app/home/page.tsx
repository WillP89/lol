'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { v2Art } from '@/lib/v2Art';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { messagePreview } from '@/lib/messagePreview';
import { IconCalendar, IconPoll } from '@/components/icons';

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

const AVATAR_COLORS = ['#ff2f7e', '#7c5cfc', '#2f8aff', '#ffc53d', '#34d399', '#ff7a3d'];
// One ring tint per Crew (hashed) — the identity marker for the Crew-bubble row below.
const CREW_RINGS = ['#7c5cfc', '#2f8aff', '#34d399', '#ffc53d', '#ff7a3d', '#ff2f7e'];

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
function crewRing(seed: string) {
  return CREW_RINGS[seedHash(seed, CREW_RINGS.length)];
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
 * Home — crew/social-first by design: people (Your people), what needs a response (Needs you)
 * and what your Crews are actually saying (In the groups) all come before anything you might do
 * next. "Next up" (a plan already locked) and "For your Crews" (a small, restrained discovery
 * strip) both sit below the fold deliberately — discovery feeds the social loop here, it doesn't
 * lead the page. See docs/DECISIONS.md#plot-design-reset.
 */
export default function HomePage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingPlan[] | null>(null);
  const [ideas, setIdeas] = useState<Experience[] | null>(null);
  const [me, setMe] = useState<{ displayName: string | null; email: string } | null>(null);
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
      .get<{ user: { displayName: string | null; email: string } }>('/users/me')
      .then((res) => { if (!cancelled) setMe(res.user); })
      .catch(() => {});
    const interval = setInterval(() => { loadCrews(); loadUpcoming(); }, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const nextPlan = upcoming?.find((p) => p.startsAt && new Date(p.startsAt).getTime() > Date.now()) ?? upcoming?.[0] ?? null;

  const needsAttention = useMemo(() => (crews ?? []).filter((c) => c.activePlan && !c.activePlan.iVoted), [crews]);

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
              <p className="v2-muted" style={{ fontSize: 14.5 }}>Here&rsquo;s what your people are up to.</p>
            </div>
            <Link
              href="/profile"
              aria-label="Your profile"
              style={{
                flexShrink: 0,
                width: 42,
                height: 42,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: 15,
                color: '#fff',
                background: me ? avatarColor(me.displayName ?? me.email) : 'var(--v2-ink-dim)',
                boxShadow: 'var(--v2-shadow-sm)',
              }}
            >
              {me ? initials(me.displayName, me.email) : ''}
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

          {/* YOUR PEOPLE — social-first: this is the first real content on the page, not
              discovery. A row of people, not a row of cards — a coloured ring (the Crew's own
              identity) around a stacked-avatar bubble, name below, the way Stories rows work. */}
          {crews && crews.length > 0 && (
            <div style={{ marginBottom: 30 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
                <div className="v2-eyebrow" style={{ marginBottom: 0 }}>Your people</div>
                <Link href="/crews" className="v2-muted" style={{ fontSize: 12.5, fontWeight: 600 }}>See all</Link>
              </div>
              <div style={{ display: 'flex', gap: 18, overflowX: 'auto', margin: '0 -20px', padding: '2px 20px 8px' }}>
                {crews.slice(0, 6).map((crew, i) => {
                  const status = crewStatusLine(crew);
                  return (
                  <Link
                    key={crew.id}
                    href={`/crews/${crew.id}`}
                    className="fade-up v2-stagger"
                    style={{ flex: '0 0 auto', width: 76, textAlign: 'center', ['--stagger-i' as string]: i }}
                  >
                    <div style={{ position: 'relative', width: 68, margin: '0 auto 8px' }}>
                      <div
                        style={{
                          width: 68,
                          height: 68,
                          borderRadius: '50%',
                          padding: 3,
                          // A Crew waiting on you gets its own ring colour (the signature pink,
                          // not the Crew's usual identity hue) — a genuinely different visual
                          // state at a glance, not just smaller caption text below.
                          background: status.urgent ? `conic-gradient(var(--v2-pop), #ff8fb8, var(--v2-pop))` : `conic-gradient(${crewRing(crew.id)}, ${crewRing(crew.id)}cc, ${crewRing(crew.id)})`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'var(--v2-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 3 }}>
                          <div className="stack">
                            {crew.members.slice(0, 3).map((m) => (
                              <div
                                key={m.user.id}
                                style={{
                                  width: 20, height: 20, borderRadius: '50%', marginLeft: -6, fontSize: 8, fontWeight: 800, color: '#fff',
                                  background: avatarColor(m.user.displayName ?? m.user.email), display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--v2-surface)',
                                }}
                              >
                                {initials(m.user.displayName, m.user.email)}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      {status.urgent && (
                        <div className="v2-pop-in" style={{ position: 'absolute', top: -1, right: -1, width: 16, height: 16, borderRadius: '50%', background: 'var(--v2-pop)', border: '2px solid var(--v2-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#fff', fontWeight: 800 }}>
                          !
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{crew.name}</div>
                    <div className={status.urgent ? undefined : 'v2-dim'} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, marginTop: 1, overflow: 'hidden', color: status.urgent ? 'var(--v2-pop)' : undefined, fontWeight: status.urgent ? 700 : 400 }}>
                      {status.kind === 'calendar' && <IconCalendar size={9} style={{ flexShrink: 0 }} />}
                      {status.kind === 'poll' && <IconPoll size={9} style={{ flexShrink: 0 }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.text}</span>
                    </div>
                  </Link>
                  );
                })}
              </div>
            </div>
          )}

          {/* NEEDS YOU */}
          {needsAttention.length > 0 && (
            <div style={{ marginBottom: 30 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Needs you</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {needsAttention.map((c) => (
                  <Link
                    key={c.id}
                    href={`/plans/${c.activePlan!.publicSlug}`}
                    className="v2-card v2-needs-you-card fade-up"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '15px 18px' }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{c.activePlan!.title}</div>
                      <div className="v2-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                        {c.name} · {c.activePlan!.inCount}/{c.activePlan!.totalMembers} voted
                      </div>
                    </div>
                    <span style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--v2-brand-ink)', background: 'var(--v2-brand)', padding: '9px 18px', borderRadius: 100 }}>
                      Vote
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* IN THE GROUPS — a real activity feed (who shared/said what, and where), the social
              signal a "what are my people up to?" Home actually needs before any hero card. */}
          {recentActivity.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 10 }}>In the groups</div>
              <div className="v2-card" style={{ padding: '4px 18px' }}>
                {recentActivity.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', gap: 12, padding: '13px 0', borderBottom: i < recentActivity.length - 1 ? '1px solid var(--v2-line)' : 'none' }}>
                    <div
                      style={{
                        flexShrink: 0, width: 34, height: 34, borderRadius: '50%', fontSize: 12, fontWeight: 800, color: '#fff',
                        background: avatarColor(c.latestMessage!.authorName), display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {c.latestMessage!.authorName.charAt(0).toUpperCase()}
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

          {/* NEXT UP — the one big, confident module further down: what's already decided, not
              what you might do. */}
          {nextPlan && (
            <Link
              href={`/plans/${nextPlan.publicSlug}`}
              className="fade-up v2-hoverable"
              style={{
                display: 'block',
                position: 'relative',
                height: 340,
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
                  Next up
                </span>
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '24px 26px' }}>
                <div className="v2-display" style={{ fontSize: 30, lineHeight: 1.08, color: '#fff', marginBottom: 10, maxWidth: '90%' }}>
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
                  <div style={{ position: 'relative', width: 38, height: 38, flexShrink: 0 }}>
                    <div style={{ width: 38, height: 38, borderRadius: '50%', padding: 2, background: status.urgent ? `conic-gradient(var(--v2-pop), #ff8fb8, var(--v2-pop))` : `conic-gradient(${crewRing(crew.id)}, ${crewRing(crew.id)}cc, ${crewRing(crew.id)})` }}>
                      <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'var(--v2-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div className="stack">
                          {crew.members.slice(0, 2).map((m) => (
                            <div key={m.user.id} style={{ width: 15, height: 15, borderRadius: '50%', marginLeft: -5, fontSize: 6.5, fontWeight: 800, color: '#fff', background: avatarColor(m.user.displayName ?? m.user.email), display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--v2-surface)' }}>
                              {initials(m.user.displayName, m.user.email)}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
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
