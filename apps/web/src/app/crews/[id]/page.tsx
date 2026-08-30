'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface CrewDetail {
  id: string;
  name: string;
  inviteCode: string;
  members: { user: { id: string; displayName: string | null; email: string } }[];
  dna: { confidence: string; topCategories: string[]; medianSpendMinor: number; bestNights: string[]; usualAreas: string[] } | null;
  plans: { id: string; title: string; status: string; publicSlug: string }[];
}

interface DayAvailability {
  day: string;
  freeCount: number;
  totalMembers: number;
}

export default function CrewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [crew, setCrew] = useState<CrewDetail | null>(null);
  const [availability, setAvailability] = useState<DayAvailability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);

  useEffect(() => {
    api
      .get<{ crew: CrewDetail }>(`/crews/${id}`)
      .then((res) => setCrew(res.crew))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Crew.'));
    api
      .get<{ availability: DayAvailability[] }>(`/crews/${id}/availability?days=0,1,2,3`)
      .then((res) => setAvailability(res.availability))
      .catch(() => {});
  }, [id]);

  function findUsSomething() {
    setFinding(true);
    router.push(`/crews/${id}/match`);
  }

  async function getInviteLink() {
    const res = await api.post<{ inviteUrl: string }>(`/crews/${id}/invites`, { channel: 'link' });
    setInviteUrl(res.inviteUrl);
  }

  if (!crew) return <div className="page">{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</div>;

  return (
    <>
      <nav className="nav">
        <Link href="/crews" className="muted" style={{ fontSize: 13 }}>
          ← Crews
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page">
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>{crew.name}</h1>
        <p className="muted" style={{ marginBottom: 18 }}>{crew.members.length} people</p>

        {crew.dna && (
          <div className="card">
            <div className="eyebrow">Group DNA · {crew.dna.confidence.toLowerCase()} confidence</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 12px' }}>
              {crew.dna.topCategories.length ? (
                crew.dna.topCategories.map((c) => (
                  <span key={c} className="chip gold static">
                    {c}
                  </span>
                ))
              ) : (
                <span className="muted">Plot is still learning this Crew&rsquo;s taste.</span>
              )}
            </div>
            {crew.dna.medianSpendMinor > 0 && <div className="muted">Median spend £{(crew.dna.medianSpendMinor / 100).toFixed(0)}</div>}
          </div>
        )}

        {availability.length > 0 && (
          <div className="card">
            <div className="eyebrow">Everyone&rsquo;s evening</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {availability.map((d) => (
                <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
                  <div className="muted" style={{ fontSize: 10 }}>
                    {d.day}
                  </div>
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

        <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
          <button className="btn btn-primary" onClick={findUsSomething} disabled={finding} style={{ flex: 1 }}>
            {finding ? 'Thinking…' : '✨ Find us something'}
          </button>
          <Link href={`/crews/${id}/chat`} className="btn" style={{ flex: '0 0 auto', textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
            💬 Chat
          </Link>
        </div>

        {crew.plans.length > 0 && (
          <>
            <div className="eyebrow" style={{ marginTop: 20 }}>
              Plans
            </div>
            {crew.plans.map((plan) => (
              <Link key={plan.id} href={`/plans/${plan.publicSlug}`} className="card" style={{ display: 'block', textDecoration: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{plan.title}</span>
                  <span className="chip static" style={{ fontSize: 10 }}>
                    {plan.status}
                  </span>
                </div>
              </Link>
            ))}
          </>
        )}

        <div className="eyebrow" style={{ marginTop: 20 }}>
          Invite
        </div>
        {inviteUrl ? (
          <div className="card muted" style={{ wordBreak: 'break-all' }}>
            {inviteUrl}
          </div>
        ) : (
          <button className="btn" onClick={getInviteLink}>
            Get invite link
          </button>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}
