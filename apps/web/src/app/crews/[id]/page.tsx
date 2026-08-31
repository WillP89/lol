'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { categoryStyle, categoryBackground } from '@/lib/categoryStyle';
import { formatPriceFrom } from '@/lib/formatPrice';
import { displayNameOf } from '@/lib/displayName';
import { BottomSheet } from '@/components/BottomSheet';
import { TabBar } from '@/components/TabBar';

interface Reaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string | null; email: string };
  reactions: Reaction[];
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
const AVATAR_COLORS = ['#ffab2e', '#ff6b4a', '#8fc9a3', '#c9a0dc', '#7fb3d5'];
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
// Matches the exact shape services/plan.ts posts when a Plan is sent to the Crew — see
// createPlanForCrew's chat announcement.
const PLAN_ANNOUNCEMENT = /^📍 Sent "(.+)" to the Crew — \/plans\/([a-zA-Z0-9-]+)$/;

function EventCard({ data }: { data: PlanCardData }) {
  const exp = data.plan.experience;
  const style = categoryStyle(exp?.category);
  return (
    <Link
      href={`/plans/${data.plan.publicSlug}`}
      className="fade-up"
      style={{
        display: 'block',
        width: 240,
        borderRadius: 20,
        overflow: 'hidden',
        background: 'var(--ink-surface)',
        textDecoration: 'none',
        color: 'inherit',
        boxShadow: 'var(--ambient-shadow)',
      }}
    >
      <div className="art-block" style={{ background: categoryBackground(exp?.imageUrl, exp?.category) }}>
        {!exp?.imageUrl && style.emoji}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 14.5, lineHeight: 1.25, marginBottom: 3 }}>
          {data.plan.title}
        </div>
        {exp && (
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
            {exp.venue?.name ?? 'Venue TBC'} ·{' '}
            {new Date(exp.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            {formatPriceFrom(exp.priceMinMinor) && ` · ${formatPriceFrom(exp.priceMinMinor)}`}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="chip gold static" style={{ fontSize: 10, padding: '4px 9px' }}>
            {data.pulse.inCount}/{data.pulse.totalMembers} in
          </span>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-gold)' }}>View plan →</span>
        </div>
      </div>
    </Link>
  );
}

/** Existing reaction pills (tap to toggle yours) plus a "+" that reveals the quick-pick row —
 * the picker only appears on demand so a chat with no reactions yet stays visually quiet. */
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
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            fontSize: 11.5,
            padding: '2px 7px',
            borderRadius: 100,
            background: r.reactedByMe ? 'rgba(255,171,46,.18)' : 'var(--ink-surface-2)',
            color: r.reactedByMe ? 'var(--ink-gold)' : 'var(--ink-text-muted)',
            cursor: 'pointer',
          }}
        >
          <span>{r.emoji}</span>
          <span>{r.count}</span>
        </button>
      ))}
      {pickerOpen ? (
        REACTION_CHOICES.map((emoji) => (
          <button
            key={emoji}
            onClick={() => onPick(emoji)}
            style={{ fontSize: 15, padding: '2px 6px', borderRadius: 100, border: 'none', background: 'var(--ink-surface-2)', cursor: 'pointer' }}
          >
            {emoji}
          </button>
        ))
      ) : (
        <button
          onClick={onTogglePicker}
          aria-label="Add reaction"
          style={{ fontSize: 11, padding: '2px 7px', borderRadius: 100, border: 'none', background: 'transparent', color: 'var(--ink-text-dim)', cursor: 'pointer' }}
        >
          +
        </button>
      )}
    </div>
  );
}

/**
 * Crew = the conversation. Not a summary page that links out to chat — the brief's own words:
 * "the conversation dominates the rest... do not surround it with panels." A compact header
 * (name, avatars) and at most one slim "what's happening" strip sit above a full-height message
 * list; everything else that used to live here as its own boxed section (Group DNA, the
 * availability strip, the invite link) moved into a single "Crew info" sheet reachable from the
 * header, the way a real messaging app puts group settings behind "tap the group name," not
 * inline in the conversation. See docs/DECISIONS.md#crew-chat-merge.
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

  useEffect(() => {
    api
      .get<{ crew: CrewDetail }>(`/crews/${crewId}`)
      .then((res) => setCrew(res.crew))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Crew.'));
    api
      .get<{ availability: DayAvailability[] }>(`/crews/${crewId}/availability?days=0,1,2,3`)
      .then((res) => setAvailability(res.availability))
      .catch(() => {});
    api
      .get<{ user: { id: string } }>('/users/me')
      .then((res) => setMe(res.user.id))
      .catch(() => {});
  }, [crewId]);

  const poll = useCallback(async () => {
    try {
      const res = await api.get<{ messages: ChatMessage[] }>(
        `/crews/${crewId}/messages${lastIdRef.current ? `?after=${lastIdRef.current}` : ''}`,
      );
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
      api
        .get<PlanCardData>(`/plans/public/${slug}`)
        .then((data) => setPlanCards((prev) => ({ ...prev, [slug]: data })))
        .catch(() => setPlanCards((prev) => ({ ...prev, [slug]: 'error' })));
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
      // not worth an error banner — the pill just won't change, the next poll reconciles it
    }
  }

  async function suggestSomething() {
    setSuggesting(true);
    setError(null);
    try {
      await api.post(`/crews/${crewId}/suggest-to-chat`);
      await poll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not find anything right now — try again.');
    } finally {
      setSuggesting(false);
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
      // cancelled — fall through to clipboard
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked — the link is still visible to copy by hand
    }
  }

  if (!crew) {
    return (
      <div className="page">
        {error ? (
          <div className="error">{error}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 20 }}>
            <div style={{ height: 40, borderRadius: 12, background: 'var(--ink-surface)', opacity: 0.5 }} />
            <div style={{ height: 90, borderRadius: 16, background: 'var(--ink-surface)', opacity: 0.5 }} />
          </div>
        )}
      </div>
    );
  }

  const solo = crew.members.length === 1;
  const activePlan = crew.plans.find((p) => ACTIVE_DECISION_STATUSES.has(p.status));
  const upcomingPlan = crew.plans.find((p) => p.status === 'BOOKED');
  const context = upcomingPlan ?? activePlan;

  return (
    <>
      <nav className="nav" style={{ gap: 10 }}>
        <Link href="/crews" className="muted" aria-label="Back to Crews" style={{ fontSize: 18, flexShrink: 0 }}>
          ←
        </Link>
        <button
          onClick={() => setInfoOpen(true)}
          style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
        >
          <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{crew.name}</div>
          <div className="stack" style={{ flexShrink: 0 }}>
            {crew.members.slice(0, 3).map((m) => (
              <div key={m.user.id} className="avatar" style={{ width: 22, height: 22, fontSize: 8.5, background: avatarColor(m.user.displayName ?? m.user.email) }}>
                {initials(m.user.displayName, m.user.email)}
              </div>
            ))}
          </div>
        </button>
        <button
          onClick={() => setInfoOpen(true)}
          aria-label="Crew info"
          style={{ flexShrink: 0, width: 30, height: 30, borderRadius: '50%', border: 'none', background: 'var(--ink-surface-2)', color: 'var(--ink-text-muted)', fontSize: 14, cursor: 'pointer' }}
        >
          ⓘ
        </button>
      </nav>

      {/* CURRENT CONTEXT — one slim strip, only when there's something to say, never both a
          locked-in plan AND an open vote taking equal space; a confirmed plan always outranks
          an in-progress decision. */}
      {context && (
        <Link
          href={`/plans/${context.publicSlug}`}
          className="fade-up crew-context-strip"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 20px',
            textDecoration: 'none',
            color: 'inherit',
            background: upcomingPlan ? 'rgba(143,201,163,0.1)' : 'rgba(255,171,46,0.1)',
            borderBottom: '1px solid var(--ink-border)',
          }}
        >
          <span style={{ fontSize: 17 }}>{upcomingPlan ? '📅' : '🗳️'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: upcomingPlan ? 'var(--ink-moss)' : 'var(--ink-gold)' }}>
              {upcomingPlan ? 'Coming up' : 'Deciding now'}
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {context.title}
              {activePlan === context && ` · ${context.votes.filter((v) => v.vote === 'IN').length}/${context.members.length} in`}
            </div>
          </div>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: upcomingPlan ? 'var(--ink-moss)' : 'var(--ink-gold)', flexShrink: 0 }}>
            {upcomingPlan ? 'View →' : 'Vote →'}
          </span>
        </Link>
      )}

      {/* 100dvh so the composer stays reachable when a mobile keyboard eats viewport height. */}
      <div
        className="page"
        style={{ display: 'flex', flexDirection: 'column', height: context ? 'calc(100dvh - 140px)' : 'calc(100dvh - 90px)', paddingTop: 14, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
      >
        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 10 }}>
          {solo && (
            <div style={{ textAlign: 'center', margin: 'auto', maxWidth: 260 }}>
              <div style={{ fontSize: 34, marginBottom: 10 }}>🎉</div>
              <p style={{ marginBottom: 6, fontWeight: 700 }}>It&rsquo;s just you here so far.</p>
              <p className="muted" style={{ marginBottom: 16, fontSize: 13.5 }}>Bring your people in and Plot finds what you should do together.</p>
              {inviteUrl ? (
                <button className="btn btn-primary" onClick={copyInvite} style={{ width: 'auto', padding: '11px 22px' }}>
                  {copied ? '✓ Copied' : 'Share invite link'}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={getInviteLink} style={{ width: 'auto', padding: '11px 22px' }}>
                  Get invite link
                </button>
              )}
            </div>
          )}
          {!solo && messages === null && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ height: 34, borderRadius: 16, background: 'var(--ink-surface-2)', width: `${50 + i * 12}%`, opacity: 0.6 }} />
              ))}
            </div>
          )}
          {!solo && messages?.length === 0 && (
            <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--ink-text-muted)' }}>
              <div style={{ fontSize: 30, marginBottom: 8 }}>💬</div>
              <p className="muted">Someone has to start it — say hi.</p>
            </div>
          )}
          {!solo &&
            messages?.map((m, i) => {
              const mine = m.author.id === me;
              const planMatch = m.body.match(PLAN_ANNOUNCEMENT);
              const cardData = planMatch ? planCards[planMatch[2]] : undefined;
              const prev = i > 0 ? messages[i - 1] : null;
              const grouped = prev !== null && prev.author.id === m.author.id;

              return (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', marginTop: grouped ? -6 : 6 }}>
                  {!mine && !grouped && (
                    <div className="muted" style={{ fontSize: 10.5, marginBottom: 2, marginLeft: 4 }}>
                      {displayNameOf(m.author.displayName, m.author.email)}
                    </div>
                  )}
                  {planMatch && cardData && cardData !== 'loading' && cardData !== 'error' ? (
                    <>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>📍 sent an event</div>
                      <EventCard data={cardData} />
                    </>
                  ) : planMatch && cardData === 'loading' ? (
                    <div style={{ width: 240, height: 108, borderRadius: 16, background: 'var(--ink-surface-2)', opacity: 0.6 }} />
                  ) : (
                    <div
                      className="fade-up"
                      style={{
                        padding: '10px 14px',
                        maxWidth: '78%',
                        background: mine ? 'var(--ink-gold)' : 'var(--ink-surface)',
                        color: mine ? 'var(--ink-gold-ink)' : 'var(--ink-text)',
                        wordBreak: 'break-word',
                        fontSize: 14.5,
                        lineHeight: 1.4,
                        borderRadius: mine ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                      }}
                    >
                      {m.body}
                    </div>
                  )}
                  {!planMatch && (
                    <ReactionRow
                      reactions={m.reactions}
                      pickerOpen={pickerFor === m.id}
                      onTogglePicker={() => setPickerFor(m.id)}
                      onPick={(emoji) => react(m.id, emoji)}
                      align={mine ? 'flex-end' : 'flex-start'}
                    />
                  )}
                  <div className="muted" style={{ fontSize: 9.5, marginTop: 3, marginInline: 4 }}>
                    {formatTime(m.createdAt)}
                  </div>
                </div>
              );
            })}
        </div>

        {error && <div className="error">{error}</div>}

        {!solo && (
          <button
            type="button"
            onClick={suggestSomething}
            disabled={suggesting}
            className="chip gold"
            style={{ alignSelf: 'flex-start', marginBottom: 8, fontSize: 12.5, padding: '8px 14px' }}
          >
            {suggesting ? 'Finding something…' : '✨ Suggest something'}
          </button>
        )}

        {!solo && (
          <form onSubmit={send} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="field"
              style={{ flex: 1, borderRadius: 100 }}
              placeholder={`Message ${crew.name}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={sending}
              maxLength={2000}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={sending || !draft.trim()}
              style={{ flex: '0 0 auto', width: 44, height: 44, padding: 0, borderRadius: '50%', fontSize: 16 }}
              aria-label="Send"
            >
              {sending ? '…' : '↑'}
            </button>
          </form>
        )}
      </div>

      {/* CREW INFO — everything that isn't "the conversation" lives here: full member list,
          Group DNA, the availability strip, the invite link. Tap the header to get here;
          nothing here competes with chat for space on the primary screen. */}
      <BottomSheet open={infoOpen} onClose={() => setInfoOpen(false)}>
        <div className="eyebrow" style={{ marginBottom: 2 }}>{crew.name}</div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
          {crew.members.length} {crew.members.length === 1 ? 'person' : 'people'}
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          {crew.members.map((m) => (
            <div key={m.user.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 10, background: avatarColor(m.user.displayName ?? m.user.email) }}>
                {initials(m.user.displayName, m.user.email)}
              </div>
              <span style={{ fontSize: 12.5 }}>{displayNameOf(m.user.displayName, m.user.email)}</span>
            </div>
          ))}
        </div>

        {crew.dna && (
          <div style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Group DNA · {crew.dna.confidence.toLowerCase()} confidence</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {crew.dna.topCategories.length ? (
                crew.dna.topCategories.map((c) => (
                  <span key={c} className="chip gold static">{c}</span>
                ))
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>Plot is still learning this Crew&rsquo;s taste.</span>
              )}
            </div>
          </div>
        )}

        {availability.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Everyone&rsquo;s evening</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {availability.map((d) => (
                <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
                  <div className="muted" style={{ fontSize: 10 }}>{d.day}</div>
                  <div
                    style={{
                      marginTop: 4,
                      padding: '8px 0',
                      borderRadius: 8,
                      fontSize: 11,
                      background: d.freeCount / d.totalMembers >= 0.6 ? 'var(--ink-moss)' : 'var(--ink-surface-2)',
                      color: d.freeCount / d.totalMembers >= 0.6 ? '#0c1712' : 'var(--ink-text-muted)',
                      fontWeight: 700,
                    }}
                  >
                    {d.freeCount}/{d.totalMembers}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="eyebrow" style={{ marginBottom: 6 }}>Invite</div>
        {inviteUrl ? (
          <button onClick={copyInvite} className="btn" style={{ justifyContent: 'space-between', textAlign: 'left' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inviteUrl}</span>
            <span style={{ color: 'var(--ink-gold)', flexShrink: 0 }}>{copied ? '✓' : 'Copy'}</span>
          </button>
        ) : (
          <button onClick={getInviteLink} className="btn">Get invite link</button>
        )}
      </BottomSheet>

      <TabBar desktopOnly />
    </>
  );
}
