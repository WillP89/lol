'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { BottomSheet } from '@/components/BottomSheet';
import { v2Art } from '@/lib/v2Art';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { messagePreview } from '@/lib/messagePreview';
import { IconGathering, IconLock, IconCalendar, IconPoll, IconChat } from '@/components/icons';
import { PersonAvatar, CrewMark } from '@/components/Avatar';
import { identityGradient } from '@/lib/identity';
import { useScrollReveal } from '@/lib/useScrollReveal';

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

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
  activePlan: {
    id: string; title: string; publicSlug: string; inCount: number; totalMembers: number; iVoted: boolean;
    // The personalisation-engine pass's own signal — Plot's own automatic recommendation
    // engine proposed this, not a Crew member. See apps/api/src/services/crew.ts
    // #crewSummaryExtras (proposedByUserId === the Plot system user).
    isPlotFound: boolean; plotReasonText: string | null;
    imageUrl: string | null; category: string | null; venueName: string | null;
  } | null;
  upcomingPlan: {
    id: string; title: string; publicSlug: string; startsAt: string | null; venueName: string | null;
    isPlotFound: boolean; plotReasonText: string | null;
  } | null;
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
  description: string | null;
  startsAt: string;
  priceMinMinor: number | null;
  currency: string;
  imageUrl: string | null;
  venue: { name: string };
  // Same escape hatch Explore's own detail view already carries — the real source page for
  // whatever Plot's own normalized fields don't (full price tiers, seating, terms). See
  // services/personalHome.ts's own ExperienceWithVenue comment.
  listings?: { externalUrl: string }[];
}

// HOME = ME (docs/DECISIONS.md#personal-home) — the shape GET /home/personalized returns.
// Deliberately NOT the same shape as Explore's flat experience list: this is already grouped
// into the sections the directive asks for (For you / This weekend / one row per explicit
// interest / Near you / a small, separate "try something different"), each item carrying real,
// explainable reasons — never re-derived or guessed client-side.
interface HomeReason {
  code: string;
  label: string;
}
interface HomeItem {
  experience: Experience;
  reasons: HomeReason[];
}
interface HomeInterestRow {
  interestId: string;
  label: string;
  items: HomeItem[];
}
interface PersonalHome {
  personalized: boolean;
  forYou: HomeItem[];
  thisWeekend: HomeItem[];
  interestRows: HomeInterestRow[];
  nearYou: HomeItem[];
  exploration: HomeItem[];
  emptyMessage: string | null;
}
interface DiscoverySection {
  key: string;
  title: string;
  items: HomeItem[];
  /** Exploration items deliberately failed Stage-A eligibility (see personalHome.ts) — rendered
   *  visibly differently so it's never mistaken for a personalised pick, per Part 12. */
  isExploration?: boolean;
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
 * One "For you" / "This weekend" / per-interest / "Near you" / "Try something different" card —
 * the mobile inline-row renderer. Carries a real, honest reason line straight from the backend's
 * own `HomeItem.reasons` (see personalHome.ts) rather than a decorative caption invented here —
 * Part 26 of the personalisation directive: never fabricate a personalisation reason. Muted rows
 * (exploration) never show a reason at all, since nothing there was actually matched to taste.
 * The × is a real "not for me" tap, optimistically removed from view and reported to
 * `/home/personalized/:id/feedback` — see `sendHomeFeedback` above.
 *
 * Real, reported bug this fixes: tapping a card used to send you to the generic /explore page —
 * not this event, not any event, just Explore's own unfiltered list. `onOpen` now opens THIS
 * card's own detail (see the sheet built in HomePage below), same as tapping a result in Explore
 * already does.
 */
function DiscoveryCard({ item, index, muted, onOpen, onNotForMe }: { item: HomeItem; index: number; muted?: boolean; onOpen: () => void; onNotForMe: () => void }) {
  const { experience } = item;
  const price = formatPriceFrom(experience.priceMinMinor, experience.currency);
  const reason = item.reasons[0]?.label;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="v2-reveal v2-hoverable"
      style={{ flex: '0 0 auto', width: 172, borderRadius: 'var(--v2-r-md)', overflow: 'hidden', boxShadow: 'var(--v2-shadow-sm)', ['--reveal-i' as string]: index, opacity: muted ? 0.85 : 1, position: 'relative', border: 'none', padding: 0, textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }}
    >
      <div style={{ position: 'relative', height: 110, background: v2Art(experience.imageUrl, experience.category, experience.id) }}>
        {CATEGORY_TAG[experience.category] && (
          <span style={{ position: 'absolute', top: 8, left: 8, fontSize: 9.5, fontWeight: 800, letterSpacing: '0.02em', textTransform: 'uppercase', color: '#fff', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', padding: '4px 8px', borderRadius: 100 }}>
            {CATEGORY_TAG[experience.category]}
          </span>
        )}
        <span
          role="button"
          aria-label="Not for me"
          onClick={(e) => { e.stopPropagation(); onNotForMe(); }}
          style={{ position: 'absolute', top: 8, right: 8, width: 22, height: 22, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)', color: '#fff', fontSize: 13, lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          ×
        </span>
      </div>
      <div style={{ padding: '10px 12px', background: 'var(--v2-surface)' }}>
        <div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.3, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{experience.name}</div>
        <div className="v2-dim" style={{ fontSize: 10.5 }}>
          {new Date(experience.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}
          {price && ` · ${price}`}
        </div>
        {reason && !muted && <div className="v2-muted" style={{ fontSize: 10, marginTop: 3, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reason}</div>}
      </div>
    </button>
  );
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
  const router = useRouter();
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingPlan[] | null>(null);
  const [home, setHome] = useState<PersonalHome | null>(null);
  // Real-only removals — a "not for me" tap (see DiscoveryCard below) hides that one card
  // immediately rather than waiting on a full refetch, without ever fabricating a replacement.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [me, setMe] = useState<{ displayName: string | null; email: string; avatarUrl: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The event detail sheet — real, reported bug this fixes: tapping a Home card used to send
  // you to the generic /explore page, not the event itself, with no way to act on it at all.
  // Same "open detail -> Share to Crew -> pick a Crew" flow Explore's own detail sheet already
  // proved out, reused here rather than reinvented, backed by the same real
  // POST /crews/:id/plans/send endpoint.
  const [selected, setSelected] = useState<Experience | null>(null);
  const [pickingCrew, setPickingCrew] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
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
    // HOME = ME — a genuinely personal, sectioned feed (see PersonalHome above), not the same
    // flat/unfiltered list Explore shows. Real, live-reported bug this replaces: this used to
    // call Explore's own endpoint and just take the first few results — someone's explicit taste
    // (rap, street food, museums) had no way to produce a Home that looked any different from
    // anyone else's, since nothing here ever asked for anything grouped or reasoned about.
    api
      .get<PersonalHome>('/home/personalized')
      .then((res) => { if (!cancelled) setHome(res); })
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

  // Real, reported feedback: "so fucking basic", and it never differentiated a Crew genuinely
  // waiting on your vote from an event now locked in from a plain chat message — three very
  // different kinds of "something's happening" all rendered as one identical grey row. This now
  // pulls all three into one live feed with a distinct kind per entry, excluding whichever Crew
  // is already the page's own dominant hero above (never say the same thing twice on one screen).
  const heroCrewId = nextPlan?.crew.id ?? heroNeedsAttention?.id ?? null;
  type ActivityItem =
    | { kind: 'plotfound'; crew: CrewSummary }
    | { kind: 'vote'; crew: CrewSummary }
    | { kind: 'event'; crew: CrewSummary }
    | { kind: 'message'; crew: CrewSummary };
  const activityFeed = useMemo(() => {
    const list = (crews ?? []).filter((c) => c.id !== heroCrewId);
    // THE SIGNATURE MOMENT (personalisation-engine pass, Phase 14) — a Plan Plot itself found
    // and delivered, still awaiting your Crew's response, gets its own branded kind, first —
    // never lumped in with a plan a human happened to share. See PlotFoundCard below.
    const plotFoundItems: ActivityItem[] = list
      .filter((c) => c.activePlan && !c.activePlan.iVoted && c.activePlan.isPlotFound)
      .map((c) => ({ kind: 'plotfound', crew: c }));
    const plotFoundIds = new Set(plotFoundItems.map((i) => i.crew.id));
    const voteItems: ActivityItem[] = list
      .filter((c) => c.activePlan && !c.activePlan.iVoted && !plotFoundIds.has(c.id))
      .map((c) => ({ kind: 'vote', crew: c }));
    const votedIds = new Set([...plotFoundIds, ...voteItems.map((i) => i.crew.id)]);
    const eventItems: ActivityItem[] = list
      .filter((c) => c.upcomingPlan && !votedIds.has(c.id))
      .map((c) => ({ kind: 'event', crew: c }));
    const claimedIds = new Set([...votedIds, ...eventItems.map((i) => i.crew.id)]);
    const messageItems: ActivityItem[] = list
      .filter((c) => c.latestMessage && !claimedIds.has(c.id))
      .sort((a, b) => new Date(b.latestMessage!.createdAt).getTime() - new Date(a.latestMessage!.createdAt).getTime())
      .map((c) => ({ kind: 'message', crew: c }));
    return [...plotFoundItems, ...voteItems, ...eventItems, ...messageItems].slice(0, 4);
  }, [crews, heroCrewId]);

  // HOME = ME's own composition — real, named sections built straight from what the API already
  // grouped (see PersonalHome above), each one skipped outright when empty rather than padded
  // with filler (Part 16: "a sparse, accurate Home is better than a full, stupid Home"). Explicit
  // interest rows use whatever label the taxonomy gave that interest ("UK garage", "Street food"),
  // never a generic "More for you". `exploration` is built into its own separately-flagged
  // section rather than folded into any of the above, so the client can never blur the line
  // between "this matches you" and "try something different" (Part 12).
  const sections = useMemo<DiscoverySection[]>(() => {
    if (!home) return [];
    const withoutDismissed = (items: HomeItem[]) => items.filter((i) => !dismissedIds.has(i.experience.id));
    const list: DiscoverySection[] = [
      { key: 'for-you', title: home.personalized ? 'For you' : 'Worth a look nearby', items: withoutDismissed(home.forYou) },
      { key: 'weekend', title: 'This weekend', items: withoutDismissed(home.thisWeekend) },
      ...home.interestRows.map((row) => ({ key: `interest-${row.interestId}`, title: row.label, items: withoutDismissed(row.items) })),
      { key: 'near-you', title: 'Near you', items: withoutDismissed(home.nearYou) },
      { key: 'exploration', title: 'Try something different', items: withoutDismissed(home.exploration), isExploration: true },
    ];
    return list.filter((s) => s.items.length > 0);
  }, [home, dismissedIds]);

  // Part 18: feedback has to actually change the feed, not just log an analytics event into the
  // void. Optimistic on the client (the card disappears immediately) — the real write lands on
  // this person's own TasteProfile server-side (services/personalHome.ts#applyHomeFeedback),
  // never a Crew's, and takes effect on the NEXT Home load, not retroactively on this one.
  function sendHomeFeedback(experienceId: string, action: 'save' | 'not_for_me') {
    setDismissedIds((prev) => new Set(prev).add(experienceId));
    api.post(`/home/personalized/${experienceId}/feedback`, { action }).catch(() => {});
  }

  // Opening a card also counts as a real, positive signal — someone stopping to actually look at
  // an event is a stronger taste signal than it merely appearing in a scroll. Fire-and-forget,
  // same as Explore's own `save` action: never blocks the sheet opening on the network round trip.
  function openDetail(experience: Experience) {
    setSelected(experience);
    setSendError(null);
    api.post(`/home/personalized/${experience.id}/feedback`, { action: 'view' }).catch(() => {});
  }
  function closeDetail() {
    if (sending !== null) return;
    setSelected(null);
    setPickingCrew(false);
    setSendError(null);
  }
  async function sendToCrew(crewId: string) {
    if (!selected) return;
    setSending(crewId);
    try {
      const res = await api.post<{ plan: { publicSlug: string } }>(`/crews/${crewId}/plans/send`, { experienceId: selected.id });
      router.push(`/plans/${res.plan.publicSlug}`);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not send to Crew.');
      setSending(null);
      setPickingCrew(false);
    }
  }

  const loading = crews === null && !error;
  const firstName = me ? displayNameOf(me.displayName, me.email).split(' ')[0] : '';

  return (
    <div className="v2 v2-app-shell">
      <div className="v2-shell-desktop">
        <div className="v2-home-split">
        <div className="v2-page v2-home-page v2-home-main" style={{ paddingTop: 24 }}>
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
                      {/* Real, reported feedback: an urgent (vote-needed) Crew only ever got a
                          coloured ring + pulse to tell it apart from an unread one — real signal,
                          but one you have to already know the colour code to read at a glance.
                          A genuine icon badge (the same amber "vote needed" language the feed row
                          below uses) beats the plain numeric unread badge in priority, since a
                          vote waiting on you is the more actionable of the two. */}
                      {status.urgent ? (
                        <div
                          className="v2-pop-in"
                          style={{
                            position: 'absolute', top: -2, right: -2, width: 22, height: 22, borderRadius: '50%',
                            background: '#b9832a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 0 0 2.5px var(--v2-bg)',
                          }}
                        >
                          <IconPoll size={11} />
                        </div>
                      ) : hasUnread ? (
                        // Real, persisted unread state (never faked client-side) — see
                        // apps/api/src/services/crew.ts#crewSummaryExtras. A count up to 9, then
                        // "9+" rather than a badge that keeps growing wider than the avatar.
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
                      ) : null}
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
              {/* Real, reported feedback: this is the single biggest, most prominent element on
                  the whole page, and v2Art's generic per-category gradient+icon (the same
                  treatment every Crew's every plan in that category shares, an icon trying and
                  failing to read as a photo) carried too much visual weight at this size to get
                  away with looking generic — "boring stock". When there's a real photo it still
                  wins outright (same as everywhere else). When there isn't, this doesn't try to
                  fake one any more: a confident, honest colour surface instead — the Crew's OWN
                  identity colour (the one their mark is already drawn from everywhere else, so
                  it's a colour the user already associates with them, not a shared category
                  palette) with a fine grain texture for depth (a flat CSS gradient alone reads as
                  a vector graphic, not a considered surface), no icon pretending to be content.
                  The bold title typography already here is the actual visual — leaning into that
                  on purpose, the way a confident editorial "no photo yet" treatment should,
                  rather than dressing up a gradient as a substitute photo. */}
              <div
                className="v2-ken-burns"
                style={{
                  position: 'absolute', inset: 0,
                  background: nextPlan.imageUrl
                    ? `url("${nextPlan.imageUrl}") center / cover no-repeat`
                    : `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="140" height="140" filter="url(%23n)" opacity="0.22"/></svg>')}") repeat, ${identityGradient(nextPlan.crew.name, 155)}`,
                }}
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
              {/* THE SIGNATURE MOMENT, at the page's single most prominent slot — real, reported
                  feedback: this hero used to look identical whether a Plot recommendation or a
                  friend's own share was still awaiting votes, using the Crew's plain identity
                  colour either way. A Plot-found Plan now gets its OWN language: the real photo
                  (never the crew colour standing in for it), the same converging-signal mark and
                  "why this fits" reasoning as the smaller feed cards, so the biggest thing on
                  Home is unmistakably a Plot moment when it is one. */}
              {heroNeedsAttention.activePlan!.isPlotFound ? (
                <div className="v2-ken-burns" style={{ position: 'absolute', inset: 0, background: v2Art(heroNeedsAttention.activePlan!.imageUrl, heroNeedsAttention.activePlan!.category, heroNeedsAttention.activePlan!.id) }} />
              ) : (
                <div className="v2-ken-burns" style={{ position: 'absolute', inset: 0, background: identityGradient(heroNeedsAttention.id, 155) }} />
              )}
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(200deg, rgba(22,19,15,0) 25%, rgba(22,19,15,0.55) 100%)' }} />
              <div style={{ position: 'absolute', top: 20, left: 20, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 800, letterSpacing: '-0.01em', color: '#fff', background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(6px)', padding: '7px 14px', borderRadius: 100 }}>
                {heroNeedsAttention.activePlan!.isPlotFound ? (
                  <>
                    <span className="v2-plotfound-mark"><IconGathering size={12} /></span>
                    Plot found this for {heroNeedsAttention.name}
                  </>
                ) : (
                  <><IconGathering size={12} />Still deciding</>
                )}
              </div>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '22px 20px' }}>
                <div className="v2-display" style={{ fontSize: 26, lineHeight: 1.08, color: '#fff', marginBottom: 8, maxWidth: '92%' }}>
                  {heroNeedsAttention.activePlan!.title}
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'rgba(255,255,255,0.85)', marginBottom: 14 }}>
                  {heroNeedsAttention.activePlan!.isPlotFound && heroNeedsAttention.activePlan!.plotReasonText
                    ? heroNeedsAttention.activePlan!.plotReasonText
                    : `${heroNeedsAttention.name} · ${heroNeedsAttention.activePlan!.inCount}/${heroNeedsAttention.activePlan!.totalMembers} have voted`}
                </div>
                {/* Real, live-reported bug this fixes: "the random white box below A-Z event" —
                    the pill's own background was hardcoded to literal white ('#fff') while its
                    text used `--v2-brand-ink`, the token meant to sit ON TOP OF `--v2-brand`
                    (near-black in light mode) — pairing them here meant white text on a white
                    background, an invisible pill with no visible label. `--v2-brand` is the
                    correct background for `--v2-brand-ink` text; it's also what the identical
                    "Plot found this for {name}" tag earlier in this same file (line ~396)
                    already correctly uses — one consistent, theme-aware pairing, not two. */}
                <span style={{ display: 'inline-block', fontSize: 12.5, fontWeight: 800, color: 'var(--v2-brand-ink)', background: 'var(--v2-brand)', padding: '9px 18px', borderRadius: 100 }}>
                  {heroNeedsAttention.activePlan!.isPlotFound ? 'Respond →' : 'Cast your vote →'}
                </span>
              </div>
            </Link>
          )}

          {/* IN THE GROUPS — a real, differentiated live feed now, not one grey row shape reused
              for three unrelated situations. A vote genuinely needing you, an event now locked
              in, and a plain message each get their own icon, colour and copy — the same amber/
              green language the Crew chat page's own context strip uses, so it reads as one
              consistent signal system across the app, not three invented separately. */}
          {activityFeed.length > 0 && (
            <div style={{ marginTop: 26, marginBottom: 8 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 8 }}>In the groups</div>
              {activityFeed.map((item, i) => {
                const c = item.crew;
                if (item.kind === 'plotfound') {
                  const plan = c.activePlan!;
                  return (
                    <Link
                      key={`plotfound-${c.id}`}
                      href={`/plans/${plan.publicSlug}`}
                      className="v2-reveal v2-plotfound-card"
                      style={{
                        ['--reveal-i' as string]: i, textDecoration: 'none', color: 'inherit', display: 'block', position: 'relative',
                        height: 156, borderRadius: 'var(--v2-r-lg)', overflow: 'hidden', marginBottom: 10,
                        boxShadow: 'var(--v2-shadow-sm)',
                      }}
                    >
                      <div className="v2-ken-burns" style={{ position: 'absolute', inset: 0, background: v2Art(plan.imageUrl, plan.category, plan.id) }} />
                      <div
                        style={{
                          position: 'absolute', left: 0, right: 0, bottom: 0, height: '80%',
                          backdropFilter: 'blur(14px) saturate(115%)', WebkitBackdropFilter: 'blur(14px) saturate(115%)',
                          maskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.45) 28%, #000 60%)',
                          WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.45) 28%, #000 60%)',
                        }}
                      />
                      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(17,14,11,0) 22%, rgba(17,14,11,0.5) 55%, rgba(12,10,8,0.92) 100%)' }} />
                      {/* THE SIGNATURE MARK — the same converging-points shape already established
                          for "Plot found this" everywhere else in the product (the in-chat
                          recommendation card's own watermark, "Still deciding"'s tag) — never a
                          robot/sparkle/AI-assistant motif. A one-shot arrival animation plays the
                          concept literally: three signals gathering into one delivered thing. */}
                      <div style={{ position: 'absolute', top: 12, left: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="v2-plotfound-mark" style={{ color: '#fff' }}>
                          <IconGathering size={14} />
                        </span>
                        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.92)' }}>
                          Plot found this for {c.name}
                        </span>
                      </div>
                      <div style={{ position: 'absolute', left: 14, right: 14, bottom: 12 }}>
                        <div className="v2-display" style={{ fontSize: 18, lineHeight: 1.1, color: '#fff', marginBottom: 4 }}>{plan.title}</div>
                        {plan.plotReasonText && (
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.82)', marginBottom: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {plan.plotReasonText}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div className="stack">
                            {c.members.slice(0, 4).map((m, mi) => (
                              <div key={m.user.id} style={{ marginLeft: mi === 0 ? 0 : -8, borderRadius: '50%', boxShadow: '0 0 0 2px rgba(12,10,8,0.9)' }}>
                                <PersonAvatar name={m.user.displayName} email={m.user.email} photoUrl={m.user.avatarUrl} size={24} />
                              </div>
                            ))}
                          </div>
                          <span style={{ fontSize: 11.5, fontWeight: 800, color: '#fff', background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(4px)', padding: '7px 14px', borderRadius: 100 }}>
                            Respond →
                          </span>
                        </div>
                      </div>
                    </Link>
                  );
                }
                if (item.kind === 'vote') {
                  const plan = c.activePlan!;
                  return (
                    <Link
                      key={`vote-${c.id}`}
                      href={`/plans/${plan.publicSlug}`}
                      className="v2-notify-row tone-vote v2-reveal"
                      style={{ ['--reveal-i' as string]: i, textDecoration: 'none', color: 'inherit' }}
                    >
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(185,131,42,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a5f1f' }}>
                          <IconPoll size={22} />
                        </div>
                        <div className="v2-live-dot" style={{ position: 'absolute', top: -1, right: -1, width: 13, height: 13, borderRadius: '50%', background: '#b9832a', boxShadow: '0 0 0 2.5px var(--v2-bg)', ['--dot-glow' as string]: 'rgba(185,131,42,0.5)' }} />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#8a5f1f', marginBottom: 4 }}>Vote needed</div>
                        <div className="v2-display" style={{ fontSize: 17.5, lineHeight: 1.25, marginBottom: 3, fontWeight: 700 }}>{plan.title}</div>
                        <div className="v2-muted" style={{ fontSize: 13 }}>{c.name} · {plan.inCount}/{plan.totalMembers} voted</div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 800, color: '#fff', background: '#b9832a', padding: '10px 16px', borderRadius: 100 }}>Vote →</span>
                    </Link>
                  );
                }
                if (item.kind === 'event') {
                  const plan = c.upcomingPlan!;
                  return (
                    <Link
                      key={`event-${c.id}`}
                      href={`/plans/${plan.publicSlug}`}
                      className="v2-notify-row tone-event v2-reveal"
                      style={{ ['--reveal-i' as string]: i, textDecoration: 'none', color: 'inherit' }}
                    >
                      <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(27,122,77,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1b7a4d', flexShrink: 0 }}>
                        <IconCalendar size={22} />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#1b7a4d', marginBottom: 4 }}>Locked in</div>
                        <div className="v2-display" style={{ fontSize: 17.5, lineHeight: 1.25, marginBottom: 3, fontWeight: 700 }}>{plan.title}</div>
                        <div className="v2-muted" style={{ fontSize: 13 }}>
                          {c.name}
                          {plan.startsAt && ` · ${new Date(plan.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`}
                          {plan.venueName && ` · ${plan.venueName}`}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 800, color: '#fff', background: 'var(--v2-green)', padding: '10px 16px', borderRadius: 100 }}>View →</span>
                    </Link>
                  );
                }
                const justArrived = Date.now() - new Date(c.latestMessage!.createdAt).getTime() < 5 * 60_000;
                // Plot's own voice, not lumped in with an ordinary human message — real, reported
                // feedback: this fell through to the exact same plain grey/pink row as anyone
                // else's text, generic "PL" initials included, the moment a plotfound plan wasn't
                // ALSO still awaiting a vote (the only case the big plotfound card above catches).
                // A message Plot itself posted is a branded product moment every time, not just
                // when it happens to coincide with an unvoted plan.
                const isPlotMessage = c.latestMessage!.authorName === 'Plot';
                return (
                  <Link
                    key={`message-${c.id}`}
                    href={`/crews/${c.id}`}
                    className={`v2-notify-row v2-reveal${isPlotMessage ? ' tone-plot' : ` tone-message${c.unreadCount > 0 ? ' unread' : ''}`}`}
                    style={{ ['--reveal-i' as string]: i, textDecoration: 'none', color: 'inherit' }}
                  >
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <PersonAvatar name={c.latestMessage!.authorName} email={c.latestMessage!.authorName} photoUrl={c.latestMessage!.authorAvatarUrl} size={52} />
                      {(c.unreadCount > 0 || justArrived) && (
                        <div className={`v2-pop-in${justArrived ? ' v2-live-dot' : ''}`} style={{ position: 'absolute', bottom: -1, right: -1, width: 13, height: 13, borderRadius: '50%', background: 'var(--v2-pop)', boxShadow: '0 0 0 2.5px var(--v2-bg)', ['--dot-glow' as string]: 'rgba(255,47,126,0.5)' }} />
                      )}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      {isPlotMessage && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--v2-pop)', marginBottom: 4 }}>
                          <IconGathering size={12} />
                          Plot
                        </div>
                      )}
                      <div className="v2-display" style={{ fontSize: 17.5, lineHeight: 1.3, marginBottom: 3, fontWeight: isPlotMessage || c.unreadCount > 0 ? 700 : undefined }}>
                        {isPlotMessage ? messagePreview(c.latestMessage!.body) : <>&ldquo;{messagePreview(c.latestMessage!.body)}&rdquo;</>}
                      </div>
                      <div className="v2-muted" style={{ fontSize: 13 }}>
                        {isPlotMessage ? c.name : (<><strong style={{ color: 'var(--v2-ink)' }}>{c.latestMessage!.authorName}</strong> in {c.name}</>)} · {justArrived ? 'just now' : timeAgo(c.latestMessage!.createdAt)}
                      </div>
                    </div>
                    {isPlotMessage ? (
                      <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 800, color: '#fff', background: 'var(--v2-pop)', padding: '10px 16px', borderRadius: 100 }}>View →</span>
                    ) : c.unreadCount > 0 ? (
                      <span style={{ flexShrink: 0, alignSelf: 'center', fontSize: 11.5, fontWeight: 800, color: '#fff', background: 'var(--v2-pop)', borderRadius: 100, minWidth: 23, height: 23, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px' }}>
                        {c.unreadCount > 9 ? '9+' : c.unreadCount}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          )}

          {/* HOME = ME — real, named sections (For you / This weekend / one row per explicit
              interest / Near you / a small, separately-labelled Try something different),
              deliberately small and last: discovery feeds the social loop, it doesn't lead the
              page. Desktop ≥1280px hides this in favour of the persistent vertical rail (see
              .v2-home-discover-rail below) — mobile/tablet/narrow-desktop keep it. Every section
              is already real (skipped by `sections` above when empty) — never padded to look
              fuller, per the product's own "sparse and accurate beats full and stupid" rule. */}
          {sections.map((section) => (
            <div key={section.key} className="v2-home-ideas-inline" style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="v2-eyebrow" style={{ marginBottom: 0, color: section.isExploration ? 'var(--v2-ink-dim)' : undefined }}>{section.title}</div>
                <Link href="/explore" className="v2-muted" style={{ fontSize: 12.5, fontWeight: 600 }}>Discover</Link>
              </div>
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto', margin: '0 -20px', padding: '2px 20px 8px' }}>
                {section.items.slice(0, 6).map((item, i) => (
                  <DiscoveryCard
                    key={item.experience.id}
                    item={item}
                    index={i}
                    muted={section.isExploration}
                    onOpen={() => openDetail(item.experience)}
                    onNotForMe={() => sendHomeFeedback(item.experience.id, 'not_for_me')}
                  />
                ))}
              </div>
            </div>
          ))}

          {home?.emptyMessage && sections.length === 0 && (
            // Part 16, taken literally: never silently show nothing when there's genuinely
            // nothing relevant right now — say so, and give a real way out rather than quietly
            // relaxing the very preferences someone explicitly set.
            <div className="v2-dim fade-up" style={{ marginTop: 20, padding: '18px 0', fontSize: 13, textAlign: 'center' }}>
              {home.emptyMessage}{' '}
              <Link href="/explore" className="v2-muted" style={{ fontWeight: 700 }}>Explore further out →</Link>
            </div>
          )}

          {/* THE BRAND MOMENT — real, reported feedback on an earlier attempt to fill this same
              space: piling in MORE event cards just turned Home into a second copy of Explore.
              This isn't discovery, it's Plot explaining itself — the one thing an event listing
              can't do. A quiet page (nothing locked, nothing to vote on) is exactly the moment
              worth spending on "here's what I'm actually doing for you" instead of more listings,
              so this sits fixed at the bottom of the page rather than only appearing when the
              feed above runs short — it's not filler, it's the product's own voice. */}
          <div className="fade-up v2-brand-moment" style={{ marginTop: 28 }}>
            <span className="v2-plotfound-mark" style={{ color: 'var(--v2-pop)' }}><IconGathering size={20} /></span>
            <div className="v2-eyebrow" style={{ margin: '10px 0 6px' }}>How Plot works</div>
            <div className="v2-display" style={{ fontSize: 19, lineHeight: 1.25, marginBottom: 8 }}>
              {crews && crews.length > 0
                ? "It's not just a list of events."
                : 'Start a Crew and Plot goes to work.'}
            </div>
            <p className="v2-muted" style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
              {crews && crews.length > 0
                ? "Plot learns what each Crew actually says yes to, then quietly puts together the next thing worth doing — so “we should do something” turns into a real plan, without anyone having to chase it."
                : "Bring your people in, tell Plot what your Crew's into, and it'll start finding the plans worth putting to a vote — automatically, from then on."}
            </p>
          </div>
        </div>

        {/* THE DESKTOP DISCOVER RAIL — real content under each section header, not empty margin
            (see globals.css's own comment on the bug this fixes). Same `sections` data the
            mobile rows already fetched; a real vertical list per section, not a second
            horizontal strip squeezed into a narrow column. Only rendered ≥1280px (globals.css),
            so this never shows twice. */}
        {sections.length > 0 && (
          <aside className="v2-home-discover-rail">
            {sections.map((section) => (
              <div key={section.key} style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div className="v2-eyebrow" style={{ marginBottom: 0, color: section.isExploration ? 'var(--v2-ink-dim)' : undefined }}>{section.title}</div>
                  <Link href="/explore" className="v2-muted" style={{ fontSize: 12.5, fontWeight: 600 }}>See all</Link>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {section.items.slice(0, 4).map((item) => {
                    const { experience } = item;
                    const price = formatPriceFrom(experience.priceMinMinor, experience.currency);
                    const reason = item.reasons[0]?.label;
                    return (
                      <button
                        key={experience.id}
                        type="button"
                        onClick={() => openDetail(experience)}
                        className="v2-hoverable"
                        style={{ display: 'flex', gap: 12, alignItems: 'center', borderRadius: 'var(--v2-r-md)', overflow: 'hidden', boxShadow: 'var(--v2-shadow-sm)', background: 'var(--v2-surface)', opacity: section.isExploration ? 0.85 : 1, border: 'none', padding: 0, width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }}
                      >
                        <div style={{ flexShrink: 0, width: 72, height: 72, background: v2Art(experience.imageUrl, experience.category, experience.id) }} />
                        <div style={{ minWidth: 0, flex: 1, padding: '8px 12px 8px 0' }}>
                          {CATEGORY_TAG[experience.category] && (
                            <div className="v2-dim" style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', marginBottom: 3 }}>
                              {CATEGORY_TAG[experience.category]}
                            </div>
                          )}
                          <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{experience.name}</div>
                          <div className="v2-dim" style={{ fontSize: 11 }}>
                            {new Date(experience.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}
                            {price && ` · ${price}`}
                          </div>
                          {/* THE EXPLAINABILITY LAYER — a real, computed reason, never a fabricated
                              "popular with people like you" (see personalHome.ts's own scorer). */}
                          {reason && !section.isExploration && (
                            <div className="v2-muted" style={{ fontSize: 10.5, marginTop: 2, fontStyle: 'italic' }}>{reason}</div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </aside>
        )}
        </div>
      </div>

      {/* THE EVENT DETAIL SHEET — real, reported bug this fixes: tapping any Home card used to
          navigate to /explore's own generic list, not the event you actually tapped, with no way
          to act on it. This is the same "see the real thing -> Share to Crew -> pick a Crew" flow
          Explore's own detail sheet already proved out (see app/explore/page.tsx), reused here
          rather than reinvented — one real POST /crews/:id/plans/send endpoint, one mental model,
          wherever an event appears in the product. */}
      <BottomSheet open={selected !== null} onClose={closeDetail}>
        {selected && !pickingCrew ? (
          <div>
            <div style={{ position: 'relative', margin: '-10px -20px 16px', height: 260, background: v2Art(selected.imageUrl, selected.category, selected.id) }}>
              <span style={{ position: 'absolute', top: 14, left: 14, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#fff', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', padding: '5px 10px', borderRadius: 100 }}>
                {selected.category.replace(/_/g, ' ')}
              </span>
            </div>
            <h2 className="v2-display" style={{ fontSize: 22, marginBottom: 6 }}>{selected.name}</h2>
            <div className="v2-muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
              {selected.venue.name} · {formatWhen(selected.startsAt)} ·{' '}
              {formatPriceFrom(selected.priceMinMinor, selected.currency) || 'Price not listed here'}
            </div>
            {selected.description && <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--v2-ink-muted)', marginBottom: 16 }}>{selected.description}</p>}
            {selected.listings?.[0]?.externalUrl && (
              <a
                href={selected.listings[0].externalUrl}
                target="_blank"
                rel="noreferrer"
                className="v2-btn v2-btn-ghost v2-tap-feedback"
                style={{ width: '100%', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                View full details &amp; pricing ↗
              </a>
            )}
            {sendError && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginBottom: 12 }}>{sendError}</div>}
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={() => setPickingCrew(true)}>
              Share to Crew →
            </button>
          </div>
        ) : selected && pickingCrew ? (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Send &ldquo;{selected.name}&rdquo; to…</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {crews === null && <p className="v2-muted">Loading your Crews…</p>}
              {crews?.length === 0 && <p className="v2-muted">You&rsquo;re not in a Crew yet — <Link href="/crews">create one first</Link>.</p>}
              {crews?.map((crew) => (
                <button key={crew.id} className="v2-btn v2-btn-ghost" disabled={sending !== null} onClick={() => sendToCrew(crew.id)} style={{ justifyContent: 'flex-start', gap: 8 }}>
                  {sending === crew.id ? 'Sending…' : (<><IconChat size={15} />{crew.name}</>)}
                </button>
              ))}
              <button className="v2-btn v2-btn-ghost" onClick={() => setPickingCrew(false)} disabled={sending !== null}>← Back</button>
            </div>
          </div>
        ) : null}
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
