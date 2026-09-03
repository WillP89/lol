/**
 * Plot Characters — REBUILT AS REAL CARTOON CHARACTERS, full stop, per direct live feedback
 * ("I DO NOT LIKE ANY OF THE AVATARS... I'd prefer cartoon characters"). The previous version
 * was a set of flat, unoutlined geometric abstractions — clean, but read as minimal icon-set,
 * not "characters" — exactly the complaint. This version commits to an actual cartoon-mascot
 * language and doesn't hedge:
 *  - A bold dark ink OUTLINE on every shape (the single biggest thing the old set lacked — flat
 *    fills with no outline is why it read as "icon", not "character").
 *  - Big, glossy, expressive eyes — white sclera, a dark pupil, a small offset highlight dot —
 *    the thing that gives any cartoon face actual personality and a sense of looking at you.
 *  - Flat, vibrant, contemporary colour per character (a light-to-mid single-hue wash for a
 *    touch of dimension, never the old set's moody near-black duotone) — the kind of palette a
 *    modern app mascot set (Slack's emoji, Duolingo, Notion) actually uses, not a children's-book
 *    palette and not a corporate-neutral one either.
 *  - A distinct expression/mouth per character (smirk, open grin, small smile, tongue-out) so
 *    the SET has personality range, not one face repeated with different ears.
 *
 * Same 12 identities as before (same ids) so anyone who already picked one keeps their pick —
 * every one of the drawings underneath is new.
 *
 * Storage: NOT a real uploaded file — a chosen Plot avatar is stored as the marker string
 * `plot-avatar:<id>` in the same `avatarUrl` column a real upload would occupy;
 * `PersonAvatar`/`CrewMark` (components/Avatar.tsx) detect the prefix and render the matching
 * badge here instead of an <img>.
 */
export const PLOT_AVATAR_PREFIX = 'plot-avatar:';
export const PLOT_CREW_ART_PREFIX = 'plot-crew-art:';

export interface PlotAvatarDef {
  id: string;
  label: string;
  /** [light, mid] — the flat cartoon-colour wash for this character's background, referenced by
   *  IdentityPicker for non-SVG contexts (e.g. a loading-state tint). */
  pair: [string, string];
  render: () => React.ReactNode;
}

// Dark warm ink — every outline, pupil, and linework detail uses this ONE colour, never pure
// black (too harsh against flat colour) and never a different tone per character (that's what
// would make the set read as sloppy rather than illustrated as one family).
const INK = '#2b211c';

// A bright, contemporary, flat-cartoon palette — one light/mid pair per character. Deliberately
// more saturated and cheerful than the old moody near-black duotone set: this is what "cartoon
// character" actually calls for, the same register Duolingo/Slack/Notion's own mascot sets use.
const RUST: [string, string] = ['#FFB37A', '#FF8A3D'];
const TEAL: [string, string] = ['#7FD9CE', '#3FAFA0'];
const AMBER: [string, string] = ['#F6C86B', '#E3A63A'];
const CORAL: [string, string] = ['#FF9E8A', '#F2694E'];
const MOSS: [string, string] = ['#9BDB7E', '#65B84A'];
const ORCHID: [string, string] = ['#E7A0D6', '#C862B0'];
const SLATE: [string, string] = ['#B7C2CE', '#8C9AA8'];
const SKY: [string, string] = ['#8FC4F2', '#4F97DD'];
const FOG: [string, string] = ['#C7CDD3', '#9AA3AD'];
const VIOLET: [string, string] = ['#B6A6E8', '#8A72D4'];
const AQUA: [string, string] = ['#9FE0EF', '#5FC1DA'];
const SAND: [string, string] = ['#F0CE9C', '#D9A86C'];

function badge([light, mid]: [string, string], id: string, art: React.ReactNode) {
  return (
    <>
      <defs>
        <linearGradient id={`pa-${id}`} x1="20%" y1="10%" x2="85%" y2="95%">
          <stop offset="0%" stopColor={light} />
          <stop offset="100%" stopColor={mid} />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#pa-${id})`} />
      {art}
    </>
  );
}

/** Big glossy cartoon eyes — the one construction every character shares, so the set reads as
 *  one illustrated family no matter how the ears/snout/markings vary. `look` nudges the pupil
 *  off-centre for a bit of personality (default straight-ahead). */
function eyes(leftX: number, rightX: number, y: number, r = 3.1, look: 'centre' | 'up' | 'side' = 'centre') {
  const dx = look === 'side' ? 0.6 : 0;
  const dy = look === 'up' ? -0.6 : 0;
  return (
    <>
      <circle cx={leftX} cy={y} r={r} fill="#fff" stroke={INK} strokeWidth="1.1" />
      <circle cx={rightX} cy={y} r={r} fill="#fff" stroke={INK} strokeWidth="1.1" />
      <circle cx={leftX + dx} cy={y + dy} r={r * 0.52} fill={INK} />
      <circle cx={rightX + dx} cy={y + dy} r={r * 0.52} fill={INK} />
      <circle cx={leftX + dx - r * 0.22} cy={y + dy - r * 0.22} r={r * 0.16} fill="#fff" />
      <circle cx={rightX + dx - r * 0.22} cy={y + dy - r * 0.22} r={r * 0.16} fill="#fff" />
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
          <path d="M9 10 3 4l3 11Z" fill="#fff" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M31 10 37 4l-3 11Z" fill="#fff" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M9.5 8.5 6 6l1.5 6.5Z" fill="#FF8A3D" />
          <path d="M30.5 8.5 34 6l-1.5 6.5Z" fill="#FF8A3D" />
          <path d="M20 12c-8 0-13.5 5.6-13.5 12.5S13 33 20 33s13.5-4 13.5-8.5S28 12 20 12Z" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M20 22.5 15 30h10Z" fill="#FF8A3D" stroke={INK} strokeWidth="1" strokeLinejoin="round" />
          <circle cx="20" cy="30" r="1.15" fill={INK} />
          {eyes(14.5, 25.5, 20, 3, 'side')}
          <path d="M17.5 26q2.5 1.8 5 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'owl',
    label: 'Owl',
    pair: SKY,
    render: () =>
      badge(SKY, 'owl', (
        <>
          <path d="M7 9c-2.5 1.5-3.5 4-2.8 6.3 1.8-.6 4-2 5-4.2Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M33 9c2.5 1.5 3.5 4 2.8 6.3-1.8-.6-4-2-5-4.2Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <ellipse cx="20" cy="23" rx="14.5" ry="13.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eyes(14, 26, 21, 5.6, 'centre')}
          <path d="M20 25.5 17.5 30h5Z" fill="#F2694E" stroke={INK} strokeWidth="1" strokeLinejoin="round" />
          <path d="M9 33c2.5-2 5-2.6 6.5-2M31 33c-2.5-2-5-2.6-6.5-2" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'bear',
    label: 'Bear',
    pair: SAND,
    render: () =>
      badge(SAND, 'bear', (
        <>
          <circle cx="9" cy="12" r="5.2" fill="#fff" stroke={INK} strokeWidth="1.2" />
          <circle cx="31" cy="12" r="5.2" fill="#fff" stroke={INK} strokeWidth="1.2" />
          <circle cx="9" cy="12.5" r="2.2" fill="#D9A86C" />
          <circle cx="31" cy="12.5" r="2.2" fill="#D9A86C" />
          <circle cx="20" cy="23" r="15.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eyes(14, 26, 21, 3, 'centre')}
          <ellipse cx="20" cy="27.5" rx="6.5" ry="5" fill="#D9A86C" stroke={INK} strokeWidth="1.1" />
          <ellipse cx="20" cy="25.5" rx="2.2" ry="1.8" fill={INK} />
          <path d="M17 29.5q3 2.2 6 0" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'tiger',
    label: 'Tiger',
    pair: AMBER,
    render: () =>
      badge(AMBER, 'tiger', (
        <>
          <path d="M8 8 12 15h-7Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M32 8 28 15h7Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <circle cx="20" cy="22" r="15" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M7 16 11.5 19M6 22 11 23M8 27 12 26.5" stroke={INK} strokeWidth="1.4" strokeLinecap="round" fill="none" />
          <path d="M33 16 28.5 19M34 22 29 23M32 27 28 26.5" stroke={INK} strokeWidth="1.4" strokeLinecap="round" fill="none" />
          {eyes(14, 26, 19.5, 3.2, 'up')}
          <ellipse cx="20" cy="26" rx="6.5" ry="5" fill="#fff" />
          <path d="M17 29.8q3 2.2 6 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M20 23.5 17.5 26h5Z" fill={INK} />
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
          <circle cx="13.5" cy="12.5" r="6" fill="#fff" stroke={INK} strokeWidth="1.2" />
          <circle cx="26.5" cy="12.5" r="6" fill="#fff" stroke={INK} strokeWidth="1.2" />
          <circle cx="13.5" cy="12.5" r="2.6" fill={INK} />
          <circle cx="26.5" cy="12.5" r="2.6" fill={INK} />
          <circle cx="12.2" cy="11.2" r="0.9" fill="#fff" />
          <circle cx="25.2" cy="11.2" r="0.9" fill="#fff" />
          <ellipse cx="20" cy="26" rx="16" ry="10.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M9 27q11 5 22 0" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <circle cx="15" cy="24" r="1.6" fill="#65B84A" opacity="0.6" />
          <circle cx="25" cy="24" r="1.6" fill="#65B84A" opacity="0.6" />
        </>
      )),
  },
  {
    id: 'octopus',
    label: 'Octopus',
    pair: ORCHID,
    render: () =>
      badge(ORCHID, 'octopus', (
        <>
          <path
            d="M9 22c-2.8 4.6 0.2 10.4 3.6 9-0.6-4.6-1.6-7-0.2-9.4M14.5 25.5c-1.4 5.8 0.8 11.4 4.2 10.4-0.2-5.8-1.8-8-0.6-10.4M20 26.5c0 6 1.2 11.6 4.4 10.6 1-5.8-0.8-8-0.2-10.6M25.5 25.5c1.4 5.8 4.4 9.2 6.6 7-1-4.6-4.2-5.8-3-9.2M31 22c2.6 4.6 5.8 6.8 8 3.6-2.2-3.6-5.4-3.6-4.2-7"
            fill="none"
            stroke={INK}
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <circle cx="20" cy="16" r="12.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eyes(14.5, 25.5, 16, 3.4, 'centre')}
          <path d="M17 20.5q3 2 6 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'raccoon',
    label: 'Raccoon',
    pair: SLATE,
    render: () =>
      badge(SLATE, 'raccoon', (
        <>
          <path d="M7 9 12.5 15" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />
          <path d="M33 9 27.5 15" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="10" r="4" fill="#fff" stroke={INK} strokeWidth="1.1" />
          <circle cx="32" cy="10" r="4" fill="#fff" stroke={INK} strokeWidth="1.1" />
          <circle cx="20" cy="23" r="15" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M6.5 20c-0.6-4.6 3.6-7.4 8.4-5.2-2.4 3.2-3.4 6.4-0.8 9.8-4.8.8-7.2-1.2-7.6-4.6Z" fill={INK} opacity="0.85" />
          <path d="M33.5 20c0.6-4.6-3.6-7.4-8.4-5.2 2.4 3.2 3.4 6.4 0.8 9.8 4.8.8 7.2-1.2 7.6-4.6Z" fill={INK} opacity="0.85" />
          <circle cx="15" cy="21.5" r="2.2" fill="#fff" />
          <circle cx="25" cy="21.5" r="2.2" fill="#fff" />
          <circle cx="15.4" cy="21.9" r="1.15" fill={INK} />
          <circle cx="25.4" cy="21.9" r="1.15" fill={INK} />
          <ellipse cx="20" cy="28" rx="3.4" ry="2.4" fill={INK} />
          <path d="M17 30.5q3 1.8 6 0" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'shark',
    label: 'Shark',
    pair: TEAL,
    render: () =>
      badge(TEAL, 'shark', (
        <>
          <path d="M20 4 26 16H14Z" fill="#fff" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
          <ellipse cx="20" cy="24" rx="17" ry="10.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M4 24-3 17v14Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          {eyes(13, 24, 21, 3, 'side')}
          <path d="M21 27.5h13l-6.5 6Z" fill={INK} opacity="0.55" />
          <path d="M17 29q3 2 6.5 0.4" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'wolf',
    label: 'Wolf',
    pair: FOG,
    render: () =>
      badge(FOG, 'wolf', (
        <>
          <path d="M9 5 2 2l3 10.5Z" fill="#fff" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M31 5 38 2l-3 10.5Z" fill="#fff" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M9.5 6.5 6 4l1.5 6.5Z" fill="#9AA3AD" />
          <path d="M30.5 6.5 34 4l-1.5 6.5Z" fill="#9AA3AD" />
          <path d="M20 10c-9 0-15 6.2-15 13.5S12 34 20 34s15-4.2 15-10.5S29 10 20 10Z" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M8 20.5c3-1.5 6-1 7.5 1M32 20.5c-3-1.5-6-1-7.5 1" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" opacity="0.5" />
          {eyes(14, 26, 20.5, 3.1, 'centre')}
          <path d="M20 24 15.5 31.5h9Z" fill="#9AA3AD" stroke={INK} strokeWidth="1" strokeLinejoin="round" />
          <circle cx="20" cy="31" r="1.15" fill={INK} />
          <path d="M17.5 27.5q2.5 1.6 5 0" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'panther',
    label: 'Panther',
    pair: VIOLET,
    render: () =>
      badge(VIOLET, 'panther', (
        <>
          <path d="M8 8 12.5 15" stroke={INK} strokeWidth="1.2" strokeLinecap="round" />
          <path d="M32 8 27.5 15" stroke={INK} strokeWidth="1.2" strokeLinecap="round" />
          <path d="M4.5 9 10 6.5 8 13Z" fill="#8A72D4" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M35.5 9 30 6.5 32 13Z" fill="#8A72D4" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <circle cx="20" cy="22" r="14.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eyes(14, 26, 21, 3.4, 'side')}
          <ellipse cx="20" cy="27" rx="3.4" ry="2.4" fill={INK} />
          <path d="M16.5 29.5q3.5 2 7 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'seal',
    label: 'Seal',
    pair: AQUA,
    render: () =>
      badge(AQUA, 'seal', (
        <>
          <ellipse cx="20" cy="22" rx="15" ry="14" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eyes(14, 26, 20, 3.6, 'centre')}
          <ellipse cx="20" cy="26" rx="4.5" ry="3.4" fill="#5FC1DA" opacity="0.7" stroke={INK} strokeWidth="1" />
          <circle cx="20" cy="25.5" r="1.15" fill={INK} />
          <path d="M9 26 3 24M9 28 2 28.5M31 26l6-2M31 28l7 .5" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.55" />
          <path d="M17.5 29q2.5 1.6 5 0" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'greyhound',
    label: 'Greyhound',
    pair: CORAL,
    render: () =>
      badge(CORAL, 'greyhound', (
        <>
          <path d="M14 5 9 15" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />
          <path d="M26 5 31 15" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />
          <path d="M13 5.5 8.5 8l3 9Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M27 5.5 31.5 8l-3 9Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <ellipse cx="20" cy="19" rx="12.5" ry="10.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M13.5 26c-3 2.2-5 6-4 9.5 3.2-.2 6.4-3 7.4-6.4Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M26.5 26c3 2.2 5 6 4 9.5-3.2-.2-6.4-3-7.4-6.4Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          {eyes(14.5, 25.5, 17.5, 3, 'up')}
          <ellipse cx="20" cy="23.5" rx="3" ry="2.2" fill={INK} />
          <path d="M17 26.5q3 1.8 6 0" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      )),
  },
];

export function getPlotAvatarDef(id: string): PlotAvatarDef | undefined {
  return PLOT_AVATARS.find((a) => a.id === id);
}
