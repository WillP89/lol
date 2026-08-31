'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { BottomSheet } from '@/components/BottomSheet';
import { LocationSearch } from '@/components/LocationSearch';
import { v2Art } from '@/lib/v2Art';
import { formatPriceRange } from '@/lib/formatPrice';
import type { ExploreExperience } from './ExploreMap';

// Leaflet touches `window` at module load — client-side only.
const ExploreMapV2 = dynamic(() => import('./ExploreMapV2'), { ssr: false, loading: () => <p className="v2-muted">Loading map…</p> });

// A genuinely UK-central fallback (Birmingham), used only until the real city-resolved centre
// comes back from the API — never a London assumption. See docs/DECISIONS.md#uk-wide-location.
const UK_FALLBACK_CENTER: [number, number] = [52.4862, -1.8904];

interface CrewSummary {
  id: string;
  name: string;
}

function formatWhen(startsAt: string) {
  return new Date(startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function formatShortDate(startsAt: string) {
  return new Date(startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function formatPrice(exp: ExploreExperience) {
  return formatPriceRange(exp.priceMinMinor, exp.priceMaxMinor, exp.currency);
}

/** One card, three sizes — a hero (2-col span) up top, then a regular grid. The image (or its
 * category art) is 70%+ of the card; the caption is title/date/price, nothing else. */
function Card({
  exp,
  size,
  selected,
  onClick,
  id,
}: {
  exp: ExploreExperience;
  size: 'hero' | 'grid';
  selected?: boolean;
  onClick: () => void;
  id?: string;
}) {
  const price = formatPrice(exp);
  return (
    <button
      id={id}
      onClick={onClick}
      className="fade-up"
      style={{
        display: 'block',
        width: '100%',
        gridColumn: size === 'hero' ? '1 / -1' : undefined,
        position: 'relative',
        height: size === 'hero' ? 280 : 200,
        borderRadius: 'var(--v2-r-md)',
        overflow: 'hidden',
        border: 'none',
        padding: 0,
        textAlign: 'left',
        cursor: 'pointer',
        boxShadow: selected ? '0 0 0 3px var(--v2-brand), var(--v2-shadow-sm)' : 'var(--v2-shadow-sm)',
        background: v2Art(exp.imageUrl, exp.category),
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(200deg, rgba(21,11,44,0) 42%, rgba(21,11,44,0.82) 100%)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: size === 'hero' ? '20px 22px' : '14px 16px' }}>
        <div className="v2-display" style={{ fontSize: size === 'hero' ? 24 : 16, color: '#fff', lineHeight: 1.15, marginBottom: 6 }}>
          {exp.name}
        </div>
        <div style={{ fontSize: size === 'hero' ? 13.5 : 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
          {formatShortDate(exp.startsAt)} · {exp.venue.name}
          {price && ` · ${price}`}
        </div>
      </div>
    </button>
  );
}

export default function ExplorePage() {
  const router = useRouter();
  const [experiences, setExperiences] = useState<ExploreExperience[] | null>(null);
  const [dataSource, setDataSource] = useState<'live' | 'mock' | null>(null);
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mobileMap, setMobileMap] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExploreExperience | null>(null);
  const [pickingCrew, setPickingCrew] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  // No hardcoded city — the backend resolves this viewer's own home city (or a genuinely
  // UK-central fallback) when none is requested; `cityCenter` comes back alongside it so the
  // map has somewhere real to sit even with zero results for that city. Switching city here
  // re-fetches against the chosen one. See docs/DECISIONS.md#uk-wide-location.
  const [city, setCity] = useState<string | null>(null);
  const [cityCenter, setCityCenter] = useState<[number, number]>(UK_FALLBACK_CENTER);
  const [pickingCity, setPickingCity] = useState(false);

  useEffect(() => {
    api
      .get<{ experiences: ExploreExperience[]; dataSource: 'live' | 'mock'; city: string; cityLat: number; cityLng: number }>(
        `/explore/experiences${city ? `?city=${encodeURIComponent(city)}` : ''}`,
      )
      .then((res) => {
        setExperiences(res.experiences);
        setDataSource(res.dataSource);
        setCity(res.city);
        setCityCenter([res.cityLat, res.cityLng]);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Explore.'));
    api
      .get<{ crews: CrewSummary[] }>('/crews')
      .then((res) => setCrews(res.crews))
      .catch(() => {});
  }, [city]);

  const searched = useMemo(() => {
    if (!experiences) return [];
    const q = query.trim().toLowerCase();
    if (!q) return experiences;
    return experiences.filter((e) => e.name.toLowerCase().includes(q) || e.venue.name.toLowerCase().includes(q));
  }, [experiences, query]);

  const hero = searched.length ? [...searched].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0] : null;
  const rest = hero ? searched.filter((e) => e.id !== hero.id) : searched;

  const center = useMemo<[number, number]>(() => {
    if (!searched.length) return cityCenter;
    const avgLat = searched.reduce((sum, e) => sum + e.venue.latitude, 0) / searched.length;
    const avgLng = searched.reduce((sum, e) => sum + e.venue.longitude, 0) / searched.length;
    return [avgLat, avgLng];
  }, [searched, cityCenter]);

  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1000px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  function openDetail(exp: ExploreExperience) {
    setSelected(exp);
    setSelectedId(exp.id);
  }
  function closeSheet() {
    if (sending !== null) return;
    setSelected(null);
    setPickingCrew(false);
  }
  async function sendToCrew(crewId: string) {
    if (!selected) return;
    setSending(crewId);
    try {
      const res = await api.post<{ plan: { publicSlug: string } }>(`/crews/${crewId}/plans/send`, { experienceId: selected.id });
      router.push(`/plans/${res.plan.publicSlug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send to Crew.');
      setSending(null);
      setPickingCrew(false);
    }
  }

  const previewExp = searched.find((e) => e.id === selectedId) ?? null;

  const discovery = (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <h1 className="v2-display" style={{ fontSize: 32 }}>Discover {city ?? ''}</h1>
        <button
          onClick={() => setPickingCity(true)}
          style={{ flexShrink: 0, marginTop: 8, border: 'none', background: 'var(--v2-bg-deep)', borderRadius: 100, padding: '7px 14px', fontSize: 12.5, fontWeight: 700, color: 'var(--v2-ink-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          📍 Change
        </button>
      </div>
      <p className="v2-muted" style={{ fontSize: 14.5, marginBottom: 20 }}>Real things happening near you, picked for tonight.</p>
      {pickingCity && (
        <div className="fade-up" style={{ marginBottom: 18 }}>
          <LocationSearch
            placeholder="Search a UK town or city…"
            onSelect={(place) => {
              setCity(place.name);
              setCityCenter([place.lat, place.lng]);
              setPickingCity(false);
            }}
          />
        </div>
      )}
      <div className="v2-search" style={{ marginBottom: 22 }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--v2-ink-dim)', flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input placeholder="Search events or venues…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {dataSource === 'mock' && (
        <div style={{ fontSize: 12.5, color: 'var(--v2-ink-muted)', background: 'var(--v2-bg-deep)', borderRadius: 12, padding: '10px 14px', marginBottom: 18 }}>
          Sample events — no live provider connected yet.
        </div>
      )}

      {experiences === null && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={{ gridColumn: '1 / -1', height: 280, borderRadius: 20, background: 'var(--v2-bg-deep)' }} />
          {[1, 2, 3, 4].map((i) => <div key={i} style={{ height: 200, borderRadius: 20, background: 'var(--v2-bg-deep)' }} />)}
        </div>
      )}

      {experiences && searched.length === 0 && (
        <p className="v2-muted" style={{ textAlign: 'center', padding: '40px 0' }}>Nothing matched that search.</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {hero && <Card exp={hero} size="hero" selected={hero.id === selectedId} onClick={() => openDetail(hero)} id={`v2-exp-${hero.id}`} />}
        {rest.map((exp) => (
          <Card key={exp.id} exp={exp} size="grid" selected={exp.id === selectedId} onClick={() => openDetail(exp)} id={`v2-exp-${exp.id}`} />
        ))}
      </div>
    </div>
  );

  // A function, not a shared JSX value — the desktop pane and the mobile full-screen overlay
  // must never both mount `<ExploreMapV2>` (Leaflet) at once. Only the render site that is
  // actually the current mode calls this; see docs/DECISIONS.md#explore-desktop-split for the
  // exact bug (Leaflet in a zero-size hidden container throws) this pattern exists to avoid.
  function renderMap() {
    if (!experiences || searched.length === 0) {
      return <div style={{ height: '100%', width: '100%', background: 'var(--v2-bg-deep)' }} />;
    }
    return (
      <div style={{ position: 'relative', height: '100%', width: '100%' }}>
        <ExploreMapV2 experiences={searched} center={center} selectedId={selectedId} onMarkerClick={(exp) => setSelectedId(exp.id)} />
        {previewExp && (
          <div className="v2-explore-preview fade-up">
            <div style={{ height: 130, background: v2Art(previewExp.imageUrl, previewExp.category) }} />
            <div style={{ padding: '12px 14px' }}>
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>{previewExp.name}</div>
              <div className="v2-muted" style={{ fontSize: 12, marginBottom: 8 }}>
                {formatShortDate(previewExp.startsAt)} · {previewExp.venue.name}
              </div>
              <button className="v2-btn v2-btn-dark" style={{ width: '100%', padding: '9px 0', fontSize: 12.5 }} onClick={() => openDetail(previewExp)}>
                View details
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="v2">
      <div className="v2-shell-desktop">
        {error && <div className="v2-page" style={{ paddingBottom: 0, color: 'var(--v2-brand)' }}>{error}</div>}

        <div className="v2-explore-split">
          <div className="v2-explore-col">{discovery}</div>
          {/* Only mounted at all when isDesktop — matches renderMap()'s own doc comment: never
              let this coexist in the tree with the mobile overlay below. */}
          {isDesktop && <div className="v2-explore-map-pane">{renderMap()}</div>}
        </div>

        {/* Mobile-only: the map is one tap away via a floating pill, full-screen when open,
            rather than permanently splitting a phone-width viewport in half. */}
        {!isDesktop && (
          <>
            <button
              onClick={() => setMobileMap((v) => !v)}
              className="v2-btn v2-btn-dark"
              style={{ position: 'fixed', right: 18, bottom: 96, zIndex: 45, boxShadow: 'var(--v2-shadow-lg)' }}
            >
              {mobileMap ? '☰ List' : '🗺 Map'}
            </button>
            {mobileMap && (
              <div style={{ position: 'fixed', inset: 0, zIndex: 42, background: 'var(--v2-bg)' }}>
                {renderMap()}
              </div>
            )}
          </>
        )}
      </div>

      <BottomSheet open={selected !== null} onClose={closeSheet} variant="light">
        {selected && !pickingCrew && (
          <div>
            <div style={{ position: 'relative', margin: '-10px -20px 16px', height: 210, background: v2Art(selected.imageUrl, selected.category) }} />
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>{selected.category.replace(/_/g, ' ')}</div>
            <h2 className="v2-display" style={{ fontSize: 23, marginBottom: 6 }}>{selected.name}</h2>
            <div className="v2-muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
              {selected.venue.name} · {formatWhen(selected.startsAt)}
              {formatPrice(selected) && ` · ${formatPrice(selected)}`}
            </div>
            {selected.description && <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--v2-ink-muted)', marginBottom: 20 }}>{selected.description}</p>}
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={() => setPickingCrew(true)}>
              Share to Crew →
            </button>
          </div>
        )}
        {selected && pickingCrew && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Send &ldquo;{selected.name}&rdquo; to…</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {crews === null && <p className="v2-muted">Loading your Crews…</p>}
              {crews?.length === 0 && <p className="v2-muted">You&rsquo;re not in a Crew yet — <Link href="/crews">create one first</Link>.</p>}
              {crews?.map((crew) => (
                <button key={crew.id} className="v2-btn v2-btn-ghost" disabled={sending !== null} onClick={() => sendToCrew(crew.id)} style={{ justifyContent: 'flex-start' }}>
                  {sending === crew.id ? 'Sending…' : `💬 ${crew.name}`}
                </button>
              ))}
              <button className="v2-btn v2-btn-ghost" onClick={() => setPickingCrew(false)} disabled={sending !== null}>← Back</button>
            </div>
          </div>
        )}
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
