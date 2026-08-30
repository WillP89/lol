'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface MatchOption {
  experience: {
    id: string;
    name: string;
    startsAt: string;
    priceMinMinor: number | null;
    priceMaxMinor: number | null;
    currency: string;
  };
  matchScore: number;
  reasons: { code: string; label: string }[];
  availableMemberCount: number;
  totalMemberCount: number;
}

export default function MatchPage() {
  const { id: crewId } = useParams<{ id: string }>();
  const router = useRouter();
  const [options, setOptions] = useState<MatchOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  useEffect(() => {
    api
      .post<{ options: MatchOption[] }>(`/crews/${crewId}/find-us-something`)
      .then((res) => setOptions(res.options))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not find recommendations.'));
  }, [crewId]);

  async function sendToCrew(experienceId: string) {
    setSendingId(experienceId);
    try {
      const res = await api.post<{ plan: { publicSlug: string } }>(`/crews/${crewId}/plans/send`, { experienceId });
      router.push(`/plans/${res.plan.publicSlug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send to Crew.');
      setSendingId(null);
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
      <div className="page">
        <div className="eyebrow">For your Crew</div>
        <h1 style={{ fontSize: 24, marginBottom: 6 }}>Three plans, not 300 results</h1>
        <p className="muted" style={{ marginBottom: 20 }}>Based on who&rsquo;s in, who&rsquo;s free, and what you&rsquo;re usually into.</p>

        {!options && !error && <p className="muted">Thinking…</p>}
        {error && <div className="error">{error}</div>}

        {options?.map((option, i) => (
          <div key={option.experience.id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 17 }}>{option.experience.name}</div>
                <div className="muted">{new Date(option.experience.startsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'Fraunces, serif', fontSize: 20, color: 'var(--ink-gold)' }}>{option.matchScore}%</div>
                <div className="muted" style={{ fontSize: 9 }}>match</div>
              </div>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              {option.availableMemberCount}/{option.totalMemberCount} free
              {option.experience.priceMinMinor !== null && ` · from £${(option.experience.priceMinMinor / 100).toFixed(0)}`}
            </div>
            {option.reasons.length > 0 && (
              <ul style={{ margin: '10px 0 0', paddingLeft: 16, fontSize: 12, color: 'var(--ink-text-muted)' }}>
                {option.reasons.map((r) => (
                  <li key={r.code}>{r.label}</li>
                ))}
              </ul>
            )}
            <button
              className={`btn ${i === 0 ? 'btn-primary' : ''}`}
              style={{ marginTop: 12 }}
              onClick={() => sendToCrew(option.experience.id)}
              disabled={sendingId === option.experience.id}
            >
              {sendingId === option.experience.id ? 'Sending…' : 'Send to Crew'}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
