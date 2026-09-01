/**
 * Plot's identity-colour system — the fix for the app's single biggest "generic web app" tell:
 * every person AND every Crew rendered as a flat single-hue circle + one initial, five separate
 * near-identical implementations of the same thing (Home, Crews, Crew chat, Profile, invite
 * preview each had their own copy-pasted `AVATAR_COLORS` array). One shared system instead.
 *
 * A curated set of tonal duotone pairs — each a single hue moving from a deep, near-black shade
 * to a mid-tone, not a multi-hue blend — deliberately avoids the "neon gradient blob" AI-startup
 * look the brief warned against. These read as pigment (rust, plum, ink-teal, ochre), not glow.
 * Deterministic: the same name/id always resolves to the same pair, so a person's avatar and a
 * Crew's mark stay stable across the whole app and across sessions — see
 * docs/DECISIONS.md#plot-brand-system.
 */
const IDENTITY_PALETTE: [string, string][] = [
  ['#7a2e18', '#c2532b'], // rust
  ['#3b1f3d', '#7d4379'], // plum
  ['#0f2f2c', '#276b60'], // ink-teal
  ['#4a2f0a', '#966123'], // ochre
  ['#3d1226', '#8a2650'], // berry
  ['#1f2e17', '#4c6e33'], // moss
  ['#16233f', '#33528a'], // slate-blue
  ['#431c14', '#9c4f38'], // clay
];

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash;
}

export function identityPair(seed: string): [string, string] {
  const idx = hashSeed(seed || 'plot') % IDENTITY_PALETTE.length;
  return IDENTITY_PALETTE[idx];
}

export function identityGradient(seed: string, angle = 135): string {
  const [from, to] = identityPair(seed);
  return `linear-gradient(${angle}deg, ${from}, ${to})`;
}

/** Shared everywhere a person's initial(s) are shown — one rule instead of five near-copies. */
export function initialsOf(displayName: string | null | undefined, email: string): string {
  const source = displayName?.trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

/** Crew initials read better as a single strong letter — "Weekend Crew" -> "W", not "WE". */
export function crewInitial(name: string): string {
  return (name.trim()[0] ?? 'P').toUpperCase();
}
