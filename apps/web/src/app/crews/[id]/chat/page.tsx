'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string | null; email: string };
}

const POLL_INTERVAL_MS = 3000;

export default function CrewChatPage() {
  const { id: crewId } = useParams<{ id: string }>();
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Refs, not state, for values the polling loop reads but shouldn't re-run its effect over.
  const lastIdRef = useRef<string | undefined>(undefined);
  const meRef = useRef<string | null>(null);

  useEffect(() => {
    api
      .get<{ user: { id: string } }>('/users/me')
      .then((res) => {
        meRef.current = res.user.id;
      })
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
      // A single failed poll tick shouldn't nuke the chat the user is already reading —
      // only surface an error if we never managed to load anything.
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
      <div className="page" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 90px)' }}>
        <div className="eyebrow">Crew chat</div>
        <p className="muted" style={{ marginBottom: 14 }}>Just this Crew. No one else can see it.</p>

        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 10 }}>
          {messages === null && !error && <p className="muted">Loading…</p>}
          {messages?.length === 0 && <p className="muted">No messages yet — say something.</p>}
          {messages?.map((m) => {
            const mine = m.author.id === meRef.current;
            return (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
                {!mine && (
                  <div className="muted" style={{ fontSize: 10.5, marginBottom: 2, marginLeft: 4 }}>
                    {m.author.displayName ?? m.author.email}
                  </div>
                )}
                <div
                  className="card"
                  style={{
                    margin: 0,
                    padding: '9px 13px',
                    maxWidth: '78%',
                    background: mine ? 'var(--ink-gold)' : undefined,
                    color: mine ? 'var(--ink-gold-ink)' : undefined,
                    wordBreak: 'break-word',
                  }}
                >
                  {m.body}
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="error">{error}</div>}

        <form onSubmit={send} style={{ display: 'flex', gap: 8, paddingTop: 10 }}>
          <input
            className="field"
            style={{ flex: 1 }}
            placeholder="Message the Crew…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
          />
          <button className="btn btn-primary" type="submit" disabled={sending || !draft.trim()} style={{ flex: '0 0 auto', padding: '10px 18px' }}>
            Send
          </button>
        </form>
      </div>
    </>
  );
}
