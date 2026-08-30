'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { BottomSheet } from '@/components/BottomSheet';
import { categoryStyle } from '@/lib/categoryStyle';
import { formatPriceRange } from '@/lib/formatPrice';
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

function formatWhen(startsAt: string) {
  return new Date(startsAt).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPrice(exp: ExploreExperience) {
  return formatPriceRange(exp.priceMinMinor, exp.priceMaxMinor, exp.currency);
}

type DiscoveryMode = 'all' | 'tonight' | 'weekend' | 'free';

const DISCOVERY_MODES: { id: DiscoveryMode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tonight', label: '🌙 Tonight' },
  { id: 'weekend', label: '📅 This weekend' },
  { id: 'free', label: '🆓 Free' },
];

/**
 * "This weekend" always means the *next* Friday-evening-through-Sunday-night window, including
 * the one currently underway if today is already Fri/Sat/Sun — never a weekend that's already
 * passed. Kept as plain Date math (no library) since it's one small, well-tested rule.
 */
function weekendWindow(now: Date): [Date, Date] {
  const day = now.getDay(); // 0 Sun … 6 Sat
  const daysSinceFriday = (day - 5 + 7) % 7; // 0 on Fri, 1 on Sat, 2 on Sun, else 3-6
  const friday = new Date(now);
  friday.setHours(0, 0, 0, 0);
  friday.setDate(now.getDate() - (daysSinceFriday <= 2 ? daysSinceFriday : daysSinceFriday - 7));
  const mondayStart = new Date(friday);
  mondayStart.setDate(friday.getDate() + 3);
  return [friday, mondayStart];
}

function matchesDiscoveryMode(exp: ExploreExperience, mode: DiscoveryMode, now: Date): boolean {
  if (mode === 'all') return true;
  if (mode === 'free') return exp.priceMinMinor === 0;
  const starts = new Date(exp.startsAt);
  if (mode === 'tonight') {
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    return starts >= now && starts <= endOfToday;
  }
  // weekend
  const [from, to] = weekendWindow(now);
  return starts >= from && starts < to;
}

export default function ExplorePage() {
  const router = useRouter();
  const [experiences, setExperiences] = useState<ExploreExperience[] | null>(null);
  const [dataSource, setDataSource] = useState<'live' | 'mock' | null>(null);
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [mode, setMode] = useState<DiscoveryMode>('all');

  // The experience someone tapped for a closer look — non-null opens the detail sheet. Sending
  // it to a Crew is a second step *inside* that same sheet (see `pickingCrew`), not a separate
  // sheet stacked on top — you read about the event before you're asked who to send it to.
  const [selected, setSelected] = useState<ExploreExperience | null>(null);
  const [pickingCrew, setPickingCrew] = useState(false);
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

  // Computed once per mount rather than per render — a discovery mode like "tonight" only needs
  // to be accurate to the minute, not re-evaluated on every keystroke elsewhere on the page.
  const now = useMemo(() => new Date(), []);

  const filtered = useMemo(
    () => (experiences ?? []).filter((exp) => matchesDiscoveryMode(exp, mode, now)),
    [experiences, mode, now],
  );

  const center = useMemo<[number, number]>(() => {
    if (!filtered.length) return LONDON_CENTER;
    const avgLat = filtered.reduce((sum, e) => sum + e.venue.latitude, 0) / filtered.length;
    const avgLng = filtered.reduce((sum, e) => sum + e.venue.longitude, 0) / filtered.length;
    return [avgLat, avgLng];
  }, [filtered]);

  function closeSheet() {
    if (sending !== null) return;
    setSelected(null);
    setPickingCrew(false);
  }

  async function sendToCrew(crewId: string) {
    if (!selected) return;
    setSending(crewId);
    try {
      const res = await api.post<{ plan: { publicSlug: string } }>(`/crews/${crewId}/plans/send`, {
        experienceId: selected.id,
      });
      router.push(`/plans/${res.plan.publicSlug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send to Crew.');
      setSending(null);
      setPickingCrew(false);
    }
  }

  return (
    <>
      <nav className="nav">
        <Link href="/home" className="muted" style={{ fontSize: 13 }}>
          ← Home
        </Link>
        <div className="wordmark">Plot</div>
      </nav>
      <div className="page">
        <div className="masthead" style={{ marginBottom: 16 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}>Explore</div>
          <h1 style={{ fontSize: 22 }}>What&rsquo;s on around London</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            {experiences
              ? `${filtered.length} option${filtered.length === 1 ? '' : 's'}${mode === 'all' ? ' over the next 3 weeks' : ''} — tap one, then send it to a Crew.`
              : 'Finding what’s on…'}
          </p>
        </div>

        {error && <div className="error">{error}</div>}

        {dataSource === 'mock' && (
          <div className="banner warn">
            ⚠️ Sample events — no real event provider is connected yet. What you send to your Crew right now won&rsquo;t be bookable.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 10, overflowX: 'auto', paddingBottom: 2 }}>
          {DISCOVERY_MODES.map((m) => (
            <button key={m.id} className={`chip ${mode === m.id ? 'selected' : ''}`} style={{ whiteSpace: 'nowrap' }} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button className={`chip ${view === 'map' ? 'selected' : ''}`} onClick={() => setView('map')}>
            🗺️ Map
          </button>
          <button className={`chip ${view === 'list' ? 'selected' : ''}`} onClick={() => setView('list')}>
            📋 List
          </button>
        </div>

        {view === 'map' ? (
          <div className="explore-viewport" style={{ borderRadius: 18, overflow: 'hidden', border: '1px solid var(--ink-border)', boxShadow: 'var(--hard-shadow)' }}>
            {experiences ? (
              filtered.length > 0 ? (
                <ExploreMap experiences={filtered} center={center} onSelect={setSelected} />
              ) : (
                <div style={{ height: '100%', background: 'var(--ink-surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center' }}>
                  <p className="muted">Nothing matches &ldquo;{DISCOVERY_MODES.find((m) => m.id === mode)?.label}&rdquo; right now — try a different filter.</p>
                </div>
              )
            ) : (
              <div style={{ height: '100%', background: 'var(--ink-surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p className="muted">Loading map…</p>
              </div>
            )}
          </div>
        ) : (
          <div>
            {experiences === null && <p className="muted">Finding what’s on…</p>}
            {experiences && filtered.length === 0 && (
              <p className="muted">
                {mode === 'all' ? 'Nothing found for London right now — check back soon.' : `Nothing matches this filter right now — try a different one.`}
              </p>
            )}
            {filtered.map((exp) => {
              const style = categoryStyle(exp.category);
              const price = formatPrice(exp);
              return (
                <button
                  key={exp.id}
                  onClick={() => setSelected(exp)}
                  className="card fade-up"
                  style={{ padding: 0, overflow: 'hidden', width: '100%', textAlign: 'left', cursor: 'pointer', display: 'block' }}
                >
                  <div
                    className="art-block"
                    style={
                      exp.imageUrl
                        ? { backgroundImage: `url(${exp.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', borderRadius: 0 }
                        : { background: style.bg, borderRadius: 0 }
                    }
                  >
                    {!exp.imageUrl && style.emoji}
                  </div>
                  <div style={{ padding: 14 }}>
                    <div style={{ fontFamily: 'Fraunces, serif', fontWeight: 700, fontSize: 16 }}>{exp.name}</div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {exp.venue.name} · {formatWhen(exp.startsAt)}
                    </div>
                    {price && (
                      <div className="chip static gold" style={{ marginTop: 8, fontSize: 11.5 }}>
                        {price}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <BottomSheet open={selected !== null} onClose={closeSheet}>
        {selected && !pickingCrew && (
          <div>
            <div
              className="art-block"
              style={{
                margin: '-10px -20px 14px',
                borderRadius: 0,
                height: 120,
                fontSize: 40,
                ...(selected.imageUrl
                  ? { backgroundImage: `url(${selected.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : { background: categoryStyle(selected.category).bg }),
              }}
            >
              {!selected.imageUrl && categoryStyle(selected.category).emoji}
            </div>
            <div className="eyebrow">{selected.category.replace(/_/g, ' ')}</div>
            <h2 style={{ fontFamily: 'Fraunces, serif', fontSize: 20, marginBottom: 4 }}>{selected.name}</h2>
            <div className="muted" style={{ fontSize: 13.5, marginBottom: 10 }}>
              {selected.venue.name} · {formatWhen(selected.startsAt)}
              {formatPrice(selected) && ` · ${formatPrice(selected)}`}
            </div>
            {selected.description && (
              <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--ink-text-muted)', marginBottom: 16 }}>{selected.description}</p>
            )}
            <button className="btn btn-primary" onClick={() => setPickingCrew(true)}>
              Send to Crew →
            </button>
          </div>
        )}

        {selected && pickingCrew && (
          <div>
            <div className="eyebrow">Send &ldquo;{selected.name}&rdquo; to…</div>
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
              <button className="btn btn-ghost" onClick={() => setPickingCrew(false)} disabled={sending !== null}>
                ← Back
              </button>
            </div>
          </div>
        )}
      </BottomSheet>

      <TabBar />
    </>
  );
}
