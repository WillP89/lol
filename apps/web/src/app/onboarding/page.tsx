'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { LocationSearch, type UkPlaceResult } from '@/components/LocationSearch';

const INTERESTS = [
  'Live music', 'Food', 'Pubs & drinks', 'Comedy', 'Sport', 'Festivals',
  'Cinema', 'Theatre', 'Days out', 'Family', 'Outdoors', 'Markets', 'Something different',
];

interface ExistingProfile {
  displayName: string | null;
  tasteProfile: { categoryAffinity: Record<string, number> } | null;
  profile: { homeCity: string | null; homeLat: number | null; homeLng: number | null } | null;
}

/**
 * Onboarding V2 — three real questions (name, where you're based, what you're into), not a
 * profile form. "Where are you based?" replaced the old hardcoded London-neighbourhood chip
 * picker entirely — see docs/DECISIONS.md#uk-wide-location. Interests are a simple tap-to-
 * include chip set, not a yes/maybe/no swipe deck — see docs/DECISIONS.md#v2-art-direction for
 * why the whole wizard reads as "setting up a social app," not a form with a progress bar.
 */
function OnboardingWizard() {
  const router = useRouter();
  const next = useSearchParams().get('next');

  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState(0);

  const [name, setName] = useState('');
  const [place, setPlace] = useState<UkPlaceResult | null>(null);
  const [interests, setInterests] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<{ user: ExistingProfile }>('/users/me')
      .then((res) => {
        if (res.user.displayName) setName(res.user.displayName);
        if (res.user.profile?.homeCity) {
          setPlace({ name: res.user.profile.homeCity, region: '', lat: res.user.profile.homeLat ?? 0, lng: res.user.profile.homeLng ?? 0 });
          setEditing(true);
        }
        if (res.user.tasteProfile) {
          const picked = Object.entries(res.user.tasteProfile.categoryAffinity)
            .filter(([, v]) => v > 0)
            .map(([k]) => k);
          if (picked.length) setInterests(picked);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  function toggleInterest(slug: string) {
    setInterests((prev) => (prev.includes(slug) ? prev.filter((i) => i !== slug) : [...prev, slug]));
  }

  async function finish() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/users/me/profile', {
        displayName: name.trim(),
        ...(place ? { homeCity: place.name, homeLat: place.lat, homeLng: place.lng } : {}),
      });
      await api.post('/users/me/taste', {
        swipes: (interests.length ? interests : ['live_music']).map((category) => ({ category: category.toLowerCase().replace(/[^a-z]+/g, '_'), choice: 'yes' as const })),
        budget: { minMinor: 1500, maxMinor: 6000, currency: 'GBP' },
        travelRadiusMeters: 24000, // ~15 miles — a real "worth travelling for" radius, not a dense-city-block assumption
        energyPreference: 'MEDIUM' as const,
      });
      router.replace(next || '/home');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="v2">
        <div className="v2-page" style={{ paddingTop: 40 }}>
          <div style={{ height: 90, borderRadius: 20, background: 'var(--v2-bg-deep)' }} />
        </div>
      </div>
    );
  }

  const steps = editing ? [0, 1, 2] : [0, 1, 2]; // Name, Location, Interests
  const canAdvance = step === 0 ? name.trim().length > 0 : step === 1 ? place !== null : true;

  return (
    <div className="v2" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div className="v2-page" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 28 }}>
          {steps.map((s) => (
            <div key={s} style={{ flex: 1, height: 3.5, borderRadius: 3, background: s <= step ? 'var(--v2-brand)' : 'var(--v2-bg-deep)' }} />
          ))}
        </div>

        {/* One shared stacking context for the whole step (content + Continue/Back), keyed by
            step so the fade replays on every transition — deliberately NOT one .fade-up per
            step-content block with the buttons as a separate later sibling: a `.fade-up`'s
            `transform: translateY(0)` end-state creates its own stacking context, which would
            trap LocationSearch's dropdown z-index inside it and let the Continue button (a
            later, unrelated sibling) paint on top and steal its clicks. */}
        <div className="fade-up" key={step}>
        {step === 0 && (
          <input
              autoFocus
              style={{ width: '100%', padding: '15px 18px', borderRadius: 16, border: 'none', outline: 'none', background: 'var(--v2-surface)', boxShadow: 'var(--v2-shadow-sm)', fontSize: 15.5, fontFamily: 'inherit', color: 'var(--v2-ink)', marginBottom: 22 }}
              placeholder="Will"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
        )}

        {step === 1 && (
          <>
            <h1 className="v2-display" style={{ fontSize: 27, marginBottom: 8 }}>Where are you based?</h1>
            <p className="v2-muted" style={{ marginBottom: 22 }}>Not just a city — this shapes what Plot finds for you. Works anywhere in the UK.</p>
            <LocationSearch placeholder="Stafford" initialValue={place?.name ?? ''} onSelect={setPlace} />
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="v2-display" style={{ fontSize: 27, marginBottom: 8 }}>What are you into?</h1>
            <p className="v2-muted" style={{ marginBottom: 22 }}>Pick a few — you can change these anytime.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {INTERESTS.map((label) => {
                const slug = label.toLowerCase().replace(/[^a-z]+/g, '_');
                const selected = interests.includes(slug);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleInterest(slug)}
                    style={{
                      padding: '10px 16px', borderRadius: 100, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 700,
                      background: selected ? 'var(--v2-brand)' : 'var(--v2-surface)',
                      color: selected ? '#fff' : 'var(--v2-ink-muted)',
                      boxShadow: selected ? 'none' : 'var(--v2-shadow-sm)',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {error && <div style={{ color: 'var(--v2-brand)', fontSize: 13, marginTop: 16 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 26 }}>
          {step > 0 && (
            <button className="v2-btn v2-btn-ghost" onClick={() => setStep((s) => s - 1)} style={{ flex: '0 0 auto', padding: '15px 20px' }}>
              ← Back
            </button>
          )}
          {step < 2 ? (
            <button className="v2-btn v2-btn-brand" disabled={!canAdvance} onClick={() => setStep((s) => s + 1)} style={{ flex: 1, padding: '15px 20px' }}>
              Continue
            </button>
          ) : (
            <button className="v2-btn v2-btn-brand" disabled={submitting} onClick={finish} style={{ flex: 1, padding: '15px 20px' }}>
              {submitting ? 'Setting up…' : editing ? 'Save' : "Let's go"}
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="v2" style={{ minHeight: '100vh' }} />}>
      <OnboardingWizard />
    </Suspense>
  );
}
