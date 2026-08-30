'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface CrewSummary {
  id: string;
  name: string;
  members: { user: { displayName: string | null; email: string } }[];
  dna: { confidence: string } | null;
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

export default function CrewsPage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Link href="/explore" className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
            Explore
          </Link>
          <Link href="/onboarding" className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
            Profile
          </Link>
        </div>
      </nav>
      <div className="page">
        <div className="masthead">
          <h1 style={{ fontSize: 22 }}>Your Crews</h1>
          <p className="muted" style={{ marginBottom: 0 }}>Pick one to talk, discover something, and decide together.</p>
        </div>

        {crews === null && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
            {[1, 2].map((i) => (
              <div key={i} className="card" style={{ height: 62, opacity: 0.5 }} />
            ))}
          </div>
        )}

        {crews?.map((crew) => (
          <Link
            key={crew.id}
            href={`/crews/${crew.id}`}
            className="card fade-up"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textDecoration: 'none' }}
          >
            <div>
              <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>{crew.name}</div>
              <div className="muted">
                {crew.members.length} {crew.members.length === 1 ? 'person' : 'people'} · Group DNA {crew.dna?.confidence?.toLowerCase() ?? 'building'}
              </div>
            </div>
            <div className="stack" style={{ flexShrink: 0 }}>
              {crew.members.slice(0, 4).map((m, i) => (
                <div key={i} className="avatar" style={{ background: avatarColor(m.user.displayName ?? m.user.email) }}>
                  {initials(m.user.displayName, m.user.email)}
                </div>
              ))}
            </div>
          </Link>
        ))}

        {crews?.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: '28px 16px' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>👋</div>
            <p style={{ marginBottom: 4 }}>No Crews yet.</p>
            <p className="muted">Create one below, or ask a friend for their invite link.</p>
          </div>
        )}

        <form onSubmit={createCrew} className="banner-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}>
            New Crew
          </div>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Boys, Flat 4B" required />
          <button className="btn btn-primary" disabled={creating || !name.trim()} type="submit">
            {creating ? 'Creating…' : 'Create Crew'}
          </button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}
