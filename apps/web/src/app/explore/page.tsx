'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import type { ExploreExperience } from './ExploreMap';

// Leaflet touches `window` at module load, which breaks Next's server render — load the map
// client-side only. See ExploreMap.tsx for the actual real-data map (Mapbox/Leaflet, real
// venue coordinates), as opposed to the founding-team demo's CSS-drawn decorative one.
const ExploreMap = dynamic(() => import('./ExploreMap'), { ssr: false, loading: () => <p className="muted">Loading map…</p> });

const LONDON_CENTER: [number, number] = [51.5074, -0.1278];

interface CrewSummary {
  id: string;
  name: string;
}

export default function ExplorePage() {
  const router = useRouter();
  const [experiences, setExperiences] = useState<ExploreExperience[] | null>(null);
  const [dataSource, setDataSource] = useState<'live' | 'mock' | null>(null);
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The experience someone tapped "Send to Crew →" on — non-null opens the crew picker.
  const [sendTarget, setSendTarget] = useState<ExploreExperience | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ experiences: ExploreExperience[]; dataSource: 'live' | 'mock' }>('/explore/experiences?city=London')
      .then((res) => {
        setExperiences(res.experiences);
        setDataSource(res.dataSource);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Explore.'));
    api
      .get<{ crews: CrewSummary[] }>('/crews')
      .then((res) => setCrews(res.crews))
      .catch(() => {});
  }, []);

  const center = useMemo<[number, number]>(() => {
    if (!experiences?.length) return LONDON_CENTER;
    const avgLat = experiences.reduce((sum, e) => sum + e.venue.latitude, 0) / experiences.length;
    const avgLng = experiences.reduce((sum, e) => sum + e.venue.longitude, 0) / experiences.length;
    return [avgLat, avgLng];
  }, [experiences]);

  async function sendToCrew(crewId: string) {
    if (!sendTarget) return;
    setSending(crewId);
    try {
      const res = await api.post<{ plan: { publicSlug: string } }>(`/crews/${crewId}/plans/send`, {
        experienceId: sendTarget.id,
      });
      router.push(`/plans/${res.plan.publicSlug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send to Crew.');
      setSending(null);
      setSendTarget(null);
    }
  }

  return (
    <>
      <nav className="nav">
        <Link href="/crews" className="muted" style={{ fontSize: 13 }}>
          ← Crews
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page">
        <div className="masthead" style={{ marginBottom: 16 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}>Explore</div>
          <h1 style={{ fontSize: 22 }}>What&rsquo;s on around London</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            {experiences
              ? `${experiences.length} option${experiences.length === 1 ? '' : 's'} over the next 3 weeks — tap a pin, then send one to a Crew.`
              : 'Finding what’s on…'}
          </p>
        </div>

        {error && <div className="error">{error}</div>}

        {dataSource === 'mock' && (
          <div className="banner warn">
            ⚠️ Sample events — no real event provider is connected yet. What you send to your Crew right now won&rsquo;t be bookable.
          </div>
        )}

        <div style={{ height: 480, borderRadius: 18, overflow: 'hidden', border: '1px solid var(--ink-border)', boxShadow: 'var(--hard-shadow)' }}>
          {experiences ? (
            <ExploreMap experiences={experiences} center={center} onSend={setSendTarget} />
          ) : (
            <div style={{ height: '100%', background: 'var(--ink-surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <p className="muted">Loading map…</p>
            </div>
          )}
        </div>

        {sendTarget && (
          <div className="banner-card fade-up" style={{ marginTop: 16 }}>
            <div className="eyebrow">Send &ldquo;{sendTarget.name}&rdquo; to…</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {crews === null && <p className="muted">Loading your Crews…</p>}
              {crews?.length === 0 && (
                <p className="muted">
                  You&rsquo;re not in a Crew yet — <Link href="/crews">create one first</Link>.
                </p>
              )}
              {crews?.map((crew) => (
                <button
                  key={crew.id}
                  className="btn"
                  disabled={sending !== null}
                  onClick={() => sendToCrew(crew.id)}
                  style={{ textAlign: 'left', justifyContent: 'flex-start' }}
                >
                  {sending === crew.id ? 'Sending…' : `💬 ${crew.name}`}
                </button>
              ))}
              <button className="btn btn-ghost" onClick={() => setSendTarget(null)} disabled={sending !== null}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <TabBar />
    </>
  );
}
