'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { BottomSheet } from '@/components/BottomSheet';
import { categoryStyle, categoryBackground } from '@/lib/categoryStyle';
import { formatPriceRange } from '@/lib/formatPrice';
import type { ExploreExperience } from './ExploreMap';

// Leaflet touches `window` at module load, which breaks Next's server render — load the map
// client-side only.
const ExploreMap = dynamic(() => import('./ExploreMap'), { ssr: false, loading: () => <p className="muted">Loading map…</p> });

const LONDON_CENTER: [number, number] = [51.5074, -0.1278];

interface CrewSummary {
  id: string;
  name: string;
}

function formatWhen(startsAt: string) {
  return new Date(startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function formatPrice(exp: ExploreExperience) {
  return formatPriceRange(exp.priceMinMinor, exp.priceMaxMinor, exp.currency);
}

/**
 * "This weekend" always means the *next* Friday-evening-through-Sunday-night window, including
 * the one currently underway if today is already Fri/Sat/Sun — never a weekend that's already
 * passed.
 */
function weekendWindow(now: Date): [Date, Date] {
  const day = now.getDay();
  const daysSinceFriday = (day - 5 + 7) % 7;
  const friday = new Date(now);
  friday.setHours(0, 0, 0, 0);
  friday.setDate(now.getDate() - (daysSinceFriday <= 2 ? daysSinceFriday : daysSinceFriday - 7));
  const mondayStart = new Date(friday);
  mondayStart.setDate(friday.getDate() + 3);
  return [friday, mondayStart];
}

interface Rail {
  key: string;
  label: string;
  items: ExploreExperience[];
}

/**
 * Explore's opening state is a set of themed rails, not a single filterable list — a database
 * result view (title + filters + identical rectangles) is exactly what the brief rejected.
 * Each rail is a real editorial question ("what's on tonight", "what won't break the bank"),
 * built by slicing the same fetched set several different ways rather than separate API calls.
 * An event can appear in more than one rail — that's fine, a rail is a lens, not a bucket.
 */
function buildRails(experiences: ExploreExperience[], now: Date): Rail[] {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const [weekendFrom, weekendTo] = weekendWindow(now);

  const tonight = experiences.filter((e) => new Date(e.startsAt) >= now && new Date(e.startsAt) <= endOfToday);
  const weekend = experiences.filter((e) => new Date(e.startsAt) >= weekendFrom && new Date(e.startsAt) < weekendTo);
  const underThirty = experiences.filter((e) => e.priceMinMinor !== null && e.priceMinMinor <= 3000);
  const free = experiences.filter((e) => e.priceMinMinor === 0);
  const soon = [...experiences].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  const rails: Rail[] = [];
  if (tonight.length) rails.push({ key: 'tonight', label: 'Tonight', items: tonight });
  if (weekend.length) rails.push({ key: 'weekend', label: 'This weekend', items: weekend });
  if (free.length) rails.push({ key: 'free', label: 'Free', items: free });
  if (underThirty.length) rails.push({ key: 'under30', label: 'Under £30', items: underThirty });
  if (soon.length) rails.push({ key: 'soon', label: 'Coming up', items: soon });
  return rails;
}

export default function ExplorePage() {
  const router = useRouter();
  const [experiences, setExperiences] = useState<ExploreExperience[] | null>(null);
  const [dataSource, setDataSource] = useState<'live' | 'mock' | null>(null);
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'browse' | 'map'>('browse');

  // The experience someone tapped for a closer look — non-null opens the detail sheet. Sending
  // it to a Crew is a second step *inside* that same sheet, not a separate sheet stacked on top.
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

  const now = useMemo(() => new Date(), []);
  const rails = useMemo(() => buildRails(experiences ?? [], now), [experiences, now]);

  const center = useMemo<[number, number]>(() => {
    if (!experiences?.length) return LONDON_CENTER;
    const avgLat = experiences.reduce((sum, e) => sum + e.venue.latitude, 0) / experiences.length;
    const avgLng = experiences.reduce((sum, e) => sum + e.venue.longitude, 0) / experiences.length;
    return [avgLat, avgLng];
  }, [experiences]);

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

  return (
    <>
      <nav className="nav">
        <Link href="/home" className="muted" style={{ fontSize: 13 }}>← Home</Link>
        <div style={{ display: 'flex', gap: 4, background: 'var(--ink-surface-2)', borderRadius: 100, padding: 3 }}>
          <button
            onClick={() => setMode('browse')}
            style={{ border: 'none', borderRadius: 100, padding: '5px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: mode === 'browse' ? 'var(--ink-gold)' : 'transparent', color: mode === 'browse' ? 'var(--ink-gold-ink)' : 'var(--ink-text-muted)' }}
          >
            Browse
          </button>
          <button
            onClick={() => setMode('map')}
            style={{ border: 'none', borderRadius: 100, padding: '5px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: mode === 'map' ? 'var(--ink-gold)' : 'transparent', color: mode === 'map' ? 'var(--ink-gold-ink)' : 'var(--ink-text-muted)' }}
          >
            Map
          </button>
        </div>
      </nav>

      <div className="page" style={{ paddingTop: 16 }}>
        {error && <div className="error">{error}</div>}

        {dataSource === 'mock' && (
          <div className="banner warn" style={{ marginBottom: 16 }}>
            ⚠️ Sample events — no real event provider is connected yet. What you send to your Crew right now won&rsquo;t be bookable.
          </div>
        )}

        {experiences === null && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ height: 20, width: 100, borderRadius: 6, background: 'var(--ink-surface)', opacity: 0.5 }} />
            <div style={{ display: 'flex', gap: 10 }}>
              {[1, 2, 3].map((i) => <div key={i} style={{ height: 180, width: 156, borderRadius: 20, background: 'var(--ink-surface)', opacity: 0.5, flexShrink: 0 }} />)}
            </div>
          </div>
        )}

        {experiences?.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🌤️</div>
            <p style={{ fontWeight: 700, marginBottom: 4 }}>Nothing great matched that.</p>
            <p className="muted">Check back soon — London&rsquo;s always got something on.</p>
          </div>
        )}

        {mode === 'browse' &&
          rails.map((rail) => (
            <div key={rail.key} style={{ marginBottom: 26 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>{rail.label}</div>
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto', margin: '0 -20px', padding: '0 20px 4px', scrollSnapType: 'x proximity' }}>
                {rail.items.map((exp) => {
                  const style = categoryStyle(exp.category);
                  const price = formatPrice(exp);
                  return (
                    <button
                      key={`${rail.key}-${exp.id}`}
                      onClick={() => setSelected(exp)}
                      className="fade-up"
                      style={{
                        flex: '0 0 auto',
                        width: 168,
                        borderRadius: 20,
                        overflow: 'hidden',
                        border: 'none',
                        padding: 0,
                        textAlign: 'left',
                        cursor: 'pointer',
                        background: 'var(--ink-surface)',
                        boxShadow: 'var(--ambient-shadow)',
                        scrollSnapAlign: 'start',
                      }}
                    >
                      {/* 65-75% of the tile is image — media, not a record: name/date/price is
                          the caption, not the point. */}
                      <div
                        style={{
                          height: 168,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 32,
                          background: categoryBackground(exp.imageUrl, exp.category),
                        }}
                      >
                        {!exp.imageUrl && style.emoji}
                      </div>
                      <div style={{ padding: '9px 11px 12px' }}>
                        <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                          {exp.name}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {new Date(exp.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          {price && ` · ${price}`}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

        {mode === 'map' && (
          <div className="explore-viewport" style={{ borderRadius: 20, overflow: 'hidden', boxShadow: 'var(--ambient-shadow)' }}>
            {experiences ? (
              experiences.length > 0 ? (
                <ExploreMap experiences={experiences} center={center} onSelect={setSelected} />
              ) : (
                <div style={{ height: '100%', background: 'var(--ink-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center' }}>
                  <p className="muted">Nothing on the map right now.</p>
                </div>
              )
            ) : (
              <div style={{ height: '100%', background: 'var(--ink-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p className="muted">Loading map…</p>
              </div>
            )}
          </div>
        )}
      </div>

      <BottomSheet open={selected !== null} onClose={closeSheet}>
        {selected && !pickingCrew && (
          <div>
            <div
              style={{
                margin: '-10px -20px 14px',
                height: 180,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 44,
                background: categoryBackground(selected.imageUrl, selected.category),
              }}
            >
              {!selected.imageUrl && categoryStyle(selected.category).emoji}
            </div>
            <div className="eyebrow">{selected.category.replace(/_/g, ' ')}</div>
            <h2 style={{ fontFamily: 'Fraunces, serif', fontSize: 21, marginBottom: 4 }}>{selected.name}</h2>
            <div className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>
              {selected.venue.name} · {formatWhen(selected.startsAt)}
              {formatPrice(selected) && ` · ${formatPrice(selected)}`}
            </div>
            {selected.description && (
              <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--ink-text-muted)', marginBottom: 18 }}>{selected.description}</p>
            )}
            <button className="btn btn-primary" onClick={() => setPickingCrew(true)}>
              Share to Crew →
            </button>
          </div>
        )}

        {selected && pickingCrew && (
          <div>
            <div className="eyebrow">Send &ldquo;{selected.name}&rdquo; to…</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {crews === null && <p className="muted">Loading your Crews…</p>}
              {crews?.length === 0 && (
                <p className="muted">You&rsquo;re not in a Crew yet — <Link href="/crews">create one first</Link>.</p>
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
