'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { BottomSheet } from '@/components/BottomSheet';
import { identityPair } from '@/lib/identity';

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

/**
 * "TUNE THIS CREW'S PLOT" — the Crew-level counterpart to TuneMyPlotSheet (see that file's own
 * header comment for the full personalisation-engine context; same taxonomy, same territory
 * browse pattern). Genuinely different data shape underneath, though: a Crew's
 * `interestPreferences` is a flat set of explicit picks ("this Crew is specifically about UK
 * garage"), not a per-person strength scale — so a tap here is a plain on/off toggle, never a
 * like/love cycle. No free-text capture either: CrewRecommendationSettings has no free-text
 * field (that's a per-person taste signal — see TasteProfile.freeTextSignals — not a Crew-level
 * one), so the search box here is a pure filter over the same ~150 interests, not an "add
 * anything" escape hatch the way Profile's is.
 */
export function CrewTuneSheet({
  open,
  onClose,
  interestPreferences,
  onToggle,
  crewTasteInterestIds = [],
  saving = false,
}: {
  open: boolean;
  onClose: () => void;
  interestPreferences: string[];
  onToggle: (interestId: string) => void;
  /** Interest ids at least one Crew member has a real positive affinity for (from
   *  computeCrewTasteSummary) — surfaced as a highlight outline so picking something the Crew is
   *  already, genuinely into is easy to spot. A hint only; never gates what can be picked. */
  crewTasteInterestIds?: string[];
  saving?: boolean;
}) {
  const [territories, setTerritories] = useState<TasteTerritory[] | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.get<{ territories: TasteTerritory[] }>('/taste/taxonomy').then((res) => setTerritories(res.territories)).catch(() => setTerritories([]));
    setQuery('');
    setExpanded(null);
  }, [open]);

  const allInterests = useMemo(() => (territories ?? []).flatMap((t) => t.interests.map((i) => ({ ...i, territoryId: t.id }))), [territories]);
  const overlapSet = useMemo(() => new Set(crewTasteInterestIds), [crewTasteInterestIds]);

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return allInterests.filter((i) => i.label.toLowerCase().includes(q) || i.synonyms.some((s) => s.includes(q))).slice(0, 14);
  }, [allInterests, query]);

  const isActive = (id: string) => interestPreferences.includes(id);

  function chipStyle(id: string): React.CSSProperties {
    const active = isActive(id);
    return {
      padding: '9px 14px',
      borderRadius: 100,
      border: !active && overlapSet.has(id) ? '1.5px solid var(--v2-brand)' : 'none',
      cursor: 'pointer',
      fontSize: 12.5,
      fontWeight: 700,
      background: active ? 'var(--v2-brand)' : 'var(--v2-bg-deep)',
      color: active ? '#fff' : 'var(--v2-ink-muted)',
      transition: 'background 0.15s ease, color 0.15s ease, border 0.15s ease',
    };
  }

  return (
    <BottomSheet open={open} onClose={onClose} zIndex={65}>
      <div style={{ paddingTop: 6 }}>
        <div className="v2-display" style={{ fontSize: 20, marginBottom: 4 }}>Tune this Crew&rsquo;s Plot</div>
        <p className="v2-muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          Pick anything this Crew is specifically into — boosts those on top of everyone&rsquo;s own taste, it doesn&rsquo;t
          replace it. Interests outlined in colour are ones your Crew already leans towards.
        </p>

        <div style={{ position: 'relative', marginBottom: 10 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search interests…"
            style={{
              width: '100%', padding: '13px 16px', borderRadius: 14, border: 'none', outline: 'none',
              background: 'var(--v2-bg-deep)', fontSize: 14.5, fontFamily: 'inherit', color: 'var(--v2-ink)',
            }}
          />
        </div>

        {query.trim().length >= 2 && (
          <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {searchMatches.length === 0 && <p className="v2-muted" style={{ fontSize: 12.5 }}>Nothing matched that.</p>}
            {searchMatches.map((i) => (
              <button key={i.id} type="button" onClick={() => onToggle(i.id)} disabled={saving} className="v2-tap-feedback" style={chipStyle(i.id)}>
                {i.label}
              </button>
            ))}
          </div>
        )}

        {/* Browse by territory — hidden while actively searching, same reasoning as TuneMyPlotSheet:
            never show the same interests twice on screen at once. */}
        {query.trim().length < 2 && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 8 }}>Browse</div>
            {territories === null && <div className="v2-skeleton" style={{ height: 200, borderRadius: 14 }} />}
            {territories?.map((territory) => {
              const [, accent] = identityPair(territory.id);
              const isOpen = expanded === territory.id;
              const activeCount = territory.interests.filter((i) => isActive(i.id)).length;
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
                        <button key={i.id} type="button" onClick={() => onToggle(i.id)} disabled={saving} className="v2-tap-feedback" style={chipStyle(i.id)}>
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
