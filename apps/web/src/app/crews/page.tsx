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

export default function CrewsPage() {
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [name, setName] = useState('The Boys');
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
    setCreating(true);
    try {
      await api.post('/crews', { name, defaultCity: 'London' });
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
        <Link href="/onboarding" className="muted" style={{ fontSize: 12 }}>
          Profile
        </Link>
      </nav>
      <div className="page">
        <h1 style={{ fontSize: 24, marginBottom: 16 }}>Your Crews</h1>

        {crews?.map((crew) => (
          <Link key={crew.id} href={`/crews/${crew.id}`} className="card" style={{ display: 'block', textDecoration: 'none' }}>
            <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 17 }}>{crew.name}</div>
            <div className="muted">
              {crew.members.length} people · Group DNA {crew.dna?.confidence?.toLowerCase() ?? 'building'}
            </div>
          </Link>
        ))}

        {crews?.length === 0 && <p className="muted" style={{ marginBottom: 16 }}>No Crews yet — create your first one below.</p>}

        <form onSubmit={createCrew} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}>
            New Crew
          </div>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="The Boys" required />
          <button className="btn btn-primary" disabled={creating} type="submit">
            {creating ? 'Creating…' : 'Create Crew'}
          </button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}
