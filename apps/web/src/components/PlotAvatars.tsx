/**
 * Plot Characters — a small, deliberately limited, art-directed collection (character over
 * quantity), not a generated icon set. Each is a self-contained badge: its own fixed duotone
 * background (drawn from the exact same tonal identity palette as everything else in Plot —
 * lib/identity.ts — so the set reads as Plot's own colour language, not a separate "sticker"
 * palette bolted on), a confident two-tone silhouette, and a few cut-out ink details. Nothing
 * here is a system emoji, stock clipart, or an AI-generated animal head — every path is
 * hand-authored for this. See docs/DECISIONS.md#plot-characters.
 *
 * Earlier version of this file rendered a bare white silhouette with no background at all,
 * handed a colour by whatever container happened to be drawing it — which is exactly why the
 * old picker read as "unfinished" (a dark ink shape on a flat grey circle, no identity, no
 * colour, no presence). Each character is now a complete piece of art on its own: `render()`
 * returns the whole badge, background included, so it looks the same everywhere — the picker
 * grid, the hero preview, a chat avatar — never assembled differently by whoever's using it.
 *
 * Storage: NOT a real uploaded file — there is nothing to persist as a photo. A chosen Plot
 * avatar is stored as the marker string `plot-avatar:<id>` in the same `avatarUrl`/`imageUrl`
 * column a real upload would occupy; `PersonAvatar`/`CrewMark` (components/Avatar.tsx) detect
 * the prefix and render the matching badge here instead of an <img>.
 */
export const PLOT_AVATAR_PREFIX = 'plot-avatar:';
export const PLOT_CREW_ART_PREFIX = 'plot-crew-art:';

export interface PlotAvatarDef {
  id: string;
  label: string;
  /** The exact same tonal pair as identity.ts's IDENTITY_PALETTE — a fixed, curated assignment
   * per character (not hashed) so the set reads as art-directed, and so a chat bubble's plain
   * background tint always matches the badge sitting on it. */
  pair: [string, string];
  render: () => React.ReactNode;
}

// [dark, mid] — reused verbatim from lib/identity.ts's IDENTITY_PALETTE so a Plot Character
// never introduces a colour outside Plot's own system.
const RUST: [string, string] = ['#7a2e18', '#c2532b'];
const PLUM: [string, string] = ['#3b1f3d', '#7d4379'];
const INK_TEAL: [string, string] = ['#0f2f2c', '#276b60'];
const OCHRE: [string, string] = ['#4a2f0a', '#966123'];
const BERRY: [string, string] = ['#3d1226', '#8a2650'];
const MOSS: [string, string] = ['#1f2e17', '#4c6e33'];
const SLATE: [string, string] = ['#16233f', '#33528a'];
const CLAY: [string, string] = ['#431c14', '#9c4f38'];

function badge([dark, mid]: [string, string], id: string, art: React.ReactNode) {
  return (
    <>
      <defs>
        <radialGradient id={`pa-${id}`} cx="32%" cy="26%" r="85%">
          <stop offset="0%" stopColor={mid} />
          <stop offset="100%" stopColor={dark} />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#pa-${id})`} />
      {art}
    </>
  );
}

export const PLOT_AVATARS: PlotAvatarDef[] = [
  {
    id: 'fox',
    label: 'Fox',
    pair: RUST,
    render: () =>
      badge(RUST, 'fox', (
        <>
          <path d="M12 9 4 4l2.5 10.5Z" fill="#fff" fillOpacity="0.92" />
          <path d="M28 9 36 4l-2.5 10.5Z" fill="#fff" fillOpacity="0.92" />
          <path d="M20 11c-9 0-15 6-15 13.5 0 6.8 6.3 11.3 15 11.3s15-4.5 15-11.3C35 17 29 11 20 11Z" fill="#fff" fillOpacity="0.92" />
          <path d="M20 22 14 32h12Z" fill="#7a2e18" fillOpacity="0.85" />
          <circle cx="14" cy="19" r="1.8" fill="#3d1509" />
          <circle cx="26" cy="19" r="1.8" fill="#3d1509" />
        </>
      )),
  },
  {
    id: 'owl',
    label: 'Owl',
    pair: SLATE,
    render: () =>
      badge(SLATE, 'owl', (
        <>
          <ellipse cx="20" cy="23" rx="14.5" ry="14.5" fill="#fff" fillOpacity="0.92" />
          <path d="M7 10 13 16M33 10 27 16" stroke="#fff" strokeOpacity="0.92" strokeWidth="3.4" strokeLinecap="round" />
          <circle cx="14" cy="21" r="6" fill="#16233f" />
          <circle cx="26" cy="21" r="6" fill="#16233f" />
          <circle cx="14" cy="21" r="2.3" fill="#fff" />
          <circle cx="26" cy="21" r="2.3" fill="#fff" />
          <path d="M20 26 16.5 32h7Z" fill="#33528a" />
        </>
      )),
  },
  {
    id: 'bear',
    label: 'Bear',
    pair: OCHRE,
    render: () =>
      badge(OCHRE, 'bear', (
        <>
          <circle cx="9" cy="12" r="5" fill="#fff" fillOpacity="0.92" />
          <circle cx="31" cy="12" r="5" fill="#fff" fillOpacity="0.92" />
          <circle cx="20" cy="23" r="16" fill="#fff" fillOpacity="0.92" />
          <ellipse cx="20" cy="27" rx="6.5" ry="5.2" fill="#4a2f0a" fillOpacity="0.85" />
          <circle cx="20" cy="25" r="2.1" fill="#241505" />
          <circle cx="13.5" cy="19" r="1.9" fill="#241505" />
          <circle cx="26.5" cy="19" r="1.9" fill="#241505" />
        </>
      )),
  },
  {
    id: 'tiger',
    label: 'Tiger',
    pair: CLAY,
    render: () =>
      badge(CLAY, 'tiger', (
        <>
          <path d="M9 8 12 15M31 8 28 15M6 20l4.5 2.2M34 20l-4.5 2.2" stroke="#fff" strokeOpacity="0.92" strokeWidth="2.8" strokeLinecap="round" />
          <circle cx="20" cy="22" r="15" fill="#fff" fillOpacity="0.92" />
          <path d="M8 18 12 21M32 18 28 21M9 26 13 26M31 26 27 26" stroke="#431c14" strokeOpacity="0.4" strokeWidth="1.8" strokeLinecap="round" />
          <ellipse cx="20" cy="26" rx="7" ry="5.4" fill="#431c14" fillOpacity="0.85" />
          <circle cx="20" cy="24" r="2.1" fill="#200c08" />
          <circle cx="13.5" cy="18" r="1.8" fill="#200c08" />
          <circle cx="26.5" cy="18" r="1.8" fill="#200c08" />
        </>
      )),
  },
  {
    id: 'frog',
    label: 'Frog',
    pair: MOSS,
    render: () =>
      badge(MOSS, 'frog', (
        <>
          <circle cx="13" cy="12" r="5.4" fill="#fff" fillOpacity="0.92" />
          <circle cx="27" cy="12" r="5.4" fill="#fff" fillOpacity="0.92" />
          <circle cx="13" cy="12" r="2.2" fill="#1f2e17" />
          <circle cx="27" cy="12" r="2.2" fill="#1f2e17" />
          <ellipse cx="20" cy="27" rx="16" ry="10.5" fill="#fff" fillOpacity="0.92" />
          <path d="M8 27c4.5 3.4 19.5 3.4 24 0" stroke="#1f2e17" strokeOpacity="0.55" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'octopus',
    label: 'Octopus',
    pair: BERRY,
    render: () =>
      badge(BERRY, 'octopus', (
        <>
          <circle cx="20" cy="15" r="11.5" fill="#fff" fillOpacity="0.92" />
          <circle cx="16" cy="13" r="2" fill="#3d1226" />
          <circle cx="24" cy="13" r="2" fill="#3d1226" />
          <path
            d="M9 21c-2.5 4.5 0.3 10 3.5 8.8 1-4.5-1.3-6.8 0-9M14.5 24.5c-1.3 5.6 1 11 4.3 10 0-5.6-2-7.8-1-10M20 25.5c0 5.8 1.3 11.3 4.5 10.2 1-5.6-1-7.8 0-10.2M25.5 24.5c1.3 5.6 4.5 9 6.7 6.7-1-4.5-4.5-5.6-3.3-9M31 21c2.5 4.5 5.8 6.7 8 3.3-2.3-3.4-5.6-3.4-4.3-6.7"
            fill="none"
            stroke="#fff"
            strokeOpacity="0.92"
            strokeWidth="3.6"
            strokeLinecap="round"
          />
        </>
      )),
  },
  {
    id: 'raccoon',
    label: 'Raccoon',
    pair: INK_TEAL,
    render: () =>
      badge(INK_TEAL, 'raccoon', (
        <>
          <path d="M7 9 13 16M33 9 27 16" stroke="#fff" strokeOpacity="0.92" strokeWidth="3.2" strokeLinecap="round" />
          <circle cx="20" cy="23" r="15" fill="#fff" fillOpacity="0.92" />
          <path d="M6 20c0-4.4 4.4-6.6 8.8-4.4-2.2 3.3-3.3 6.6-1.1 9.9-4.4 1.1-7.7-1.1-7.7-5.5Z" fill="#0f2f2c" fillOpacity="0.5" />
          <path d="M34 20c0-4.4-4.4-6.6-8.8-4.4 2.2 3.3 3.3 6.6 1.1 9.9 4.4 1.1 7.7-1.1 7.7-5.5Z" fill="#0f2f2c" fillOpacity="0.5" />
          <circle cx="15" cy="21" r="2" fill="#0f2f2c" />
          <circle cx="25" cy="21" r="2" fill="#0f2f2c" />
          <ellipse cx="20" cy="29" rx="3.3" ry="2.2" fill="#0f2f2c" fillOpacity="0.75" />
        </>
      )),
  },
  {
    id: 'shark',
    label: 'Shark',
    pair: PLUM,
    render: () =>
      badge(PLUM, 'shark', (
        <>
          <path d="M20 4 25 15h-10Z" fill="#fff" fillOpacity="0.92" />
          <ellipse cx="20" cy="24" rx="17" ry="10.5" fill="#fff" fillOpacity="0.92" />
          <path d="M5 24 -2 18v12Z" fill="#fff" fillOpacity="0.92" />
          <circle cx="12" cy="21" r="1.8" fill="#3b1f3d" />
          <path d="M22 28.5h13l-6.5 5.5Z" fill="#3b1f3d" fillOpacity="0.5" />
        </>
      )),
  },
];

export function getPlotAvatarDef(id: string): PlotAvatarDef | undefined {
  return PLOT_AVATARS.find((a) => a.id === id);
}
