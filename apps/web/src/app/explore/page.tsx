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
import { useScrollReveal } from '@/lib/useScrollReveal';
import { IconChat, IconPlace, IconList, IconMap } from '@/components/icons';
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

// "Meaningful filters without becoming Expedia" — a small, real set (only what this data can
// actually support: no indoor/outdoor flag exists on Experience, so it's not offered), applied
// client-side against the already-fetched result set (the same pattern the existing text search
// already uses) rather than a round trip per filter change — this page's own result sets are
// small enough (dozens, not thousands) that a server filter endpoint would be real complexity
// for no perceptible speed gain.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'LIVE_MUSIC', label: 'Live music' }, { value: 'CLUBBING', label: 'Clubbing' },
  { value: 'RESTAURANT', label: 'Restaurant' }, { value: 'BAR', label: 'Pubs & bars' },
  { value: 'COMEDY', label: 'Comedy' }, { value: 'THEATRE', label: 'Theatre' },
  { value: 'CINEMA', label: 'Cinema' }, { value: 'ART_CULTURE', label: 'Art & culture' },
  { value: 'SPORT', label: 'Sport' }, { value: 'FITNESS', label: 'Fitness' },
  { value: 'FESTIVAL', label: 'Festival' }, { value: 'DAY_ACTIVITY', label: 'Day out' },
  { value: 'COMMUNITY', label: 'Community' },
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORY_OPTIONS.map((o) => [o.value, o.label]));

type DateFilter = 'any' | 'tonight' | 'weekend' | 'week';
const DATE_OPTIONS: { value: DateFilter; label: string }[] = [
  { value: 'any', label: 'Any date' }, { value: 'tonight', label: 'Tonight' },
  { value: 'weekend', label: 'This weekend' }, { value: 'week', label: 'Next 7 days' },
];

type PriceFilter = 'any' | 'free' | '15' | '30' | '50';
const PRICE_OPTIONS: { value: PriceFilter; label: string; maxMinor: number | null }[] = [
  { value: 'any', label: 'Any price', maxMinor: null }, { value: 'free', label: 'Free', maxMinor: 0 },
  { value: '15', label: 'Under £15', maxMinor: 1500 }, { value: '30', label: 'Under £30', maxMinor: 3000 },
  { value: '50', label: 'Under £50', maxMinor: 5000 },
];

function matchesDateFilter(startsAtIso: string, filter: DateFilter): boolean {
  if (filter === 'any') return true;
  const startsAt = new Date(startsAtIso);
  const now = new Date();
  if (filter === 'tonight') {
    return startsAt.toDateString() === now.toDateString();
  }
  if (filter === 'week') {
    const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return startsAt >= now && startsAt <= weekOut;
  }
  // Weekend — the NEXT (or current, if today is already Fri/Sat/Sun) Friday-through-Sunday
  // window, never a past weekend. Find this week's Friday 00:00 (or today, if already Fri-Sun).
  const day = now.getDay(); // 0=Sun..6=Sat
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offsetToFriday = (5 - day + 7) % 7;
  const weekendStart = day === 6 || day === 0 ? new Date(base.getTime() - (day === 6 ? 1 : 2) * 86400000) : new Date(base.getTime() + offsetToFriday * 86400000);
  const weekendEnd = new Date(weekendStart.getTime() + 3 * 86400000); // through end of Sunday
  return startsAt >= weekendStart && startsAt < weekendEnd;
}

/** One card, three sizes — a hero (2-col span) up top, then a regular grid. The image (or its
 * category art) is 70%+ of the card; the caption is title/date/price, nothing else. */
function Card({
  exp,
  size,
  selected,
  onClick,
  onHoverChange,
  id,
  revealIndex,
}: {
  exp: ExploreExperience;
  size: 'hero' | 'grid';
  selected?: boolean;
  onClick: () => void;
  onHoverChange?: (hovering: boolean) => void;
  id?: string;
  revealIndex?: number;
}) {
  const price = formatPrice(exp);
  return (
    <button
      id={id}
      onClick={onClick}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      className="v2-reveal v2-hoverable"
      style={{
        display: 'block',
        width: '100%',
        ['--reveal-i' as string]: revealIndex ?? 0,
        gridColumn: size === 'hero' ? '1 / -1' : undefined,
        position: 'relative',
        height: size === 'hero' ? 280 : 200,
        borderRadius: 'var(--v2-r-md)',
        overflow: 'hidden',
        border: 'none',
        padding: 0,
        textAlign: 'left',
        cursor: 'pointer',
        boxShadow: selected ? '0 0 0 3px var(--v2-pop), var(--v2-shadow-sm)' : 'var(--v2-shadow-sm)',
        background: v2Art(exp.imageUrl, exp.category, exp.id),
      }}
    >
      {/* A real live legibility bug, not a taste call: a diagonal scrim alone reads fine over
          dark tour-poster photography but genuinely fails over the bright, busy, high-contrast
          flyer art a live events provider (Skiddle in particular) actually returns — faces,
          bold colour blocks, dense type, right where the caption sits. Replaced with a proper
          frosted caption panel — the same "glass bar over a photo" pattern iOS/Music/Spotify use
          — rather than trying to tune one more gradient stop: a backdrop-blur softens whatever
          busy imagery is directly behind the text (killing the eye's contrast fight at the
          source, not just dimming it), and the colour wash layered on top gives a real, high,
          guaranteed-legible floor (0.93 at the very baseline) no photo can defeat, while staying
          essentially invisible over the top ~55% of the card so the photo itself still reads as
          a photo, not a tinted rectangle. */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, height: size === 'hero' ? '52%' : '58%',
          backdropFilter: 'blur(14px) saturate(115%)', WebkitBackdropFilter: 'blur(14px) saturate(115%)',
          maskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 30%, #000 62%)',
          WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 30%, #000 62%)',
        }}
      />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: size === 'hero' ? '52%' : '58%', background: 'linear-gradient(180deg, rgba(17,14,11,0) 0%, rgba(17,14,11,0.42) 46%, rgba(14,11,9,0.93) 100%)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: size === 'hero' ? '20px 22px' : '14px 16px' }}>
        <div className="v2-display" style={{ fontSize: size === 'hero' ? 24 : 16, color: '#fff', lineHeight: 1.15, marginBottom: 6 }}>
          {exp.name}
        </div>
        {/* `v2-explore-card-meta`'s mobile-only right padding keeps price/date clear of the
            floating Map toggle (fixed at `right:18, bottom:96`, so it can float over any card
            depending on scroll position) — a real overlap found scrolling this page for real: a
            card's own price text ending up rendered partly underneath that button's opaque
            background. Desktop never mounts that button (see `!isDesktop` above), so it gets no
            padding there. */}
        <div className="v2-explore-card-meta" style={{ fontSize: size === 'hero' ? 13.5 : 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
          {formatShortDate(exp.startsAt)} · {exp.venue.name}
          {price && ` · ${price}`}
        </div>
      </div>
    </button>
  );
}

export default function ExplorePage() {
  useScrollReveal();
  const router = useRouter();
  const [experiences, setExperiences] = useState<ExploreExperience[] | null>(null);
  const [dataSource, setDataSource] = useState<'live' | 'mock' | null>(null);
  // Skiddle's own API terms require crediting them "by name and brand logo" wherever their data
  // is shown — this drives the attribution line below, real signal not a static flag, since it
  // reflects whether SKIDDLE_API_KEY is actually configured server-side right now.
  const [hasSkiddleProvider, setHasSkiddleProvider] = useState(false);
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mobileMap, setMobileMap] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Desktop-only hover sync between the result list and the map — see ExploreMapV2's own
  // comment. Meaningless on touch (no hover), so it's simply never set there.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
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

  // Radius search — "extend the map radius and pick areas, even a postcode". `radiusKm === null`
  // is the original exact-city mode (unchanged default behaviour); a number switches to a real
  // multi-city, distance-checked search (services/explore.ts#listExploreExperiencesByRadius).
  // `pickedCenter` is set ONLY by explicit user actions (a postcode pick, or clicking a radius
  // chip) — never by the fetch response — so it can safely sit in the effect's dependency array
  // below without ever causing a refetch loop.
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  const [pickedCenter, setPickedCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [areaLabel, setAreaLabel] = useState<string | null>(null);
  const [placesSearched, setPlacesSearched] = useState<{ name: string; distanceKm: number }[] | null>(null);
  // "Way more filters on the ability to pick location" — a real "near me" control alongside the
  // existing named-place search, using the browser's own location rather than making someone
  // type their own town/postcode back to themselves. `locatingMe` is its own loading flag (not
  // reusing the page's main `error`/loading state) since this is a small, local action inside an
  // already-loaded page, not a full page reload.
  const [locatingMe, setLocatingMe] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const usingRadius = radiusKm !== null && pickedCenter !== null;

  // "When I change my preferences, the discovery page should IMMEDIATELY change to only show
  // events within that preference, it should not still show other events that are not
  // relevant" — the real behavioural change, not just a reorder (see
  // services/explore.ts#finishExploreList for exactly what counts as relevant, and why an
  // account with no taste signal yet is never filtered to an empty page). Explore always fetches
  // fresh on mount, so returning here from tuning taste on Profile already picks up the new
  // filter with no separate refresh step needed. `tasteFilterOn` is the one explicit escape
  // hatch — a person can always ask to see everything again without having to un-tune anything.
  const [tasteFilterOn, setTasteFilterOn] = useState(true);
  const [filteredToTaste, setFilteredToTaste] = useState(false);
  const [totalBeforeFilter, setTotalBeforeFilter] = useState(0);

  // Category/date/price — mobile-first via one "Filters" sheet (progressive disclosure), never
  // a row of dropdowns above the results. Applied client-side, chained after the text search —
  // see CATEGORY_OPTIONS/matchesDateFilter's own comments above.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [dateFilter, setDateFilter] = useState<DateFilter>('any');
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('any');
  const activeFilterCount = selectedCategories.size + (dateFilter !== 'any' ? 1 : 0) + (priceFilter !== 'any' ? 1 : 0);
  function toggleCategory(value: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }
  function clearFilters() {
    setSelectedCategories(new Set());
    setDateFilter('any');
    setPriceFilter('any');
  }

  useEffect(() => {
    const base = usingRadius
      ? `/explore/experiences?lat=${pickedCenter!.lat}&lng=${pickedCenter!.lng}&radiusKm=${radiusKm}`
      : `/explore/experiences${city ? `?city=${encodeURIComponent(city)}` : ''}`;
    const url = `${base}${base.includes('?') ? '&' : '?'}filter=${tasteFilterOn ? 'on' : 'off'}`;

    api
      .get<{
        experiences: ExploreExperience[];
        dataSource: 'live' | 'mock';
        hasSkiddleProvider: boolean;
        city: string | null;
        cityLat: number;
        cityLng: number;
        radius: { centerLat: number; centerLng: number; radiusKm: number; placesSearched: { name: string; distanceKm: number }[] } | null;
        filteredToTaste: boolean;
        totalBeforeFilter: number;
      }>(url)
      .then((res) => {
        setExperiences(res.experiences);
        setDataSource(res.dataSource);
        setHasSkiddleProvider(res.hasSkiddleProvider);
        setCityCenter([res.cityLat, res.cityLng]);
        setPlacesSearched(res.radius?.placesSearched ?? null);
        setFilteredToTaste(res.filteredToTaste);
        setTotalBeforeFilter(res.totalBeforeFilter);
        // Exact-city mode is still the source of truth for `city`/`areaLabel` (the resolved home
        // city on first load, in particular) — a radius search's own picked label is set by the
        // action that started it, not by this response, since the server has no single "city"
        // to hand back for an arbitrary point.
        if (!usingRadius) {
          setCity(res.city);
          setAreaLabel(res.city);
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load Explore.'));
    api
      .get<{ crews: CrewSummary[] }>('/crews')
      .then((res) => setCrews(res.crews))
      .catch(() => {});
    // `usingRadius` is derived from `radiusKm`/`pickedCenter`, already listed below — including
    // it too would be redundant, not incorrect.
  }, [city, radiusKm, pickedCenter, tasteFilterOn]);

  // More granularity than the original 4 — real request: "way more filters on the ability to
  // pick location". 5/200 are new floor/ceiling options (a genuine walking-distance search, and
  // a genuine "chase something rare, anywhere reasonably reachable" search), the rest fill in
  // the gaps a jump from 25 straight to 50 used to skip over.
  const RADIUS_OPTIONS_KM = [5, 10, 25, 50, 100, 200];

  /** The browser's own location, not a typed-in place — real distance search centred on
   *  wherever the person actually is right now. Same radius-mode machinery as picking a
   *  postcode (`pickedCenter` + `radiusKm`); the only new thing is where the centre comes from. */
  function useMyLocation() {
    setLocationError(null);
    if (!('geolocation' in navigator)) {
      setLocationError('Location isn’t available in this browser.');
      return;
    }
    setLocatingMe(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocatingMe(false);
        setCity(null);
        setAreaLabel('your location');
        setPickedCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setRadiusKm((current) => current ?? 25);
      },
      (err) => {
        setLocatingMe(false);
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? 'Location access was declined — allow it in your browser settings, or search a town/postcode instead.'
            : 'Could not get your location — try searching a town or postcode instead.',
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60 * 1000 },
    );
  }

  const searched = useMemo(() => {
    if (!experiences) return [];
    let list = experiences;
    const q = query.trim().toLowerCase();
    if (q) {
      // Real gap found typing "Comedy" into this box live: it only ever matched the event NAME
      // or venue name, so a search for a category word came back "Nothing matched that search"
      // even with genuine comedy nights on screen a moment earlier — the category itself
      // (`COMEDY`/`LIVE_MUSIC`/…) was never checked. Matching the human-readable form of it too
      // (underscores to spaces) makes a category search actually work, the way someone typing it
      // would expect.
      list = list.filter(
        (e) => e.name.toLowerCase().includes(q) || e.venue.name.toLowerCase().includes(q) || e.category.replace(/_/g, ' ').toLowerCase().includes(q),
      );
    }
    if (selectedCategories.size > 0) {
      list = list.filter((e) => selectedCategories.has(e.category));
    }
    if (dateFilter !== 'any') {
      list = list.filter((e) => matchesDateFilter(e.startsAt, dateFilter));
    }
    if (priceFilter !== 'any') {
      const band = PRICE_OPTIONS.find((p) => p.value === priceFilter);
      if (band && band.maxMinor !== null) {
        // Unknown price (null) never silently passes a price filter — "under £X" only ever
        // means a real, known price at or under that, matching the brief's no-fake-data rule
        // (an unpriced event isn't provably "free" or "under £15").
        list = list.filter((e) => e.priceMinMinor !== null && e.priceMinMinor <= band.maxMinor!);
      }
    }
    return list;
  }, [experiences, query, selectedCategories, dateFilter, priceFilter]);

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

  // Shared between the mobile BottomSheet and the desktop inline panel below — same content,
  // two different containers. Root-caused bug this replaces: BottomSheet is a mobile pattern
  // (fixed, centred across the *entire* viewport width via `margin: 0 auto`) that was being
  // used unconditionally, including on the desktop split — so opening a detail floated a
  // phone-width card dead-centre of the whole 1600px window, landing on top of the seam
  // between the results column and the map pane regardless of either pane's actual width. A
  // desktop detail view now renders *inside* the results column instead (no BottomSheet
  // involved at all there), so it physically cannot overlap the map. See
  // docs/DECISIONS.md#explore-detail-desktop.
  const detailContent = selected && !pickingCrew ? (
    <div>
      {/* Real, live-reported complaint this fixes ("the white space on the image to book an
          event, that is not good"): a short card (a one-line venue/date, no description) left a
          large dimmed BACKDROP gap above the sheet — the panel only grows as tall as its own
          content, and 210px of image plus a couple of text lines wasn't enough to fill the screen
          on most devices. Growing the hero image itself (210 -> 300, the same immersive-image
          instinct already applied to Home's own hero) is the honest fix, not padding: it makes
          the sheet genuinely taller with something worth looking at, rather than empty space
          either above the sheet OR inside it. The category badge moves onto the image itself
          (Home's own card treatment) instead of sitting as a second, separate line of text below
          it — one clean visual read, not two competing labels for the same fact. */}
      <div style={{ position: 'relative', margin: '-10px -20px 16px', height: 300, background: v2Art(selected.imageUrl, selected.category, selected.id) }}>
        <span style={{ position: 'absolute', top: 14, left: 14, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#fff', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', padding: '5px 10px', borderRadius: 100 }}>
          {selected.category.replace(/_/g, ' ')}
        </span>
      </div>
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
  ) : selected && pickingCrew ? (
    <div>
      <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Send &ldquo;{selected.name}&rdquo; to…</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {crews === null && <p className="v2-muted">Loading your Crews…</p>}
        {crews?.length === 0 && <p className="v2-muted">You&rsquo;re not in a Crew yet — <Link href="/crews">create one first</Link>.</p>}
        {crews?.map((crew) => (
          <button key={crew.id} className="v2-btn v2-btn-ghost" disabled={sending !== null} onClick={() => sendToCrew(crew.id)} style={{ justifyContent: 'flex-start', gap: 8 }}>
            {sending === crew.id ? 'Sending…' : (<><IconChat size={15} />{crew.name}</>)}
          </button>
        ))}
        <button className="v2-btn v2-btn-ghost" onClick={() => setPickingCrew(false)} disabled={sending !== null}>← Back</button>
      </div>
    </div>
  ) : null;

  const discovery = (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <h1 className="v2-display" style={{ fontSize: 32 }}>
          Discover {usingRadius ? `within ${radiusKm}km of ${areaLabel ?? ''}` : (city ?? '')}
        </h1>
        <button
          onClick={() => setPickingCity(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, marginTop: 8, border: 'none', background: 'var(--v2-bg-deep)', borderRadius: 100, padding: '7px 14px', fontSize: 12.5, fontWeight: 700, color: 'var(--v2-ink-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          <IconPlace size={13} />Change
        </button>
      </div>
      <p className="v2-muted" style={{ fontSize: 14.5, marginBottom: 6 }}>Real things happening near you, picked for tonight.</p>
      {/* The real, visible proof that changing taste preferences actually changes what shows up
          here — never a silent black-box filter. Only appears once there's something to say:
          either the filter is actively hiding something right now, or the person has explicitly
          asked to see everything (so they can always find their way back to "matched"). */}
      {(filteredToTaste || !tasteFilterOn) && (
        <button
          type="button"
          onClick={() => setTasteFilterOn((v) => !v)}
          className="v2-tap-feedback"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14, border: 'none', borderRadius: 100,
            padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            background: tasteFilterOn ? 'var(--v2-brand)' : 'var(--v2-bg-deep)',
            color: tasteFilterOn ? 'var(--v2-brand-ink)' : 'var(--v2-ink-muted)',
          }}
        >
          {tasteFilterOn
            ? `Matched to your taste${totalBeforeFilter > (experiences?.length ?? 0) ? ` · ${totalBeforeFilter - (experiences?.length ?? 0)} hidden` : ''} · Show everything`
            : 'Showing everything · Match my taste'}
        </button>
      )}
      {pickingCity && (
        <div className="fade-up" style={{ marginBottom: 18 }}>
          <LocationSearch
            placeholder="Search a UK town or city, or a postcode…"
            onSelect={(place) => {
              setPickingCity(false);
              setAreaLabel(place.name);
              if (place.kind === 'postcode') {
                // A postcode has no matching venue.city — it can only ever work as a radius
                // centre, not an exact-city match, so picking one forces radius mode on.
                setCity(null);
                setPickedCenter({ lat: place.lat, lng: place.lng });
                setRadiusKm((current) => current ?? 15);
              } else if (radiusKm !== null) {
                // Already searching by radius — re-centre the same radius on the newly picked city.
                setPickedCenter({ lat: place.lat, lng: place.lng });
                setCity(place.name);
              } else {
                setCity(place.name);
                setCityCenter([place.lat, place.lng]); // immediate feedback before the fetch resolves
              }
            }}
          />
        </div>
      )}
      {/* Radius control — "extend the map radius", the directive this exists for. "This area"
          only appears once a real named city is resolved (a postcode alone has no exact-city
          equivalent to fall back to). Widening genuinely re-queries a wider real set of gazetteer
          places (see services/explore.ts#listExploreExperiencesByRadius) — never a fabricated
          "more results" — which is exactly why `placesSearched` below is shown, not hidden. */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: placesSearched && placesSearched.length > 1 ? 6 : 18 }}>
        {city !== null && (
          <button
            onClick={() => { setRadiusKm(null); setPickedCenter(null); }}
            style={{
              border: 'none', borderRadius: 100, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: radiusKm === null ? 'var(--v2-ink)' : 'var(--v2-bg-deep)',
              color: radiusKm === null ? 'var(--v2-surface)' : 'var(--v2-ink-muted)',
            }}
          >
            This area
          </button>
        )}
        {RADIUS_OPTIONS_KM.map((km) => (
          <button
            key={km}
            onClick={() => { setPickedCenter({ lat: cityCenter[0], lng: cityCenter[1] }); setRadiusKm(km); }}
            style={{
              border: 'none', borderRadius: 100, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: radiusKm === km ? 'var(--v2-ink)' : 'var(--v2-bg-deep)',
              color: radiusKm === km ? 'var(--v2-surface)' : 'var(--v2-ink-muted)',
            }}
          >
            {km}km
          </button>
        ))}
        <button
          onClick={useMyLocation}
          disabled={locatingMe}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            border: 'none', borderRadius: 100, padding: '6px 13px', fontSize: 12, fontWeight: 700,
            cursor: locatingMe ? 'default' : 'pointer',
            background: 'var(--v2-bg-deep)', color: 'var(--v2-ink-muted)', opacity: locatingMe ? 0.6 : 1,
          }}
        >
          <IconPlace size={12} />{locatingMe ? 'Finding you…' : 'Use my location'}
        </button>
      </div>
      {locationError && (
        <p style={{ fontSize: 12, color: 'var(--v2-error)', marginBottom: 14 }}>{locationError}</p>
      )}
      {usingRadius && placesSearched && placesSearched.length > 1 && (
        <p className="v2-muted" style={{ fontSize: 12, marginBottom: 18 }}>
          Also searching {placesSearched.slice(1).map((p) => `${p.name} (${p.distanceKm}km)`).join(', ')}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: activeFilterCount > 0 ? 10 : 22 }}>
        <div className="v2-search" style={{ flex: 1 }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--v2-ink-dim)', flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input placeholder="Search events or venues…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {/* One "Filters" launch, not a row of dropdowns — category/date/price all live behind
            it (progressive disclosure, the brief's own mobile-first requirement). The count
            badge is the at-a-glance "something's filtered" signal even with the sheet closed. */}
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          className="v2-tap-feedback"
          style={{
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 14, padding: '0 16px',
            background: activeFilterCount > 0 ? 'var(--v2-ink)' : 'var(--v2-surface)', color: activeFilterCount > 0 ? 'var(--v2-surface)' : 'var(--v2-ink-muted)',
            fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--v2-shadow-sm)',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          Filters{activeFilterCount > 0 && ` (${activeFilterCount})`}
        </button>
      </div>

      {/* Active filters, obviously visible and each individually removable — "easy to change/
          remove", never a silent black-box narrowing of results the way a plain applied filter
          with no visible trace would be. */}
      {activeFilterCount > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
          {[...selectedCategories].map((cat) => (
            <button key={cat} type="button" onClick={() => toggleCategory(cat)} className="v2-tap-feedback" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', borderRadius: 100, padding: '6px 11px 6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: 'var(--v2-bg-deep)', color: 'var(--v2-ink)' }}>
              {CATEGORY_LABEL[cat] ?? cat}<span style={{ fontSize: 14, lineHeight: 1, opacity: 0.5 }}>×</span>
            </button>
          ))}
          {dateFilter !== 'any' && (
            <button type="button" onClick={() => setDateFilter('any')} className="v2-tap-feedback" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', borderRadius: 100, padding: '6px 11px 6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: 'var(--v2-bg-deep)', color: 'var(--v2-ink)' }}>
              {DATE_OPTIONS.find((d) => d.value === dateFilter)?.label}<span style={{ fontSize: 14, lineHeight: 1, opacity: 0.5 }}>×</span>
            </button>
          )}
          {priceFilter !== 'any' && (
            <button type="button" onClick={() => setPriceFilter('any')} className="v2-tap-feedback" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', borderRadius: 100, padding: '6px 11px 6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: 'var(--v2-bg-deep)', color: 'var(--v2-ink)' }}>
              {PRICE_OPTIONS.find((p) => p.value === priceFilter)?.label}<span style={{ fontSize: 14, lineHeight: 1, opacity: 0.5 }}>×</span>
            </button>
          )}
          <button type="button" onClick={clearFilters} className="v2-tap-feedback" style={{ border: 'none', background: 'none', fontSize: 12, fontWeight: 700, color: 'var(--v2-ink-dim)', cursor: 'pointer', padding: '6px 4px' }}>
            Clear all
          </button>
        </div>
      )}

      {dataSource === 'mock' && (
        <div style={{ fontSize: 12.5, color: 'var(--v2-ink-muted)', background: 'var(--v2-bg-deep)', borderRadius: 12, padding: '10px 14px', marginBottom: 6 }}>
          {/* Specifically about TICKETED events (concerts, gigs, shows) — restaurants/bars/
              cafes/museums/markets on this page are real OpenStreetMap inventory regardless of
              this flag, which is exactly why this no longer says "sample events" unqualified. */}
          Sample events — no live ticketing provider connected yet.
        </div>
      )}
      {/* ODbL attribution — a real licensing requirement of using OpenStreetMap data (see
          providers/live/openStreetMap.ts), not a design flourish; shown once per page rather
          than per-card, which satisfies it without competing with Plot's own branding. Always
          rendered once experiences have loaded: restaurants/bars/cafes/museums/markets are
          OpenStreetMap-sourced in every environment that can reach it, independent of whether a
          ticketing provider is configured. */}
      {experiences !== null && experiences.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--v2-ink-dim)', marginBottom: 18, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <span>
            Place data{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
              © OpenStreetMap contributors
            </a>
          </span>
          {/* Skiddle's own API terms require crediting them "by name and brand logo" wherever
              their data might be shown — shown whenever SKIDDLE_API_KEY is configured
              server-side, the same honest "could be present" standard the OpenStreetMap credit
              above already uses, rather than trying to detect it per-card. */}
          {hasSkiddleProvider && (
            <span>
              {' • '}Event data via{' '}
              <a href="https://www.skiddle.com" target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 600 }}>
                Skiddle
              </a>
            </span>
          )}
        </div>
      )}

      {experiences === null && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="v2-skeleton" style={{ gridColumn: '1 / -1', height: 280, borderRadius: 20 }} />
          {[1, 2, 3, 4].map((i) => <div key={i} className="v2-skeleton" style={{ height: 200, borderRadius: 20 }} />)}
        </div>
      )}

      {experiences && searched.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <p className="v2-muted" style={{ marginBottom: query.trim() ? 0 : 12 }}>
            {query.trim()
              ? 'Nothing matched that search.'
              : filteredToTaste
                ? "Nothing here matches your taste yet — tune it further, or see everything nearby."
                : 'Nothing on right now nearby.'}
          </p>
          {!query.trim() && filteredToTaste && (
            <button type="button" onClick={() => setTasteFilterOn(false)} className="v2-btn v2-btn-dark v2-tap-feedback" style={{ padding: '10px 20px', fontSize: 13 }}>
              Show everything
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {hero && (
          <Card
            exp={hero}
            size="hero"
            selected={hero.id === selectedId}
            onClick={() => openDetail(hero)}
            onHoverChange={(h) => setHoveredId(h ? hero.id : null)}
            id={`v2-exp-${hero.id}`}
          />
        )}
        {rest.map((exp, i) => (
          <Card
            key={exp.id}
            exp={exp}
            size="grid"
            selected={exp.id === selectedId}
            onClick={() => openDetail(exp)}
            onHoverChange={(h) => setHoveredId(h ? exp.id : null)}
            id={`v2-exp-${exp.id}`}
            // Capped, not a running total — each pair of grid cards staggers against its
            // immediate neighbour, but a card 20 rows down the grid doesn't inherit a multi-
            // second transition-delay it never needed just because of its position in the list.
            revealIndex={i % 4}
          />
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
        <ExploreMapV2 experiences={searched} center={center} selectedId={selectedId} hoveredId={hoveredId} onMarkerClick={(exp) => setSelectedId(exp.id)} />
        {/* Real bug, confirmed via a live screenshot: `selectedId` stays set once the full
            detail sheet opens (openDetail sets both), so this compact preview kept rendering
            underneath the sheet — two cards for the same event stacked on top of each other.
            Hide it whenever the full sheet has taken over. */}
        {previewExp && !selected && (
          <div className="v2-explore-preview fade-up">
            <div style={{ height: 130, background: v2Art(previewExp.imageUrl, previewExp.category, previewExp.id) }} />
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
    <div className="v2 v2-app-shell">
      <div className="v2-shell-desktop">
        {error && <div className="v2-page" style={{ paddingBottom: 0, color: 'var(--v2-error)' }}>{error}</div>}

        <div className="v2-explore-split">
          <div className="v2-explore-col">
            {/* Desktop detail view replaces the results column in place — never a floating
                sheet — so it is physically impossible for it to sit on top of the map pane. */}
            {isDesktop && selected ? (
              <div className="fade-up">
                <button
                  onClick={closeSheet}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', color: 'var(--v2-ink-muted)', fontWeight: 700, fontSize: 13.5, padding: '4px 0 18px', cursor: 'pointer' }}
                >
                  ← Back to results
                </button>
                {detailContent}
              </div>
            ) : (
              discovery
            )}
          </div>
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
              // Position comes from the class, not inline, on purpose: `.v2-explore-map-toggle`
              // defaults to `fixed` but the `v2-app-shell` media rule (globals.css) switches it
              // to `absolute`, anchored to this page's own 100dvh shell instead of the true
              // browser viewport — the fix for exactly this button drifting/misaligning as the
              // address bar collapses. An inline `position` would silently out-rank that rule.
              className="v2-btn v2-btn-dark v2-explore-map-toggle"
              style={{ display: 'flex', alignItems: 'center', gap: 6, right: 18, bottom: 96, zIndex: 45, boxShadow: 'var(--v2-shadow-lg)' }}
            >
              {mobileMap ? <><IconList size={15} />List</> : <><IconMap size={15} />Map</>}
            </button>
            {mobileMap && (
              <div className="v2-explore-map-overlay" style={{ inset: 0, zIndex: 42, background: 'var(--v2-bg)' }}>
                {renderMap()}
              </div>
            )}
          </>
        )}
      </div>

      {/* Mobile only — the desktop equivalent renders inline in the results column above, never
          as a floating sheet. Passing `open: false` on desktop (rather than not rendering the
          component) keeps its close transition/scroll-lock cleanup consistent if the viewport
          crosses the breakpoint while it's open. */}
      <BottomSheet open={!isDesktop && selected !== null} onClose={closeSheet}>
        {detailContent}
      </BottomSheet>

      {/* The Filters sheet — category (multi-select), date, price. Every control live-applies
          (no separate "Apply" step to remember) with an immediate result count, matching the
          rest of the app's own direct-manipulation conventions (Profile's Budget/Travel pills). */}
      <BottomSheet open={filtersOpen} onClose={() => setFiltersOpen(false)}>
        <div className="v2-eyebrow" style={{ marginBottom: 4 }}>Filters</div>
        <h2 className="v2-display" style={{ fontSize: 19, marginBottom: 16 }}>Narrow it down</h2>

        <div className="v2-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Category</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
          {CATEGORY_OPTIONS.map((opt) => {
            const active = selectedCategories.has(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleCategory(opt.value)}
                className="v2-tap-feedback"
                style={{ border: 'none', borderRadius: 100, padding: '8px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: active ? 'var(--v2-brand)' : 'var(--v2-bg-deep)', color: active ? 'var(--v2-brand-ink)' : 'var(--v2-ink-muted)' }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="v2-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>When</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
          {DATE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setDateFilter(opt.value)}
              className="v2-tap-feedback"
              style={{ border: 'none', borderRadius: 100, padding: '8px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: dateFilter === opt.value ? 'var(--v2-ink)' : 'var(--v2-bg-deep)', color: dateFilter === opt.value ? 'var(--v2-surface)' : 'var(--v2-ink-muted)' }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="v2-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Price</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 24 }}>
          {PRICE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPriceFilter(opt.value)}
              className="v2-tap-feedback"
              style={{ border: 'none', borderRadius: 100, padding: '8px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', background: priceFilter === opt.value ? 'var(--v2-ink)' : 'var(--v2-bg-deep)', color: priceFilter === opt.value ? 'var(--v2-surface)' : 'var(--v2-ink-muted)' }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          {activeFilterCount > 0 && (
            <button type="button" className="v2-btn v2-btn-ghost" style={{ flex: '0 0 auto' }} onClick={clearFilters}>
              Clear all
            </button>
          )}
          <button type="button" className="v2-btn v2-btn-brand" style={{ flex: 1 }} onClick={() => setFiltersOpen(false)}>
            Show {searched.length} {searched.length === 1 ? 'result' : 'results'}
          </button>
        </div>
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
