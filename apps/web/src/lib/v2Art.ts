/**
 * The image treatment for an experience/plan tile. Image pipeline is sound end to end — every
 * live-provider adapter maps a real `imageUrl` through to the Experience row untouched, so the
 * ONLY reason a real photo doesn't show is a missing image (a provider genuinely has none, or no
 * live ticketing key is configured in this environment — see docs/providers/ticketing.md).
 *
 * REAL, LIVE-REPORTED BUG this rewrite fixes ("the purple music graphic" — named directly,
 * repeatedly): the previous version was a PURE function of `category` alone — a gradient, one
 * fixed icon, one fixed layout. Every single LIVE_MUSIC card, for every different artist, on
 * every different day, rendered the exact same pixel-identical purple wash with the exact same
 * crotchet-and-quaver icon in the exact same corner. That reads as generic and cheap precisely
 * because it IS the same image, reused — the opposite of "premium editorial fallback art system
 * with personality per category." Confirmed live via a real Playwright walkthrough: three
 * different real artists (Jorja Smith, Jamie xx, Overmono) on Home's "Worth a look nearby" row
 * rendered as three literally identical tiles.
 *
 * The fix keeps the one thing that WAS working — a single tonal-duotone colour family per
 * category (lib/identity.ts's own palette language, never a neon multi-hue "AI-startup" blend)
 * and hand-drawn stroke icons in the app's own nav-icon style, never emoji or stock clipart — and
 * adds real per-ITEM variation on top of the per-category identity, so the fallback reads as a
 * small designed poster SERIES per category, not one fixed poster. Deterministic (hashed off a
 * stable per-experience seed — id, or name as a fallback — never `Math.random()`, so the same
 * event always renders the same way and doesn't flicker between re-renders), never per-category
 * alone: three composition layouts (corner-crop / centred mark / radial ring), a gradient-angle
 * variant, and — for the categories most likely to sit side by side (LIVE_MUSIC, CLUBBING,
 * SPORT, RESTAURANT, BAR) — a second icon so even the motif itself isn't always the same drawing.
 */
interface CategoryArt {
  /** [near-black, mid-tone] — the category's fixed hue identity, unchanged by which variant a
   *  given item lands on. This is the "one visual family" half of the brief's own requirement. */
  hues: [string, string];
  icons: string[]; // 1-2 raw SVG markups, stroke="white", viewBox 0 0 24 24 — hash-picked per item
}

const ICONS = {
  // A simple crotchet/quaver pair — reads as "music" at a glance even at low opacity.
  music: '<path d="M9 18V5l11-2v13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  // A handheld mic — the live-gig alternate to the crotchet/quaver pair, so a Live Music tile
  // isn't always the same drawing.
  mic: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" stroke-linecap="round" stroke-linejoin="round"/>',
  // A disco ball — clubbing.
  disco: '<circle cx="12" cy="12" r="7"/><path d="M5 12h14M12 5v14M7.5 7.5l9 9M16.5 7.5l-9 9" stroke-linecap="round"/>',
  // A turntable/vinyl record — the electronic-night alternate to the disco ball.
  vinyl: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="0.9" fill="white" stroke="none"/><path d="M12 3v3M12 18v3" stroke-linecap="round"/>',
  // Fork + knife — restaurant.
  dine: '<path d="M7 3v7a2 2 0 0 0 2 2v9M7 3v7M10 3v7M13 3c-1.5 3-1.5 6 0 8v9" stroke-linecap="round" stroke-linejoin="round"/>',
  // A noodle bowl + chopsticks — the market/street-food alternate to fork+knife.
  bowl: '<path d="M3 12h18a9 5 0 0 1-18 0Z" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 12c0-3 2-6 3-7M18 5l-2 3" stroke-linecap="round"/>',
  // A martini glass — bar.
  drink: '<path d="M5 4h14l-7 8v8m-4 0h8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="9" r="1" fill="white" stroke="none"/>',
  // A pint glass — the pub alternate to the martini glass.
  pint: '<path d="M7 3h9l-1 17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1L7 3Z" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 7h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2.5" stroke-linecap="round"/>',
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
  // A football — the fixture-day alternate to the trophy.
  ball: '<circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10l4-3Z" stroke-linejoin="round"/><path d="M12 3v4M4.5 9l3.5 1M19.5 9l-3.5 1M8 21l1.5-5M16 21l-1.5-5" stroke-linecap="round"/>',
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

const CATEGORY_ART: Record<string, CategoryArt> = {
  LIVE_MUSIC: { hues: ['#2a1230', '#74335a'], icons: [ICONS.music, ICONS.mic] },
  CLUBBING: { hues: ['#12142b', '#333866'], icons: [ICONS.disco, ICONS.vinyl] },
  RESTAURANT: { hues: ['#331c12', '#8f4d2c'], icons: [ICONS.dine, ICONS.bowl] },
  BAR: { hues: ['#3a2210', '#99591f'], icons: [ICONS.drink, ICONS.pint] },
  COMEDY: { hues: ['#3d2b09', '#ac8020'], icons: [ICONS.laugh] },
  THEATRE: { hues: ['#300f1e', '#82234a'], icons: [ICONS.theatre] },
  CINEMA: { hues: ['#131a26', '#375670'], icons: [ICONS.film] },
  ART_CULTURE: { hues: ['#2c1830', '#6f486c'], icons: [ICONS.palette] },
  SPORT: { hues: ['#142013', '#43602c'], icons: [ICONS.trophy, ICONS.ball] },
  FITNESS: { hues: ['#0d2420', '#297058'], icons: [ICONS.dumbbell] },
  FESTIVAL: { hues: ['#3a190f', '#a8542c'], icons: [ICONS.burst] },
  DAY_ACTIVITY: { hues: ['#182615', '#4f6a33'], icons: [ICONS.outdoors] },
  COMMUNITY: { hues: ['#17202e', '#425c7c'], icons: [ICONS.people] },
  CUSTOM: { hues: ['#201822', '#5b4259'], icons: [ICONS.sparkle] },
};
const DEFAULT_ART = CATEGORY_ART.LIVE_MUSIC;

// Small, deterministic string hash (FNV-1a) — same seed always produces the same variant, so an
// experience's fallback art never flickers between re-renders or differs card to card for the
// SAME item, only between DIFFERENT items. Never Math.random(): a poster that changed every time
// React re-rendered the tile would read as broken, not designed.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function pick<T>(seed: number, options: readonly T[]): T {
  return options[seed % options.length];
}

function iconDataUri(svgInner: string, opacity: number, rotate = 0): string {
  const transform = rotate ? ` style="transform:rotate(${rotate}deg)"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,${opacity})" stroke-width="1.1"${transform}>${svgInner}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function ringDataUri(opacity: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,${opacity})" stroke-width="1.4"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// A faint repeating dot grid — texture for the layout variant that wants it (corner-crop); the
// other two variants deliberately stay clean (a poster lives or dies on negative space, and three
// variants that all reach for the same "add texture" move would just be three flavours of one
// idea, not three different compositions).
const DOT_GRID = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="2" cy="2" r="1.1" fill="rgba(255,255,255,0.09)"/></svg>',
)}") repeat`;

const ANGLES = [135, 155, 175] as const;
const ROTATIONS = [-6, 0, 8] as const;

/**
 * `seed` should be something stable and unique to the specific item — an experience/plan id,
 * falling back to its name — never omitted for a list of same-category tiles sitting next to
 * each other (that's exactly the "purple music graphic" bug this file's header describes). A
 * missing seed still renders correctly (falls back to the category name itself, so at minimum
 * every category still looks distinct from every other), it just loses the per-item variation.
 */
export function v2Art(imageUrl: string | null | undefined, category: string | null | undefined, seed?: string | null): string {
  const art = CATEGORY_ART[category ?? ''] ?? DEFAULT_ART;
  const h = hashString(`${category ?? 'x'}:${seed ?? ''}`);
  const [dark, mid] = art.hues;
  const icon = pick(h >>> 3, art.icons);
  const angle = pick(h >>> 5, ANGLES);
  const layout = h % 3;

  let fallback: string;
  if (layout === 0) {
    // Corner-crop: a large icon bleeding off the bottom-right edge, a small echo top-left, dot
    // grid texture, linear wash.
    const bigIcon = `${iconDataUri(icon, 0.14)} no-repeat 122% 128% / 62% auto`;
    const smallIcon = `${iconDataUri(icon, 0.1)} no-repeat -8% -14% / 26% auto`;
    fallback = `${bigIcon}, ${smallIcon}, ${DOT_GRID}, linear-gradient(${angle}deg, ${dark} 0%, ${mid} 100%)`;
  } else if (layout === 1) {
    // Centred mark: one bold, slightly rotated icon dead-centre at real "poster" scale, a soft
    // diagonal light band crossing it, no texture — the confident, gallery-poster option.
    const rotate = pick(h >>> 7, ROTATIONS);
    const centreIcon = `${iconDataUri(icon, 0.16, rotate)} no-repeat center / 58% auto`;
    const band = `linear-gradient(${angle - 20}deg, transparent 35%, rgba(255,255,255,0.05) 50%, transparent 65%)`;
    fallback = `${centreIcon}, ${band}, linear-gradient(${angle}deg, ${dark} 0%, ${mid} 100%)`;
  } else {
    // Radial ring: opposite-corner icon pair plus one oversized ring motif bleeding off two
    // edges, radial wash anchored at the icon corner — the most "editorial print" option.
    const corner = h % 2 === 0 ? ['0% 0%', '100% 100%'] : ['100% 0%', '0% 100%'];
    const primaryIcon = `${iconDataUri(icon, 0.15)} no-repeat ${corner[0]} / 46% auto`;
    const echoIcon = `${iconDataUri(icon, 0.08)} no-repeat ${corner[1]} / 30% auto`;
    const ring = `${ringDataUri(0.07)} no-repeat 65% 35% / 140% auto`;
    fallback = `${primaryIcon}, ${echoIcon}, ${ring}, radial-gradient(120% 120% at ${corner[0]}, ${mid} 0%, ${dark} 70%)`;
  }

  return imageUrl ? `url("${imageUrl}") center / cover no-repeat, ${fallback}` : fallback;
}
