/**
 * Dark mode preference — an explicit choice only, `light` or `dark`, always persisted once made.
 *
 * Real, explicit product decision, not an oversight: this used to have a third `system` state
 * that silently followed the OS/browser's live `prefers-color-scheme` the moment nobody had ever
 * touched the toggle — meaning anyone whose phone or laptop happened to be in dark mode got Plot
 * in dark mode on first visit, unasked. Reported directly: "NEVER AUTO SWITCH TO DARK MODE, I
 * want light mode to be default ALWAYS." There is no more silent default to auto-switch into —
 * `light` is the one and only default for anyone who hasn't explicitly chosen `dark`, full stop,
 * regardless of what their OS is set to. Dark stays available, but only ever by a real, explicit
 * tap on the toggle — never inferred.
 */
export type ThemePreference = 'light' | 'dark';

const STORAGE_KEY = 'plot-theme';

/** Reads the stored explicit preference — `light` (not an error) for "none set yet" or for any
 *  environment where localStorage genuinely isn't available (SSR, a locked-down browser
 *  context). Never throws: a person's stored theme choice is a nice-to-have, not something worth
 *  crashing the page over if it can't be read. */
export function getStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark') return 'dark';
  } catch {
    // localStorage blocked (e.g. some older private-browsing modes) — fall through to 'light'.
  }
  return 'light';
}

/** Applies a theme preference immediately (sets `data-theme` on <html>, the same attribute the
 *  anti-flash script in layout.tsx sets before first paint) and persists it for next time.
 *  `light` is written explicitly too (not just cleared) — the point of this whole file is that
 *  light is the default with or without a stored value, but writing it explicitly means a
 *  person who taps back to Light after trying Dark gets a real, intentional record of that
 *  choice rather than relying on "absence of a key" to mean the same thing. */
export function applyThemePreference(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', pref);
  // Keeps Safari's status-bar/notch colour (the `<meta name="theme-color">` tag Next's static
  // metadata renders, always the light value at build time — see layout.tsx's `viewport` export)
  // in sync with a LIVE toggle, not just the page-load case layout.tsx's own init script handles.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', pref === 'dark' ? '#131316' : '#f6f6f4');
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Persistence failed — the attribute above is still applied for this page load, so the
    // toggle isn't a dead control, it just won't survive a reload in this one environment.
  }
}
