'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { BottomSheet } from '@/components/BottomSheet';

interface CrewSummary {
  id: string;
  name: string;
  members: { user: { displayName: string | null; email: string } }[];
  dna: { confidence: string } | null;
  latestMessage: { body: string; authorName: string; createdAt: string } | null;
  activePlan: { id: string; title: string; publicSlug: string; inCount: number; totalMembers: number } | null;
  upcomingPlan: { id: string; title: string; publicSlug: string; startsAt: string | null; venueName: string | null } | null;
}

const AVATAR_COLORS = ['#f2a93b', '#7fb79a', '#ea5b3d', '#9c97ae', '#6b8ef2'];

function initials(displayName: string | null, email: string) {
  const source = displayName?.trim() || email;
  return source.slice(0, 1).toUpperCase();
}

function avatarColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

// A short, human "X ago"/"day" label — good enough for a chat-preview timestamp without
// pulling in a date library for one string.
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * What a Crew card actually shows, in priority order — this is what turns "a list of Crew
 * names" into "what's actually going on", per docs/DECISIONS.md#home-surface: a locked-in
 * plan beats an open decision beats a chat snippet beats nothing.
 */
function CrewActivityLine({ crew }: { crew: CrewSummary }) {
  if (crew.upcomingPlan) {
    const when = crew.upcomingPlan.startsAt
      ? new Date(crew.upcomingPlan.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      : null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-moss)', fontWeight: 600 }}>
        <span>📅</span>
        <span>
          {crew.upcomingPlan.title}
          {when && ` · ${when}`}
        </span>
      </div>
    );
  }
  if (crew.activePlan) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-gold)', fontWeight: 600 }}>
        <span>🗳️</span>
        <span>
          Deciding: {crew.activePlan.title} · {crew.activePlan.inCount}/{crew.activePlan.totalMembers} in
        </span>
      </div>
    );
  }
  if (crew.latestMessage) {
    return (
      <div className="muted" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 600, color: 'var(--ink-text)' }}>{crew.latestMessage.authorName}: </span>
        {crew.latestMessage.body}
      </div>
    );
  }
  return <div className="muted" style={{ fontSize: 12.5 }}>No activity yet — say hi.</div>;
}

export default function CrewsPage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    api
      .get<{ crews: CrewSummary[] }>('/crews')
      .then((res) => setCrews(res.crews))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Crews.'));
  }

  useEffect(load, []);

  async function createCrew(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api.post('/crews', { name: name.trim(), defaultCity: 'London' });
      setName('');
      setShowCreate(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create Crew.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <nav className="nav">
        <div className="wordmark">
          Plot<span>·</span>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          aria-label="New Crew"
          style={{ background: 'var(--ink-surface-2)', border: '1px solid var(--ink-border)', color: 'var(--ink-text)', width: 32, height: 32, borderRadius: '50%', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          +
        </button>
      </nav>
      <div className="page">
        <div className="masthead">
          <h1 style={{ fontSize: 22 }}>Home</h1>
          <p className="muted" style={{ marginBottom: 0 }}>What your Crews are up to.</p>
        </div>

        {crews === null && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
            {[1, 2].map((i) => (
              <div key={i} className="card" style={{ height: 74, opacity: 0.5 }} />
            ))}
          </div>
        )}

        {crews?.map((crew) => (
          <Link key={crew.id} href={`/crews/${crew.id}`} className="card fade-up" style={{ display: 'block', textDecoration: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
              <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 17 }}>{crew.name}</div>
              <div className="stack" style={{ flexShrink: 0 }}>
                {crew.members.slice(0, 4).map((m, i) => (
                  <div key={i} className="avatar" style={{ width: 24, height: 24, fontSize: 9.5, background: avatarColor(m.user.displayName ?? m.user.email) }}>
                    {initials(m.user.displayName, m.user.email)}
                  </div>
                ))}
              </div>
            </div>
            <CrewActivityLine crew={crew} />
            {crew.latestMessage && (crew.upcomingPlan || crew.activePlan) && (
              <div className="muted" style={{ fontSize: 10.5, marginTop: 4 }}>{timeAgo(crew.latestMessage.createdAt)} ago in chat</div>
            )}
          </Link>
        ))}

        {crews?.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: '28px 16px' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>👋</div>
            <p style={{ marginBottom: 4 }}>No Crews yet.</p>
            <p className="muted" style={{ marginBottom: 14 }}>Create one, or ask a friend for their invite link.</p>
            <button className="btn btn-primary" onClick={() => setShowCreate(true)} style={{ width: 'auto', padding: '10px 20px' }}>
              Create a Crew
            </button>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>

      <BottomSheet open={showCreate} onClose={() => !creating && setShowCreate(false)}>
        <form onSubmit={createCrew} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}>
            New Crew
          </div>
          <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Boys, Flat 4B" required />
          <button className="btn btn-primary" disabled={creating || !name.trim()} type="submit">
            {creating ? 'Creating…' : 'Create Crew'}
          </button>
        </form>
      </BottomSheet>

      <TabBar />
    </>
  );
}
