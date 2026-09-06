'use client';

/**
 * A small, real distance vocabulary ("Nearby", "Up to 10mi", "Worth travelling for") rather than
 * a raw slider/number input — the same bands Profile's own travel-radius picker has always used.
 * Pulled out here (rather than kept private to profile/page.tsx) so the New Crew flow's own
 * location step (apps/web/src/app/crews/page.tsx) can offer the exact same real distances a
 * person already tunes for themselves, instead of a second, drifting set of numbers.
 */
export const TRAVEL_BANDS = [
  { label: 'Nearby', meters: 4800 },
  { label: 'Up to 10mi', meters: 16000 },
  { label: 'Up to 25mi', meters: 40000 },
  { label: 'Up to 50mi', meters: 80000 },
  { label: 'Worth travelling for', meters: 160000 },
];

export function closestBand<T extends { [k: string]: unknown }>(bands: T[], key: keyof T, value: number): T {
  return bands.reduce((best, band) => (Math.abs((band[key] as number) - value) < Math.abs((best[key] as number) - value) ? band : best));
}

/** A row of tap-to-select pills — one active at a time. Used for travel radius, budget, and
 *  energy bands across Profile and the New Crew flow. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
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
              color: active ? 'var(--v2-brand-ink)' : 'var(--v2-ink-muted)',
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
