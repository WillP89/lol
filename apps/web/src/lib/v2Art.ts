/**
 * The image treatment for an experience/plan tile. Image pipeline is sound end to end — every
 * live-provider adapter maps a real `imageUrl` through to the Experience row untouched (no
 * `select` ever excludes it, no `next/image` remotePatterns gate exists since this renders via
 * plain CSS `background-image`, not the Next image optimiser) — the ONLY reason a real photo
 * doesn't show today is that no `TICKETMASTER_API_KEY`/`EVENTBRITE_API_KEY` is configured in
 * this environment, so every experience is mock data with no real photo to show. See
 * docs/providers/ticketing.md for exactly what unblocks it.
 *
 * For that fallback case specifically: a flat duotone was reading as "unfinished," so this is a
 * real per-category editorial treatment — a distinct gradient direction/palette PER category
 * (never the same wash for a gig vs a food festival) plus a large, faint, oversized line-icon
 * watermark unique to that category, in the same stroke style as the app's own nav icons rather
 * than emoji. `imageUrl` is layered on TOP when present (`url(...) center/cover`), so a real
 * photo always fully obscures the icon+gradient beneath it — the watermark only shows for the
 * fallback case it exists for.
 */
interface CategoryArt {
  gradient: string;
  icon: string; // raw SVG markup, stroke="white", viewBox 0 0 24 24
}

const ICONS = {
  // A simple crotchet/quaver pair — reads as "music" at a glance even at low opacity.
  music: '<path d="M9 18V5l11-2v13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  // A disco ball — clubbing.
  disco: '<circle cx="12" cy="12" r="7"/><path d="M5 12h14M12 5v14M7.5 7.5l9 9M16.5 7.5l-9 9" stroke-linecap="round"/>',
  // Fork + knife — restaurant.
  dine: '<path d="M7 3v7a2 2 0 0 0 2 2v9M7 3v7M10 3v7M13 3c-1.5 3-1.5 6 0 8v9" stroke-linecap="round" stroke-linejoin="round"/>',
  // A martini glass — bar.
  drink: '<path d="M5 4h14l-7 8v8m-4 0h8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="9" r="1" fill="white" stroke="none"/>',
  // A laughing mask — comedy.
  laugh: '<circle cx="12" cy="12" r="9"/><path d="M8 10h.01M16 10h.01M8 15c1.5 2 6.5 2 8 0" stroke-linecap="round"/>',
  // A theatre curtain / masks — theatre.
  theatre: '<path d="M4 4c3 2 3 14 0 16M20 4c-3 2-3 14 0 16M9 4h6v16H9z" stroke-linecap="round" stroke-linejoin="round"/>',
  // A film strip — cinema.
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" stroke-linecap="round"/>',
  // A paint palette — art & culture.
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-.5-1.5-1-2 0-2 1-2h2a4 4 0 0 0 4-4c0-4.4-3.6-8-8-8Z"/><circle cx="8" cy="11" r="1" fill="white" stroke="none"/><circle cx="12" cy="8" r="1" fill="white" stroke="none"/><circle cx="16" cy="11" r="1" fill="white" stroke="none"/>',
  // A trophy — sport.
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4M10 15v3h4v-3M8 21h8" stroke-linecap="round"/>',
  // A dumbbell — fitness.
  dumbbell: '<path d="M4 9v6M7 6v12M17 6v12M20 9v6M7 12h10" stroke-linecap="round" stroke-linejoin="round"/>',
  // A burst of confetti/sparkle lines — festival.
  burst: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6M4.9 4.9l4.2 4.2M14.9 14.9l4.2 4.2M19.1 4.9l-4.2 4.2M9.1 14.9l-4.2 4.2" stroke-linecap="round"/>',
  // A tree + sun — outdoors/days out.
  outdoors: '<circle cx="12" cy="6" r="2.5"/><path d="M12 8.5V13m-4 8 4-6 4 6M6 21h12" stroke-linecap="round" stroke-linejoin="round"/>',
  // Two overlapping speech bubbles — community.
  people: '<path d="M8 4a5 5 0 0 0 0 10h1l3 3v-3.3A5 5 0 0 0 8 4Z" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9a5 5 0 0 1-1 9.7V22l-3-3" stroke-linecap="round" stroke-linejoin="round"/>',
  // A sparkle/star — custom/other.
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" stroke-linecap="round"/><circle cx="12" cy="12" r="3"/>',
};

/**
 * Real gap found while auditing the brand pass: these were a 3-stop pink→purple→black diagonal
 * on every category — exactly the "neon gradient blob" AI-startup look the brand brief calls
 * out by name, despite the icon watermarks themselves being genuinely purpose-drawn. Replaced
 * with the same tonal-duotone language as the identity-colour system (lib/identity.ts): one hue
 * family per category moving from a near-black shade to a mid-tone, not a multi-hue blend — the
 * difference between pigment and glow. Distinct direction/pairing per category, never the same
 * wash for a gig vs a food festival, same as before — just no longer neon.
 */
const CATEGORY_ART: Record<string, CategoryArt> = {
  LIVE_MUSIC: { gradient: 'linear-gradient(155deg, #2a1230 0%, #74335a 100%)', icon: ICONS.music },
  CLUBBING: { gradient: 'linear-gradient(155deg, #12142b 0%, #333866 100%)', icon: ICONS.disco },
  RESTAURANT: { gradient: 'linear-gradient(155deg, #331c12 0%, #8f4d2c 100%)', icon: ICONS.dine },
  BAR: { gradient: 'linear-gradient(155deg, #3a2210 0%, #99591f 100%)', icon: ICONS.drink },
  COMEDY: { gradient: 'linear-gradient(155deg, #3d2b09 0%, #ac8020 100%)', icon: ICONS.laugh },
  THEATRE: { gradient: 'linear-gradient(155deg, #300f1e 0%, #82234a 100%)', icon: ICONS.theatre },
  CINEMA: { gradient: 'linear-gradient(155deg, #131a26 0%, #375670 100%)', icon: ICONS.film },
  ART_CULTURE: { gradient: 'linear-gradient(155deg, #2c1830 0%, #6f486c 100%)', icon: ICONS.palette },
  SPORT: { gradient: 'linear-gradient(155deg, #142013 0%, #43602c 100%)', icon: ICONS.trophy },
  FITNESS: { gradient: 'linear-gradient(155deg, #0d2420 0%, #297058 100%)', icon: ICONS.dumbbell },
  FESTIVAL: { gradient: 'linear-gradient(155deg, #3a190f 0%, #a8542c 100%)', icon: ICONS.burst },
  DAY_ACTIVITY: { gradient: 'linear-gradient(155deg, #182615 0%, #4f6a33 100%)', icon: ICONS.outdoors },
  COMMUNITY: { gradient: 'linear-gradient(155deg, #17202e 0%, #425c7c 100%)', icon: ICONS.people },
  CUSTOM: { gradient: 'linear-gradient(155deg, #201822 0%, #5b4259 100%)', icon: ICONS.sparkle },
};
const DEFAULT_ART = CATEGORY_ART.LIVE_MUSIC;

function iconDataUri(svgInner: string): string {
  // Low-opacity white baked directly into the SVG (rather than a CSS `opacity` on the whole
  // background layer, which would also fade the gradient beneath it) — a faint texture, not a
  // foreground graphic competing with the title/date text over it.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.1">${svgInner}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function v2Art(imageUrl: string | null | undefined, category: string | null | undefined): string {
  const art = CATEGORY_ART[category ?? ''] ?? DEFAULT_ART;
  const iconLayer = `${iconDataUri(art.icon)} no-repeat 115% 130% / 55% auto`;
  const fallback = `${iconLayer}, ${art.gradient}`;
  return imageUrl ? `url("${imageUrl}") center / cover no-repeat, ${fallback}` : fallback;
}
