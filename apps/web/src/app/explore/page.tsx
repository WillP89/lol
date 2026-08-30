'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import type { ExploreExperience } from './ExploreMap';

// Leaflet touches `window` at module load, which breaks Next's server render — load the map
// client-side only. See ExploreMap.tsx for the actual real-data map (Mapbox/Leaflet, real
// venue coordinates), as opposed to the founding-team demo's CSS-drawn decorative one.
const ExploreMap = dynamic(() => import('./ExploreMap'), { ssr: false, loading: () => <p className="muted">Loading map…</p> });

const LONDON_CENTER: [number, number] = [51.5074, -0.1278];

export default function ExplorePage() {
  const [experiences, setExperiences] = useState<ExploreExperience[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ experiences: ExploreExperience[] }>('/explore/experiences?city=London')
      .then((res) => setExperiences(res.experiences))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Explore.'));
  }, []);

  const center = useMemo<[number, number]>(() => {
    if (!experiences?.length) return LONDON_CENTER;
    const avgLat = experiences.reduce((sum, e) => sum + e.venue.latitude, 0) / experiences.length;
    const avgLng = experiences.reduce((sum, e) => sum + e.venue.longitude, 0) / experiences.length;
    return [avgLat, avgLng];
  }, [experiences]);

  return (
    <>
      <nav className="nav">
        <Link href="/crews" className="muted" style={{ fontSize: 13 }}>
          ← Crews
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page">
        <div className="eyebrow">Explore</div>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>What&rsquo;s on around London</h1>
        <p className="muted" style={{ marginBottom: 16 }}>
          {experiences ? `${experiences.length} real, bookable options over the next 3 weeks.` : 'Loading real venues…'}
        </p>

        {error && <div className="error">{error}</div>}

        <div style={{ height: 480, borderRadius: 18, overflow: 'hidden', border: '1px solid var(--ink-border)' }}>
          {experiences && <ExploreMap experiences={experiences} center={center} />}
        </div>
      </div>
    </>
  );
}
