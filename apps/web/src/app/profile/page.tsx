'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { TabBarV2 } from '@/components/TabBarV2';
import { BottomSheet } from '@/components/BottomSheet';
import { formatPriceFrom } from '@/lib/formatPrice';
import { v2Art } from '@/lib/v2Art';
import { PersonAvatar, CrewMark } from '@/components/Avatar';
import { MediaUploadButton } from '@/components/MediaUploadButton';
import { LocationSearch, type UkPlaceResult } from '@/components/LocationSearch';
import { INTERESTS, interestSlug } from '@/lib/interests';

interface ProfileUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  tasteProfile: {
    categoryAffinity: Record<string, number>;
    budgetMaxMinor: number;
    energyPreference: 'LOW' | 'MEDIUM' | 'HIGH';
    travelRadiusMeters: number;
  } | null;
  profile: { homeCity: string | null; homeLat: number | null; homeLng: number | null } | null;
  locationPrefs: { kind: string; label: string }[];
}

interface CrewSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  members: { user: { displayName: string | null; email: string; avatarUrl?: string | null } }[];
}

interface UpcomingPlan {
  id: string;
  publicSlug: string;
  title: string;
  crew: { name: string };
  startsAt: string | null;
  venueName: string | null;
  category: string | null;
  imageUrl: string | null;
  priceMinMinor: number | null;
  currency: string;
}

const BUDGET_BANDS = [
  { label: 'Free', maxMinor: 0 },
  { label: 'Under £15', maxMinor: 1500 },
  { label: 'Under £30', maxMinor: 3000 },
  { label: 'Under £50', maxMinor: 5000 },
  { label: '£50+', maxMinor: 10000 },
];

const TRAVEL_BANDS = [
  { label: 'Nearby', meters: 4800 },
  { label: 'Up to 10mi', meters: 16000 },
  { label: 'Up to 25mi', meters: 40000 },
  { label: 'Up to 50mi', meters: 80000 },
  { label: 'Worth travelling for', meters: 160000 },
];

const ENERGY_BANDS: { label: string; value: 'LOW' | 'MEDIUM' | 'HIGH' }[] = [
  { label: 'Low-key', value: 'LOW' },
  { label: 'Balanced', value: 'MEDIUM' },
  { label: 'Full send', value: 'HIGH' },
];

function closestBand<T extends { [k: string]: unknown }>(bands: T[], key: keyof T, value: number): T {
  return bands.reduce((best, band) => (Math.abs((band[key] as number) - value) < Math.abs((best[key] as number) - value) ? band : best));
}

function Segmented<T extends string>({ options, value, onChange, disabled }: { options: { label: string; value: T }[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className="v2-tap-feedback"
            style={{
              padding: '9px 14px',
              borderRadius: 100,
              border: 'none',
              cursor: disabled ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: 700,
              background: active ? 'var(--v2-brand)' : 'var(--v2-bg-deep)',
              color: active ? '#fff' : 'var(--v2-ink-muted)',
              transition: 'background 0.15s ease, color 0.15s ease',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

type DangerAction = 'deactivate' | 'delete' | null;

/**
 * Profile — Plot's real identity surface, not a settings form. A person's identity (photo/
 * character, name, location), what Plot actually knows about them (the exact levers that shape
 * discovery — interests, budget, travel, energy — editable in place, not linked out to the
 * onboarding wizard), and their real social context (Crews, what's next) in one place. See
 * docs/DECISIONS.md#plot-profile.
 */
export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [crews, setCrews] = useState<CrewSummary[] | null>(null);
  const [nextPlan, setNextPlan] = useState<UpcomingPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dangerAction, setDangerAction] = useState<DangerAction>(null);
  const [busy, setBusy] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);

  // Local, editable mirror of taste — starts from the server value and diverges as the person
  // taps a pill/chip; each change saves immediately (see saveTaste), so this is never "unsaved
  // form state" waiting on a Save button.
  const [interests, setInterests] = useState<string[]>([]);
  const [budgetMaxMinor, setBudgetMaxMinor] = useState(3000);
  const [travelRadiusMeters, setTravelRadiusMeters] = useState(16000);
  const [energy, setEnergy] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    api
      .get<{ user: ProfileUser }>('/users/me')
      .then((res) => {
        setUser(res.user);
        setNameDraft(res.user.displayName ?? '');
        if (res.user.tasteProfile) {
          setInterests(Object.entries(res.user.tasteProfile.categoryAffinity).filter(([, v]) => v > 0.3).map(([k]) => k));
          setBudgetMaxMinor(res.user.tasteProfile.budgetMaxMinor);
          setTravelRadiusMeters(res.user.tasteProfile.travelRadiusMeters);
          setEnergy(res.user.tasteProfile.energyPreference);
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/auth?next=/profile');
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not load your profile.');
      });
    api.get<{ crews: CrewSummary[] }>('/crews').then((res) => setCrews(res.crews)).catch(() => setCrews([]));
    api
      .get<{ plans: UpcomingPlan[] }>('/plans/upcoming')
      .then((res) => setNextPlan(res.plans[0] ?? null))
      .catch(() => {});
  }, [router]);

  async function saveTaste(next: { interests?: string[]; budgetMaxMinor?: number; travelRadiusMeters?: number; energy?: 'LOW' | 'MEDIUM' | 'HIGH' }) {
    const nextInterests = next.interests ?? interests;
    const nextBudget = next.budgetMaxMinor ?? budgetMaxMinor;
    const nextTravel = next.travelRadiusMeters ?? travelRadiusMeters;
    const nextEnergy = next.energy ?? energy;
    try {
      await api.post('/users/me/taste', {
        swipes: (nextInterests.length ? nextInterests : ['live_music']).map((category) => ({ category, choice: 'yes' as const })),
        budget: { minMinor: 0, maxMinor: nextBudget, currency: 'GBP' },
        travelRadiusMeters: nextTravel,
        energyPreference: nextEnergy,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1400);
    } catch {
      setError('Could not save that change — try again.');
    }
  }

  function toggleInterest(slug: string) {
    const next = interests.includes(slug) ? interests.filter((i) => i !== slug) : [...interests, slug];
    setInterests(next);
    saveTaste({ interests: next });
  }

  async function saveName() {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === user?.displayName) return;
    try {
      await api.post('/users/me/profile', { displayName: trimmed });
      setUser((prev) => (prev ? { ...prev, displayName: trimmed } : prev));
    } catch {
      setError('Could not save your name — try again.');
    }
  }

  async function saveLocation(place: UkPlaceResult) {
    try {
      await api.post('/users/me/profile', { homeCity: place.name, homeLat: place.lat, homeLng: place.lng });
      setUser((prev) => (prev ? { ...prev, profile: { ...prev.profile, homeCity: place.name, homeLat: place.lat, homeLng: place.lng } } : prev));
      setLocationOpen(false);
    } catch {
      setError('Could not save your area — try again.');
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await api.post('/auth/logout');
    } catch {
      // Sign-out should never leave someone stuck — even if this fails, still send them to
      // /auth; the session cookie is httpOnly so there's nothing else to clean up client-side.
    }
    router.push('/auth');
  }

  async function confirmDanger() {
    if (!dangerAction) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(dangerAction === 'deactivate' ? '/users/me/deactivate' : '/users/me/delete');
      router.push('/auth');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
      setDangerAction(null);
    }
  }

  if (!user) {
    return (
      <div className="v2">
        <div className="v2-page v2-page-wide" style={{ paddingTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error ? <div style={{ color: 'var(--v2-error)' }}>{error}</div> : <div className="v2-skeleton" style={{ height: 120, borderRadius: 'var(--v2-r-lg)' }} />}
        </div>
      </div>
    );
  }

  const memberSince = new Date(user.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const activeBudget = closestBand(BUDGET_BANDS, 'maxMinor', budgetMaxMinor);
  const activeTravel = closestBand(TRAVEL_BANDS, 'meters', travelRadiusMeters);

  return (
    <div className="v2">
      <div className="v2-shell-desktop">
        <div className="v2-page v2-page-wide" style={{ paddingTop: 28 }}>
          {/* Identity header — the biggest, most personal thing on the page, not a 56px icon
              beside a form field. Tap the photo to open the real identity picker, tap the name
              to edit it in place, tap the area to change it — direct manipulation throughout,
              no "Edit profile" form to navigate into. */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 28 }}>
            <MediaUploadButton
              uploadPath="/users/me/avatar"
              deletePath="/users/me/avatar"
              size={92}
              presetKind="avatar"
              value={user.avatarUrl}
              name={user.displayName ?? undefined}
              email={user.email}
              onChange={(url) => setUser((prev) => (prev ? { ...prev, avatarUrl: url } : prev))}
            >
              <PersonAvatar name={user.displayName} email={user.email} photoUrl={user.avatarUrl} size={92} />
            </MediaUploadButton>

            <div style={{ marginTop: 14 }}>
              {editingName ? (
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  maxLength={80}
                  style={{
                    fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 24, textAlign: 'center',
                    border: 'none', outline: 'none', borderBottom: '2px solid var(--v2-brand)', background: 'none', color: 'var(--v2-ink)', width: 220,
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  className="v2-tap-feedback"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                >
                  <h1 className="v2-display" style={{ fontSize: 24 }}>{user.displayName || 'Add your name'}</h1>
                </button>
              )}
            </div>
            <div className="v2-muted" style={{ fontSize: 13, marginTop: 2 }}>{user.email}</div>
            <button type="button" onClick={() => setLocationOpen(true)} className="v2-tap-feedback" style={{ border: 'none', background: 'var(--v2-bg-deep)', borderRadius: 100, padding: '5px 12px', marginTop: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--v2-ink-muted)' }}>
              {user.profile?.homeCity ?? 'Set your area'}
            </button>
            <div className="v2-dim" style={{ fontSize: 11.5, marginTop: 6 }}>Member since {memberSince}</div>
          </div>

          {error && <div style={{ color: 'var(--v2-error)', fontSize: 13, marginBottom: 16, textAlign: 'center' }}>{error}</div>}

          {/* My Crews — real social context, not another card of stats. */}
          {crews && crews.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 10 }}>My Crews</div>
              <div style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 4 }}>
                {crews.map((crew) => (
                  <Link key={crew.id} href={`/crews/${crew.id}`} className="v2-tap-feedback" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0, width: 66 }}>
                    <CrewMark name={crew.name} imageUrl={crew.imageUrl} size={56} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--v2-ink)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>{crew.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Next up — the nearest real, locked thing, so Profile isn't a dead end away from the
              rest of Plot. */}
          {nextPlan && (
            <div style={{ marginBottom: 22 }}>
              <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Next up</div>
              <Link href={`/plans/${nextPlan.publicSlug}`} className="v2-card v2-tap-feedback" style={{ display: 'flex', gap: 12, padding: 10, alignItems: 'center' }}>
                <div style={{ flexShrink: 0, width: 52, height: 52, borderRadius: 12, background: v2Art(nextPlan.imageUrl, nextPlan.category) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="v2-display" style={{ fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nextPlan.title}</div>
                  <div className="v2-muted" style={{ fontSize: 12 }}>{nextPlan.crew.name}{nextPlan.venueName && ` · ${nextPlan.venueName}`}{formatPriceFrom(nextPlan.priceMinMinor, nextPlan.currency) && ` · ${formatPriceFrom(nextPlan.priceMinMinor, nextPlan.currency)}`}</div>
                </div>
              </Link>
            </div>
          )}

          {/* What Plot knows about you — the actual levers behind discovery, editable directly,
              not "go re-do the onboarding wizard." Every change here saves immediately. */}
          <div className="v2-card" style={{ padding: '18px 20px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <div className="v2-eyebrow">Your vibe</div>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--v2-brand)', opacity: savedFlash ? 1 : 0, transition: 'opacity 0.3s ease' }}>Saved</span>
            </div>
            <p className="v2-muted" style={{ fontSize: 12.5, margin: '2px 0 12px' }}>What Plot uses to find things for you.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {INTERESTS.map((label) => {
                const slug = interestSlug(label);
                const selected = interests.includes(slug);
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => toggleInterest(slug)}
                    className="v2-tap-feedback"
                    style={{
                      padding: '9px 14px', borderRadius: 100, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                      background: selected ? 'var(--v2-brand)' : 'var(--v2-bg-deep)', color: selected ? '#fff' : 'var(--v2-ink-muted)',
                      transition: 'background 0.15s ease, color 0.15s ease',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div style={{ height: 1, background: 'var(--v2-line)', margin: '18px 0 14px' }} />
            <div className="v2-eyebrow" style={{ marginBottom: 8 }}>Budget</div>
            <Segmented options={BUDGET_BANDS.map((b) => ({ label: b.label, value: String(b.maxMinor) }))} value={String(activeBudget.maxMinor)} onChange={(v) => { const n = Number(v); setBudgetMaxMinor(n); saveTaste({ budgetMaxMinor: n }); }} />

            <div style={{ height: 1, background: 'var(--v2-line)', margin: '16px 0 14px' }} />
            <div className="v2-eyebrow" style={{ marginBottom: 8 }}>How far you&rsquo;ll travel</div>
            <Segmented options={TRAVEL_BANDS.map((b) => ({ label: b.label, value: String(b.meters) }))} value={String(activeTravel.meters)} onChange={(v) => { const n = Number(v); setTravelRadiusMeters(n); saveTaste({ travelRadiusMeters: n }); }} />

            <div style={{ height: 1, background: 'var(--v2-line)', margin: '16px 0 14px' }} />
            <div className="v2-eyebrow" style={{ marginBottom: 8 }}>Energy</div>
            <Segmented options={ENERGY_BANDS} value={energy} onChange={(v) => { setEnergy(v); saveTaste({ energy: v }); }} />
          </div>

          <div className="v2-card" style={{ padding: '8px 20px', marginBottom: 14 }}>
            <button
              onClick={signOut}
              disabled={busy}
              style={{ width: '100%', padding: '14px 0', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 14.5, fontWeight: 700, color: 'var(--v2-ink)' }}
            >
              Sign out
            </button>
          </div>

          <div className="v2-card" style={{ padding: '18px 20px' }}>
            <div className="v2-eyebrow" style={{ marginBottom: 10 }}>Danger zone</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={() => setDangerAction('deactivate')}
                disabled={busy}
                style={{ padding: '12px 16px', borderRadius: 100, border: 'none', background: 'var(--v2-bg-deep)', color: 'var(--v2-error)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}
              >
                Deactivate account
              </button>
              <button
                onClick={() => setDangerAction('delete')}
                disabled={busy}
                style={{ padding: '12px 16px', borderRadius: 100, border: 'none', background: 'var(--v2-bg-deep)', color: 'var(--v2-error)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}
              >
                Delete account
              </button>
            </div>
            <p className="v2-dim" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
              Deactivating signs you out everywhere and hides you from your Crews — you can come back later. Deleting
              removes your personal details for good.
            </p>
          </div>
        </div>
      </div>

      <BottomSheet open={locationOpen} onClose={() => setLocationOpen(false)}>
        <div className="v2-eyebrow" style={{ marginBottom: 4 }}>Your area</div>
        <h2 className="v2-display" style={{ fontSize: 19, marginBottom: 14 }}>Where are you based?</h2>
        <LocationSearch placeholder="Stafford" initialValue={user.profile?.homeCity ?? ''} onSelect={saveLocation} />
      </BottomSheet>

      <BottomSheet open={dangerAction !== null} onClose={() => !busy && setDangerAction(null)}>
        {dangerAction && (
          <div>
            <div className="v2-eyebrow" style={{ marginBottom: 4 }}>{dangerAction === 'deactivate' ? 'Deactivate account?' : 'Delete account?'}</div>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: '8px 0 16px' }}>
              {dangerAction === 'deactivate'
                ? 'You’ll be signed out on every device and your Crews will stop seeing you as active. You can sign back in any time to reactivate.'
                : 'This permanently removes your name, email and taste profile from Plot. Your Crews and past Plans stay intact for everyone else, but you won’t be identifiable in them any more. This can’t be undone.'}
            </p>
            <button className="v2-btn v2-btn-brand" style={{ width: '100%' }} onClick={confirmDanger} disabled={busy}>
              {busy ? 'Working…' : dangerAction === 'deactivate' ? 'Yes, deactivate' : 'Yes, delete my account'}
            </button>
            <button className="v2-btn v2-btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setDangerAction(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        )}
      </BottomSheet>

      <TabBarV2 />
    </div>
  );
}
