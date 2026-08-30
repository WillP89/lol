'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

const CATEGORIES = ['live_music', 'clubbing', 'restaurant', 'comedy', 'art_culture', 'sport', 'day_activity'];
const AREAS = ['Shoreditch', 'Soho', 'Clapham', 'Brixton', 'Camden', 'Hackney'];

interface ExistingProfile {
  tasteProfile: {
    categoryAffinity: Record<string, number>;
    budgetMaxMinor: number;
    energyPreference: 'LOW' | 'MEDIUM' | 'HIGH';
  } | null;
  locationPrefs: { kind: string; label: string }[];
}

function OnboardingWizard() {
  const router = useRouter();
  // Carries an invite (or anywhere else that required a profile first) through onboarding —
  // finishing lands you back on the invite instead of the generic Crews list.
  const next = useSearchParams().get('next');

  // Whether an existing profile has loaded yet, and whether this is a first-time run (fresh
  // wizard) or a returning user editing in place (pre-filled, `editing: true`, "Save" instead
  // of "This is scarily accurate", returns to /profile instead of /crews when done).
  const [loaded, setLoaded] = useState(false);
  const [existing, setExisting] = useState<ExistingProfile | null>(null);
  const [editing, setEditing] = useState(false);

  const [step, setStep] = useState(0);
  const [homeArea, setHomeArea] = useState('Clapham');
  const [favAreas, setFavAreas] = useState<string[]>(['Shoreditch']);
  const [taste, setTaste] = useState<Record<string, 'yes' | 'maybe' | 'no'>>({});
  const [budgetMax, setBudgetMax] = useState(6000);
  const [energy, setEnergy] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<{ user: ExistingProfile }>('/users/me')
      .then((res) => {
        setExisting(res.user);
        if (res.user.tasteProfile) {
          // Pre-fill the wizard with what's already there, so Edit is a tweak, not a restart.
          const home = res.user.locationPrefs.find((p) => p.kind === 'HOME');
          const favs = res.user.locationPrefs.filter((p) => p.kind === 'FAVOURITE').map((p) => p.label);
          if (home) setHomeArea(home.label);
          if (favs.length) setFavAreas(favs);
          const affinityToChoice = (v: number): 'yes' | 'maybe' | 'no' => (v > 0.3 ? 'yes' : v < -0.3 ? 'no' : 'maybe');
          const tasteFromAffinity = Object.fromEntries(
            Object.entries(res.user.tasteProfile.categoryAffinity).map(([k, v]) => [k, affinityToChoice(v)]),
          );
          setTaste(tasteFromAffinity);
          setBudgetMax(res.user.tasteProfile.budgetMaxMinor);
          setEnergy(res.user.tasteProfile.energyPreference);
          // Returning user — /profile is the real "here's what Plot knows about you" surface
          // now, so this page's only job is the editable wizard, pre-filled, not a second
          // read-only summary duplicating it.
          setEditing(true);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  function toggleFavArea(area: string) {
    setFavAreas((prev) => (prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]));
  }

  async function finish() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/users/me/locations', {
        prefs: [
          { kind: 'HOME', label: homeArea },
          ...favAreas.map((label) => ({ kind: 'FAVOURITE' as const, label })),
        ],
      });
      const swipes = Object.entries(taste).map(([category, choice]) => ({ category, choice }));
      await api.post('/users/me/taste', {
        swipes: swipes.length ? swipes : [{ category: 'live_music', choice: 'maybe' }],
        budget: { minMinor: 1500, maxMinor: budgetMax, currency: 'GBP' },
        travelRadiusMeters: 8000,
        energyPreference: energy,
      });
      if (existing?.tasteProfile) {
        // Editing an existing profile — /profile is where "here's what Plot knows about you"
        // actually lives now, so saving returns there instead of leaving you stranded mid-wizard.
        router.replace(next || '/profile');
      } else {
        router.replace(next || '/home');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="page" style={{ paddingTop: 40, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card" style={{ height: 90, opacity: 0.5 }} />
        <div className="card" style={{ height: 60, opacity: 0.5 }} />
      </div>
    );
  }

  return (
    <div className="page" style={{ paddingTop: 40 }}>
      {editing ? (
        <button className="btn btn-ghost" onClick={() => router.push('/profile')} style={{ marginBottom: 14, width: 'auto', padding: '8px 0' }}>
          ← Back to profile
        </button>
      ) : (
        <>
          <div className="eyebrow">Step {step + 1} of 3</div>
          <div style={{ display: 'flex', gap: 5, marginBottom: 20 }}>
            {[0, 1, 2].map((s) => (
              <div key={s} style={{ flex: 1, height: 3, borderRadius: 3, background: s <= step ? 'var(--ink-gold)' : 'var(--ink-border)' }} />
            ))}
          </div>
        </>
      )}

      {step === 0 && (
        <>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>Where do you spend your time?</h1>
          <p className="muted" style={{ marginBottom: 16 }}>Not just a city — this shapes everything we suggest.</p>
          <div style={{ fontSize: 11, color: 'var(--ink-text-dim)', textTransform: 'uppercase', marginBottom: 8 }}>Home area</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {AREAS.map((a) => (
              <button key={a} type="button" className={`chip ${homeArea === a ? 'selected' : ''}`} onClick={() => setHomeArea(a)}>
                {a}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-text-dim)', textTransform: 'uppercase', marginBottom: 8 }}>Favourite areas</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
            {AREAS.map((a) => (
              <button key={a} type="button" className={`chip ${favAreas.includes(a) ? 'selected' : ''}`} onClick={() => toggleFavArea(a)}>
                {a}
              </button>
            ))}
          </div>
          {editing ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={finish} disabled={submitting}>
                {submitting ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-primary" onClick={() => setStep(1)} style={{ flex: 1 }}>
                Continue
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => setStep(1)}>
              Continue
            </button>
          )}
        </>
      )}

      {step === 1 && (
        <>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>Build your taste</h1>
          <p className="muted" style={{ marginBottom: 16 }}>React fast — first instinct.</p>
          {CATEGORIES.map((cat) => (
            <div key={cat} className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12 }}>
              <span style={{ textTransform: 'capitalize' }}>{cat.replace('_', ' ')}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['no', 'maybe', 'yes'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className={`chip ${taste[cat] === choice ? 'selected' : ''}`}
                    onClick={() => setTaste((prev) => ({ ...prev, [cat]: choice }))}
                    style={{ padding: '6px 10px' }}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11, color: 'var(--ink-text-dim)', textTransform: 'uppercase', margin: '18px 0 8px' }}>Usual energy</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            {(['LOW', 'MEDIUM', 'HIGH'] as const).map((e) => (
              <button key={e} type="button" className={`chip ${energy === e ? 'selected' : ''}`} onClick={() => setEnergy(e)}>
                {e}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setStep(0)}>
              ← Back
            </button>
            <button className="btn btn-primary" onClick={() => setStep(2)} style={{ flex: 1 }}>
              Continue
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>Budget sweet spot</h1>
          <p className="muted" style={{ marginBottom: 16 }}>Per event, roughly. £{(budgetMax / 100).toFixed(0)} max.</p>
          <input
            type="range"
            min={1500}
            max={15000}
            step={500}
            value={budgetMax}
            onChange={(e) => setBudgetMax(Number(e.target.value))}
            style={{ width: '100%', marginBottom: 24 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button className="btn btn-primary" onClick={finish} disabled={submitting} style={{ flex: 1 }}>
              {submitting ? (editing ? 'Saving…' : 'Building your Plot…') : editing ? 'Save' : 'This is scarily accurate'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="page" style={{ paddingTop: 40 }}><p className="muted">Loading…</p></div>}>
      <OnboardingWizard />
    </Suspense>
  );
}
