'use client';

/**
 * Recommendation diagnostics — the "real button in the app" version of the read-only
 * `/admin/crews/:id/explain-recommendation` and `/admin/users/lookup` tools (routes/admin.ts).
 * Built after a live product-owner request: the curl-command version of this ("Before you start"
 * in the pilot readiness checklist) assumed a terminal and an admin key someone already had
 * memorised — this page needs neither beyond entering the key once, in a normal form field, on
 * this device. Same shared-secret gate as every other /admin/* route (see
 * docs/DECISIONS.md#admin-auth for why that's a deliberate pilot-stage stopgap, not real
 * per-operator auth) — this page doesn't change that model, it just gives it a face.
 */

import { useCallback, useEffect, useState } from 'react';

const ADMIN_KEY_STORAGE = 'plot_admin_key';

// ---------------------------------------------------------------------------
// Shapes — matching services/crewRecommendations.ts#explainCrewRecommendation and
// routes/admin.ts's own response shapes exactly (see each route's own doc comment).
// ---------------------------------------------------------------------------

interface TopCandidate {
  experienceId: string;
  title: string;
  category: string;
  distanceMiles: number | null;
  startsAt: string;
  priceMinMinor: number | null;
  sourceKind: string;
  planWorthiness: string;
  planWorthinessReasons: string[];
  bookingType: string;
  matchScore: number;
  reasons: { code: string; label: string }[];
  eligible: boolean;
  rejectionReasons: string[];
}

interface MemberLocation {
  email: string;
  homeCity: string | null;
  hasCoordinates: boolean;
}

interface ExplainResult {
  crewId: string;
  outcome: string;
  crewName?: string;
  defaultCity?: string | null;
  bestCandidate: { experienceId: string; experienceName: string; category: string; score: number } | null;
  city?: string;
  memberLocations?: MemberLocation[];
  totalScored?: number;
  afterDedup?: number;
  afterRadius?: number;
  afterTasteSignal?: number;
  bestScoreSeen?: number | null;
  scoreThreshold?: number;
  topCandidates?: TopCandidate[];
  reason?: string; // crew_inactive's own activity reason
  lastRecommendationAt?: string | null;
  hoursSinceLast?: number;
  minHoursBetween?: number;
  recentCount?: number;
  maxPerWeek?: number;
  memberCount?: number;
  guaranteedFirst?: boolean;
  exploratory?: boolean;
}

interface LookupCrew {
  crewId: string;
  crewName: string;
  defaultCity: string | null;
  memberCount: number;
  recommendationsEnabled: boolean;
  mostRecentRecommendation: { experienceName: string | null; category: string | null; score: number; createdAt: string } | null;
  rightNow: ExplainResult;
}

interface NearbyExperience {
  id: string;
  name: string;
  category: string;
  subcategories: string[];
  venueName: string | null;
  venueCity: string | null;
  distanceKm: number;
  startsAt: string;
  bookingStatus: string;
  qualityScore: number;
  hasImage: boolean;
  passesQualityGate: boolean;
  passesDateWindow: boolean;
  passesBookingStatus: boolean;
  isPlanWorthy: boolean;
}

interface NearbyResult {
  city: string;
  radiusKm: number;
  totalWithinRadius: number;
  minPublishableQualityScore: number;
  experiences: NearbyExperience[];
}

interface RecentDelivery {
  crewId: string;
  crewName: string;
  crewMembers: string[];
  experienceName: string | null;
  category: string | null;
  score: number;
  status: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// A tiny fetch wrapper local to this page — admin routes authenticate with a shared key, not the
// normal session cookie, so this deliberately bypasses lib/api.ts's session-oriented helper.
// ---------------------------------------------------------------------------

class AdminApiError extends Error {}

async function adminFetch<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const url = `/api${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AdminApiError(res.status === 401 ? 'That key was rejected — double-check it and try again.' : body.message || `Request failed (${res.status})`);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Plain-English outcome copy — the whole point of this page: nobody should have to know what
// "no_eligible_candidate" means. See services/crewRecommendations.ts's own RecommendationOutcome
// union for the full, authoritative list this mirrors.
// ---------------------------------------------------------------------------

type Tone = 'good' | 'attention' | 'quiet' | 'bad';

const OUTCOME_INFO: Record<string, { label: string; tone: Tone; blurb: string }> = {
  disabled: { label: 'Turned off', tone: 'quiet', blurb: 'This Crew has switched Plot recommendations off in its own settings.' },
  preferences_not_set: { label: 'Preferences not set', tone: 'attention', blurb: "This Crew hasn't set its taste yet — nothing can be sent until it does." },
  location_not_set: { label: 'No location known', tone: 'attention', blurb: "No location is known for this Crew yet — Plot deliberately won't guess rather than risk sending something from miles away." },
  crew_inactive: { label: 'Crew looks inactive', tone: 'quiet', blurb: 'No recent chat, responses, or plans — Plot is leaving this Crew alone on purpose, rather than nagging it.' },
  too_soon: { label: 'Spacing itself out', tone: 'quiet', blurb: 'A recommendation went out recently. Plot deliberately waits between sends — this is expected, not a bug.' },
  weekly_cap_reached: { label: "Hit this week's cap", tone: 'quiet', blurb: 'This Crew has already had its recommendations for this week.' },
  too_few_members: { label: 'Not enough members', tone: 'attention', blurb: 'Fewer than two active members — nothing to recommend to yet.' },
  no_eligible_candidate: { label: 'Nothing good enough, honestly', tone: 'attention', blurb: "Genuinely nothing nearby clears the bar for this Crew's taste right now. Not a bug — Plot sends nothing rather than something half-right." },
  eligible: { label: 'Ready to send', tone: 'good', blurb: "A recommendation is ready — it just hasn't gone out at this exact moment." },
  delivered: { label: 'Just delivered', tone: 'good', blurb: 'A recommendation was delivered by this very check.' },
  error: { label: 'Something went wrong', tone: 'bad', blurb: 'Plot hit an error evaluating this Crew — worth a closer look, or ask an engineer.' },
};

const ACTIVITY_REASON_LABEL: Record<string, string> = {
  onboarding_grace_period: 'still within its first few weeks (benefit of the doubt for a brand-new Crew)',
  recent_message: 'recent chat activity',
  recent_response: 'a recent reply to a Plot recommendation',
  recent_plan_activity: 'a recent Plan being worked on',
  inactive: 'no recent activity of any kind',
};

const REJECTION_LABEL: Record<string, string> = {
  ALREADY_RECOMMENDED_OR_SHARED: 'Already sent or shared before',
  OUTSIDE_CREW_RADIUS: "Outside the Crew's radius",
  DISTANCE_UNKNOWN: 'Distance unknown',
  NO_TASTE_SIGNAL: "No real match to this Crew's taste",
  BELOW_CONFIDENCE_THRESHOLD: 'Score too low to send',
};

function toneColor(tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'good': return { fg: '#0f7a44', bg: '#def7e8' };
    case 'attention': return { fg: '#a15a06', bg: '#fbead0' };
    case 'bad': return { fg: '#c11f2b', bg: '#fbe1e2' };
    default: return { fg: 'var(--v2-ink-muted)', bg: 'var(--v2-bg-deep)' };
  }
}

function titleCaseCategory(category: string): string {
  return category.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hrs = ms / 36e5;
  if (hrs < 1) return 'moments ago';
  if (hrs < 48) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Key gate
// ---------------------------------------------------------------------------

function KeyGate({ onSaved }: { onSaved: (key: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="v2" style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="v2-card" style={{ maxWidth: 380, width: '100%', padding: 26 }}>
        <div className="v2-eyebrow" style={{ marginBottom: 6 }}>Recommendation diagnostics</div>
        <h1 className="v2-display" style={{ fontSize: 22, marginBottom: 8 }}>Enter the admin key</h1>
        <p className="v2-muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          Ask whoever set up Plot for this if you don&rsquo;t have it. It&rsquo;s saved only in this browser, on this device — never sent anywhere else.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onSaved(value.trim());
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Admin key"
            autoFocus
            style={{ padding: '11px 13px', borderRadius: 10, border: '1px solid var(--v2-line)', background: 'var(--v2-bg)', color: 'var(--v2-ink)', fontSize: 14 }}
          />
          <button type="submit" className="v2-btn v2-btn-brand" style={{ padding: '11px 16px' }} disabled={!value.trim()}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The explain panel — shared by both the email-lookup results and the direct Crew-id lookup.
// ---------------------------------------------------------------------------

function ExplainPanel({
  crewId, crewName, defaultCity, memberCount, recommendationsEnabled, mostRecentRecommendation, explain, adminKey, onRefresh,
}: {
  crewId: string;
  crewName?: string;
  defaultCity?: string | null;
  memberCount?: number;
  recommendationsEnabled?: boolean;
  mostRecentRecommendation?: LookupCrew['mostRecentRecommendation'];
  explain: ExplainResult;
  adminKey: string;
  onRefresh: (next: ExplainResult) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [forceMsg, setForceMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyResult | 'loading' | null>(null);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const info = OUTCOME_INFO[explain.outcome] ?? { label: explain.outcome, tone: 'quiet' as Tone, blurb: '' };
  const colors = toneColor(info.tone);
  const candidates = explain.topCandidates ?? [];
  const cityToSync = explain.city ?? defaultCity ?? explain.defaultCity ?? null;

  async function forceCheck() {
    setForcing(true);
    setForceMsg(null);
    try {
      const result = await adminFetch<{ delivered: number; recommendation: { experienceId: string } | null }>(
        '/admin/recommendations/sweep', adminKey, { method: 'POST', body: JSON.stringify({ crewId }) },
      );
      const fresh = await adminFetch<ExplainResult>(`/admin/crews/${crewId}/explain-recommendation`, adminKey);
      onRefresh(fresh);
      setForceMsg(result.delivered > 0 ? 'Sent something — check the Crew chat.' : "Checked — still nothing genuinely due, see the outcome above.");
    } catch (err) {
      setForceMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setForcing(false);
    }
  }

  // A real, distinct action from "force a check" — that only re-runs eligibility against
  // whatever's already in the database. This actually re-fetches from every live provider and
  // writes fresh rows, for the exact case a real production incident surfaced: a city that DOES
  // have existing content doesn't block on a background resync (see inventorySync.ts#
  // ensureInventoryProduction's own "stale-while-revalidate" comment) — so a Crew can see zero
  // scored candidates against genuinely stale/mismatched existing rows while real, current
  // inventory sits one real sync away. Exposed here rather than only via curl/`/admin/sync`
  // because "why is there nothing for my city" needs a one-click real fix, not just a diagnosis.
  async function syncInventory() {
    if (!cityToSync) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      await adminFetch<{ results: unknown }>('/admin/sync', adminKey, { method: 'POST', body: JSON.stringify({ city: cityToSync }) });
      const fresh = await adminFetch<ExplainResult>(`/admin/crews/${crewId}/explain-recommendation`, adminKey);
      onRefresh(fresh);
      setSyncMsg(`Synced ${cityToSync} — re-checked above.`);
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSyncing(false);
    }
  }

  // Real gap this closes: `totalScored`/`afterRadius`/`afterTasteSignal` above prove something
  // is empty, but not WHICH gate emptied it — a sync completing cleanly ("fetched 40, upserted
  // 40") only proves listings exist somewhere, not that any of them are the right category,
  // within date, above the quality floor, or "plan-worthy" (see routes/admin.ts's own
  // `/experiences-near` comment). This is the direct, in-app way to see that without pasting raw
  // JSON back and forth — the exact same annotated gates the real scorer applies, read-only.
  async function checkNearby() {
    if (!cityToSync) return;
    setNearby('loading');
    setNearbyError(null);
    try {
      const result = await adminFetch<NearbyResult>(`/admin/experiences-near?city=${encodeURIComponent(cityToSync)}&radiusKm=50&limit=40`, adminKey);
      setNearby(result);
    } catch (err) {
      setNearby(null);
      setNearbyError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div className="v2-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="v2-display" style={{ fontSize: 17 }}>{crewName ?? explain.crewName ?? 'Crew'}</div>
          <div className="v2-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            {(defaultCity ?? explain.defaultCity) || 'No city set'}
            {memberCount !== undefined ? ` · ${memberCount} member${memberCount === 1 ? '' : 's'}` : ''}
            {recommendationsEnabled === false ? ' · recommendations off' : ''}
          </div>
        </div>
        <span style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 11px', borderRadius: 100, color: colors.fg, background: colors.bg, whiteSpace: 'nowrap' }}>
          {info.label}
        </span>
      </div>

      <p style={{ fontSize: 13.5, color: 'var(--v2-ink)', margin: 0 }}>{info.blurb}</p>

      {explain.outcome === 'crew_inactive' && explain.reason && (
        <p className="v2-dim" style={{ fontSize: 12, margin: 0 }}>Reason: {ACTIVITY_REASON_LABEL[explain.reason] ?? explain.reason}.</p>
      )}
      {explain.outcome === 'too_soon' && explain.hoursSinceLast !== undefined && (
        <p className="v2-dim" style={{ fontSize: 12, margin: 0 }}>
          Last sent {Math.round(explain.hoursSinceLast)}h ago — Plot waits at least {explain.minHoursBetween}h between sends.
        </p>
      )}
      {explain.outcome === 'weekly_cap_reached' && explain.recentCount !== undefined && (
        <p className="v2-dim" style={{ fontSize: 12, margin: 0 }}>{explain.recentCount} of {explain.maxPerWeek} used this week.</p>
      )}

      {mostRecentRecommendation && (
        <div style={{ fontSize: 12.5, color: 'var(--v2-ink-muted)', background: 'var(--v2-bg-deep)', borderRadius: 10, padding: '9px 12px' }}>
          Most recent send: <b style={{ color: 'var(--v2-ink)' }}>{mostRecentRecommendation.experienceName ?? '—'}</b>
          {mostRecentRecommendation.category ? ` (${titleCaseCategory(mostRecentRecommendation.category)})` : ''} · {timeAgo(mostRecentRecommendation.createdAt)}
        </div>
      )}

      {explain.totalScored !== undefined && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, color: 'var(--v2-ink-muted)' }}>
          <span><b style={{ color: 'var(--v2-ink)' }}>{explain.totalScored}</b> scored</span>
          <span><b style={{ color: 'var(--v2-ink)' }}>{explain.afterRadius}</b> in radius</span>
          <span><b style={{ color: 'var(--v2-ink)' }}>{explain.afterTasteSignal}</b> real taste match</span>
          {explain.bestScoreSeen !== null && explain.bestScoreSeen !== undefined && (
            <span>best score <b style={{ color: 'var(--v2-ink)' }}>{explain.bestScoreSeen}</b> / needs {explain.scoreThreshold}</span>
          )}
        </div>
      )}

      {candidates.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--v2-brand)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
          >
            {expanded ? 'Hide' : 'See'} every candidate considered ({candidates.length})
          </button>
          {expanded && (
            <div style={{ marginTop: 10, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--v2-ink-muted)' }}>
                    <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Title</th>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>Category</th>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>Distance</th>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>Score</th>
                    <th style={{ padding: '4px 0', fontWeight: 600 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.experienceId} style={{ borderTop: '1px solid var(--v2-line)' }}>
                      <td style={{ padding: '7px 8px 7px 0', maxWidth: 200 }}>{c.title}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--v2-ink-muted)' }}>{titleCaseCategory(c.category)}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--v2-ink-muted)' }}>{c.distanceMiles !== null ? `${c.distanceMiles.toFixed(1)}mi` : '—'}</td>
                      <td style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.matchScore}</td>
                      <td style={{ padding: '7px 0' }}>
                        {c.eligible ? (
                          <span>
                            <span style={{ color: '#0f7a44', fontWeight: 700 }}>Eligible</span>
                            {c.reasons.length > 0 && (
                              <span style={{ color: 'var(--v2-ink-muted)' }}> — {c.reasons.map((r) => r.label).join(', ')}</span>
                            )}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--v2-ink-dim)' }}>
                            {c.rejectionReasons.map((r) => REJECTION_LABEL[r] ?? r).join(', ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4, borderTop: '1px solid var(--v2-line)', marginTop: 2, flexWrap: 'wrap' }}>
        <button type="button" onClick={forceCheck} disabled={forcing} className="v2-btn v2-btn-ghost" style={{ padding: '8px 14px', fontSize: 12.5, marginTop: 10 }}>
          {forcing ? 'Checking…' : 'Force a check now'}
        </button>
        {cityToSync && (
          <button type="button" onClick={syncInventory} disabled={syncing} className="v2-btn v2-btn-ghost" style={{ padding: '8px 14px', fontSize: 12.5, marginTop: 10 }}>
            {syncing ? `Syncing ${cityToSync}…` : `Sync ${cityToSync} inventory now`}
          </button>
        )}
        {cityToSync && (
          <button type="button" onClick={checkNearby} disabled={nearby === 'loading'} className="v2-btn v2-btn-ghost" style={{ padding: '8px 14px', fontSize: 12.5, marginTop: 10 }}>
            {nearby === 'loading' ? 'Checking database…' : "What's actually in the database near here?"}
          </button>
        )}
        {forceMsg && <span className="v2-dim" style={{ fontSize: 12, marginTop: 10 }}>{forceMsg}</span>}
        {syncMsg && <span className="v2-dim" style={{ fontSize: 12, marginTop: 10 }}>{syncMsg}</span>}
        {nearbyError && <span style={{ color: 'var(--v2-error)', fontSize: 12, marginTop: 10 }}>{nearbyError}</span>}
      </div>

      {nearby && nearby !== 'loading' && (
        <div style={{ marginTop: -4 }}>
          <p className="v2-dim" style={{ fontSize: 12, margin: '0 0 8px' }}>
            <b style={{ color: 'var(--v2-ink)' }}>{nearby.totalWithinRadius}</b> real row{nearby.totalWithinRadius === 1 ? '' : 's'} within {nearby.radiusKm}km of {nearby.city} — quality floor is {nearby.minPublishableQualityScore}.
            {nearby.totalWithinRadius === 0 && ' Nothing has been synced this close yet — try Sync above, then check again.'}
          </p>
          {nearby.totalWithinRadius > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--v2-ink-muted)' }}>
                    <th style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>Name</th>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>Category</th>
                    <th style={{ padding: '4px 8px', fontWeight: 600 }}>Distance</th>
                    <th style={{ padding: '4px 0', fontWeight: 600 }}>Why it would/wouldn&rsquo;t reach a Crew</th>
                  </tr>
                </thead>
                <tbody>
                  {nearby.experiences.map((e) => {
                    const fails: string[] = [];
                    if (!e.passesQualityGate) fails.push(`quality score ${e.qualityScore} < ${nearby.minPublishableQualityScore}`);
                    if (!e.passesDateWindow) fails.push('outside the recommendation date window');
                    if (!e.passesBookingStatus) fails.push('sold out');
                    if (!e.isPlanWorthy) fails.push('not specific enough to be plan-worthy');
                    return (
                      <tr key={e.id} style={{ borderTop: '1px solid var(--v2-line)' }}>
                        <td style={{ padding: '7px 8px 7px 0', maxWidth: 200 }}>{e.name}</td>
                        <td style={{ padding: '7px 8px', color: 'var(--v2-ink-muted)' }}>{titleCaseCategory(e.category)}</td>
                        <td style={{ padding: '7px 8px', color: 'var(--v2-ink-muted)' }}>{e.distanceKm.toFixed(1)}km</td>
                        <td style={{ padding: '7px 0' }}>
                          {fails.length === 0 ? (
                            <span style={{ color: '#0f7a44', fontWeight: 700 }}>Clears every gate</span>
                          ) : (
                            <span style={{ color: 'var(--v2-ink-dim)' }}>{fails.join(', ')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RecommendationDiagnosticsPage() {
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [keyChecked, setKeyChecked] = useState(false);

  const [email, setEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailCrews, setEmailCrews] = useState<LookupCrew[] | null>(null);

  const [crewIdInput, setCrewIdInput] = useState('');
  const [crewIdBusy, setCrewIdBusy] = useState(false);
  const [crewIdError, setCrewIdError] = useState<string | null>(null);
  const [crewIdResult, setCrewIdResult] = useState<ExplainResult | null>(null);

  const [recent, setRecent] = useState<RecentDelivery[] | 'loading' | 'error' | null>(null);

  useEffect(() => {
    try {
      setAdminKey(localStorage.getItem(ADMIN_KEY_STORAGE));
    } catch {
      setAdminKey(null);
    }
    setKeyChecked(true);
  }, []);

  const loadRecent = useCallback(async (key: string) => {
    setRecent('loading');
    try {
      const { recommendations } = await adminFetch<{ recommendations: RecentDelivery[] }>('/admin/recommendations/recent?limit=15', key);
      setRecent(recommendations);
    } catch {
      setRecent('error');
    }
  }, []);

  useEffect(() => {
    if (adminKey) loadRecent(adminKey);
  }, [adminKey, loadRecent]);

  function saveKey(key: string) {
    try { localStorage.setItem(ADMIN_KEY_STORAGE, key); } catch { /* ignore — falls back to session-only */ }
    setAdminKey(key);
  }

  function forgetKey() {
    try { localStorage.removeItem(ADMIN_KEY_STORAGE); } catch { /* ignore */ }
    setAdminKey(null);
    setEmailCrews(null);
    setCrewIdResult(null);
  }

  async function lookupByEmail() {
    if (!adminKey || !email.trim()) return;
    setEmailBusy(true);
    setEmailError(null);
    setEmailCrews(null);
    try {
      const body = await adminFetch<{ crews: LookupCrew[] }>(`/admin/users/lookup?email=${encodeURIComponent(email.trim())}`, adminKey);
      setEmailCrews(body.crews);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setEmailBusy(false);
    }
  }

  async function lookupByCrewId() {
    if (!adminKey || !crewIdInput.trim()) return;
    setCrewIdBusy(true);
    setCrewIdError(null);
    setCrewIdResult(null);
    try {
      const body = await adminFetch<ExplainResult>(`/admin/crews/${crewIdInput.trim()}/explain-recommendation`, adminKey);
      setCrewIdResult(body);
    } catch (err) {
      setCrewIdError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setCrewIdBusy(false);
    }
  }

  if (!keyChecked) return null;
  if (!adminKey) return <KeyGate onSaved={saveKey} />;

  return (
    <div className="v2">
      <div className="v2-page v2-page-wide" style={{ paddingTop: 28, paddingBottom: 60, display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>Admin · internal only</div>
            <h1 className="v2-display" style={{ fontSize: 26, marginBottom: 4 }}>Recommendation diagnostics</h1>
            <p className="v2-muted" style={{ fontSize: 13.5, maxWidth: 60 + 'ch' }}>
              Why a Crew did or didn&rsquo;t get a Plot recommendation — the exact same eligibility check the automatic engine itself runs, live, without sending anything.
            </p>
          </div>
          <button type="button" onClick={forgetKey} className="v2-btn v2-btn-ghost" style={{ padding: '7px 13px', fontSize: 12 }}>Forget key</button>
        </div>

        <section className="v2-card" style={{ padding: 20 }}>
          <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Look up by member email</div>
          <form
            onSubmit={(e) => { e.preventDefault(); lookupByEmail(); }}
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@example.com"
              style={{ flex: '1 1 220px', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--v2-line)', background: 'var(--v2-bg)', color: 'var(--v2-ink)', fontSize: 13.5 }}
            />
            <button type="submit" disabled={emailBusy || !email.trim()} className="v2-btn v2-btn-brand" style={{ padding: '10px 18px', fontSize: 13.5 }}>
              {emailBusy ? 'Looking up…' : 'Look up'}
            </button>
          </form>
          {emailError && <p style={{ color: 'var(--v2-error)', fontSize: 12.5, marginTop: 10 }}>{emailError}</p>}
        </section>

        {emailCrews && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {emailCrews.length === 0 && <p className="v2-muted" style={{ fontSize: 13.5 }}>That email isn&rsquo;t in any active Crew.</p>}
            {emailCrews.map((c) => (
              <ExplainPanel
                key={c.crewId}
                crewId={c.crewId}
                crewName={c.crewName}
                defaultCity={c.defaultCity}
                memberCount={c.memberCount}
                recommendationsEnabled={c.recommendationsEnabled}
                mostRecentRecommendation={c.mostRecentRecommendation}
                explain={c.rightNow}
                adminKey={adminKey}
                onRefresh={(fresh) => setEmailCrews((prev) => prev?.map((x) => (x.crewId === c.crewId ? { ...x, rightNow: fresh } : x)) ?? null)}
              />
            ))}
          </div>
        )}

        <section className="v2-card" style={{ padding: 20 }}>
          <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Or look up by Crew ID</div>
          <p className="v2-dim" style={{ fontSize: 12, marginTop: -4, marginBottom: 10 }}>Open the Crew in the app — the id is the part of the address bar right after <code>/crews/</code>.</p>
          <form
            onSubmit={(e) => { e.preventDefault(); lookupByCrewId(); }}
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            <input
              type="text"
              value={crewIdInput}
              onChange={(e) => setCrewIdInput(e.target.value)}
              placeholder="Crew id"
              style={{ flex: '1 1 220px', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--v2-line)', background: 'var(--v2-bg)', color: 'var(--v2-ink)', fontSize: 13.5, fontFamily: 'monospace' }}
            />
            <button type="submit" disabled={crewIdBusy || !crewIdInput.trim()} className="v2-btn v2-btn-brand" style={{ padding: '10px 18px', fontSize: 13.5 }}>
              {crewIdBusy ? 'Checking…' : 'Check'}
            </button>
          </form>
          {crewIdError && <p style={{ color: 'var(--v2-error)', fontSize: 12.5, marginTop: 10 }}>{crewIdError}</p>}
        </section>

        {crewIdResult && (
          <ExplainPanel
            crewId={crewIdResult.crewId}
            explain={crewIdResult}
            adminKey={adminKey}
            onRefresh={(fresh) => setCrewIdResult(fresh)}
          />
        )}

        <section>
          <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Recently delivered, across every Crew</div>
          {recent === 'loading' && <p className="v2-muted" style={{ fontSize: 13 }}>Loading…</p>}
          {recent === 'error' && <p style={{ color: 'var(--v2-error)', fontSize: 13 }}>Couldn&rsquo;t load recent deliveries.</p>}
          {Array.isArray(recent) && (
            recent.length === 0 ? (
              <p className="v2-muted" style={{ fontSize: 13 }}>Nothing delivered yet.</p>
            ) : (
              <div className="v2-card" style={{ padding: '4px 0', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--v2-ink-muted)' }}>
                      <th style={{ padding: '10px 14px', fontWeight: 600 }}>Crew</th>
                      <th style={{ padding: '10px 14px', fontWeight: 600 }}>Sent</th>
                      <th style={{ padding: '10px 14px', fontWeight: 600 }}>Category</th>
                      <th style={{ padding: '10px 14px', fontWeight: 600 }}>Score</th>
                      <th style={{ padding: '10px 14px', fontWeight: 600 }}>Response</th>
                      <th style={{ padding: '10px 14px', fontWeight: 600 }}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--v2-line)' }}>
                        <td style={{ padding: '10px 14px' }}>{r.crewName}</td>
                        <td style={{ padding: '10px 14px' }}>{r.experienceName ?? '—'}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--v2-ink-muted)' }}>{r.category ? titleCaseCategory(r.category) : '—'}</td>
                        <td style={{ padding: '10px 14px', fontVariantNumeric: 'tabular-nums' }}>{r.score}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--v2-ink-muted)' }}>{r.status.replace(/_/g, ' ').toLowerCase()}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--v2-ink-muted)' }}>{timeAgo(r.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>
      </div>
    </div>
  );
}
