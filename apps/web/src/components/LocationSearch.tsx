'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

export interface UkPlaceResult {
  name: string;
  region: string;
  lat: number;
  lng: number;
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
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      api
        .get<{ results: UkPlaceResult[] }>(`/locations/search?q=${encodeURIComponent(query.trim())}`)
        .then((res) => setResults(res.results))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
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
                <div className="v2-muted" style={{ fontSize: 12 }}>{r.region}</div>
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
