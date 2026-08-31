'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { v2Art } from '@/lib/v2Art';
import { BottomSheet } from '@/components/BottomSheet';
import { TabBarV2 } from '@/components/TabBarV2';

interface Reaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

interface Poll {
  id: string;
  question: string;
  options: string[];
  kind: 'GENERAL' | 'AVAILABILITY';
  counts: Record<string, number>;
  totalVotes: number;
  myVote: string | null;
}

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string | null; email: string };
  reactions: Reaction[];
  poll: Poll | null;
}

interface ExploreExperienceLite {
  id: string;
  name: string;
  category: string;
  startsAt: string;
  venue: { name: string };
  priceMinMinor: number | null;
  priceMaxMinor?: number | null;
  currency: string;
  imageUrl: string | null;
}

const REACTION_CHOICES = ['👍', '❤️', '😂', '🎉'];

interface PlanCardData {
  plan: {
    id: string;
    title: string;
    publicSlug: string;
    status: string;
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
  pulse: { inCount: number; totalMembers: number };
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
  inviteCode: string;
  members: { user: { id: string; displayName: string | null; email: string } }[];
  dna: { confidence: string; topCategories: string[]; medianSpendMinor: number; bestNights: string[]; usualAreas: string[] } | null;
  plans: Plan[];
}

interface DayAvailability {
  day: string;
  freeCount: number;
  totalMembers: number;
}

const ACTIVE_DECISION_STATUSES = new Set(['SHARED', 'GATHERING_INTEREST', 'LIKELY', 'READY']);
const AVATAR_COLORS = ['#ff3d5a', '#5b3df0', '#1c7a52', '#ffb238', '#ff6fae'];
function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}
function initials(displayName: string | null, email: string) {
  return (displayName?.trim() || email).slice(0, 1).toUpperCase();
}
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const POLL_INTERVAL_MS = 3000;
const PLAN_ANNOUNCEMENT = /^📍 Sent "(.+)" to the Crew — \/plans\/([a-zA-Z0-9-]+)$/;

const LOCKABLE_STATUSES = new Set(['SHARED', 'GATHERING_INTEREST', 'LIKELY', 'READY']);

/** The rich event-share card — replaces a wall of text with something that looks like the
 * actual event. `v2Art` gives it the same category-tinted composition as Explore/Home so a
 * shared event reads as "the same product," not a different, plainer feature bolted on. A
 * still-open Plan gets its own one-tap "Lock it in" right here — the payoff moment shouldn't
 * require navigating away from the conversation it happened in. */
function EventCard({ data, onLock, locking }: { data: PlanCardData; onLock: (planId: string) => void; locking: boolean }) {
  const exp = data.plan.experience;
  const lockable = LOCKABLE_STATUSES.has(data.plan.status);
  return (
    <div className="fade-up v2-hoverable" style={{ width: 260, borderRadius: 'var(--v2-r-md)', overflow: 'hidden', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)' }}>
      <Link href={`/plans/${data.plan.publicSlug}`} style={{ display: 'block' }}>
        <div style={{ height: 120, background: v2Art(exp?.imageUrl, exp?.category) }} />
        <div style={{ padding: '12px 14px 8px' }}>
          <div className="v2-display" style={{ fontSize: 15, marginBottom: 4 }}>{data.plan.title}</div>
          {exp && (
            <div className="v2-muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {exp.venue?.name ?? 'Venue TBC'} · {new Date(exp.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              {formatPriceFrom(exp.priceMinMinor) && ` · ${formatPriceFrom(exp.priceMinMinor)}`}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: data.plan.status === 'BOOKED' ? 'var(--v2-green)' : 'var(--v2-ink-muted)', background: data.plan.status === 'BOOKED' ? 'rgba(28,122,82,0.12)' : 'var(--v2-bg-deep)', padding: '4px 10px', borderRadius: 100 }}>
              {data.plan.status === 'BOOKED' ? '🔒 Locked in' : `${data.pulse.inCount}/${data.pulse.totalMembers} in`}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--v2-brand)' }}>View →</span>
          </div>
        </div>
      </Link>
      {lockable && (
        <button
          onClick={() => onLock(data.plan.id)}
          disabled={locking}
          style={{ display: 'block', width: '100%', padding: '10px 0', border: 'none', borderTop: '1px solid var(--v2-line)', background: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 800, color: 'var(--v2-brand)' }}
        >
          {locking ? 'Locking in…' : '🔒 Lock it in'}
        </button>
      )}
    </div>
  );
}

/** A poll (or availability check-in, `kind: AVAILABILITY`) as a native conversational object —
 * tap an option, see the tally move live, no separate results screen. Once anyone's voted, the
 * leading option gets its own one-tap "Lock it in" that turns the decision into a real Plan. */
function PollCard({ poll, onVote, voting, onLockOption, locking }: {
  poll: Poll;
  onVote: (option: string) => void;
  voting: boolean;
  onLockOption: (option: string) => void;
  locking: boolean;
}) {
  const leading = poll.totalVotes > 0 ? poll.options.reduce((a, b) => (poll.counts[b] > poll.counts[a] ? b : a)) : null;
  return (
    <div className="fade-up" style={{ width: 260, borderRadius: 'var(--v2-r-md)', overflow: 'hidden', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', padding: '14px 14px 10px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--v2-brand)', marginBottom: 6 }}>
        {poll.kind === 'AVAILABILITY' ? 'When works?' : 'Poll'}
      </div>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 10 }}>{poll.question}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: leading ? 10 : 2 }}>
        {poll.options.map((option) => {
          const count = poll.counts[option] ?? 0;
          const pct = poll.totalVotes > 0 ? Math.round((count / poll.totalVotes) * 100) : 0;
          const mine = poll.myVote === option;
          return (
            <button
              key={option}
              onClick={() => onVote(option)}
              disabled={voting}
              style={{ position: 'relative', textAlign: 'left', border: 'none', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', padding: '9px 12px', background: 'var(--v2-bg-deep)' }}
            >
              <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: mine ? 'rgba(255,61,90,0.22)' : 'rgba(26,21,16,0.06)', transition: 'width 0.3s ease' }} />
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: mine ? 800 : 600 }}>
                <span>{mine ? '✓ ' : ''}{option}</span>
                {poll.totalVotes > 0 && <span className="v2-muted">{count}</span>}
              </div>
            </button>
          );
        })}
      </div>
      {leading && (
        <button
          onClick={() => onLockOption(leading)}
          disabled={locking}
          style={{ display: 'block', width: '100%', padding: '9px 0', border: 'none', borderTop: '1px solid var(--v2-line)', background: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 800, color: 'var(--v2-brand)' }}
        >
          {locking ? 'Locking in…' : `🔒 Lock in "${leading}"`}
        </button>
      )}
    </div>
  );
}

function ReactionRow({
  reactions,
  pickerOpen,
  onTogglePicker,
  onPick,
  align,
}: {
  reactions: Reaction[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onPick: (emoji: string) => void;
  align: 'flex-end' | 'flex-start';
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: align === 'flex-end' ? 'flex-end' : 'flex-start' }}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          onClick={() => onPick(r.emoji)}
          className="v2-chip-toggle"
          style={{
            display: 'flex', alignItems: 'center', gap: 3, fontSize: 11.5, padding: '2px 8px', borderRadius: 100, border: 'none', cursor: 'pointer',
            background: r.reactedByMe ? 'rgba(255,61,90,0.12)' : 'var(--v2-bg-deep)',
            color: r.reactedByMe ? 'var(--v2-brand)' : 'var(--v2-ink-muted)',
          }}
        >
          <span>{r.emoji}</span><span>{r.count}</span>
        </button>
      ))}
      {pickerOpen ? (
        REACTION_CHOICES.map((emoji) => (
          <button key={emoji} onClick={() => onPick(emoji)} className="v2-chip-toggle" style={{ fontSize: 15, padding: '2px 6px', borderRadius: 100, border: 'none', background: 'var(--v2-bg-deep)', cursor: 'pointer' }}>
            {emoji}
          </button>
        ))
      ) : (
        <button onClick={onTogglePicker} aria-label="Add reaction" style={{ fontSize: 11, padding: '2px 7px', borderRadius: 100, border: 'none', background: 'transparent', color: 'var(--v2-ink-dim)', cursor: 'pointer' }}>+</button>
      )}
    </div>
  );
}

/**
 * Crew/Chat V2 — same data/logic as the original (polling, reactions, plan-card parsing,
 * suggest-to-chat), an entirely different presentation. The brief's own words: "the interface
 * around chat should disappear as much as possible... the people and content create the visual
 * interest." No boxed panels, minimal chrome, one slim context strip, avatars only where they
 * carry information (the first message in a run). See docs/DECISIONS.md#v2-art-direction.
 */
export default function CrewPage() {
  const { id: crewId } = useParams<{ id: string }>();
  const [crew, setCrew] = useState<CrewDetail | null>(null);
  const [availability, setAvailability] = useState<DayAvailability[]>([]);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [planCards, setPlanCards] = useState<Record<string, PlanCardData | 'loading' | 'error'>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | undefined>(undefined);
  const router = useRouter();

  // The composer's "+" action sheet — one entry point into every way of adding something to
  // the conversation beyond plain text (see docs/DECISIONS.md#decision-objects).
  const [actionOpen, setActionOpen] = useState(false);
  const [actionView, setActionView] = useState<'menu' | 'poll' | 'availability' | 'share' | 'manual'>('menu');
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [postingPoll, setPostingPoll] = useState(false);
  const [shareItems, setShareItems] = useState<ExploreExperienceLite[] | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [manualTitle, setManualTitle] = useState('');
  const [manualVenue, setManualVenue] = useState('');
  const [manualWhen, setManualWhen] = useState('');
  const [postingManual, setPostingManual] = useState(false);
  const [votingMessageId, setVotingMessageId] = useState<string | null>(null);
  const [lockingPlanId, setLockingPlanId] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ crew: CrewDetail }>(`/crews/${crewId}`).then((res) => setCrew(res.crew)).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Crew.'));
    api.get<{ availability: DayAvailability[] }>(`/crews/${crewId}/availability?days=0,1,2,3`).then((res) => setAvailability(res.availability)).catch(() => {});
    api.get<{ user: { id: string } }>('/users/me').then((res) => setMe(res.user.id)).catch(() => {});
  }, [crewId]);

  const poll = useCallback(async () => {
    try {
      const res = await api.get<{ messages: ChatMessage[] }>(`/crews/${crewId}/messages${lastIdRef.current ? `?after=${lastIdRef.current}` : ''}`);
      if (res.messages.length === 0) {
        setMessages((prev) => prev ?? []);
        return;
      }
      lastIdRef.current = res.messages[res.messages.length - 1].id;
      setMessages((prev) => (prev ? [...prev, ...res.messages] : res.messages));
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
      const match = m.body.match(PLAN_ANNOUNCEMENT);
      if (!match) continue;
      const slug = match[2];
      if (planCards[slug]) continue;
      setPlanCards((prev) => ({ ...prev, [slug]: 'loading' }));
      api.get<PlanCardData>(`/plans/public/${slug}`).then((data) => setPlanCards((prev) => ({ ...prev, [slug]: data }))).catch(() => setPlanCards((prev) => ({ ...prev, [slug]: 'error' })));
    }
  }, [messages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function react(messageId: string, emoji: string) {
    setPickerFor(null);
    try {
      const res = await api.post<{ reactions: Reaction[] }>(`/crews/${crewId}/messages/${messageId}/react`, { emoji });
      setMessages((prev) => prev?.map((m) => (m.id === messageId ? { ...m, reactions: res.reactions } : m)) ?? prev);
    } catch {
      // next poll reconciles it
    }
  }

  async function suggestSomething() {
    setSuggesting(true);
    setError(null);
    try {
      await api.post(`/crews/${crewId}/suggest-to-chat`);
      await poll();
      closeActionSheet();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not find anything right now — try again.');
    } finally {
      setSuggesting(false);
    }
  }

  function closeActionSheet() {
    setActionOpen(false);
    setActionView('menu');
    setPollQuestion('');
    setPollOptions(['', '']);
  }

  function openAction(view: 'poll' | 'availability' | 'share' | 'manual') {
    setActionView(view);
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
    setVotingMessageId(messageId);
    try {
      const res = await api.post<{ poll: Poll }>(`/crews/${crewId}/messages/${messageId}/poll-vote`, { option });
      setMessages((prev) => prev?.map((m) => (m.id === messageId ? { ...m, poll: res.poll } : m)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vote did not go through.');
    } finally {
      setVotingMessageId(null);
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
    try {
      await api.post(`/plans/${planId}/lock`);
      await poll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not lock that in.');
    } finally {
      setLockingPlanId(null);
    }
  }

  /** Locking straight from a poll's leading option: there's no Plan yet, so create a manual one
   * from the poll's own question/option, then lock it in one motion — a poll answered becomes a
   * plan without a separate "now go make a Plan" step. */
  async function lockPollOption(messageId: string, question: string, option: string) {
    setLockingPlanId(messageId);
    try {
      const res = await api.post<{ plan: { id: string; publicSlug: string } }>(`/crews/${crewId}/plans/manual`, { title: `${question} — ${option}` });
      await api.post(`/plans/${res.plan.id}/lock`);
      router.push(`/plans/${res.plan.publicSlug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not lock that in.');
      setLockingPlanId(null);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft('');
    try {
      const res = await api.post<{ message: ChatMessage }>(`/crews/${crewId}/messages`, { body });
      lastIdRef.current = res.message.id;
      setMessages((prev) => [...(prev ?? []), res.message]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Message did not send.');
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  async function getInviteLink() {
    const res = await api.post<{ inviteUrl: string }>(`/crews/${crewId}/invites`, { channel: 'link' });
    setInviteUrl(res.inviteUrl);
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

  if (!crew) {
    return (
      <div className="v2">
        <div className="v2-page" style={{ paddingTop: 28 }}>
          {error ? <div style={{ color: 'var(--v2-brand)' }}>{error}</div> : <div style={{ height: 60, borderRadius: 16, background: 'var(--v2-bg-deep)' }} />}
        </div>
      </div>
    );
  }

  const solo = crew.members.length === 1;
  const activePlan = crew.plans.find((p) => ACTIVE_DECISION_STATUSES.has(p.status));
  const upcomingPlan = crew.plans.find((p) => p.status === 'BOOKED');
  const context = upcomingPlan ?? activePlan;

  return (
    <div className="v2">
      <div className="v2-shell-desktop" style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Header — minimal, no boxed nav bar: back arrow, avatar cluster + name (tap opens
            Crew info), that's the whole chrome. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 10px' }}>
          <Link href="/crews" aria-label="Back to Crews" style={{ fontSize: 20, color: 'var(--v2-ink-muted)', flexShrink: 0 }}>←</Link>
          <button onClick={() => setInfoOpen(true)} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <div className="stack">
              {crew.members.slice(0, 4).map((m) => (
                <div key={m.user.id} style={{ width: 30, height: 30, borderRadius: '50%', marginLeft: -8, fontSize: 11, fontWeight: 800, color: '#fff', background: avatarColor(m.user.displayName ?? m.user.email), display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--v2-bg)' }}>
                  {initials(m.user.displayName, m.user.email)}
                </div>
              ))}
            </div>
            <div className="v2-display" style={{ fontSize: 17, textAlign: 'left' }}>{crew.name}</div>
          </button>
        </div>

        {/* CURRENT CONTEXT — one slim, colourful strip, never a card competing with chat. */}
        {context && (
          <Link
            href={`/plans/${context.publicSlug}`}
            className="fade-up"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, margin: '0 20px 8px', padding: '11px 16px', borderRadius: 100,
              background: upcomingPlan ? 'rgba(28,122,82,0.1)' : 'rgba(255,178,56,0.16)',
            }}
          >
            <span style={{ fontSize: 15 }}>{upcomingPlan ? '📅' : '🗳️'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>{context.title}</span>
              {activePlan === context && <span className="v2-muted" style={{ fontSize: 12 }}> · {context.votes.filter((v) => v.vote === 'IN').length}/{context.members.length} in</span>}
            </div>
            <span style={{ fontSize: 12, fontWeight: 800, color: upcomingPlan ? 'var(--v2-green)' : '#a06a00', flexShrink: 0 }}>{upcomingPlan ? 'View' : 'Vote'} →</span>
          </Link>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', height: context ? 'calc(100dvh - 132px)' : 'calc(100dvh - 82px)', padding: '4px 20px calc(env(safe-area-inset-bottom, 0px) + 14px)' }}>
          <div ref={listRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 10 }}>
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
                {[1, 2, 3].map((i) => <div key={i} style={{ height: 34, borderRadius: 16, background: 'var(--v2-bg-deep)', width: `${50 + i * 12}%` }} />)}
              </div>
            )}
            {!solo && messages?.length === 0 && (
              <div style={{ textAlign: 'center', margin: 'auto' }}>
                <p className="v2-muted">Someone has to start it — say hi.</p>
              </div>
            )}
            {!solo && messages?.map((m, i) => {
              const mine = m.author.id === me;
              const planMatch = m.body.match(PLAN_ANNOUNCEMENT);
              const cardData = planMatch ? planCards[planMatch[2]] : undefined;
              const prev = i > 0 ? messages[i - 1] : null;
              const grouped = prev !== null && prev.author.id === m.author.id;

              return (
                <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: mine ? 'row-reverse' : 'row', marginTop: grouped ? -4 : 8 }}>
                  {!mine && (
                    <div style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, visibility: grouped ? 'hidden' : 'visible', fontSize: 9.5, fontWeight: 800, color: '#fff', background: avatarColor(m.author.displayName ?? m.author.email), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {initials(m.author.displayName, m.author.email)}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '76%' }}>
                    {!mine && !grouped && <div className="v2-dim" style={{ fontSize: 10.5, marginBottom: 2, marginLeft: 2 }}>{displayNameOf(m.author.displayName, m.author.email)}</div>}
                    {m.poll ? (
                      <PollCard
                        poll={m.poll}
                        voting={votingMessageId === m.id}
                        onVote={(option) => votePollOption(m.id, option)}
                        locking={lockingPlanId === m.id}
                        onLockOption={(option) => lockPollOption(m.id, m.poll!.question, option)}
                      />
                    ) : planMatch && cardData && cardData !== 'loading' && cardData !== 'error' ? (
                      <EventCard data={cardData} onLock={lockPlanById} locking={lockingPlanId === cardData.plan.id} />
                    ) : planMatch && cardData === 'loading' ? (
                      <div style={{ width: 260, height: 120, borderRadius: 16, background: 'var(--v2-bg-deep)' }} />
                    ) : (
                      <div
                        className="fade-up"
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
                    {!planMatch && !m.poll && <ReactionRow reactions={m.reactions} pickerOpen={pickerFor === m.id} onTogglePicker={() => setPickerFor(m.id)} onPick={(emoji) => react(m.id, emoji)} align={mine ? 'flex-end' : 'flex-start'} />}
                    <div className="v2-dim" style={{ fontSize: 9.5, marginTop: 3 }}>{formatTime(m.createdAt)}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {error && <div style={{ color: 'var(--v2-brand)', fontSize: 12.5, marginBottom: 6 }}>{error}</div>}

          {!solo && (
            <form onSubmit={send} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setActionOpen(true)}
                aria-label="Add to conversation"
                style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', border: 'none', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', color: 'var(--v2-ink)', fontSize: 20, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}
              >
                +
              </button>
              <input
                style={{
                  flex: 1, padding: '13px 18px', borderRadius: 100, border: 'none', outline: 'none',
                  background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', fontSize: 14.5, fontFamily: 'inherit', color: 'var(--v2-ink)',
                }}
                placeholder={`Message ${crew.name}…`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={sending}
                maxLength={2000}
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                aria-label="Send"
                style={{ flexShrink: 0, width: 44, height: 44, borderRadius: '50%', border: 'none', background: 'var(--v2-brand)', color: '#fff', fontSize: 17, cursor: 'pointer', opacity: sending || !draft.trim() ? 0.5 : 1 }}
              >
                {sending ? '…' : '↑'}
              </button>
            </form>
          )}
        </div>
      </div>

      {/* THE COMPOSER'S "+" ACTION SHEET — every way of adding something to the conversation
          beyond plain text, one entry point. See docs/DECISIONS.md#decision-objects. */}
      <BottomSheet open={actionOpen} onClose={closeActionSheet} variant="light">
        {actionView === 'menu' && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 14 }}>Add to {crew.name}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { icon: '✨', label: 'Suggest something', desc: suggesting ? 'Finding something…' : 'Plot picks from what everyone likes', action: suggestSomething, disabled: suggesting },
                { icon: '📍', label: 'Share a place', desc: 'Browse and send something specific', action: () => openAction('share'), disabled: false },
                { icon: '🗳️', label: 'Poll the group', desc: 'Ask a question, watch it settle', action: () => openAction('poll'), disabled: false },
                { icon: '📅', label: 'Check availability', desc: "When's everyone actually free", action: () => openAction('availability'), disabled: false },
                { icon: '📌', label: 'Log a plan', desc: "Already know what you're doing", action: () => openAction('manual'), disabled: false },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  disabled={item.disabled}
                  className="v2-card"
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', border: 'none', textAlign: 'left', cursor: item.disabled ? 'default' : 'pointer', width: '100%', opacity: item.disabled ? 0.6 : 1 }}
                >
                  <span style={{ fontSize: 22 }}>{item.icon}</span>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 14.5 }}>{item.label}</div>
                    <div className="v2-muted" style={{ fontSize: 12 }}>{item.desc}</div>
                  </div>
                </button>
              ))}
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

        {actionView === 'share' && (
          <div>
            <button onClick={() => setActionView('menu')} className="v2-muted" style={{ background: 'none', border: 'none', fontSize: 13, marginBottom: 10, cursor: 'pointer', padding: 0 }}>← Back</button>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Share a place</div>
            {shareItems === null && <p className="v2-muted">Loading ideas…</p>}
            {shareItems?.length === 0 && <p className="v2-muted">Nothing to suggest right now — try again shortly.</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
              {shareItems?.map((exp) => (
                <button
                  key={exp.id}
                  onClick={() => shareExperience(exp.id)}
                  disabled={sharingId !== null}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, border: 'none', background: 'var(--v2-bg-deep)', borderRadius: 14, padding: 10, cursor: 'pointer', textAlign: 'left' }}
                >
                  <div style={{ width: 52, height: 52, borderRadius: 10, flexShrink: 0, background: v2Art(exp.imageUrl, exp.category) }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exp.name}</div>
                    <div className="v2-muted" style={{ fontSize: 11.5 }}>{exp.venue.name}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--v2-brand)', flexShrink: 0 }}>{sharingId === exp.id ? '…' : 'Send'}</span>
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

      <BottomSheet open={infoOpen} onClose={() => setInfoOpen(false)} variant="light">
        <div className="v2-eyebrow" style={{ marginBottom: 2 }}>{crew.name}</div>
        <p className="v2-muted" style={{ fontSize: 12.5, marginBottom: 16 }}>{crew.members.length} people</p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          {crew.members.map((m) => (
            <div key={m.user.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 26, height: 26, borderRadius: '50%', fontSize: 10, fontWeight: 800, color: '#fff', background: avatarColor(m.user.displayName ?? m.user.email), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {initials(m.user.displayName, m.user.email)}
              </div>
              <span style={{ fontSize: 12.5 }}>{displayNameOf(m.user.displayName, m.user.email)}</span>
            </div>
          ))}
        </div>

        {crew.dna && (
          <div style={{ marginBottom: 18 }}>
            <div className="v2-eyebrow" style={{ marginBottom: 6 }}>Group DNA · {crew.dna.confidence.toLowerCase()} confidence</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {crew.dna.topCategories.length ? (
                crew.dna.topCategories.map((c) => <span key={c} style={{ fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 100, background: 'rgba(255,178,56,0.16)', color: '#8a5a00' }}>{c}</span>)
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

        <div className="v2-eyebrow" style={{ marginBottom: 6 }}>Invite</div>
        {inviteUrl ? (
          <button onClick={copyInvite} className="v2-btn v2-btn-ghost" style={{ justifyContent: 'space-between', textAlign: 'left' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inviteUrl}</span>
            <span style={{ color: 'var(--v2-brand)', flexShrink: 0 }}>{copied ? '✓' : 'Copy'}</span>
          </button>
        ) : (
          <button onClick={getInviteLink} className="v2-btn v2-btn-ghost">Get invite link</button>
        )}
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
