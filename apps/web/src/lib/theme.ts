/**
 * Dark mode preference — three real states, not a boolean: an explicit choice (`light`/`dark`,
 * persisted so it survives a reload) or `system` (no explicit choice — just follow the OS/browser
 * setting live, the default for anyone who's never touched the toggle). This mirrors exactly what
 * globals.css's own dark-mode block expects: no `data-theme` attribute at all means "system",
 * `data-theme="light"`/`"dark"` means an explicit override that wins regardless of the OS setting.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'plot-theme';

/** Reads the stored explicit preference, if any — `system` (not an error) for "none set yet" or
 *  for any environment where localStorage genuinely isn't available (SSR, a locked-down browser
 *  context). Never throws: a person's stored theme choice is a nice-to-have, not something worth
 *  crashing the page over if it can't be read. */
export function getStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage blocked (e.g. some older private-browsing modes) — fall through to 'system'.
  }
  return 'system';
}

/** Applies a theme preference immediately (sets/clears `data-theme` on <html>, the same
 *  attribute the anti-flash script in layout.tsx sets before first paint) and persists it for
 *  next time. `system` explicitly REMOVES both the attribute and the stored value, rather than
 *  writing the string 'system' — matching the CSS's own contract of "no attribute = follow the
 *  OS setting live", which persisting a literal value could never do (a stored 'system' would
 *  need the CSS to check it explicitly, and would go stale the moment the OS setting changed
 *  without the page open to notice). */
export function applyThemePreference(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  if (pref === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', pref);
  }
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Persistence failed — the attribute above is still applied for this page load, so the
    // toggle isn't a dead control, it just won't survive a reload in this one environment.
  }
}
