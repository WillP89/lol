'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBar } from '@/components/TabBar';
import { BottomSheet } from '@/components/BottomSheet';
import { CategoryArt } from '@/components/CategoryArt';
import { formatPriceRange } from '@/lib/formatPrice';
import type { ExploreExperience } from './ExploreMap';

// Leaflet touches `window` at module load, which breaks Next's server render — load client-side only.
const ExploreMap = dynamic(() => import('./ExploreMap'), { ssr: false, loading: () => <p className="muted">Loading map…</p> });

const LONDON_CENTER: [number, number] = [51.5074, -0.1278];

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

/** Themed rails, not a single filterable list — each is a different lens over the same fetched
 * set (an event can legitimately appear in more than one). Only rails with content render. */
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

/** One tile design, three sizes — variety in rhythm without a different component per context.
 * 65-75% of every size is the visual; the caption is title/date/price, nothing else. */
function Tile({
  exp,
  size,
  selected,
  onClick,
  id,
}: {
  exp: ExploreExperience;
  size: 'hero' | 'rail' | 'strip';
  selected?: boolean;
  onClick: () => void;
  id?: string;
}) {
  const dims = size === 'hero' ? { w: '100%', h: 240 } : size === 'rail' ? { w: 172, h: 172 } : { w: 220, h: 96 };
  const price = formatPrice(exp);
  return (
    <button
      id={id}
      onClick={onClick}
      className="fade-up"
      style={{
        flex: size === 'hero' ? '1 1 auto' : '0 0 auto',
        width: dims.w,
        display: size === 'strip' ? 'flex' : 'block',
        borderRadius: 20,
        overflow: 'hidden',
        border: 'none',
        padding: 0,
        textAlign: 'left',
        cursor: 'pointer',
        background: 'var(--ink-surface)',
        boxShadow: selected ? '0 0 0 2.5px var(--ink-gold), var(--ambient-shadow)' : 'var(--ambient-shadow)',
        scrollSnapAlign: 'start',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: size === 'strip' ? 96 : '100%',
          height: size === 'strip' ? '100%' : dims.h,
          flexShrink: 0,
          ...(exp.imageUrl ? { backgroundImage: `url("${exp.imageUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
        }}
      >
        {!exp.imageUrl && <CategoryArt category={exp.category} compact={size !== 'hero'} />}
      </div>
      <div style={{ padding: size === 'hero' ? '14px 16px' : size === 'strip' ? '8px 12px' : '9px 11px 12px', flex: size === 'strip' ? 1 : undefined, minWidth: 0 }}>
        <div
          style={{
            fontFamily: size === 'hero' ? 'Fraunces, serif' : undefined,
            fontWeight: 700,
            fontSize: size === 'hero' ? 19 : size === 'strip' ? 13 : 13,
            lineHeight: 1.3,
            marginBottom: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: size === 'strip' ? 1 : 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {exp.name}
        </div>
        <div className="muted" style={{ fontSize: size === 'hero' ? 13 : 11 }}>
          {formatShortDate(exp.startsAt)}
          {size === 'hero' && ` · ${exp.venue.name}`}
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
  const [mode, setMode] = useState<'browse' | 'map'>('browse');
  const [query, setQuery] = useState('');

  // selectedId: the event a marker/card tap has focused (drives map pan + highlight). selected:
  // the event whose full detail sheet is open — a superset action, always sets selectedId too.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExploreExperience | null>(null);
  const [pickingCrew, setPickingCrew] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  // The mobile map block and the desktop split both exist in markup (see the return below) —
  // CSS's `display: none` only ever hides one of them, it doesn't unmount it. Leaflet mounted
  // inside a zero-size hidden container throws ("Invalid LatLng (NaN, NaN)") when it measures
  // its own pixel origin, so which pane is allowed to actually mount `<ExploreMap>` has to be
  // driven by the same real viewport check CSS uses, not left to "the DOM node is just hidden."
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

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

  // A marker tap only previews (selects) — on mobile it should scroll the bottom card strip to
  // match, since that's the actual "preview" surface there. Tapping the preview card opens detail.
  useEffect(() => {
    if (mode !== 'map' || !selectedId) return;
    document.getElementById(`explore-tile-${selectedId}`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [selectedId, mode]);

  const now = useMemo(() => new Date(), []);

  const searched = useMemo(() => {
    if (!experiences) return [];
    const q = query.trim().toLowerCase();
    if (!q) return experiences;
    return experiences.filter((e) => e.name.toLowerCase().includes(q) || e.venue.name.toLowerCase().includes(q));
  }, [experiences, query]);

  const rails = useMemo(() => buildRails(searched, now), [searched, now]);
  const hero = searched.length ? [...searched].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0] : null;

  const center = useMemo<[number, number]>(() => {
    if (!searched.length) return LONDON_CENTER;
    const avgLat = searched.reduce((sum, e) => sum + e.venue.latitude, 0) / searched.length;
    const avgLng = searched.reduce((sum, e) => sum + e.venue.longitude, 0) / searched.length;
    return [avgLat, avgLng];
  }, [searched]);

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

  const discoveryColumn = (
    <div>
      {dataSource === 'mock' && (
        <div className="banner warn" style={{ marginBottom: 16 }}>
          ⚠️ Sample events — no real event provider is connected yet. What you send to your Crew right now won&rsquo;t be bookable.
        </div>
      )}

      {experiences === null && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ height: 240, borderRadius: 20, background: 'var(--ink-surface)', opacity: 0.5 }} />
          <div style={{ display: 'flex', gap: 10 }}>
            {[1, 2, 3].map((i) => <div key={i} style={{ height: 172, width: 172, borderRadius: 20, background: 'var(--ink-surface)', opacity: 0.5, flexShrink: 0 }} />)}
          </div>
        </div>
      )}

      {experiences && searched.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🌤️</div>
          <p style={{ fontWeight: 700, marginBottom: 4 }}>{query ? 'Nothing matched that search.' : 'Nothing great matched that.'}</p>
          <p className="muted">{query ? 'Try a different name or venue.' : "Check back soon — London's always got something on."}</p>
        </div>
      )}

      {hero && !query && (
        <div style={{ marginBottom: 26 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Coming up next</div>
          <Tile exp={hero} size="hero" selected={hero.id === selectedId} onClick={() => openDetail(hero)} id={`explore-tile-${hero.id}`} />
        </div>
      )}

      {rails.map((rail) => (
        <div key={rail.key} style={{ marginBottom: 26 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>{rail.label}</div>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', margin: '0 -20px', padding: '0 20px 4px', scrollSnapType: 'x proximity' }}>
            {rail.items.map((exp) => (
              <Tile key={`${rail.key}-${exp.id}`} exp={exp} size="rail" selected={exp.id === selectedId} onClick={() => openDetail(exp)} id={`explore-tile-${rail.key}-${exp.id}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  // A function, not a plain JSX value — the mobile map block and the desktop split both exist
  // in markup at once (CSS decides which is visible), so each call site has to pass whether
  // IT is the one actually allowed to mount the real `<ExploreMap>` right now (see `isDesktop`
  // above). The other call site still renders the same loading/empty states, just never Leaflet.
  function mapPane(active: boolean) {
    return (
      <div style={{ position: 'relative', height: '100%', width: '100%' }}>
        {experiences ? (
          searched.length > 0 ? (
            active ? (
              <ExploreMap experiences={searched} center={center} selectedId={selectedId} onMarkerClick={(exp) => setSelectedId(exp.id)} />
            ) : (
              <div style={{ height: '100%', background: 'var(--ink-surface)' }} />
            )
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
    );
  }

  return (
    <>
      <nav className="nav" style={{ gap: 12 }}>
        <Link href="/home" className="muted" style={{ fontSize: 13, flexShrink: 0 }}>← Home</Link>
        <div style={{ flex: 1, position: 'relative', maxWidth: 340 }}>
          <input
            className="field"
            style={{ width: '100%', padding: '8px 14px', fontSize: 13, borderRadius: 100 }}
            placeholder="Search events or venues in London…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {/* Map is always on for desktop (see the split-view below) — this toggle only matters
            on mobile, where there isn't room to show both at once. Its `display: flex` lives in
            the stylesheet (not inline) specifically so the desktop media query's `display: none`
            can actually win — an inline style beats any class rule regardless of specificity. */}
        <div className="explore-mode-toggle" style={{ flexShrink: 0 }}>
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

      {error && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="error">{error}</div>
        </div>
      )}

      {/* Mobile: Browse shows the full-width rails; Map is full-height with a swipeable card
          strip over the bottom, synced to marker selection. Desktop ignores `mode` entirely —
          both panes are always visible side by side, the real split-view. */}
      <div className="explore-mobile-browse">
        {mode === 'browse' && <div className="page" style={{ paddingTop: 16 }}>{discoveryColumn}</div>}
        {mode === 'map' && (
          <div className="explore-mobile-map">
            {mapPane(!isDesktop)}
            <div className="explore-map-strip">
              {searched.map((exp) => (
                <Tile key={exp.id} exp={exp} size="strip" selected={exp.id === selectedId} onClick={() => openDetail(exp)} id={`explore-tile-${exp.id}`} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="explore-desktop-split">
        <div className="explore-desktop-column">{discoveryColumn}</div>
        <div className="explore-desktop-map">{mapPane(isDesktop)}</div>
      </div>

      <BottomSheet open={selected !== null} onClose={closeSheet}>
        {selected && !pickingCrew && (
          <div>
            <div style={{ position: 'relative', margin: '-10px -20px 14px', height: 200, overflow: 'hidden' }}>
              {selected.imageUrl ? (
                <div style={{ position: 'absolute', inset: 0, backgroundImage: `url("${selected.imageUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
              ) : (
                <CategoryArt category={selected.category} />
              )}
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
