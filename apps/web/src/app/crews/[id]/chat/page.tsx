'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { categoryStyle } from '@/lib/categoryStyle';

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string | null; email: string };
}

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
      venue: { name: string } | null;
    } | null;
  };
  pulse: { inCount: number; totalMembers: number };
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
        borderRadius: 18,
        overflow: 'hidden',
        border: '1px solid var(--ink-border)',
        background: 'var(--ink-surface)',
        textDecoration: 'none',
        color: 'inherit',
        boxShadow: 'var(--hard-shadow)',
      }}
    >
      <div className="art-block" style={{ background: style.bg }}>
        {style.emoji}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 14.5, lineHeight: 1.25, marginBottom: 3 }}>
          {data.plan.title}
        </div>
        {exp && (
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
            {exp.venue?.name ?? 'Venue TBC'} ·{' '}
            {new Date(exp.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            {exp.priceMinMinor !== null && ` · from £${(exp.priceMinMinor / 100).toFixed(0)}`}
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

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function CrewChatPage() {
  const { id: crewId } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [planCards, setPlanCards] = useState<Record<string, PlanCardData | 'loading' | 'error'>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    api
      .get<{ user: { id: string } }>('/users/me')
      .then((res) => setMe(res.user.id))
      .catch(() => {});
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await api.get<{ messages: ChatMessage[] }>(
        `/crews/${crewId}/messages${lastIdRef.current ? `?after=${lastIdRef.current}` : ''}`,
      );
      if (res.messages.length === 0) return;
      lastIdRef.current = res.messages[res.messages.length - 1].id;
      setMessages((prev) => (prev ? [...prev, ...res.messages] : res.messages));
    } catch (err) {
      // A single failed poll tick shouldn't nuke the chat someone's already reading — only
      // surface an error if nothing has ever loaded.
      setMessages((prev) => prev ?? []);
      setError((prev) => prev ?? (err instanceof ApiError ? err.message : 'Could not load chat.'));
    }
  }, [crewId]);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

  // Fetch (once, cached) the real Plan + Experience data behind every "sent to Crew" chat
  // message, so it renders as a real event card instead of a bare text link.
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
    // planCards intentionally omitted — it's the cache being written, not a trigger.
  }, [messages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

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

  return (
    <>
      <nav className="nav">
        <Link href={`/crews/${crewId}`} className="muted" style={{ fontSize: 13 }}>
          ← Crew
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      {/* 100dvh (not 100vh) so the composer stays reachable when a mobile keyboard eats
          viewport height, instead of getting pushed off-screen below the fold. */}
      <div className="page" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 90px)', paddingBottom: 12 }}>
        <div className="eyebrow">Crew chat</div>
        <p className="muted" style={{ marginBottom: 14 }}>Just this Crew. No one else can see it.</p>

        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 10 }}>
          {messages === null && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ height: 34, borderRadius: 16, background: 'var(--ink-surface-2)', width: `${50 + i * 12}%`, opacity: 0.6 }} />
              ))}
            </div>
          )}
          {messages?.length === 0 && (
            <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--ink-text-muted)' }}>
              <div style={{ fontSize: 30, marginBottom: 8 }}>💬</div>
              <p className="muted">No messages yet — say hi, or send an event from Explore.</p>
            </div>
          )}
          {messages?.map((m, i) => {
            const mine = m.author.id === me;
            const planMatch = m.body.match(PLAN_ANNOUNCEMENT);
            const cardData = planMatch ? planCards[planMatch[2]] : undefined;
            // Consecutive messages from the same sender group together — a name/avatar on
            // every single line reads as unfinished the moment someone sends two in a row.
            const prev = i > 0 ? messages[i - 1] : null;
            const grouped = prev !== null && prev.author.id === m.author.id;

            return (
              <div
                key={m.id}
                style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', marginTop: grouped ? -6 : 6 }}
              >
                {!mine && !grouped && (
                  <div className="muted" style={{ fontSize: 10.5, marginBottom: 2, marginLeft: 4 }}>
                    {m.author.displayName ?? m.author.email}
                  </div>
                )}

                {planMatch && cardData && cardData !== 'loading' && cardData !== 'error' ? (
                  <>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      📍 sent an event
                    </div>
                    <EventCard data={cardData} />
                  </>
                ) : planMatch && cardData === 'loading' ? (
                  <div style={{ width: 240, height: 108, borderRadius: 16, background: 'var(--ink-surface-2)', opacity: 0.6 }} />
                ) : (
                  <div
                    className="card fade-up"
                    style={{
                      margin: 0,
                      padding: '9px 13px',
                      maxWidth: '78%',
                      background: mine ? 'var(--ink-gold)' : undefined,
                      color: mine ? 'var(--ink-gold-ink)' : undefined,
                      wordBreak: 'break-word',
                      boxShadow: 'none', // a shadow on every bubble is too heavy for a chat thread
                    }}
                  >
                    {m.body}
                  </div>
                )}
                <div className="muted" style={{ fontSize: 9.5, marginTop: 3, marginInline: 4 }}>
                  {formatTime(m.createdAt)}
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="error">{error}</div>}

        <form onSubmit={send} style={{ display: 'flex', gap: 8, paddingTop: 10, alignItems: 'center' }}>
          <input
            className="field"
            style={{ flex: 1, borderRadius: 100 }}
            placeholder="Message the Crew…"
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
      </div>
    </>
  );
}
