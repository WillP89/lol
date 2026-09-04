'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

export interface UkPlaceResult {
  name: string;
  region: string;
  lat: number;
  lng: number;
  // 'place' = a gazetteer town/city; 'postcode' = a real postcode/outward code resolved via
  // postcodes.io (see apps/api/src/lib/postcodes.ts). Optional/omittable — onboarding's
  // "Where are you based?" screen (also using this component) only ever deals in named places
  // today, so it never sets this; Explore's location picker is the one place that reads it,
  // to decide whether a selection should search by exact city name or by radius around a point.
  kind?: 'place' | 'postcode';
}

/**
 * UK-wide place search — a real product control, not a raw text field: type a few letters of a
 * town/city, pick from a dropdown of real results (backed by /locations/search, see
 * docs/DECISIONS.md#uk-wide-location). Used by onboarding's "Where are you based?" and Explore's
 * city switcher — the two places the brief specifically calls for this.
 */
export function LocationSearch({
  placeholder = 'Search a town or city…',
  onSelect,
  initialValue = '',
}: {
  placeholder?: string;
  onSelect: (place: UkPlaceResult) => void;
  initialValue?: string;
}) {
  const [query, setQuery] = useState(initialValue);
  const [results, setResults] = useState<UkPlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  // Real bug this fixes: a failed request (misconfigured API proxy, a cold/sleeping backend on
  // Render free tier, a network blip) used to be swallowed into the exact same empty `results`
  // array as a genuine "no UK city matches that" — so a user typing "Stafford" or "London" saw
  // the identical "No UK towns or cities matched" message whether the city didn't exist (never
  // true for any real UK town) or the search request itself never reached the server. Tracking
  // failure separately from "searched successfully, zero matches" lets the UI tell the truth and
  // give a real retry instead of quietly implying the UK's biggest cities don't exist.
  const [searchFailed, setSearchFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestIdRef = useRef(0);

  function runSearch(q: string) {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    setSearching(true);
    setSearchFailed(false);
    const thisRequestId = ++requestIdRef.current;
    // A hung request (e.g. a sleeping free-tier host still waking up) previously left the user
    // staring at "Searching…" with no way out short of retyping — an explicit timeout turns that
    // into the same actionable retry state as any other failure, instead of an indefinite spinner.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    api
      .get<{ results: UkPlaceResult[] }>(`/locations/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
      .then((res) => {
        if (requestIdRef.current !== thisRequestId) return; // a newer keystroke's search already superseded this one
        setResults(res.results);
        setSearchFailed(false);
      })
      .catch(() => {
        if (requestIdRef.current !== thisRequestId) return;
        setResults([]);
        setSearchFailed(true);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (requestIdRef.current === thisRequestId) setSearching(false);
      });
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => runSearch(query), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // Deliberately keyed on `query` alone — `runSearch` is a plain function recreated each
    // render, not a dependency whose identity should retrigger this debounce.
  }, [query]);

  const showDropdown = open && query.trim().length >= 2;

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{ width: '100%', padding: '15px 18px', borderRadius: 16, border: 'none', outline: 'none', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', fontSize: 15.5, fontFamily: 'inherit', color: 'var(--v2-ink)' }}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {showDropdown && (searching || results.length > 0 || query.trim().length >= 2) && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 6px)', background: 'var(--v2-surface)', borderRadius: 16, boxShadow: 'var(--v2-shadow-lg)', overflow: 'hidden', zIndex: 50 }}>
          {searching ? (
            <div className="v2-dim" style={{ padding: '14px 16px', fontSize: 13 }}>Searching…</div>
          ) : searchFailed ? (
            // Same single-row footprint as the "Searching…"/no-match states below (one line,
            // 14px 16px padding) — an earlier version stacked the message above a separate Retry
            // button, which made this state ~2x taller and, on short screens (e.g. onboarding's
            // step-1 card), pushed it down far enough to overlap the page's own footer buttons.
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px' }}>
              <div className="v2-dim" style={{ fontSize: 13 }}>Couldn&rsquo;t reach location search.</div>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runSearch(query)}
                style={{ flex: '0 0 auto', padding: 0, border: 'none', background: 'none', color: 'var(--v2-ink)', fontSize: 13, fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Retry
              </button>
            </div>
          ) : results.length > 0 ? (
            results.map((r) => (
              <button
                key={r.name}
                type="button"
                className="v2-location-result"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery(r.name);
                  setOpen(false);
                  onSelect(r);
                }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>{r.name}</div>
                <div className="v2-muted" style={{ fontSize: 12 }}>
                  {r.kind === 'postcode' ? `Postcode · ${r.region}` : r.region}
                </div>
              </button>
            ))
          ) : (
            <div className="v2-dim" style={{ padding: '14px 16px', fontSize: 13 }}>No UK towns or cities matched &ldquo;{query.trim()}&rdquo;.</div>
          )}
        </div>
      )}
    </div>
  );
}
