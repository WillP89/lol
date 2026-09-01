'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { v2Art } from '@/lib/v2Art';
import { messagePreview } from '@/lib/messagePreview';
import { useVisualViewportHeight } from '@/lib/useVisualViewportHeight';
import { BottomSheet } from '@/components/BottomSheet';
import { TabBarV2 } from '@/components/TabBarV2';
import { PersonAvatar, CrewMark } from '@/components/Avatar';
import { MediaUploadButton } from '@/components/MediaUploadButton';
import { IconSpark, IconPlace, IconPoll, IconCalendar, IconFlag, IconLock, IconGathering, IconAddPerson } from '@/components/icons';
import { identityPair } from '@/lib/identity';

interface CrewListItem {
  id: string;
  name: string;
  imageUrl: string | null;
  members: { user: { id: string; displayName: string | null; email: string; avatarUrl?: string | null } }[];
  latestMessage: { body: string; authorName: string; createdAt: string } | null;
  activePlan: { title: string } | null;
  upcomingPlan: { title: string } | null;
}

interface Reaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  reactedBy: string[];
}

interface Poll {
  id: string;
  question: string;
  options: string[];
  kind: 'GENERAL' | 'AVAILABILITY';
  counts: Record<string, number>;
  votersByOption: Record<string, string[]>;
  totalVotes: number;
  myVote: string | null;
}

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string | null; email: string; avatarUrl?: string | null };
  reactions: Reaction[];
  poll: Poll | null;
}

interface ExploreExperienceLite {
  id: string;
  name: string;
  description?: string;
  category: string;
  startsAt: string;
  venue: { name: string; city?: string };
  priceMinMinor: number | null;
  priceMaxMinor?: number | null;
  currency: string;
  imageUrl: string | null;
}

const REACTION_CHOICES = ['👍', '❤️', '😂', '🎉'];

type MemberLite = { user: { id: string; displayName: string | null; email: string; avatarUrl?: string | null } };

/** One named group in the "who's behind this tally" sheet — see `computeVoterSheet` below. A
 * poll option opens with a single group; an IN/MAYBE/CAN'T breakdown or a multi-emoji reaction
 * opens with one group per bucket. */
type VoterGroup = { label: string; userIds: string[] };
/** What to show is resolved from a lightweight *source*, not a frozen snapshot of ids — the
 * brief's own requirement is "live-updating": if someone else votes while the sheet is open, it
 * should visibly move, the same way the underlying card does. Storing "which plan/poll/message"
 * and re-deriving the actual group membership from current state on every render achieves that
 * for free, using data CrewPage is already re-fetching on its poll interval. */
type VoterSheetSource =
  | { kind: 'plan'; planId: string }
  | { kind: 'poll'; messageId: string }
  | { kind: 'reactions'; messageId: string };
type OpenVoterSheet = (source: VoterSheetSource) => void;

interface PlanCardData {
  plan: {
    id: string;
    title: string;
    publicSlug: string;
    status: string;
    proposedByUserId: string;
    votes: { userId: string; vote: string }[];
    experience: {
      name: string;
      category: string;
      startsAt: string;
      priceMinMinor: number | null;
      currency: string;
      imageUrl: string | null;
      venue: { name: string } | null;
    } | null;
  };
  // The backend already computes the full state-machine pulse (services/plan.ts) — status
  // (SHARED → GATHERING_INTEREST → LIKELY → READY → BOOKED), maybe/out breakdown, the lot. The
  // card used to only destructure inCount/totalMembers off this and throw the rest away, which
  // is why it read as a flat counter instead of an idea with a life cycle.
  pulse: { inCount: number; maybeCount: number; outCount: number; totalMembers: number; level: number; status: string };
  // Present only when this Plan came from the automatic Crew recommendation engine, not a
  // member sharing something themselves — see docs/DECISIONS.md#crew-auto-recommendations.
  recommendation?: { id: string; reasonText: string; status: string } | null;
}

interface Plan {
  id: string;
  title: string;
  status: string;
  publicSlug: string;
  votes: { vote: string }[];
  members: unknown[];
  experience: { category: string; startsAt: string; venue: { name: string } | null } | null;
}

interface CrewDetail {
  id: string;
  name: string;
  imageUrl: string | null;
  inviteCode: string;
  members: { role: string; user: { id: string; displayName: string | null; email: string; avatarUrl?: string | null } }[];
  dna: { confidence: string; topCategories: string[]; medianSpendMinor: number; bestNights: string[]; usualAreas: string[] } | null;
  plans: Plan[];
}

interface DayAvailability {
  day: string;
  freeCount: number;
  totalMembers: number;
}

const ACTIVE_DECISION_STATUSES = new Set(['SHARED', 'GATHERING_INTEREST', 'LIKELY', 'READY']);
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const POLL_INTERVAL_MS = 3000;
// The composer's auto-grow ceiling — about 6 lines at the composer's own font size, past which
// it scrolls internally rather than eating the whole screen on a long paste.
const COMPOSER_MAX_HEIGHT = 140;
// Two distinct announcement formats land in chat: a member sharing something themselves, and
// the automatic recommendation engine's own distinct copy (services/plan.ts#
// createRecommendationPlanForCrew) — deliberately different wording/emoji so a recommendation
// never reads as if a real person shared it. Both still need to resolve to the same rich
// EventCard, which is what tripped this up the first time: adding the second format here
// without teaching the frontend to recognise it left it rendering as a bare text bubble
// instead of a plan card — caught via a real multi-user Playwright run, not code reading. See
// docs/DECISIONS.md#crew-auto-recommendations.
const MEMBER_PLAN_ANNOUNCEMENT = /^Sent "(.+)" to the Crew — \/plans\/([a-zA-Z0-9-]+)$/;
const RECOMMENDATION_PLAN_ANNOUNCEMENT = /^Plot found something your Crew might like: "(.+)" — \/plans\/([a-zA-Z0-9-]+)$/;
function matchPlanAnnouncement(body: string): { title: string; slug: string } | null {
  const memberMatch = body.match(MEMBER_PLAN_ANNOUNCEMENT);
  if (memberMatch) return { title: memberMatch[1], slug: memberMatch[2] };
  const recMatch = body.match(RECOMMENDATION_PLAN_ANNOUNCEMENT);
  if (recMatch) return { title: recMatch[1], slug: recMatch[2] };
  return null;
}

const LOCKABLE_STATUSES = new Set(['SHARED', 'GATHERING_INTEREST', 'LIKELY', 'READY']);

// The auto-recommendation system's travel-range chips (brief: "Nearby/25mi/50mi/Worth
// travelling", not a slider) — metres, since that's what the API stores; miles is a UK-
// convention display detail only. See docs/DECISIONS.md#crew-auto-recommendations.
const RADIUS_CHIPS: { label: string; meters: number }[] = [
  { label: 'Nearby', meters: 8047 }, // ~5 miles
  { label: 'Within 25mi', meters: 40225 },
  { label: 'Within 50mi', meters: 80450 },
  { label: 'Worth travelling', meters: 160934 }, // ~100 miles
];

/** A status → what-to-say map for the shared-idea life cycle (services/plan.ts#derivePulseStatus).
 * The point: the SAME card should not read identically at every stage — "Robin shared this" is a
 * different moment from "3 in · likely happening" is a different moment from "Confirmed". */
function planStageCopy(status: string, pulse: PlanCardData['pulse'], proposerName: string): string {
  if (status === 'LOCKED' || status === 'BOOKED') return 'Confirmed';
  if (status === 'READY') return `Ready — ${pulse.inCount}/${pulse.totalMembers} in`;
  if (status === 'LIKELY') return `Likely happening · ${pulse.inCount} in`;
  if (status === 'GATHERING_INTEREST') return `${pulse.inCount} in so far`;
  return `${proposerName} shared this — who's in?`;
}

/** The rich event-share card — the "shared idea" object, with an actual life cycle rather than a
 * flat counter: who suggested it, who's visibly converging on it (avatars, not just a number),
 * and a real vote surface right here in the conversation (previously voting IN required leaving
 * the thread entirely for the separate public Plan Card page — a real continuity gap, not a
 * styling one). `v2Art` gives it the same category-tinted composition as Explore/Home. A still-
 * open Plan gets its own one-tap "Lock it in" right here — the payoff moment shouldn't require
 * navigating away from the conversation it happened in. */
function EventCard({
  data, members, me, onLock, locking, justLocked, onVote, onExpandVoters, onRespondRecommendation,
}: {
  data: PlanCardData;
  members: MemberLite[];
  me: string | null;
  onLock: (planId: string) => void;
  locking: boolean;
  justLocked: boolean;
  onVote: (planId: string, vote: 'in' | 'maybe' | 'out') => void;
  onExpandVoters: OpenVoterSheet;
  onRespondRecommendation: (recommendationId: string) => void;
}) {
  const exp = data.plan.experience;
  const lockable = LOCKABLE_STATUSES.has(data.plan.status);
  const locked = data.plan.status === 'LOCKED' || data.plan.status === 'BOOKED' || justLocked;
  const proposer = members.find((m) => m.user.id === data.plan.proposedByUserId)?.user;
  // A recommendation's proposer is the Plot system user, which is deliberately never a
  // CrewMember (see docs/DECISIONS.md#crew-auto-recommendations) — `members.find` correctly
  // finds nothing, so this reads "Plot shared this" rather than the generic "Someone" fallback,
  // which is itself part of what makes an automatic recommendation distinguishable from a real
  // person's share without a separate disclaimer.
  const proposerName = data.recommendation ? 'Plot' : proposer ? displayNameOf(proposer.displayName, proposer.email).split(' ')[0] : 'Someone';
  const inVoterIds = data.plan.votes.filter((v) => v.vote === 'IN').map((v) => v.userId);
  const maybeVoterIds = data.plan.votes.filter((v) => v.vote === 'MAYBE').map((v) => v.userId);
  const outVoterIds = data.plan.votes.filter((v) => v.vote === 'OUT').map((v) => v.userId);
  const myVote = data.plan.votes.find((v) => v.userId === me)?.vote ?? null;
  const openBreakdown = () => onExpandVoters({ kind: 'plan', planId: data.plan.id });
  return (
    <div
      className={`v2-hoverable${justLocked ? ' v2-lock-transform' : ' fade-up'}`}
      style={{
        width: 264, borderRadius: 'var(--v2-r-md)', overflow: 'hidden', background: 'var(--v2-surface)',
        // A recommendation reads as a distinct signature object at a glance — its OWN outer
        // ring, not just a small badge buried below the image — so scanning a conversation full
        // of ordinary shares, a Plot-found card is visually singled out before you've read a
        // single word on it, the way a shared Reel or a Spotify card is instantly recognisable
        // as its own kind of object in other products (without borrowing their exact look).
        boxShadow: data.recommendation ? '0 0 0 1.5px rgba(255,47,126,0.4), var(--v2-shadow-sm)' : 'var(--v2-shadow-sm)',
      }}
    >
      <Link href={`/plans/${data.plan.publicSlug}`} style={{ display: 'block' }}>
        <div className={locked ? `v2-event-art-locked${justLocked ? ' v2-just-locked' : ''}` : undefined} style={{ height: 120, background: v2Art(exp?.imageUrl, exp?.category), position: 'relative', overflow: 'hidden' }}>
          {/* The mark lives ON the image itself now, not only in a text line beneath it — large,
              faint, watermark-scale (the same treatment the category fallback art already uses
              for its own icon), so even glancing past the card at speed, the shape registers as
              "Plot found this" before any text does. */}
          {data.recommendation && (
            <div style={{ position: 'absolute', top: -6, right: -10, opacity: 0.16, color: '#fff', transform: 'rotate(8deg)' }}>
              <IconGathering size={72} />
            </div>
          )}
          {/* The definitive-state overlay — date/venue moving from "proposed" to "confirmed" is
              the actual payoff of Lock It In, so it happens right on the card people were
              already looking at, not only in a separate confetti layer. Deliberately NOT a
              floating icon-in-a-circle badge (a real, reported regression: that treatment read
              as a sticker/emoji dropped onto the photo, exactly what the brief bans) — a scrim
              wash across the whole image, the same "the object itself changes state" idea a
              photo caption bar uses, not a decoration stuck on top of it. */}
          {locked && (
            <div className="v2-pop-in" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', padding: '10px 12px', background: 'linear-gradient(180deg, rgba(15,60,38,0) 55%, rgba(11,46,29,0.88) 100%)', pointerEvents: 'none' }}>
              <span style={{ color: '#fff', fontSize: 12.5, fontWeight: 800, letterSpacing: '0.01em' }}>Locked in</span>
            </div>
          )}
          {/* The distinguishable "this is Plot, not a person" marker, moved onto the primary
              image real estate (top-right, clear of "Locked in" at top-left) rather than tucked
              below it in the text area — brief: unprompted delivery must read as native to the
              conversation but never pretend to be a human share, and specifically NOT an "AI
              sparkle" mark (IconSpark, used elsewhere for a person's own found idea) —
              IconGathering (loose converging points) is Plot noticing a pattern the Crew already
              likes, not magic. See docs/DECISIONS.md#plot-brand-system. */}
          {data.recommendation && (
            <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', alignItems: 'center', gap: 5, background: 'var(--v2-brand)', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', padding: '5px 9px', borderRadius: 100 }}>
              <IconGathering size={11} /><span>Plot found this</span>
            </div>
          )}
          {/* Who's actually converging on this, right on the object itself — not buried in a
              text line beneath it. Brief: "the group should visually gather around the idea." */}
          {inVoterIds.length > 0 && (
            <div className="stack" style={{ position: 'absolute', bottom: 9, left: 10 }}>
              {inVoterIds.slice(0, 4).map((id) => {
                const voter = members.find((x) => x.user.id === id)?.user;
                if (!voter) return null;
                return (
                  <div key={id} className="v2-pop-in" style={{ marginLeft: -6, borderRadius: '50%', boxShadow: '0 0 0 2px rgba(22,19,15,0.5)' }}>
                    <PersonAvatar name={voter.displayName} email={voter.email} photoUrl={voter.avatarUrl} size={22} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ padding: '12px 14px 8px' }}>
          <div className="v2-display" style={{ fontSize: 15, marginBottom: 4 }}>{data.plan.title}</div>
          {exp && (
            <div className="v2-muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {exp.venue?.name ?? 'Venue TBC'} · {new Date(exp.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              {formatPriceFrom(exp.priceMinMinor) && ` · ${formatPriceFrom(exp.priceMinMinor)}`}
            </div>
          )}
          {/* A small, honest, non-creepy explanation — never the raw score. */}
          {data.recommendation && (
            <div className="v2-dim" style={{ fontSize: 11.5, marginBottom: 8 }}>{data.recommendation.reasonText}</div>
          )}
          {/* The actual life-cycle line — different words at each stage, not the same "X/Y in"
              counter throughout. Keyed on `locked` so it crossfades in as its own fresh element
              the instant the card converges, rather than the text silently swapping in place. */}
          <div key={locked ? 'locked' : 'pending'} className="v2-pop-in" style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
            {locked && <IconLock size={12} style={{ flexShrink: 0, color: 'var(--v2-green)' }} />}
            <span style={{ fontSize: 12, fontWeight: 700, color: locked ? 'var(--v2-green)' : 'var(--v2-ink)' }}>
              {locked ? 'Locked in' : planStageCopy(data.plan.status, data.pulse, proposerName)}
            </span>
          </div>
        </div>
      </Link>
      {/* Lightweight per-recommendation feedback — brief: "More like this/Not for us/Too
          far/Too expensive/Wrong vibe". A sibling of the Link (see the voter-breakdown comment
          above for why), and only while unanswered — once responded, a small acknowledgment
          replaces it rather than the buttons lingering meaninglessly. */}
      {data.recommendation && (
        data.recommendation.status === 'SENT' ? (
          <button
            type="button"
            onClick={() => onRespondRecommendation(data.recommendation!.id)}
            className="v2-tap-feedback"
            style={{ display: 'block', width: '100%', padding: '0 14px 10px', margin: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--v2-ink-dim)', textDecoration: 'underline', textUnderlineOffset: 2 }}
          >
            Not quite right?
          </button>
        ) : (
          <div className="v2-dim" style={{ padding: '0 14px 10px', fontSize: 11 }}>Thanks — noted for next time.</div>
        )
      )}
      {/* Who's actually in, converging visibly — and the real "who selected each state" fix: a
          bare "3 in" was never enough detail once the group grows past a couple of people.
          Tapping breaks down all three buckets (In/Maybe/Can't) by name, live-updating as votes
          change. Deliberately a sibling of the Link above, not nested inside it — a clickable
          element inside an <a> is invalid HTML and unreliable to tap on some browsers. */}
      {(inVoterIds.length + maybeVoterIds.length + outVoterIds.length) > 0 && (
        <button
          type="button"
          onClick={openBreakdown}
          className="v2-tap-feedback"
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', margin: 0, padding: '0 14px 10px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}
        >
          <OptionVoters voterIds={inVoterIds} members={members} />
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--v2-ink-dim)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
            {inVoterIds.length} in · {maybeVoterIds.length} maybe · {outVoterIds.length} can&rsquo;t make it
          </span>
        </button>
      )}
      {/* Voting + the Lock It In bar — hidden once locked, but SHRUNK away rather than yanked
          out the instant `locked` flips: still mounted through the `justLocked` transition beat
          (collapsed via CSS grid-rows, see .v2-collapse-row), then genuinely gone once the card
          has settled into its steady locked state on a later load. This is the actual "the idea
          becomes a plan" moment, not a badge swap — the same card shrinks its own decision
          controls away as it converges, instead of a different card silently replacing it. */}
      {(!locked || justLocked) && (
        <div className={`v2-collapse-row${justLocked ? ' v2-collapsed' : ''}`}>
          <div>
            <div style={{ display: 'flex', borderTop: '1px solid var(--v2-line)' }}>
              {([['in', "I'm in"], ['maybe', 'Maybe'], ['out', "Can't make it"]] as const).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => onVote(data.plan.id, v)}
                  className="v2-tap-feedback"
                  style={{
                    flex: 1, padding: '9px 4px', border: 'none', borderRight: v !== 'out' ? '1px solid var(--v2-line)' : 'none',
                    background: myVote === v ? 'var(--v2-bg-deep)' : 'none', cursor: 'pointer', fontSize: 11.5,
                    fontWeight: myVote === v ? 800 : 600, color: myVote === v ? 'var(--v2-ink)' : 'var(--v2-ink-muted)',
                  }}
                >
                  {myVote === v ? '✓ ' : ''}{label}
                </button>
              ))}
            </div>
            {lockable && (
              <button
                onClick={() => onLock(data.plan.id)}
                disabled={locking}
                className="v2-tap-feedback"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '10px 0', border: 'none', borderTop: '1px solid var(--v2-line)', background: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 800, color: 'var(--v2-brand)' }}
              >
                {!locking && <IconLock size={13} />}
                {locking ? 'Locking in…' : 'Lock it in'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Small overlapping avatar chips for who picked a given option — this is the actual point of
 * exposing `votersByOption`: seeing the group visibly forming around a choice, not just a
 * number climbing. New voters mount as genuinely new keyed DOM nodes, so `.v2-pop-in` fires on
 * them automatically with zero animation-library wiring.
 *
 * `onExpand`, when given, makes the whole cluster tappable — the pilot-readiness fix for "the
 * user wants to see WHO selected each state": a stack of initials tells you a group exists but
 * not who's actually in it. Tapping opens the full named breakdown (see `openVoterSheet`). */
function OptionVoters({ voterIds, members, onExpand }: { voterIds: string[]; members: MemberLite[]; onExpand?: () => void }) {
  if (voterIds.length === 0) return null;
  const shown = voterIds.slice(0, 4);
  return (
    <div
      className="stack"
      style={{ marginTop: 4, cursor: onExpand ? 'pointer' : undefined }}
      {...(onExpand ? { role: 'button', tabIndex: 0, onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onExpand(); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); onExpand(); } } } : {})}
    >
      {shown.map((id) => {
        const m = members.find((x) => x.user.id === id)?.user;
        if (!m) return null;
        return (
          <div key={id} className="v2-pop-in" style={{ marginLeft: -5, borderRadius: '50%', boxShadow: '0 0 0 1.5px var(--v2-surface)' }}>
            <PersonAvatar name={m.displayName} email={m.email} photoUrl={m.avatarUrl} size={18} />
          </div>
        );
      })}
      {voterIds.length > 4 && (
        <div style={{ width: 18, height: 18, borderRadius: '50%', marginLeft: -5, fontSize: 7, fontWeight: 800, color: 'var(--v2-ink-muted)', background: 'var(--v2-bg-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--v2-surface)' }}>
          +{voterIds.length - 4}
        </div>
      )}
    </div>
  );
}

/** A poll (or availability check-in, `kind: AVAILABILITY`) as a native conversational object —
 * tap an option, see the tally move live (optimistically — see `votePollOption`), watch the
 * group actually form around a choice via `OptionVoters`, not just a bare percentage. Once
 * anyone's voted, the leading option gets its own one-tap "Lock it in" that turns the decision
 * into a real Plan. `justLocked` renders the same card in its confirmed state for a beat before
 * the real "locked in" system message replaces it — the state TRANSFORMATION is the point, not
 * only the confetti burst alongside it. */
function PollCard({ poll, messageId, onVote, members, onLockOption, locking, justLocked, onExpandVoters }: {
  poll: Poll;
  messageId: string;
  onVote: (option: string) => void;
  members: MemberLite[];
  onLockOption: (option: string) => void;
  locking: boolean;
  justLocked: string | null;
  onExpandVoters: OpenVoterSheet;
}) {
  const leading = poll.totalVotes > 0 ? poll.options.reduce((a, b) => (poll.counts[b] > poll.counts[a] ? b : a)) : null;
  const locked = justLocked !== null;

  return (
    <div
      className={`${justLocked ? 'v2-lock-transform' : 'fade-up'}`}
      style={{
        width: 260, borderRadius: 'var(--v2-r-md)', overflow: 'hidden', boxShadow: 'var(--v2-shadow-sm)', padding: '14px 14px 10px',
        background: locked ? 'var(--v2-green)' : 'var(--v2-surface)',
        transition: 'background 0.45s cubic-bezier(.2,.8,.2,1)',
      }}
    >
      {/* The header pill crossfades label + colour instead of the card being swapped for a
          differently-structured one — same object, converging. */}
      <div key={locked ? 'locked' : 'open'} className="v2-pop-in" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: locked ? 'rgba(255,255,255,0.8)' : 'var(--v2-pop)', marginBottom: 6 }}>
        {locked && <IconLock size={10} />}
        {locked ? 'Locked in' : poll.kind === 'AVAILABILITY' ? 'When works?' : 'Poll'}
      </div>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 10, color: locked ? '#fff' : 'var(--v2-ink)' }}>{poll.question}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: leading || locked ? 10 : 2 }}>
        {poll.options.map((option) => {
          const count = poll.counts[option] ?? 0;
          const pct = poll.totalVotes > 0 ? Math.round((count / poll.totalVotes) * 100) : 0;
          const mine = poll.myVote === option;
          const isLeading = option === leading && poll.totalVotes > 0;
          // Losing options shrink away as the group converges (the same wrapper stays mounted
          // the whole time — only its collapsed class toggles — so the CSS transition actually
          // has two real states to interpolate between, not a swap to a differently-shaped
          // node); the winner is the one option that stays, expanding into its confirmed look
          // in the exact same slot rather than a new card silently replacing this one.
          const isLoser = locked && option !== justLocked;
          return (
            <div key={option} className={`v2-collapse-row${isLoser ? ' v2-collapsed' : ''}`}>
              <div>
                <button
                  onClick={() => onVote(option)}
                  disabled={locked}
                  className="v2-tap-feedback"
                  style={{
                    position: 'relative', textAlign: 'left', border: 'none', borderRadius: 10, overflow: 'hidden', cursor: locked ? 'default' : 'pointer', padding: '9px 12px', width: '100%',
                    background: locked ? 'rgba(255,255,255,0.16)' : 'var(--v2-bg-deep)',
                    boxShadow: isLeading && !locked ? 'inset 0 0 0 1.5px var(--v2-green)' : 'none',
                    transition: 'background 0.4s ease',
                  }}
                >
                  {!locked && (
                    <div className="v2-settle" key={pct} style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: mine ? 'rgba(255,47,126,0.18)' : 'rgba(12,12,13,0.06)', transition: 'width 0.35s cubic-bezier(.2,.8,.2,1)' }} />
                  )}
                  <div style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, fontWeight: mine || locked ? 800 : 600, color: locked ? '#fff' : undefined }}>
                      <span>{locked ? <><span className="v2-pop-in" style={{ marginRight: 5 }}>✓</span>{option}</> : <>{mine ? '✓ ' : ''}{option}</>}</span>
                      {poll.totalVotes > 0 && !locked && <span className="v2-muted">{count}</span>}
                    </div>
                    <OptionVoters voterIds={poll.votersByOption[option] ?? []} members={members} />
                  </div>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {/* "Who's voted" — one sheet covering every option, opened by a real sibling button, not
          a clickable nested inside each option's own <button> (which is invalid HTML and
          unreliable to tap on some browsers). Collapses away with the rest once locked. */}
      <div className={`v2-collapse-row${locked ? ' v2-collapsed' : ''}`}>
        <div>
          {poll.totalVotes > 0 && (
            <button
              type="button"
              onClick={() => onExpandVoters({ kind: 'poll', messageId })}
              className="v2-tap-feedback"
              style={{ display: 'block', width: '100%', padding: '2px 0 8px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--v2-ink-dim)', textDecoration: 'underline', textUnderlineOffset: 2 }}
            >
              See who voted
            </button>
          )}
          {leading && (
            <button
              onClick={() => onLockOption(leading)}
              disabled={locking}
              className="v2-tap-feedback"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '9px 0', border: 'none', borderTop: '1px solid var(--v2-line)', background: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 800, color: 'var(--v2-brand)' }}
            >
              {!locking && <IconLock size={13} />}
              {locking ? 'Locking in…' : `Lock in "${leading}"`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReactionRow({
  reactions,
  pickerOpen,
  onTogglePicker,
  onPick,
  align,
  onExpandVoters,
}: {
  reactions: Reaction[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onPick: (emoji: string) => void;
  align: 'flex-end' | 'flex-start';
  onExpandVoters: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'flex-end' ? 'flex-end' : 'flex-start', gap: 2, marginTop: 4 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: align === 'flex-end' ? 'flex-end' : 'flex-start' }}>
      {reactions.map((r) => (
        <button
          // Keying on count too forces a fresh DOM node whenever the tally changes — which is
          // exactly what makes .v2-pop-in (a mount-triggered animation) replay on every tap,
          // yours or someone else's, without any animation-library state tracking.
          key={`${r.emoji}-${r.count}`}
          onClick={() => onPick(r.emoji)}
          className="v2-chip-toggle v2-tap-feedback v2-pop-in"
          style={{
            display: 'flex', alignItems: 'center', gap: 3, fontSize: 11.5, padding: '2px 8px', borderRadius: 100, border: 'none', cursor: 'pointer',
            background: r.reactedByMe ? 'rgba(255,47,126,0.14)' : 'var(--v2-bg-deep)',
            color: r.reactedByMe ? 'var(--v2-pop)' : 'var(--v2-ink-muted)',
          }}
        >
          <span>{r.emoji}</span><span>{r.count}</span>
        </button>
      ))}
      {pickerOpen ? (
        REACTION_CHOICES.map((emoji) => (
          <button key={emoji} onClick={() => onPick(emoji)} className="v2-chip-toggle v2-tap-feedback" style={{ fontSize: 15, padding: '2px 6px', borderRadius: 100, border: 'none', background: 'var(--v2-bg-deep)', cursor: 'pointer' }}>
            {emoji}
          </button>
        ))
      ) : (
        <button onClick={onTogglePicker} aria-label="Add reaction" className="v2-tap-feedback" style={{ fontSize: 11, padding: '2px 7px', borderRadius: 100, border: 'none', background: 'transparent', color: 'var(--v2-ink-dim)', cursor: 'pointer' }}>+</button>
      )}
    </div>
    {/* "Who reacted" — separate from the tap-to-react chips above (which react on tap), so
        seeing names never accidentally changes your own reaction. */}
    {reactions.length > 0 && (
      <button
        type="button"
        onClick={onExpandVoters}
        className="v2-tap-feedback"
        style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontSize: 10.5, fontWeight: 600, color: 'var(--v2-ink-dim)' }}
      >
        {reactions.reduce((n, r) => n + r.count, 0) === 1 ? '1 person reacted' : `${reactions.reduce((n, r) => n + r.count, 0)} people reacted`}
      </button>
    )}
    </div>
  );
}

/**
 * Crew/Chat — the core experience: opening a Crew should feel like entering a private group of
 * real people, not opening a software object. Conversation dominates; there is no boxed nav bar,
 * no card chrome — a back arrow, an avatar cluster + name, a slim context strip when there's an
 * active decision, then the thread itself, WhatsApp/iMessage-plain (grouped bubbles, avatars only
 * where they carry information, reactions, real-time-feeling polling). Shared things (a poll, an
 * event, a plan) render as native conversational objects inline, not a different, plainer feature
 * bolted on. See docs/DECISIONS.md#plot-design-reset.
 */
export default function CrewPage() {
  const { id: crewId } = useParams<{ id: string }>();
  const [crew, setCrew] = useState<CrewDetail | null>(null);
  const [availability, setAvailability] = useState<DayAvailability[]>([]);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Optimistic-send bookkeeping — see `send`/`retrySend`. A message is in exactly one of these
  // (or neither, once confirmed): pending while the request is in flight, failed if it errored.
  const [pendingMessageIds, setPendingMessageIds] = useState<Set<string>>(new Set());
  const [failedMessageIds, setFailedMessageIds] = useState<Set<string>>(new Set());
  const [planCards, setPlanCards] = useState<Record<string, PlanCardData | 'loading' | 'error'>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  // The real, primary "manage this Crew's people" surface — see the header button below and
  // docs/DECISIONS.md#plot-design-reset. `infoOpen` (Crew photo + DNA + availability + rec
  // settings) stays a separate, secondary sheet reachable from inside this one.
  const [membersOpen, setMembersOpen] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leavingCrew, setLeavingCrew] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | undefined>(undefined);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  // The composer's multi-line growth — real, reported gap: it was a fixed-height single-line
  // `<input>`, so a message longer than one line just silently scrolled its own text sideways
  // inside a tiny box instead of growing, the way every real chat composer (iMessage, WhatsApp,
  // Slack) does. `rows={1}` plus this effect resetting height to `auto` then to the actual
  // `scrollHeight` on every keystroke is the standard auto-grow technique — capped at
  // `COMPOSER_MAX_HEIGHT` so a genuinely long paste grows the box, not the whole page, past
  // which it scrolls internally instead.
  useEffect(() => {
    const el = composerInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);
  const router = useRouter();
  // The real source of truth for "how much space do I actually have" on mobile — see
  // lib/useVisualViewportHeight.ts. `null` until the API has fired once (SSR, or a browser
  // without it), so every usage below falls back to the existing `dvh` calc in that case.
  const visualViewportHeight = useVisualViewportHeight();

  // The composer's "+" action sheet — one entry point into every way of adding something to
  // the conversation beyond plain text (see docs/DECISIONS.md#decision-objects).
  const [actionOpen, setActionOpen] = useState(false);
  const [actionView, setActionView] = useState<'menu' | 'poll' | 'availability' | 'share' | 'suggest' | 'manual'>('menu');
  // "Suggest something" — a curated shortlist (2-3, matched to the Crew's own taste), not a
  // blind auto-post of several full cards into permanent chat history. Tap one, it's shared,
  // the picker closes — the rest are just not sent, same as browsing "Share a place" and
  // picking one. See docs/DECISIONS.md.
  const [suggestOptions, setSuggestOptions] = useState<ExploreExperienceLite[] | 'loading' | 'error' | null>(null);
  // Real UX bug this fixes: tapping a suggested tile used to send it to the Crew immediately —
  // no preview, no chance to actually look at what you're about to share. Now a tap opens this
  // instead; only the explicit "Share with Crew" button on the preview actually sends.
  const [previewOption, setPreviewOption] = useState<ExploreExperienceLite | null>(null);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [postingPoll, setPostingPoll] = useState(false);
  const [shareItems, setShareItems] = useState<ExploreExperienceLite[] | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [manualTitle, setManualTitle] = useState('');
  const [manualVenue, setManualVenue] = useState('');
  const [manualWhen, setManualWhen] = useState('');
  const [postingManual, setPostingManual] = useState(false);
  const [lockingPlanId, setLockingPlanId] = useState<string | null>(null);
  // The "we are actually doing this" transition state — see lockPlanById/lockPollOption. Set
  // optimistically the instant Lock It In is tapped, so the card itself flips to its confirmed
  // state before the network round trip, not only after.
  const [justLockedPlanIds, setJustLockedPlanIds] = useState<Set<string>>(new Set());
  const [justLockedByMessage, setJustLockedByMessage] = useState<Record<string, string>>({});
  // Desktop only — the persistent Crews rail beside the active conversation (see globals.css's
  // .v2-crew-split comment for why this exists instead of just widening the message column).
  const [crewList, setCrewList] = useState<CrewListItem[] | null>(null);
  // "Who's behind this tally" — see docs/DECISIONS.md#in-maybe-pass-who. One shared sheet for
  // every group-state surface (plan votes, poll options, reactions) rather than a bespoke
  // popover per feature. Stores only a *source* (which plan/poll/message), not a frozen
  // snapshot — see VoterSheetSource's own comment for why that's what makes it live-update.
  const [voterSheetSource, setVoterSheetSource] = useState<VoterSheetSource | null>(null);
  const openVoterSheet: OpenVoterSheet = useCallback((source) => setVoterSheetSource(source), []);
  // Which recommendation's lightweight feedback sheet ("More like this" / "Not for us" / ...)
  // is currently open — see docs/DECISIONS.md#crew-auto-recommendations.
  const [respondingRecId, setRespondingRecId] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  // The auto-recommendation system's Crew-level controls (on/off, frequency, travel range) -
  // fetched lazily the first time the Crew info sheet opens.
  const [recSettings, setRecSettings] = useState<{ enabled: boolean; maxPerWeek: number; travelRadiusMeters: number | null } | null>(null);
  const [savingRecSettings, setSavingRecSettings] = useState(false);

  // Real gap found via live multi-user testing: `crew` (and therefore `activePlan`/
  // `upcomingPlan`, the header's own member list/image, and the top-of-page context strip's
  // vote count) was fetched exactly once on mount and never again — a member voting IN in one
  // browser tab genuinely did not move the SAME NUMBER shown a few lines above the plan card in
  // a second member's tab until they hard-refreshed, even though the card itself (a separately-
  // polled `planCards` entry) updated live. Two "how many are in" numbers on one screen,
  // silently drifting apart — one live, one stale. Now polled on the same cadence as messages.
  const loadCrew = useCallback(() => {
    api.get<{ crew: CrewDetail }>(`/crews/${crewId}`).then((res) => setCrew(res.crew)).catch((err) => setError((prev) => prev ?? (err instanceof ApiError ? err.message : 'Could not load Crew.')));
  }, [crewId]);

  useEffect(() => {
    loadCrew();
    const interval = setInterval(loadCrew, POLL_INTERVAL_MS);
    api.get<{ availability: DayAvailability[] }>(`/crews/${crewId}/availability?days=0,1,2,3`).then((res) => setAvailability(res.availability)).catch(() => {});
    api.get<{ user: { id: string } }>('/users/me').then((res) => setMe(res.user.id)).catch(() => {});
    api.get<{ crews: CrewListItem[] }>('/crews').then((res) => setCrewList(res.crews)).catch(() => {});
    return () => clearInterval(interval);
  }, [crewId, loadCrew]);

  // Real, persisted unread state — marks this Crew read (see apps/api/src/services/crew.ts
  // #markCrewRead) whenever this member is actually looking at it, not on a timer regardless of
  // whether anyone's here. Only while the tab is genuinely visible — a backgrounded tab still
  // polling for messages should NOT silently mark them read before anyone's actually seen them.
  function markRead() {
    if (document.visibilityState !== 'visible') return;
    api.post(`/crews/${crewId}/read`).catch(() => {});
  }

  const poll = useCallback(async () => {
    try {
      const res = await api.get<{ messages: ChatMessage[] }>(`/crews/${crewId}/messages${lastIdRef.current ? `?after=${lastIdRef.current}` : ''}`);
      if (res.messages.length === 0) {
        setMessages((prev) => prev ?? []);
        return;
      }
      lastIdRef.current = res.messages[res.messages.length - 1].id;
      markRead();
      // Merge by id (not append) and re-sort by createdAt — real bug found via multi-session
      // testing: two overlapping `poll()` calls (React StrictMode double-invoking this effect
      // in dev; a slow response racing the next 3s interval tick in any environment) could each
      // fetch the same message and both get appended, rendering it twice and, since insertion
      // order no longer matched createdAt order once that happened, out of chronological order
      // too. A Map keyed by id makes a duplicate fetch a no-op instead of a second bubble, and
      // the final sort makes rendering correct regardless of what order responses land in.
      setMessages((prev) => {
        const byId = new Map((prev ?? []).map((m) => [m.id, m]));
        for (const m of res.messages) byId.set(m.id, m);
        return Array.from(byId.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      });
    } catch (err) {
      setMessages((prev) => prev ?? []);
      setError((prev) => prev ?? (err instanceof ApiError ? err.message : 'Could not load chat.'));
    }
  }, [crewId]);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

  useEffect(() => {
    if (!messages) return;
    for (const m of messages) {
      const match = matchPlanAnnouncement(m.body);
      if (!match) continue;
      const slug = match.slug;
      if (planCards[slug]) continue;
      setPlanCards((prev) => ({ ...prev, [slug]: 'loading' }));
      api.get<PlanCardData>(`/plans/public/${slug}`).then((data) => setPlanCards((prev) => ({ ...prev, [slug]: data }))).catch(() => setPlanCards((prev) => ({ ...prev, [slug]: 'error' })));
    }
  }, [messages]);

  // A shared idea is only "alive" if the group can actually watch it converge without reloading
  // — someone else voting IN, or the pulse crossing into LIKELY/READY, should appear on its own.
  // Only re-polls cards that can still change (skips BOOKED — a locked plan's own vote/pulse
  // never moves again, so refetching it forever would be pure waste).
  const planCardsRef = useRef(planCards);
  planCardsRef.current = planCards;
  useEffect(() => {
    const interval = setInterval(() => {
      const current = planCardsRef.current;
      for (const [slug, entry] of Object.entries(current)) {
        if (entry === 'loading' || entry === 'error') continue;
        // Fully terminal — never worth refetching: a real payment is done (BOOKED), or a
        // manual plan locked with nothing left that could ever change (LOCKED + no Experience).
        // A LOCKED plan that DOES have an Experience keeps polling — it can still move to
        // BOOKED if someone completes a real booking from the booking page.
        const terminal = entry.plan.status === 'BOOKED' || (entry.plan.status === 'LOCKED' && !entry.plan.experience);
        if (terminal) continue;
        api.get<PlanCardData>(`/plans/public/${slug}`).then((data) => setPlanCards((prev) => ({ ...prev, [slug]: data }))).catch(() => {});
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  /** Voting IN/MAYBE/OUT right from the conversation — optimistic, same pattern as reactions/
   * poll voting: the card updates before the network call resolves, reverts on a real failure. */
  async function votePlanCard(planId: string, vote: 'in' | 'maybe' | 'out') {
    if (!me) return;
    const entry = Object.entries(planCards).find(([, v]) => v !== 'loading' && v !== 'error' && v.plan.id === planId);
    if (!entry) return;
    const [slug, data] = entry as [string, PlanCardData];
    const prevVotes = data.plan.votes;
    const nextVotes = [...prevVotes.filter((v) => v.userId !== me), { userId: me, vote: vote.toUpperCase() }];
    const inCount = nextVotes.filter((v) => v.vote === 'IN').length;
    const maybeCount = nextVotes.filter((v) => v.vote === 'MAYBE').length;
    const outCount = nextVotes.filter((v) => v.vote === 'OUT').length;
    const level = data.pulse.totalMembers > 0 ? inCount / data.pulse.totalMembers : 0;
    const status = data.plan.status === 'LOCKED' || data.plan.status === 'BOOKED'
      ? data.plan.status
      : level >= 0.6 ? 'READY' : level >= 0.5 ? 'LIKELY' : level > 0 ? 'GATHERING_INTEREST' : 'SHARED';
    setPlanCards((prev) => ({
      ...prev,
      [slug]: { plan: { ...data.plan, votes: nextVotes, status }, pulse: { ...data.pulse, inCount, maybeCount, outCount, level, status } },
    }));
    try {
      await api.post(`/plans/public/${slug}/vote`, { vote });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vote did not go through.');
      setPlanCards((prev) => ({ ...prev, [slug]: data })); // revert
    }
  }

  /** One of the lightweight recommendation-feedback actions — see docs/DECISIONS.md#crew-auto-
   * recommendations. Finds the card by recommendation id (not plan id — the caller only has
   * the recommendation's own id), marks it responded optimistically, then calls the real
   * endpoint. */
  async function respondToRecommendation(action: 'more_like_this' | 'not_for_us' | 'too_far' | 'too_expensive' | 'wrong_vibe') {
    const recId = respondingRecId;
    if (!recId) return;
    const entry = Object.entries(planCards).find(([, v]) => v !== 'loading' && v !== 'error' && v.recommendation?.id === recId);
    setResponding(true);
    setRespondingRecId(null);
    if (entry) {
      const [slug, data] = entry as [string, PlanCardData];
      const status = { more_like_this: 'MORE_LIKE_THIS', not_for_us: 'NOT_FOR_US', too_far: 'TOO_FAR', too_expensive: 'TOO_EXPENSIVE', wrong_vibe: 'WRONG_VIBE' }[action];
      setPlanCards((prev) => ({ ...prev, [slug]: { ...data, recommendation: { ...data.recommendation!, status } } }));
    }
    try {
      await api.post(`/crews/${crewId}/recommendations/${recId}/respond`, { action });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that.');
      // Not reverted — a failed feedback POST isn't worth resurrecting the buttons over; the
      // worst case is a slightly stale local "responded" state that a refetch corrects.
    } finally {
      setResponding(false);
    }
  }

  // Smart scroll — real bug this replaces: unconditionally forcing scroll-to-bottom on every
  // `messages` change drags you back down mid-scroll-up-to-read-history the moment anyone
  // (including you, sending) touches the thread. Only auto-scroll when you were already at the
  // bottom (or on first load); otherwise surface a restrained "new messages" pill instead of
  // moving the viewport out from under you.
  const nearBottomRef = useRef(true);
  const hasScrolledOnceRef = useRef(false);
  const [newMessagesPill, setNewMessagesPill] = useState(false);

  function handleListScroll() {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottomRef.current) setNewMessagesPill(false);
  }
  function scrollToBottom(smooth: boolean) {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    nearBottomRef.current = true;
    setNewMessagesPill(false);
  }
  useEffect(() => {
    if (!messages) return;
    if (!hasScrolledOnceRef.current) {
      hasScrolledOnceRef.current = true;
      scrollToBottom(false);
      return;
    }
    if (nearBottomRef.current) scrollToBottom(true);
    else setNewMessagesPill(true);
  }, [messages]);

  // The keyboard opening/closing shrinks or grows visualViewportHeight, which resizes this
  // container — if you were already reading the latest message, keep it in view through that
  // resize instead of letting it silently scroll out of frame; if you'd scrolled up to read
  // history, leave you exactly where you were (never yank the viewport while you're mid-read).
  useEffect(() => {
    if (visualViewportHeight == null) return;
    if (nearBottomRef.current) scrollToBottom(false);
    // Intentionally only re-runs on visualViewportHeight — scrollToBottom/nearBottomRef are
    // stable across renders (a ref and a function declared once in this component body).
  }, [visualViewportHeight]); // eslint-disable-line

  async function react(messageId: string, emoji: string) {
    setPickerFor(null);
    // Optimistic — mirrors the backend's own toggle-and-replace semantics (tap the same emoji
    // again to remove it, a different one to switch) so the tap reads as instant regardless of
    // round-trip time. Reconciled with the real aggregate on response; reverted via a refetch
    // if the request itself fails.
    setMessages((prev) => prev?.map((m) => {
      if (m.id !== messageId) return m;
      const mine = m.reactions.find((r) => r.reactedByMe);
      let next = m.reactions.map((r) => ({ ...r, reactedBy: [...r.reactedBy] }));
      if (mine) {
        next = next
          .map((r) => (r.emoji === mine.emoji ? { ...r, count: r.count - 1, reactedByMe: false, reactedBy: r.reactedBy.filter((id) => id !== me) } : r))
          .filter((r) => r.count > 0);
      }
      if (!mine || mine.emoji !== emoji) {
        const target = next.find((r) => r.emoji === emoji);
        if (target) { target.count += 1; target.reactedByMe = true; if (me) target.reactedBy.push(me); }
        else next.push({ emoji, count: 1, reactedByMe: true, reactedBy: me ? [me] : [] });
      }
      return { ...m, reactions: next };
    }) ?? prev);
    try {
      const res = await api.post<{ reactions: Reaction[] }>(`/crews/${crewId}/messages/${messageId}/react`, { emoji });
      setMessages((prev) => prev?.map((m) => (m.id === messageId ? { ...m, reactions: res.reactions } : m)) ?? prev);
    } catch {
      await poll(); // the optimistic guess was wrong — a real refetch corrects it
    }
  }

  function closeActionSheet() {
    setActionOpen(false);
    setActionView('menu');
    setPollQuestion('');
    setPollOptions(['', '']);
    setPreviewOption(null);
  }

  function openAction(view: 'poll' | 'availability' | 'share' | 'suggest' | 'manual') {
    // Real, reported bug this fixes: this function only ever changed WHICH view shows inside the
    // "+" sheet — it never opened the sheet itself. That's invisible when it's called from a menu
    // item inside an already-open sheet (the sheet is already open, so nothing looked broken),
    // but the empty-chat starter prompts ("See when everyone's free", "Find something for the
    // Crew") call this directly as their own entry point, with the sheet closed — so tapping them
    // visibly did nothing at all.
    setActionOpen(true);
    setActionView(view);
    if (view === 'suggest' && suggestOptions === null) {
      setSuggestOptions('loading');
      api
        .post<{ options: { experience: ExploreExperienceLite }[] }>(`/crews/${crewId}/find-us-something`)
        .then((res) => setSuggestOptions(res.options.slice(0, 3).map((o) => o.experience)))
        .catch(() => setSuggestOptions('error'));
    }
    if (view === 'availability') {
      // A ready-made "when works?" poll — the brief's own words: "do not make users open
      // calendars manually just to answer." Next three weekend nights, not a bare date picker.
      const days: string[] = [];
      const cursor = new Date();
      while (days.length < 3) {
        cursor.setDate(cursor.getDate() + 1);
        const dow = cursor.getDay();
        if (dow === 5 || dow === 6 || dow === 0) {
          days.push(cursor.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
        }
      }
      setPollQuestion('When works?');
      setPollOptions(days);
    }
    if (view === 'share' && shareItems === null) {
      api
        .get<{ experiences: ExploreExperienceLite[] }>('/explore/experiences')
        .then((res) => setShareItems(res.experiences.slice(0, 8)))
        .catch(() => setShareItems([]));
    }
  }

  async function votePollOption(messageId: string, option: string) {
    if (!me) return;
    // Optimistic — the bar, the count and your own avatar sliding under the option all move the
    // instant you tap, not after a round trip. Re-voting moves your avatar from the old option
    // to the new one, same as the backend's replace-not-accumulate semantics.
    setMessages((prev) => prev?.map((m) => {
      if (m.id !== messageId || !m.poll) return m;
      const p = m.poll;
      const prevVote = p.myVote;
      if (prevVote === option) return m;
      const counts = { ...p.counts };
      const votersByOption = Object.fromEntries(Object.entries(p.votersByOption).map(([k, v]) => [k, [...v]]));
      if (prevVote) {
        counts[prevVote] = Math.max(0, (counts[prevVote] ?? 0) - 1);
        votersByOption[prevVote] = (votersByOption[prevVote] ?? []).filter((id) => id !== me);
      }
      counts[option] = (counts[option] ?? 0) + 1;
      votersByOption[option] = [...(votersByOption[option] ?? []), me];
      return { ...m, poll: { ...p, counts, votersByOption, myVote: option, totalVotes: prevVote ? p.totalVotes : p.totalVotes + 1 } };
    }) ?? prev);
    try {
      const res = await api.post<{ poll: Poll }>(`/crews/${crewId}/messages/${messageId}/poll-vote`, { option });
      setMessages((prev) => prev?.map((m) => (m.id === messageId ? { ...m, poll: res.poll } : m)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vote did not go through.');
      await poll(); // revert the optimistic guess
    }
  }

  async function postPoll() {
    const question = pollQuestion.trim();
    const options = pollOptions.map((o) => o.trim()).filter(Boolean);
    if (!question || options.length < 2) return;
    setPostingPoll(true);
    setError(null);
    try {
      await api.post(`/crews/${crewId}/polls`, { question, options, kind: actionView === 'availability' ? 'AVAILABILITY' : 'GENERAL' });
      await poll();
      closeActionSheet();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not post that.');
    } finally {
      setPostingPoll(false);
    }
  }

  async function shareExperience(experienceId: string) {
    setSharingId(experienceId);
    try {
      await api.post(`/crews/${crewId}/plans/send`, { experienceId });
      await poll();
      closeActionSheet();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not share that.');
    } finally {
      setSharingId(null);
    }
  }

  async function postManualPlan() {
    const title = manualTitle.trim();
    if (!title) return;
    setPostingManual(true);
    setError(null);
    try {
      await api.post(`/crews/${crewId}/plans/manual`, {
        title,
        venueName: manualVenue.trim() || undefined,
        startsAt: manualWhen ? new Date(manualWhen).toISOString() : undefined,
      });
      await poll();
      closeActionSheet();
      setManualTitle('');
      setManualVenue('');
      setManualWhen('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log that plan.');
    } finally {
      setPostingManual(false);
    }
  }

  async function lockPlanById(planId: string) {
    setLockingPlanId(planId);
    // The state TRANSFORMATION happens right here, optimistically, before the network call even
    // resolves — the EventCard morphs into its confirmed state immediately (v2-lock-transform;
    // see the component below). That transform IS the signature moment — no confetti burst
    // alongside it (explicitly ruled out: "no sparkle, no confetti, no AI magic" — a real one
    // used to run here and was removed for exactly that reason).
    setJustLockedPlanIds((prev) => new Set(prev).add(planId));
    try {
      await api.post(`/plans/${planId}/lock`);
      await poll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not lock that in.');
      setJustLockedPlanIds((prev) => { const n = new Set(prev); n.delete(planId); return n; });
    } finally {
      setLockingPlanId(null);
    }
  }

  /** Locking straight from a poll's leading option: there's no Plan yet, so create a manual one
   * from the poll's own question/option, then lock it in one motion — a poll answered becomes a
   * plan without a separate "now go make a Plan" step. */
  async function lockPollOption(messageId: string, question: string, option: string) {
    setLockingPlanId(messageId);
    // Same optimistic transform as lockPlanById — the poll card itself morphs to its locked
    // look the instant you tap, not after the manual-plan-then-lock round trip completes.
    setJustLockedByMessage((prev) => ({ ...prev, [messageId]: option }));
    try {
      const res = await api.post<{ plan: { id: string; publicSlug: string } }>(`/crews/${crewId}/plans/manual`, { title: `${question} — ${option}` });
      await api.post(`/plans/${res.plan.id}/lock`);
      // The brief's own words: "we've stopped talking about it, this is happening" deserves a
      // beat to actually be seen — navigating away instantly would cut the transition off
      // before it plays, so the redirect waits just long enough for it to land.
      setTimeout(() => router.push(`/plans/${res.plan.publicSlug}`), 700);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not lock that in.');
      setJustLockedByMessage((prev) => { const n = { ...prev }; delete n[messageId]; return n; });
      setLockingPlanId(null);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !me) return;
    setDraft('');
    // Truly optimistic — the bubble appears immediately (quietly dimmed via `.v2-pending`, not
    // a loud spinner), before the network round trip, so sending never has a beat where the
    // input clears but nothing else visibly happened. Reconciled with the real message (real id,
    // real timestamp) on success; kept in place with a retry affordance on failure rather than
    // silently vanishing.
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: ChatMessage = {
      id: tempId,
      body,
      createdAt: new Date().toISOString(),
      author: { id: me, displayName: null, email: '' },
      reactions: [],
      poll: null,
    };
    setMessages((prev) => [...(prev ?? []), optimistic]);
    setPendingMessageIds((prev) => new Set(prev).add(tempId));
    setFailedMessageIds((prev) => { const n = new Set(prev); n.delete(tempId); return n; });
    try {
      const res = await api.post<{ message: ChatMessage }>(`/crews/${crewId}/messages`, { body });
      lastIdRef.current = res.message.id;
      setMessages((prev) => prev?.map((m) => (m.id === tempId ? res.message : m)) ?? prev);
      setPendingMessageIds((prev) => { const n = new Set(prev); n.delete(tempId); return n; });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Message did not send.');
      setPendingMessageIds((prev) => { const n = new Set(prev); n.delete(tempId); return n; });
      setFailedMessageIds((prev) => new Set(prev).add(tempId));
    }
  }

  /** Retry a message that failed to send — same optimistic id, same position in the thread, so
   * retrying doesn't reorder or duplicate anything, just tries the same POST again. */
  async function retrySend(tempId: string) {
    const msg = messages?.find((m) => m.id === tempId);
    if (!msg) return;
    setFailedMessageIds((prev) => { const n = new Set(prev); n.delete(tempId); return n; });
    setPendingMessageIds((prev) => new Set(prev).add(tempId));
    try {
      const res = await api.post<{ message: ChatMessage }>(`/crews/${crewId}/messages`, { body: msg.body });
      lastIdRef.current = res.message.id;
      setMessages((prev) => prev?.map((m) => (m.id === tempId ? res.message : m)) ?? prev);
      setPendingMessageIds((prev) => { const n = new Set(prev); n.delete(tempId); return n; });
    } catch {
      setPendingMessageIds((prev) => { const n = new Set(prev); n.delete(tempId); return n; });
      setFailedMessageIds((prev) => new Set(prev).add(tempId));
    }
  }

  async function getInviteLink() {
    const res = await api.post<{ inviteUrl: string }>(`/crews/${crewId}/invites`, { channel: 'link' });
    setInviteUrl(res.inviteUrl);
  }

  /** Fetched lazily the first time the Crew info sheet opens, not on every Crew page load -
   * these settings are read far less often than they're irrelevant. */
  async function loadRecSettings() {
    if (recSettings) return;
    try {
      const res = await api.get<{ settings: { enabled: boolean; maxPerWeek: number; travelRadiusMeters: number | null } }>(`/crews/${crewId}/recommendation-settings`);
      setRecSettings(res.settings);
    } catch {
      // Non-critical - the sheet just won't show this section if it fails.
    }
  }
  async function patchRecSettings(patch: Partial<{ enabled: boolean; maxPerWeek: number; travelRadiusMeters: number | null }>) {
    if (!recSettings) return;
    const prev = recSettings;
    setRecSettings({ ...prev, ...patch });
    setSavingRecSettings(true);
    try {
      const res = await api.patch<{ settings: typeof prev }>(`/crews/${crewId}/recommendation-settings`, patch);
      setRecSettings(res.settings);
    } catch {
      setRecSettings(prev); // revert
    } finally {
      setSavingRecSettings(false);
    }
  }
  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: `Join ${crew?.name} on Plot`, url: inviteUrl });
        return;
      }
    } catch {
      // cancelled
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked
    }
  }

  /** Owner-only. Optimistic — the row disappears immediately, reverts if the request fails. */
  async function removeMember(userId: string) {
    if (!crew) return;
    const prev = crew;
    setConfirmRemoveId(null);
    setRemovingUserId(userId);
    setCrew({ ...crew, members: crew.members.filter((m) => m.user.id !== userId) });
    try {
      await api.delete(`/crews/${crew.id}/members/${userId}`);
    } catch {
      setCrew(prev);
    } finally {
      setRemovingUserId(null);
    }
  }

  async function leaveThisCrew() {
    if (!crew) return;
    setLeavingCrew(true);
    try {
      await api.post(`/crews/${crew.id}/leave`);
      router.push('/crews');
    } catch {
      setLeavingCrew(false);
      setConfirmLeave(false);
    }
  }

  if (!crew) {
    return (
      <div className="v2">
        <div className="v2-page" style={{ paddingTop: 28 }}>
          {error ? <div style={{ color: 'var(--v2-error)' }}>{error}</div> : <div className="v2-skeleton" style={{ height: 60, borderRadius: 16 }} />}
        </div>
      </div>
    );
  }

  const solo = crew.members.length === 1;
  const isOwner = crew.members.find((m) => m.user.id === me)?.role === 'OWNER';
  // The same two colours the Crew's own mark already draws from (lib/identity.ts) — the header
  // banner wash and the chat canvas tint both read from this ONE pair, never a separate palette
  // invented for either, so a Crew's identity feels like one consistent thing across the screen.
  const crewPair = identityPair(crew.name);
  const activePlan = crew.plans.find((p) => ACTIVE_DECISION_STATUSES.has(p.status));
  const upcomingPlan = crew.plans.find((p) => p.status === 'LOCKED' || p.status === 'BOOKED');
  const context = upcomingPlan ?? activePlan;

  // Re-derived from the live `planCards`/`messages` state on every render (not a snapshot taken
  // when the sheet opened) — see VoterSheetSource's comment.
  let voterSheetData: { title: string; groups: VoterGroup[] } | null = null;
  if (voterSheetSource?.kind === 'plan') {
    const entry = Object.values(planCards).find((v) => v !== 'loading' && v !== 'error' && v.plan.id === voterSheetSource.planId) as PlanCardData | undefined;
    if (entry) {
      voterSheetData = {
        title: entry.plan.title,
        groups: [
          { label: 'In', userIds: entry.plan.votes.filter((v) => v.vote === 'IN').map((v) => v.userId) },
          { label: 'Maybe', userIds: entry.plan.votes.filter((v) => v.vote === 'MAYBE').map((v) => v.userId) },
          { label: "Can't make it", userIds: entry.plan.votes.filter((v) => v.vote === 'OUT').map((v) => v.userId) },
        ],
      };
    }
  } else if (voterSheetSource?.kind === 'poll') {
    const msg = messages?.find((m) => m.id === voterSheetSource.messageId);
    if (msg?.poll) {
      voterSheetData = {
        title: msg.poll.question,
        groups: msg.poll.options.map((option) => ({ label: option, userIds: msg.poll!.votersByOption[option] ?? [] })),
      };
    }
  } else if (voterSheetSource?.kind === 'reactions') {
    const msg = messages?.find((m) => m.id === voterSheetSource.messageId);
    if (msg) {
      voterSheetData = { title: 'Reactions', groups: msg.reactions.map((r) => ({ label: r.emoji, userIds: r.reactedBy })) };
    }
  }

  return (
    // Real, reported P0 fix: the composer used to fight a hardcoded/measured pixel-height guess
    // for "how much space is left" — fragile by construction, and it broke again the moment the
    // header's own height changed. Replaced with the actually-correct way to pin a bottom bar in
    // a scrollable conversation: ONE flex column filling the real viewport height (`100dvh` —
    // already tracks the keyboard/toolbar on modern mobile browsers, the same technique
    // BottomSheet already relies on elsewhere in this file), where the header is a natural
    // flex-shrink:0 child, the message list is the one `flex:1; min-height:0; overflow-y:auto`
    // scroll region, and the composer is just the LAST flex child — inherently always visible at
    // the bottom, because that is what a flex column does, not because of a number anyone
    // calculated. No JS measurement of anything is needed for this to stay correct.
    <div className="v2" style={{ height: '100dvh', overflow: 'hidden' }}>
      <div className="v2-shell-desktop v2-crew-split" style={{ height: '100%' }}>
        {/* Desktop-only Crews rail beside the active conversation — see globals.css's
            .v2-crew-split comment: the conversation column staying a fixed, readable width is
            correct (WhatsApp/iMessage desktop both do this), but the dead space that used to sit
            beside it wasn't. This is real navigation, not decoration. */}
        {crewList && crewList.length > 0 && (
          <div className="v2-crew-rail">
            <div className="v2-card" style={{ padding: '16px 14px' }}>
              <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Your Crews</div>
              {crewList.map((c) => (
                <Link
                  key={c.id}
                  href={`/crews/${c.id}`}
                  className="v2-rail-crew-row"
                  style={{ background: c.id === crewId ? 'var(--v2-bg-deep)' : undefined }}
                >
                  <CrewMark name={c.name} imageUrl={c.imageUrl} size={34} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                    <div className="v2-dim" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, overflow: 'hidden' }}>
                      {c.upcomingPlan ? <IconCalendar size={11} style={{ flexShrink: 0 }} /> : c.activePlan ? <IconPoll size={11} style={{ flexShrink: 0 }} /> : null}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.upcomingPlan ? c.upcomingPlan.title : c.activePlan ? c.activePlan.title : c.latestMessage ? messagePreview(c.latestMessage.body) : 'Say hi'}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      <div className="v2-crew-main" style={{ maxWidth: 720, width: '100%', height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flexShrink: 0 }}>
        {/* Header — HARD RESET. Real, reported feedback: "tiny Crew header, tiny social presence".
            This is now a real banner, not a slim top bar: the Crew's own identity wash fills it
            (the same two colours its mark already draws from — never a new palette invented for
            this), the mark itself is nearly double its old size, and the whole thing IS the
            entry point into member management, not a settings menu. */}
        <div style={{ position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(160deg, ${crewPair[0]}45, ${crewPair[1]}22)` }} />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14, padding: '18px 20px 16px' }}>
            <Link href="/crews" aria-label="Back to Crews" style={{ fontSize: 20, color: 'var(--v2-ink-muted)', flexShrink: 0 }}>←</Link>
            {/* Tapping the people/avatar cluster is the entry point into real member management —
                not a settings page. See docs/DECISIONS.md#plot-design-reset. Crew photo/DNA/
                availability/recommendation settings live one step further in, off the sheet this
                opens, not here. */}
            <button onClick={() => setMembersOpen(true)} aria-label="Crew members" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 13, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={54} />
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div className="v2-display" style={{ fontSize: 21, lineHeight: 1.08 }}>{crew.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                  <div className="stack">
                    {crew.members.slice(0, 4).map((m, mi) => (
                      <div key={m.user.id} style={{ marginLeft: mi === 0 ? 0 : -7, borderRadius: '50%', boxShadow: '0 0 0 2px var(--v2-bg)' }}>
                        <PersonAvatar name={m.user.displayName} email={m.user.email} photoUrl={m.user.avatarUrl} size={19} />
                      </div>
                    ))}
                  </div>
                  <span className="v2-muted" style={{ fontSize: 11.5, fontWeight: 700 }}>{crew.members.length} {crew.members.length === 1 ? 'person' : 'people'}</span>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* CURRENT CONTEXT — one slim, colourful strip, never a card competing with chat. */}
        {context && (
          <Link
            href={`/plans/${context.publicSlug}`}
            className="fade-up"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, margin: '0 20px 8px', padding: '11px 16px', borderRadius: 100,
              background: upcomingPlan ? 'rgba(27,122,77,0.1)' : 'rgba(185,131,42,0.16)',
            }}
          >
            <span style={{ color: upcomingPlan ? '#1b7a4d' : '#8a5f1f', flexShrink: 0 }}>
              {upcomingPlan ? <IconCalendar size={15} /> : <IconPoll size={15} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>{context.title}</span>
              {activePlan === context && <span className="v2-muted" style={{ fontSize: 12 }}> · {context.votes.filter((v) => v.vote === 'IN').length}/{context.members.length} in</span>}
            </div>
            <span style={{ fontSize: 12, fontWeight: 800, color: upcomingPlan ? 'var(--v2-green)' : '#8a5f1f', flexShrink: 0 }}>{upcomingPlan ? 'View' : 'Vote'} →</span>
          </Link>
        )}
      </div>

        <div
          style={{
            // The one flex-fill scroll region — no explicit height anywhere here. `flex: 1`
            // takes exactly whatever's left below the header inside .v2-crew-main's own
            // height:100dvh, and `minHeight: 0` is the one non-obvious rule flexbox needs to let
            // a flex child actually shrink below its content's natural height instead of
            // overflowing its parent (the classic "flexbox scroll area" gotcha — without this
            // the message list would just keep growing and push the composer off-screen again).
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            padding: '4px 20px calc(env(safe-area-inset-bottom, 0px) + 14px)',
            position: 'relative',
          }}
        >
          {/* Restrained "new messages" affordance — only shown while you've scrolled up to read
              history and something new has arrived below; tapping it is the one thing that
              moves the viewport for you in that state. */}
          {newMessagesPill && (
            <button
              onClick={() => scrollToBottom(true)}
              className="v2-pop-in v2-tap-feedback"
              style={{ position: 'absolute', bottom: 74, left: '50%', transform: 'translateX(-50%)', zIndex: 5, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 100, border: 'none', background: 'var(--v2-ink)', color: '#fff', fontSize: 12.5, fontWeight: 700, boxShadow: 'var(--v2-shadow-lg)', cursor: 'pointer' }}
            >
              New messages ↓
            </button>
          )}
          {/* The message canvas itself — real, reported feedback: "huge empty white canvas, tiny
              bubbles" read as unfinished, not a place a group actually lives. A soft two-colour
              wash from the Crew's own identity pair (never a colour invented just for this)
              replaces the flat white fill, low enough opacity that bubbles stay the highest-
              contrast thing on screen. `background-attachment: local` (see .v2-chat-canvas) so
              the wash scrolls with the messages instead of feeling like a fixed backdrop behind
              them. */}
          <div
            ref={listRef}
            onScroll={handleListScroll}
            className="v2-chat-canvas"
            style={{
              flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 10,
              margin: '0 -20px', padding: '10px 20px 10px',
              ['--v2-chat-wash' as string]: `radial-gradient(90% 70% at 100% 0%, ${crewPair[0]}2e, transparent 65%), radial-gradient(90% 70% at 0% 100%, ${crewPair[1]}26, transparent 65%)`,
            }}
          >
            {solo && (
              <div style={{ textAlign: 'center', margin: 'auto', maxWidth: 260 }}>
                <div className="v2-display" style={{ fontSize: 20, marginBottom: 8 }}>It&rsquo;s just you here so far.</div>
                <p className="v2-muted" style={{ marginBottom: 18, fontSize: 13.5 }}>Bring your people in and Plot finds what you should do together.</p>
                {inviteUrl ? (
                  <button className="v2-btn v2-btn-brand" onClick={copyInvite}>{copied ? '✓ Copied' : 'Share invite link'}</button>
                ) : (
                  <button className="v2-btn v2-btn-brand" onClick={getInviteLink}>Get invite link</button>
                )}
              </div>
            )}
            {!solo && messages === null && !error && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[1, 2, 3].map((i) => <div key={i} className="v2-skeleton" style={{ height: 34, borderRadius: 16, width: `${50 + i * 12}%` }} />)}
              </div>
            )}
            {!solo && messages?.length === 0 && (
              <div style={{ margin: 'auto', maxWidth: 300, textAlign: 'center' }}>
                <div className="v2-display" style={{ fontSize: 19, marginBottom: 6 }}>{crew.name} is ready.</div>
                <p className="v2-muted" style={{ fontSize: 13.5, marginBottom: 20 }}>Here&rsquo;s a good way to start.</p>
                {/* Real, actionable starter prompts — replaces a dead "say hi" line that gave a
                    brand-new Crew no obvious next move. Each one is the same real action the "+"
                    composer menu offers, just surfaced where a first-time member actually is. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button className="v2-card v2-tap-feedback" style={{ padding: '13px 16px', border: 'none', textAlign: 'left', cursor: 'pointer', width: '100%' }} onClick={() => openAction('availability')}>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>See when everyone&rsquo;s free</div>
                    <div className="v2-muted" style={{ fontSize: 12 }}>A quick poll for the next few weekend nights</div>
                  </button>
                  <button className="v2-card v2-tap-feedback" style={{ padding: '13px 16px', border: 'none', textAlign: 'left', cursor: 'pointer', width: '100%' }} onClick={() => openAction('suggest')}>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>Find something for the Crew</div>
                    <div className="v2-muted" style={{ fontSize: 12 }}>Plot picks a few — you choose what to share</div>
                  </button>
                  <button
                    className="v2-card v2-tap-feedback"
                    style={{ padding: '13px 16px', border: 'none', textAlign: 'left', cursor: 'pointer', width: '100%' }}
                    onClick={() => { setDraft('Hey everyone!'); composerInputRef.current?.focus(); }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 14 }}>Say hello</div>
                    <div className="v2-muted" style={{ fontSize: 12 }}>Break the ice — everyone can see this</div>
                  </button>
                </div>
              </div>
            )}
            {!solo && messages?.map((m, i) => {
              const mine = m.author.id === me;
              const planMatch = matchPlanAnnouncement(m.body);
              const cardData = planMatch ? planCards[planMatch.slug] : undefined;
              const prev = i > 0 ? messages[i - 1] : null;
              const grouped = prev !== null && prev.author.id === m.author.id;
              const pending = pendingMessageIds.has(m.id);
              const failed = failedMessageIds.has(m.id);

              return (
                <div
                  key={m.id}
                  className="v2-arrive"
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: mine ? 'row-reverse' : 'row', marginTop: grouped ? -4 : 8 }}
                >
                  {!mine && (
                    <div style={{ flexShrink: 0, visibility: grouped ? 'hidden' : 'visible' }}>
                      <PersonAvatar name={m.author.displayName} email={m.author.email} photoUrl={m.author.avatarUrl} size={24} />
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '76%' }}>
                    {!mine && !grouped && <div className="v2-dim" style={{ fontSize: 10.5, marginBottom: 2, marginLeft: 2 }}>{displayNameOf(m.author.displayName, m.author.email)}</div>}
                    {m.poll ? (
                      <PollCard
                        poll={m.poll}
                        messageId={m.id}
                        members={crew.members}
                        onVote={(option) => votePollOption(m.id, option)}
                        locking={lockingPlanId === m.id}
                        onLockOption={(option) => lockPollOption(m.id, m.poll!.question, option)}
                        justLocked={justLockedByMessage[m.id] ?? null}
                        onExpandVoters={openVoterSheet}
                      />
                    ) : planMatch && cardData && cardData !== 'loading' && cardData !== 'error' ? (
                      <EventCard
                        data={cardData}
                        members={crew.members}
                        me={me}
                        onLock={lockPlanById}
                        locking={lockingPlanId === cardData.plan.id}
                        justLocked={justLockedPlanIds.has(cardData.plan.id)}
                        onVote={votePlanCard}
                        onExpandVoters={openVoterSheet}
                        onRespondRecommendation={(recId) => setRespondingRecId(recId)}
                      />
                    ) : planMatch && cardData === 'loading' ? (
                      <div className="v2-skeleton" style={{ width: 260, height: 120, borderRadius: 16 }} />
                    ) : (
                      <div
                        className={pending ? 'v2-pending' : undefined}
                        style={{
                          padding: '10px 15px', wordBreak: 'break-word', fontSize: 14.5, lineHeight: 1.4,
                          background: mine ? 'var(--v2-brand)' : 'var(--v2-surface)',
                          color: mine ? '#fff' : 'var(--v2-ink)',
                          borderRadius: mine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                          boxShadow: mine ? 'none' : 'var(--v2-shadow-sm)',
                        }}
                      >
                        {m.body}
                      </div>
                    )}
                    {!planMatch && !m.poll && !failed && (
                      <ReactionRow
                        reactions={m.reactions}
                        pickerOpen={pickerFor === m.id}
                        onTogglePicker={() => setPickerFor(m.id)}
                        onPick={(emoji) => react(m.id, emoji)}
                        align={mine ? 'flex-end' : 'flex-start'}
                        onExpandVoters={() => openVoterSheet({ kind: 'reactions', messageId: m.id })}
                      />
                    )}
                    {failed ? (
                      <button onClick={() => retrySend(m.id)} className="v2-tap-feedback" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--v2-error)', padding: 0 }}>
                        Didn&rsquo;t send — retry
                      </button>
                    ) : (
                      <div className="v2-dim" style={{ fontSize: 9.5, marginTop: 3 }}>{pending ? 'Sending…' : formatTime(m.createdAt)}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {error && <div style={{ color: 'var(--v2-error)', fontSize: 12.5, marginBottom: 6 }}>{error}</div>}

          {!solo && (
            <form ref={composerFormRef} onSubmit={send} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setActionOpen(true)}
                aria-label="Add to conversation"
                style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', border: 'none', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', color: 'var(--v2-ink)', fontSize: 20, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}
              >
                +
              </button>
              {/* A real multi-line composer, not a fixed-height single-line input — grows with
                  the message (see the auto-resize effect above), capped at COMPOSER_MAX_HEIGHT
                  and internally scrollable past that. Enter sends (the iMessage/WhatsApp
                  convention); Shift+Enter inserts a real newline. */}
              <textarea
                ref={composerInputRef}
                rows={1}
                style={{
                  flex: 1, padding: '12px 18px', borderRadius: 22, border: 'none', outline: 'none', resize: 'none',
                  background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', fontSize: 14.5, fontFamily: 'inherit', color: 'var(--v2-ink)',
                  lineHeight: 1.35, maxHeight: COMPOSER_MAX_HEIGHT, overflowY: 'auto',
                }}
                placeholder={`Message ${crew.name}…`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    composerFormRef.current?.requestSubmit();
                  }
                }}
                maxLength={2000}
              />
              {/* Never disabled while a send is in flight — sending is optimistic, so there is
                  nothing to wait for; the next message can go straight out. */}
              <button
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send"
                className="v2-tap-feedback"
                style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', border: 'none', background: 'var(--v2-brand)', color: '#fff', fontSize: 17, cursor: 'pointer', opacity: !draft.trim() ? 0.5 : 1 }}
              >
                ↑
              </button>
            </form>
          )}
        </div>
      </div>
      </div>

      {/* THE COMPOSER'S "+" ACTION — HARD RESET. The previous version was five identical white
          rows (icon, title, description) — the exact "component library" shape the brief calls
          out ("could belong to literally any productivity application"). This is a real moment —
          "we're trying to do something" — so every action gets its own colour and a large glyph,
          organised by INTENT (find something / ask the Crew / check when / add something we
          know) rather than by feature name, sized for a thumb rather than a list to scan. */}
      <BottomSheet open={actionOpen} onClose={closeActionSheet}>
        {actionView === 'menu' && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>{crew.name}</div>
            <h2 className="v2-display" style={{ fontSize: 21, marginBottom: 16 }}>What are we doing?</h2>
            <div className="v2-action-grid">
              {[
                { Icon: IconSpark, bg: 'var(--v2-confetti-1)', fg: '#fff', label: 'Find something', desc: 'Plot picks a few', action: () => openAction('suggest') },
                { Icon: IconPoll, bg: 'var(--v2-confetti-2)', fg: '#fff', label: 'Ask the Crew', desc: 'Poll & watch it settle', action: () => openAction('poll') },
                { Icon: IconCalendar, bg: 'var(--v2-green)', fg: '#fff', label: 'Check when', desc: "Who's actually free", action: () => openAction('availability') },
                { Icon: IconPlace, bg: 'var(--v2-confetti-3)', fg: '#fff', label: 'Share a place', desc: 'Browse & send it', action: () => openAction('share') },
              ].map((item) => (
                <button key={item.label} onClick={item.action} className="v2-action-tile v2-tap-feedback" style={{ background: item.bg, color: item.fg }}>
                  <item.Icon size={26} />
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{item.label}</div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.85 }}>{item.desc}</div>
                  </div>
                </button>
              ))}
              <button
                onClick={() => openAction('manual')}
                className="v2-action-tile v2-tap-feedback"
                style={{ background: 'var(--v2-confetti-4)', color: '#2b1a00', gridColumn: '1 / -1', flexDirection: 'row', alignItems: 'center', minHeight: 'auto', padding: '16px' }}
              >
                <IconFlag size={22} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>Add something we know</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.75 }}>Already got a plan — log it</div>
                </div>
              </button>
            </div>
          </div>
        )}

        {(actionView === 'poll' || actionView === 'availability') && (
          <div>
            <button onClick={() => setActionView('menu')} className="v2-muted" style={{ background: 'none', border: 'none', fontSize: 13, marginBottom: 10, cursor: 'pointer', padding: 0 }}>← Back</button>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>{actionView === 'availability' ? 'Check availability' : 'Poll the group'}</div>
            <input
              style={{ width: '100%', padding: '13px 16px', borderRadius: 14, border: 'none', outline: 'none', background: 'var(--v2-bg-deep)', fontSize: 14.5, fontFamily: 'inherit', marginBottom: 10 }}
              placeholder="What night works?"
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              maxLength={200}
            />
            {pollOptions.map((opt, i) => (
              <input
                key={i}
                style={{ width: '100%', padding: '11px 16px', borderRadius: 14, border: 'none', outline: 'none', background: 'var(--v2-bg-deep)', fontSize: 14, fontFamily: 'inherit', marginBottom: 8 }}
                placeholder={`Option ${i + 1}`}
                value={opt}
                onChange={(e) => setPollOptions((prev) => prev.map((o, oi) => (oi === i ? e.target.value : o)))}
                maxLength={60}
              />
            ))}
            {pollOptions.length < 6 && (
              <button onClick={() => setPollOptions((prev) => [...prev, ''])} className="v2-muted" style={{ background: 'none', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: '4px 0', marginBottom: 14 }}>
                + Add option
              </button>
            )}
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={postPoll} disabled={postingPoll || !pollQuestion.trim() || pollOptions.filter((o) => o.trim()).length < 2}>
              {postingPoll ? 'Posting…' : 'Send'}
            </button>
          </div>
        )}

        {/* The preview step — this is the real fix, not the list below it. Tapping any result
            (from either "Suggest something" or "Share a place") used to send it to the Crew
            immediately, with no chance to actually look at what you were about to share. Now a
            tap only opens this; nothing sends until "Share with Crew" is tapped explicitly. */}
        {previewOption && (
          <div>
            <button onClick={() => setPreviewOption(null)} className="v2-muted" style={{ background: 'none', border: 'none', fontSize: 13, marginBottom: 10, cursor: 'pointer', padding: 0 }}>← Back to results</button>
            <div style={{ height: 150, margin: '0 0 14px', borderRadius: 16, background: v2Art(previewOption.imageUrl, previewOption.category) }} />
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>{previewOption.category.replace(/_/g, ' ')}</div>
            <div className="v2-display" style={{ fontSize: 19, marginBottom: 6 }}>{previewOption.name}</div>
            <div className="v2-muted" style={{ fontSize: 13.5, marginBottom: 10 }}>
              {new Date(previewOption.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
            {/* Location hierarchy the brief specifically called out as inconsistent: venue name,
                then town/city, always together — never a bare venue name with no sense of where
                it actually is. */}
            <div style={{ fontSize: 13.5, marginBottom: 10 }}>
              {previewOption.venue.name}{previewOption.venue.city && `, ${previewOption.venue.city}`}
            </div>
            {formatPriceFrom(previewOption.priceMinMinor) && (
              <div style={{ fontSize: 13.5, marginBottom: 10, fontWeight: 700 }}>{formatPriceFrom(previewOption.priceMinMinor)}</div>
            )}
            {previewOption.description && (
              <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--v2-ink-muted)', marginBottom: 18 }}>{previewOption.description}</p>
            )}
            <button
              className="v2-btn v2-btn-brand v2-tap-feedback"
              style={{ width: '100%' }}
              disabled={sharingId !== null}
              onClick={() => shareExperience(previewOption.id)}
            >
              {sharingId === previewOption.id ? 'Sharing…' : 'Share with Crew'}
            </button>
          </div>
        )}

        {/* A curated shortlist, not an auto-post of several full cards straight into permanent
            chat history — that was the old "Suggest something" behaviour and it was too heavy
            for what should be a fast, considered moment. Plot narrows to 2-3 matches; tapping one
            opens the preview above, which is the only place that actually sends. */}
        {!previewOption && actionView === 'suggest' && (
          <div>
            <button onClick={() => setActionView('menu')} className="v2-muted" style={{ background: 'none', border: 'none', fontSize: 13, marginBottom: 10, cursor: 'pointer', padding: 0 }}>← Back</button>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Plot&rsquo;s picks for this Crew</div>
            {suggestOptions === 'loading' && <p className="v2-muted">Finding something…</p>}
            {suggestOptions === 'error' && <p className="v2-muted">Couldn&rsquo;t find anything right now — try again shortly.</p>}
            {Array.isArray(suggestOptions) && suggestOptions.length === 0 && <p className="v2-muted">Nothing matches yet — try &ldquo;Share a place&rdquo; to browse everything.</p>}
            {Array.isArray(suggestOptions) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {suggestOptions.map((exp) => (
                  <button
                    key={exp.id}
                    onClick={() => setPreviewOption(exp)}
                    className="v2-hoverable"
                    style={{ display: 'block', textAlign: 'left', border: 'none', background: 'var(--v2-bg-deep)', borderRadius: 14, padding: 0, overflow: 'hidden', cursor: 'pointer' }}
                  >
                    <div style={{ height: 84, background: v2Art(exp.imageUrl, exp.category) }} />
                    <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exp.name}</div>
                        <div className="v2-muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {exp.venue.name}{exp.venue.city && `, ${exp.venue.city}`} · {new Date(exp.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                        </div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--v2-brand)', flexShrink: 0 }}>View</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!previewOption && actionView === 'share' && (
          <div>
            <button onClick={() => setActionView('menu')} className="v2-muted" style={{ background: 'none', border: 'none', fontSize: 13, marginBottom: 10, cursor: 'pointer', padding: 0 }}>← Back</button>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Share a place</div>
            {shareItems === null && <p className="v2-muted">Loading ideas…</p>}
            {shareItems?.length === 0 && <p className="v2-muted">Nothing to suggest right now — try again shortly.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
              {shareItems?.map((exp) => (
                <button
                  key={exp.id}
                  onClick={() => setPreviewOption(exp)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, border: 'none', background: 'var(--v2-bg-deep)', borderRadius: 14, padding: 10, cursor: 'pointer', textAlign: 'left' }}
                >
                  <div style={{ width: 52, height: 52, borderRadius: 10, flexShrink: 0, background: v2Art(exp.imageUrl, exp.category) }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exp.name}</div>
                    <div className="v2-muted" style={{ fontSize: 11.5 }}>{exp.venue.name}{exp.venue.city && `, ${exp.venue.city}`}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--v2-brand)', flexShrink: 0 }}>View</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {actionView === 'manual' && (
          <div>
            <button onClick={() => setActionView('menu')} className="v2-muted" style={{ background: 'none', border: 'none', fontSize: 13, marginBottom: 10, cursor: 'pointer', padding: 0 }}>← Back</button>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>Log a plan</div>
            <p className="v2-muted" style={{ fontSize: 12.5, marginBottom: 14 }}>Doesn&rsquo;t need to be ticketed — a pub, someone&rsquo;s house, a walk.</p>
            <input
              style={{ width: '100%', padding: '13px 16px', borderRadius: 14, border: 'none', outline: 'none', background: 'var(--v2-bg-deep)', fontSize: 14.5, fontFamily: 'inherit', marginBottom: 8 }}
              placeholder="Pub Saturday"
              value={manualTitle}
              onChange={(e) => setManualTitle(e.target.value)}
              maxLength={120}
            />
            <input
              style={{ width: '100%', padding: '13px 16px', borderRadius: 14, border: 'none', outline: 'none', background: 'var(--v2-bg-deep)', fontSize: 14.5, fontFamily: 'inherit', marginBottom: 8 }}
              placeholder="Where (optional)"
              value={manualVenue}
              onChange={(e) => setManualVenue(e.target.value)}
              maxLength={160}
            />
            <input
              type="datetime-local"
              style={{ width: '100%', padding: '13px 16px', borderRadius: 14, border: 'none', outline: 'none', background: 'var(--v2-bg-deep)', fontSize: 14.5, fontFamily: 'inherit', marginBottom: 14, colorScheme: 'light' }}
              value={manualWhen}
              onChange={(e) => setManualWhen(e.target.value)}
            />
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={postManualPlan} disabled={postingManual || !manualTitle.trim()}>
              {postingManual ? 'Logging…' : 'Send to Crew'}
            </button>
          </div>
        )}
      </BottomSheet>

      <BottomSheet open={infoOpen} onClose={() => setInfoOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 16 }}>
          <MediaUploadButton
            uploadPath={`/crews/${crew.id}/image`}
            deletePath={`/crews/${crew.id}/image`}
            shape="squircle"
            size={72}
            presetKind="crew"
            value={crew.imageUrl}
            name={crew.name}
            onChange={(url) => setCrew((prev) => (prev ? { ...prev, imageUrl: url } : prev))}
          >
            <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={72} />
          </MediaUploadButton>
          <div className="v2-display" style={{ fontSize: 18, marginTop: 10 }}>{crew.name}</div>
          <button
            onClick={() => { setInfoOpen(false); setMembersOpen(true); }}
            className="v2-muted v2-tap-feedback"
            style={{ fontSize: 12.5, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', textDecoration: 'underline', textUnderlineOffset: 3 }}
          >
            {crew.members.length} {crew.members.length === 1 ? 'person' : 'people'} · manage
          </button>
        </div>

        {crew.dna && (
          <div style={{ marginBottom: 18 }}>
            <div className="v2-eyebrow" style={{ marginBottom: 6 }}>Group DNA · {crew.dna.confidence.toLowerCase()} confidence</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {crew.dna.topCategories.length ? (
                crew.dna.topCategories.map((c) => <span key={c} style={{ fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 100, background: 'rgba(185,131,42,0.16)', color: '#8a5f1f' }}>{c}</span>)
              ) : (
                <span className="v2-muted" style={{ fontSize: 13 }}>Plot is still learning this Crew&rsquo;s taste.</span>
              )}
            </div>
          </div>
        )}

        {availability.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div className="v2-eyebrow" style={{ marginBottom: 6 }}>Everyone&rsquo;s evening</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {availability.map((d) => (
                <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
                  <div className="v2-muted" style={{ fontSize: 10 }}>{d.day}</div>
                  <div style={{ marginTop: 4, padding: '8px 0', borderRadius: 8, fontSize: 11, fontWeight: 700, background: d.freeCount / d.totalMembers >= 0.6 ? 'var(--v2-green)' : 'var(--v2-bg-deep)', color: d.freeCount / d.totalMembers >= 0.6 ? '#fff' : 'var(--v2-ink-muted)' }}>
                    {d.freeCount}/{d.totalMembers}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {recSettings && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 0 }}>Plot recommendations</div>
              <button
                onClick={() => patchRecSettings({ enabled: !recSettings.enabled })}
                disabled={savingRecSettings}
                className="v2-tap-feedback"
                style={{ border: 'none', background: recSettings.enabled ? 'var(--v2-green)' : 'var(--v2-bg-deep)', color: recSettings.enabled ? '#fff' : 'var(--v2-ink-muted)', fontSize: 11.5, fontWeight: 800, padding: '5px 12px', borderRadius: 100, cursor: 'pointer' }}
              >
                {recSettings.enabled ? 'On' : 'Off'}
              </button>
            </div>
            <p className="v2-muted" style={{ fontSize: 12, marginBottom: recSettings.enabled ? 12 : 0, lineHeight: 1.5 }}>
              Plot occasionally finds something your Crew might like and shares it here — never more than a couple of times a week.
            </p>
            {recSettings.enabled && (
              <>
                <div className="v2-dim" style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>How often</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                  {[1, 2, 3].map((n) => (
                    <button
                      key={n}
                      onClick={() => patchRecSettings({ maxPerWeek: n })}
                      disabled={savingRecSettings}
                      className="v2-tap-feedback"
                      style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, background: recSettings.maxPerWeek === n ? 'var(--v2-ink)' : 'var(--v2-bg-deep)', color: recSettings.maxPerWeek === n ? '#fff' : 'var(--v2-ink-muted)' }}
                    >
                      {n}/week
                    </button>
                  ))}
                </div>
                <div className="v2-dim" style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>How far</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {RADIUS_CHIPS.map((chip) => (
                    <button
                      key={chip.label}
                      onClick={() => patchRecSettings({ travelRadiusMeters: chip.meters })}
                      disabled={savingRecSettings}
                      className="v2-tap-feedback"
                      style={{ padding: '7px 12px', borderRadius: 100, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, background: recSettings.travelRadiusMeters === chip.meters ? 'var(--v2-ink)' : 'var(--v2-bg-deep)', color: recSettings.travelRadiusMeters === chip.meters ? '#fff' : 'var(--v2-ink-muted)' }}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </BottomSheet>

      {/* The real member-management surface — reachable directly from tapping the Crew header's
          avatar cluster (see the header button above), not buried in the settings sheet above.
          Add people is the first thing in it, not the last. */}
      <BottomSheet open={membersOpen} onClose={() => { setMembersOpen(false); setConfirmRemoveId(null); setConfirmLeave(false); }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 18 }}>
          <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="v2-display" style={{ fontSize: 17, lineHeight: 1.15 }}>{crew.name}</div>
            <p className="v2-muted" style={{ fontSize: 12, margin: 0 }}>{crew.members.length} {crew.members.length === 1 ? 'person' : 'people'}</p>
          </div>
        </div>

        <button
          onClick={inviteUrl ? copyInvite : getInviteLink}
          className="v2-btn v2-btn-brand v2-tap-feedback"
          style={{ width: '100%', justifyContent: 'center', gap: 8, marginBottom: 20 }}
        >
          <IconAddPerson size={15} />
          {inviteUrl ? (copied ? 'Copied — send it on' : 'Copy invite link') : 'Add people'}
        </button>

        <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Members</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
          {crew.members.map((m) => {
            const mine = m.user.id === me;
            return (
              <div key={m.user.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
                <PersonAvatar name={m.user.displayName} email={m.user.email} photoUrl={m.user.avatarUrl} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayNameOf(m.user.displayName, m.user.email)}{mine && <span className="v2-dim"> (you)</span>}
                  </div>
                  {m.role === 'OWNER' && <div className="v2-dim" style={{ fontSize: 11, fontWeight: 700 }}>Owner</div>}
                </div>
                {isOwner && !mine && (
                  confirmRemoveId === m.user.id ? (
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button
                        onClick={() => removeMember(m.user.id)}
                        disabled={removingUserId === m.user.id}
                        className="v2-tap-feedback"
                        style={{ border: 'none', background: 'var(--v2-error)', color: '#fff', fontSize: 11.5, fontWeight: 700, padding: '6px 10px', borderRadius: 100, cursor: 'pointer' }}
                      >
                        Remove
                      </button>
                      <button onClick={() => setConfirmRemoveId(null)} className="v2-tap-feedback" style={{ border: 'none', background: 'var(--v2-bg-deep)', color: 'var(--v2-ink-muted)', fontSize: 11.5, fontWeight: 700, padding: '6px 10px', borderRadius: 100, cursor: 'pointer' }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmRemoveId(m.user.id)}
                      className="v2-tap-feedback"
                      style={{ border: 'none', background: 'none', color: 'var(--v2-ink-dim)', fontSize: 11.5, fontWeight: 700, padding: '6px 4px', cursor: 'pointer', flexShrink: 0 }}
                    >
                      Remove
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>

        {confirmLeave ? (
          <div style={{ padding: '12px 14px', borderRadius: 14, background: 'var(--v2-bg-deep)' }}>
            <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px' }}>
              {isOwner && crew.members.length > 1 ? `Leave ${crew.name}? Ownership passes to whoever's been here longest.` : `Leave ${crew.name}?`}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={leaveThisCrew} disabled={leavingCrew} className="v2-btn v2-btn-brand" style={{ flex: 1 }}>{leavingCrew ? 'Leaving…' : 'Leave'}</button>
              <button onClick={() => setConfirmLeave(false)} disabled={leavingCrew} className="v2-btn v2-btn-ghost" style={{ flex: 1 }}>Stay</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirmLeave(true)} className="v2-tap-feedback" style={{ width: '100%', border: 'none', background: 'none', color: 'var(--v2-error)', fontSize: 13, fontWeight: 700, padding: '10px 0', cursor: 'pointer' }}>
            Leave Crew
          </button>
        )}

        <button
          onClick={() => { setMembersOpen(false); setInfoOpen(true); loadRecSettings(); }}
          className="v2-tap-feedback"
          style={{ width: '100%', border: 'none', background: 'none', color: 'var(--v2-ink-muted)', fontSize: 12.5, fontWeight: 600, padding: '10px 0 0', cursor: 'pointer' }}
        >
          Crew settings →
        </button>
      </BottomSheet>

      {/* "Who's behind this" — the shared sheet for every group-state tally (plan votes, poll
          options, reactions). Re-derived live from `planCards`/`messages` on every render (see
          `voterSheetData` above), so it keeps moving while it's open if someone else votes. */}
      <BottomSheet open={voterSheetSource !== null} onClose={() => setVoterSheetSource(null)}>
        {voterSheetData && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 2 }}>{voterSheetData.title}</div>
            <p className="v2-muted" style={{ fontSize: 12.5, marginBottom: 18 }}>Who&rsquo;s said what</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {voterSheetData.groups.map((group) => (
                <div key={group.label}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 8 }}>
                    {group.label} <span className="v2-dim" style={{ fontWeight: 600 }}>· {group.userIds.length}</span>
                  </div>
                  {group.userIds.length === 0 ? (
                    <p className="v2-dim" style={{ fontSize: 12.5, margin: 0 }}>No one yet.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {group.userIds.map((id) => {
                        const m = crew.members.find((x) => x.user.id === id)?.user;
                        if (!m) return null;
                        return (
                          <div key={id} className="v2-pop-in" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                            <PersonAvatar name={m.displayName} email={m.email} photoUrl={m.avatarUrl} size={26} />
                            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{displayNameOf(m.displayName, m.email)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </BottomSheet>

      {/* Lightweight recommendation feedback — brief's exact five controls. Deliberately a
          plain list, not a form: one tap, done. */}
      <BottomSheet open={respondingRecId !== null} onClose={() => setRespondingRecId(null)}>
        <div className="v2-eyebrow" style={{ marginBottom: 14 }}>What&rsquo;s wrong with this one?</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {([
            ['more_like_this', 'More like this'],
            ['not_for_us', 'Not for us'],
            ['too_far', 'Too far'],
            ['too_expensive', 'Too expensive'],
            ['wrong_vibe', 'Wrong vibe'],
          ] as const).map(([action, label]) => (
            <button
              key={action}
              onClick={() => respondToRecommendation(action)}
              disabled={responding}
              className="v2-card v2-tap-feedback"
              style={{ padding: '13px 16px', border: 'none', textAlign: 'left', cursor: 'pointer', width: '100%', fontWeight: 700, fontSize: 14 }}
            >
              {label}
            </button>
          ))}
        </div>
      </BottomSheet>

      <TabBarV2 hideMobile />
    </div>
  );
}
