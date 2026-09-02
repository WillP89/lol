'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
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

export interface CrewTuneContentProps {
  crewId: string;
  interestPreferences: string[];
  onToggle: (interestId: string) => void;
  /** Called with the full, already-updated interestPreferences array once an AI setup call
   *  lands — the parent's own recSettings state is the single source of truth, this sheet never
   *  keeps a second copy of it. */
  onAiApplied: (interestPreferences: string[]) => void;
  /** Interest ids at least one Crew member has a real positive affinity for (from
   *  computeCrewTasteSummary) — surfaced as a highlight outline so picking something the Crew is
   *  already, genuinely into is easy to spot. A hint only; never gates what can be picked. */
  crewTasteInterestIds?: string[];
  saving?: boolean;
}

/**
 * The actual picker — AI-setup fast path, search, and territory browse — extracted from the
 * BottomSheet wrapper below it so it can also be mounted directly inside a step of the New Crew
 * flow (apps/web/src/app/crews/page.tsx), which needs this exact interaction without a second,
 * nested sheet — see that flow's own 'taste' step for why (the real, live product requirement:
 * "no events or things should be done on crew until preference set", set once at CREATION time
 * by the person creating it, not derived from members).
 */
export function CrewTuneContent({
  crewId,
  interestPreferences,
  onToggle,
  onAiApplied,
  crewTasteInterestIds = [],
  saving = false,
}: CrewTuneContentProps) {
  const [territories, setTerritories] = useState<TasteTerritory[] | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // "Describe this Crew and Plot sets up its preferences for you" — same fast-path idea as
  // TuneMyPlotSheet's own AI setup, one level up: adds to (never replaces) interestPreferences,
  // and the result is reviewable/removable via the same tap-to-toggle chips below.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiAppliedCount, setAiAppliedCount] = useState<number | null>(null);

  // No `open` gate here — the caller controls freshness by mounting/unmounting this (a
  // BottomSheet keeps its children mounted across open/close, so CrewTuneSheet below mounts this
  // conditionally itself; the New Crew flow's step naturally mounts/unmounts with the step).
  useEffect(() => {
    api.get<{ territories: TasteTerritory[] }>('/taste/taxonomy').then((res) => setTerritories(res.territories)).catch(() => setTerritories([]));
  }, []);

  const allInterests = useMemo(() => (territories ?? []).flatMap((t) => t.interests.map((i) => ({ ...i, territoryId: t.id }))), [territories]);
  const overlapSet = useMemo(() => new Set(crewTasteInterestIds), [crewTasteInterestIds]);

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return allInterests.filter((i) => i.label.toLowerCase().includes(q) || i.synonyms.some((s) => s.includes(q))).slice(0, 14);
  }, [allInterests, query]);

  async function submitAiSetup() {
    const text = aiText.trim();
    if (!text || aiSubmitting) return;
    setAiSubmitting(true);
    setAiError(null);
    try {
      const res = await api.post<{ settings: { interestPreferences: string[] }; applied: { interestIds: string[] } }>(
        `/crews/${crewId}/taste/ai-setup`,
        { description: text },
      );
      onAiApplied(res.settings.interestPreferences);
      setAiAppliedCount(res.applied.interestIds.length);
      setAiText('');
    } catch (err) {
      setAiError(
        err instanceof ApiError
          ? err.status === 503
            ? "Plot's AI setup isn't switched on yet — pick from the list below instead."
            : err.message
          : 'Could not set that up — try again, or pick from the list below.',
      );
    } finally {
      setAiSubmitting(false);
    }
  }

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
    <>
      {/* THE FAST PATH — "describe this Crew and Plot sets this up for you" (services/
            aiTasteSetup.ts). Collapsed by default; whatever it selects lands in the exact same
            interestPreferences state a manual tap would, reviewable/removable immediately after. */}
        <div style={{ marginBottom: 16 }}>
          {!aiOpen ? (
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              className="v2-tap-feedback"
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 9, border: '1.5px dashed var(--v2-brand)', borderRadius: 14,
                padding: '11px 14px', background: 'rgba(230,80,60,0.06)', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 17 }}>✨</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--v2-brand)' }}>Describe this Crew — let Plot set this up</span>
            </button>
          ) : (
            <div style={{ border: '1.5px solid var(--v2-brand)', borderRadius: 14, padding: 12, background: 'rgba(230,80,60,0.06)' }}>
              <textarea
                autoFocus
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                placeholder="e.g. we're five friends who love UK garage nights, trying new restaurants, and football on a Saturday"
                rows={3}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 10, border: 'none', outline: 'none', resize: 'vertical',
                  background: 'var(--v2-surface)', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--v2-ink)', marginBottom: 8,
                }}
              />
              {aiError && <p style={{ color: 'var(--v2-error)', fontSize: 12, marginBottom: 8 }}>{aiError}</p>}
              {aiAppliedCount !== null && !aiError && (
                <p style={{ color: 'var(--v2-brand)', fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                  {aiAppliedCount > 0
                    ? `Added ${aiAppliedCount} interest${aiAppliedCount === 1 ? '' : 's'} based on that — have a look below, tap to adjust anything.`
                    : "Nothing specific enough in there to pick out — try naming an artist, cuisine, team, or genre."}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={submitAiSetup}
                  disabled={aiSubmitting || !aiText.trim() || saving}
                  className="v2-btn v2-btn-brand v2-tap-feedback"
                  style={{ flex: 1, padding: '10px 0', fontSize: 13 }}
                >
                  {aiSubmitting ? 'Setting up…' : 'Set it up'}
                </button>
                <button
                  type="button"
                  onClick={() => { setAiOpen(false); setAiError(null); }}
                  disabled={aiSubmitting}
                  className="v2-btn v2-btn-ghost v2-tap-feedback"
                  style={{ padding: '10px 16px', fontSize: 13 }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

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
    </>
  );
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
 *
 * Just the BottomSheet + copy + "Done" wrapper around CrewTuneContent above, for the one place
 * (crew settings) this genuinely is a dismissable sheet, not a mandatory setup step.
 */
export function CrewTuneSheet({
  open,
  onClose,
  ...contentProps
}: CrewTuneContentProps & { open: boolean; onClose: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} zIndex={65}>
      <div style={{ paddingTop: 6 }}>
        <div className="v2-display" style={{ fontSize: 20, marginBottom: 4 }}>Tune this Crew&rsquo;s Plot</div>
        <p className="v2-muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          Pick anything this Crew is specifically into — boosts those on top of everyone&rsquo;s own taste, it doesn&rsquo;t
          replace it. Interests outlined in colour are ones your Crew already leans towards.
        </p>
        {/* Mounted only while actually open, not just visually hidden — a fresh mount is what
            resets its internal search/expanded/AI-box state each time the sheet reopens, same
            behaviour the old single-component version got from its own `open`-gated effect. */}
        {open && <CrewTuneContent {...contentProps} />}
        <button onClick={onClose} className="v2-btn v2-btn-brand" style={{ width: '100%', marginTop: 18 }}>
          Done
        </button>
      </div>
    </BottomSheet>
  );
}
