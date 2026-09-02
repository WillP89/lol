'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { BottomSheet } from '@/components/BottomSheet';
import { identityPair } from '@/lib/identity';

/**
 * "TUNE MY PLOT" — the personalisation-engine pass's real preference editor (docs/DECISIONS.md
 * #personalisation-engine). Replaces a flat wall of ~15 category chips ("I like music") with
 * real, specific taste ("UK garage", "Championship football") — the actual thing this whole
 * pass exists to fix. Deliberately NOT a giant settings form: one search/free-text input up top
 * (the "tell Plot something specific" escape hatch, always available, never a dead end — see
 * `addFreeText` below), then progressive disclosure by territory (Music, Sport, Food, ...) so
 * ~150 possible interests are never all on screen at once. Every tap saves immediately, same
 * "no Save button, ever" pattern the rest of Profile already uses.
 */

interface TasteInterest {
  id: string;
  label: string;
  synonyms: string[];
}
interface TasteTerritory {
  id: string;
  label: string;
  interests: TasteInterest[];
}
interface FreeTextSignal {
  text: string;
  matchedInterestIds: string[];
  confidence: 'high' | 'low';
  addedAt: string;
}

type Strength = 'like' | 'love' | null;

function strengthFromAffinity(v: number | undefined): Strength {
  if (v === undefined) return null;
  if (v >= 0.9) return 'love';
  if (v > 0) return 'like';
  return null;
}

export function TuneMyPlotSheet({
  open,
  onClose,
  interestAffinity,
  freeTextSignals,
}: {
  open: boolean;
  onClose: () => void;
  interestAffinity: Record<string, number>;
  freeTextSignals: FreeTextSignal[];
}) {
  const [territories, setTerritories] = useState<TasteTerritory[] | null>(null);
  const [local, setLocal] = useState<Record<string, Strength>>({});
  const [signals, setSignals] = useState<FreeTextSignal[]>(freeTextSignals);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get<{ territories: TasteTerritory[] }>('/taste/taxonomy').then((res) => setTerritories(res.territories)).catch(() => setTerritories([]));
    const seeded: Record<string, Strength> = {};
    for (const [id, v] of Object.entries(interestAffinity)) seeded[id] = strengthFromAffinity(v);
    setLocal(seeded);
    setSignals(freeTextSignals);
    setQuery('');
    setExpanded(null);
    // Deliberately only re-seeds when the sheet actually opens (`open` is the only real
    // dependency) — re-running on every parent re-render (interestAffinity is a fresh object
    // each time) would stomp an in-progress tap.
  }, [open]);

  const allInterests = useMemo(() => (territories ?? []).flatMap((t) => t.interests.map((i) => ({ ...i, territoryId: t.id }))), [territories]);

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return allInterests.filter((i) => i.label.toLowerCase().includes(q) || i.synonyms.some((s) => s.includes(q))).slice(0, 12);
  }, [allInterests, query]);

  async function cycleInterest(interestId: string) {
    const current = local[interestId] ?? null;
    const next: Strength = current === null ? 'like' : current === 'like' ? 'love' : null;
    setLocal((prev) => ({ ...prev, [interestId]: next }));
    // A cleared interest still needs a real write — 'open' carries a small positive weight
    // server-side (see tasteSignals.ts's STRENGTH_WEIGHT) rather than deleting the key, so
    // clearing here sends 'open' rather than skipping the call.
    await api.post('/users/me/taste/interests', { updates: [{ interestId, strength: next ?? 'open' }] }).catch(() => {});
  }

  async function addFreeText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      const res = await api.post<{ tasteProfile: { freeTextSignals: FreeTextSignal[] } }>('/users/me/taste/free-text', { text: trimmed });
      setSignals(res.tasteProfile.freeTextSignals);
      setQuery('');
    } catch {
      // stays in the input — nothing silently lost
    } finally {
      setAdding(false);
    }
  }

  async function removeFreeText(text: string) {
    setSignals((prev) => prev.filter((s) => s.text !== text));
    await api.delete('/users/me/taste/free-text', { text }).catch(() => {});
  }

  const pillStyle = (active: Strength): React.CSSProperties => ({
    padding: '9px 14px',
    borderRadius: 100,
    border: active === 'love' ? '1.5px solid var(--v2-pop)' : 'none',
    cursor: 'pointer',
    fontSize: 12.5,
    fontWeight: 700,
    background: active === 'love' ? 'var(--v2-pop)' : active === 'like' ? 'var(--v2-brand)' : 'var(--v2-bg-deep)',
    color: active ? '#fff' : 'var(--v2-ink-muted)',
    transition: 'background 0.15s ease, color 0.15s ease, border 0.15s ease',
  });

  return (
    <BottomSheet open={open} onClose={onClose} zIndex={60}>
      <div style={{ paddingTop: 6 }}>
        <div className="v2-display" style={{ fontSize: 20, marginBottom: 4 }}>Tune my Plot</div>
        <p className="v2-muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          The more specific, the better Plot gets — tap to say what you&rsquo;re into, tap again for &ldquo;love it&rdquo;.
        </p>

        {/* THE ESCAPE HATCH — always available, never limited to the fixed list below. */}
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && searchMatches.length === 0 && addFreeText(query)}
            placeholder="Artist, team, cuisine, activity..."
            style={{
              width: '100%', padding: '13px 16px', borderRadius: 14, border: 'none', outline: 'none',
              background: 'var(--v2-bg-deep)', fontSize: 14.5, fontFamily: 'inherit', color: 'var(--v2-ink)',
            }}
          />
        </div>

        {query.trim().length >= 2 && (
          <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {searchMatches.map((i) => (
              <button key={i.id} type="button" onClick={() => cycleInterest(i.id)} className="v2-tap-feedback" style={pillStyle(local[i.id] ?? null)}>
                {i.label}
              </button>
            ))}
            {/* Free-text add — offered whenever nothing in the taxonomy matches, so typing
                something real (an artist, a specific team) is never a dead end. */}
            <button
              type="button"
              onClick={() => addFreeText(query)}
              disabled={adding}
              className="v2-tap-feedback"
              style={{ padding: '9px 14px', borderRadius: 100, border: '1.5px dashed var(--v2-ink-dim)', background: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--v2-ink-muted)' }}
            >
              + Add &ldquo;{query.trim()}&rdquo;
            </button>
          </div>
        )}

        {signals.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div className="v2-eyebrow" style={{ marginBottom: 8 }}>You&rsquo;ve told Plot</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {signals.map((s) => (
                <span
                  key={s.text}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 8px 7px 14px', borderRadius: 100,
                    background: 'var(--v2-bg-deep)', fontSize: 12.5, fontWeight: 700, color: 'var(--v2-ink)',
                  }}
                >
                  &ldquo;{s.text}&rdquo;
                  <button
                    type="button"
                    onClick={() => removeFreeText(s.text)}
                    aria-label={`Remove ${s.text}`}
                    style={{ width: 20, height: 20, borderRadius: '50%', border: 'none', background: 'var(--v2-bg)', color: 'var(--v2-ink-muted)', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Browse by territory — hidden while actively searching, so the picker never shows the
            same interests twice on screen at once. */}
        {query.trim().length < 2 && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 8 }}>Browse</div>
            {territories === null && <div className="v2-skeleton" style={{ height: 200, borderRadius: 14 }} />}
            {territories?.map((territory) => {
              const [, accent] = identityPair(territory.id);
              const isOpen = expanded === territory.id;
              const activeCount = territory.interests.filter((i) => local[i.id]).length;
              return (
                <div key={territory.id} style={{ marginBottom: 6 }}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : territory.id)}
                    className="v2-tap-feedback"
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', borderRadius: 14,
                      border: 'none', cursor: 'pointer', background: isOpen ? 'var(--v2-bg-deep)' : 'transparent', textAlign: 'left',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>{territory.label}</span>
                    {activeCount > 0 && (
                      <span style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: accent, borderRadius: 100, padding: '3px 8px' }}>{activeCount}</span>
                    )}
                    <span style={{ color: 'var(--v2-ink-dim)', fontSize: 12, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</span>
                  </button>
                  {isOpen && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 4px 14px' }}>
                      {territory.interests.map((i) => (
                        <button key={i.id} type="button" onClick={() => cycleInterest(i.id)} className="v2-tap-feedback" style={pillStyle(local[i.id] ?? null)}>
                          {i.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button onClick={onClose} className="v2-btn v2-btn-brand" style={{ width: '100%', marginTop: 18 }}>
          Done
        </button>
      </div>
    </BottomSheet>
  );
}
