'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { categoryStyle } from '@/lib/categoryStyle';

interface MatchOption {
  experience: {
    id: string;
    name: string;
    category: string;
    startsAt: string;
    priceMinMinor: number | null;
    priceMaxMinor: number | null;
    currency: string;
    venue?: { name: string } | null;
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
  const [dataSource, setDataSource] = useState<'live' | 'mock' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  useEffect(() => {
    api
      .post<{ options: MatchOption[]; dataSource: 'live' | 'mock' }>(`/crews/${crewId}/find-us-something`)
      .then((res) => {
        setOptions(res.options);
        setDataSource(res.dataSource);
      })
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

        {dataSource === 'mock' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 13px',
              borderRadius: 10,
              background: 'rgba(242, 169, 59, 0.1)',
              border: '1px solid rgba(242, 169, 59, 0.3)',
              fontSize: 12,
              color: 'var(--ink-gold)',
              marginBottom: 16,
            }}
          >
            ⚠️ Sample events — no real event provider is connected yet.
          </div>
        )}

        {!options && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="card" style={{ height: 92, opacity: 0.5 }} />
            ))}
          </div>
        )}
        {error && <div className="error">{error}</div>}

        {options?.length === 0 && (
          <div className="card" style={{ textAlign: 'center', padding: '28px 16px' }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>🤔</div>
            <p style={{ marginBottom: 4 }}>Nothing matched right now.</p>
            <p className="muted">
              Try widening the Crew&rsquo;s taste in <Link href="/onboarding">Profile</Link>, or check back once more of the Crew has marked
              their evenings free.
            </p>
          </div>
        )}

        {options?.map((option, i) => {
          const style = categoryStyle(option.experience.category);
          const best = i === 0;
          return (
            <div
              key={option.experience.id}
              className="card fade-up"
              style={{ padding: 0, overflow: 'hidden', border: best ? '1.5px solid var(--ink-gold)' : undefined }}
            >
              <div className="art-block" style={{ background: style.bg, borderRadius: 0, position: 'relative', justifyContent: 'flex-start', padding: '0 16px' }}>
                <span style={{ fontSize: 22, marginRight: 10 }}>{style.emoji}</span>
                {best && (
                  <span className="chip gold static" style={{ fontSize: 10, padding: '4px 9px', position: 'absolute', top: 10, right: 12 }}>
                    ✨ best match
                  </span>
                )}
              </div>
              <div style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 17 }}>{option.experience.name}</div>
                    <div className="muted">
                      {option.experience.venue?.name && `${option.experience.venue.name} · `}
                      {new Date(option.experience.startsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <div style={{ textAlign: 'center', flexShrink: 0, marginLeft: 12 }}>
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
                  className={`btn ${best ? 'btn-primary' : ''}`}
                  style={{ marginTop: 12 }}
                  onClick={() => sendToCrew(option.experience.id)}
                  disabled={sendingId === option.experience.id}
                >
                  {sendingId === option.experience.id ? 'Sending…' : 'Send to Crew'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
