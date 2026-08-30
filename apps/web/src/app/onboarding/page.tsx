'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

const CATEGORIES = ['live_music', 'clubbing', 'restaurant', 'comedy', 'art_culture', 'sport', 'day_activity'];
const AREAS = ['Shoreditch', 'Soho', 'Clapham', 'Brixton', 'Camden', 'Hackney'];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [homeArea, setHomeArea] = useState('Clapham');
  const [favAreas, setFavAreas] = useState<string[]>(['Shoreditch']);
  const [taste, setTaste] = useState<Record<string, 'yes' | 'maybe' | 'no'>>({});
  const [budgetMax, setBudgetMax] = useState(6000);
  const [energy, setEnergy] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      router.replace('/crews');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: 40 }}>
      <div className="eyebrow">
        Step {step + 1} of 3
      </div>

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
          <button className="btn btn-primary" onClick={() => setStep(1)}>
            Continue
          </button>
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
          <button className="btn btn-primary" onClick={() => setStep(2)}>
            Continue
          </button>
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
          <button className="btn btn-primary" onClick={finish} disabled={submitting}>
            {submitting ? 'Building your Plot…' : "This is scarily accurate"}
          </button>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}
