'use client';

import { useEffect, useState } from 'react';
import { getStoredThemePreference, applyThemePreference, type ThemePreference } from '@/lib/theme';

const OPTIONS: { label: string; value: ThemePreference }[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'system' },
];

/**
 * The real toggle for the "same app, same brand system, dark mode" feature — three explicit
 * states (Light/Dark/System), not a single on/off switch, so someone who wants to just follow
 * their OS's own day/night schedule isn't forced to pick a side. Reads its initial state from
 * localStorage on mount rather than assuming 'system' — the anti-flash script in layout.tsx
 * already applied the real theme to the DOM before this component ever renders; this just needs
 * to reflect that back into the toggle's own UI state so it doesn't show the wrong option
 * selected for one frame.
 */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>('system');
  useEffect(() => {
    setPref(getStoredThemePreference());
  }, []);

  function choose(next: ThemePreference) {
    setPref(next);
    applyThemePreference(next);
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {OPTIONS.map((opt) => {
        const active = opt.value === pref;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => choose(opt.value)}
            className="v2-tap-feedback"
            style={{
              padding: '9px 14px',
              borderRadius: 100,
              border: 'none',
              cursor: 'pointer',
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
