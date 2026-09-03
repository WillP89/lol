/**
 * Plot Characters — SECOND FULL REPLACEMENT, per direct live feedback that rejected the first
 * one outright ("NOPE NOT ACCEPTED HATE THEM ALL... DIFFERENT STYLE DIFFERENT VIBE"). That
 * version was real cartoon-mascot construction (outline, glossy eyes, flat colour) but still a
 * literal zoo-animal-face set (fox/owl/bear/...) — the same genre every app-mascot set reaches
 * for first. This version is a genuinely different genre, not a restyle of the same idea:
 * original quirky BLOB/CREATURE characters — nobody's seen this exact fox before, because it
 * isn't a fox. The energy is closer to a vinyl-toy/collectible-figure line (Pop Mart, a modern
 * sticker pack) than a children's-book animal set — asymmetric, a little weird on purpose,
 * vivid multi-stop gradient bodies (not flat single-hue), variable eye count (one/two/three)
 * and mismatched eye sizes for real personality range instead of one face repeated with
 * different ears, a distinct mouth per character (fang, gap-tooth grin, zigzag teeth, tongue
 * out, sleepy smile, smirk), and one small unique physical quirk each (a horn, a drip, an
 * antenna, a patch, spots, a tuft) rather than a swapped accessory prop.
 *
 * New ids (the old animal-named ones don't fit creatures with no species) — safe pre-launch:
 * no real user has a stored `plot-avatar:fox`-style pick yet to orphan.
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
  /** [light, mid] of this character's gradient body — referenced by IdentityPicker for
   *  non-SVG contexts (e.g. a loading-state tint). */
  pair: [string, string];
  render: () => React.ReactNode;
}

const INK = '#241c17'; // one dark warm ink for every outline/pupil/linework detail, every character

function badge([light, mid]: [string, string], id: string, art: React.ReactNode) {
  return (
    <>
      <defs>
        <linearGradient id={`pa-${id}`} x1="15%" y1="5%" x2="90%" y2="100%">
          <stop offset="0%" stopColor={light} />
          <stop offset="100%" stopColor={mid} />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#pa-${id})`} />
      {art}
    </>
  );
}

/** One glossy eye — white sclera, dark pupil, a small offset highlight. `r` and vertical offset
 *  are per-call so eyes can genuinely mismatch in size (the thing that makes these read as
 *  original creatures rather than a symmetric icon-face). */
function eye(cx: number, cy: number, r: number) {
  return (
    <g key={`${cx}-${cy}`}>
      <circle cx={cx} cy={cy} r={r} fill="#fff" stroke={INK} strokeWidth={r > 2.6 ? 1.1 : 0.9} />
      <circle cx={cx} cy={cy + r * 0.08} r={r * 0.52} fill={INK} />
      <circle cx={cx - r * 0.22} cy={cy - r * 0.22} r={r * 0.16} fill="#fff" />
    </g>
  );
}

export const PLOT_AVATARS: PlotAvatarDef[] = [
  {
    id: 'sparky',
    label: 'Sparky',
    pair: ['#C9A6F5', '#8A5CD6'],
    render: () =>
      badge(['#C9A6F5', '#8A5CD6'], 'sparky', (
        <>
          <path d="M20 4 22 10 18 10Z" fill="#F7D354" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <ellipse cx="20" cy="23" rx="14" ry="13" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eye(15, 21, 4.4)}
          {eye(26, 22.5, 3)}
          <path d="M15 29c1.5 2.5 8 2.5 9-1" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M15.5 30.5 16.5 32" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'blink',
    label: 'Blink',
    pair: ['#8FE3D9', '#2FA99B'],
    render: () =>
      badge(['#8FE3D9', '#2FA99B'], 'blink', (
        <>
          <ellipse cx="20" cy="24" rx="16" ry="12.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M9 15c-1.5-3 0-6 3-6" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <circle cx="12.5" cy="9.5" r="1.4" fill="#F7D354" stroke={INK} strokeWidth="0.9" />
          {eye(14, 22, 5)}
          <path d="M23 22.5q3-2.2 6 0" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M14 30c3 2 9 2 11-1.5" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M11 29.5 8.5 32M27 29 30 31" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" opacity="0.7" />
        </>
      )),
  },
  {
    id: 'gummy',
    label: 'Gummy',
    pair: ['#FFB4A8', '#F2694E'],
    render: () =>
      badge(['#FFB4A8', '#F2694E'], 'gummy', (
        <>
          <circle cx="20" cy="22" r="15" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <circle cx="12" cy="14" r="1.6" fill="#F2694E" opacity="0.55" />
          <circle cx="29" cy="17" r="1.1" fill="#F2694E" opacity="0.55" />
          <circle cx="27" cy="27" r="1.4" fill="#F2694E" opacity="0.55" />
          <circle cx="13" cy="28" r="1" fill="#F2694E" opacity="0.55" />
          {eye(14.5, 20, 3.6)}
          {eye(25.5, 20, 3.6)}
          <path d="M13.5 27c2 3 11 3 13 0" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M17 27.5v2.5M20 28v3M23 27.5v2.5" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'drift',
    label: 'Drift',
    pair: ['#9AC8F5', '#4E7FCB'],
    render: () =>
      badge(['#9AC8F5', '#4E7FCB'], 'drift', (
        <>
          <path d="M20 6c-1 3-2 4-2 6a2 2 0 0 0 4 0c0-2-1-3-2-6Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <ellipse cx="20" cy="24" rx="15.5" ry="12.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eye(15, 22.5, 3.4)}
          {eye(25, 24, 2.4)}
          <path d="M15 30q5 2.5 10-1" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M9 24c-2 .5-3 2-2.5 4M31 25c2 .3 3.2 1.8 2.8 3.8" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" opacity="0.6" />
        </>
      )),
  },
  {
    id: 'nova',
    label: 'Nova',
    pair: ['#FDDD8B', '#E8A93B'],
    render: () =>
      badge(['#FDDD8B', '#E8A93B'], 'nova', (
        <>
          <path d="M13 10c-3-2-6 0-5 4 2-.5 4-2 5-4Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <circle cx="20" cy="23" r="14.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eye(15, 21, 4.2)}
          {eye(26, 21.5, 3.4)}
          <path d="M16 29c2.5 2 6 2 8-.5" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M20 29.5q0 3-2 3.5" stroke={INK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <ellipse cx="19.2" cy="33" rx="1.6" ry="1.1" fill="#F2694E" />
        </>
      )),
  },
  {
    id: 'pip',
    label: 'Pip',
    pair: ['#FFC2DC', '#E770A8'],
    render: () =>
      badge(['#FFC2DC', '#E770A8'], 'pip', (
        <>
          <path d="M6 18c-3 1-3 6 1 7 .5-3 1-5-1-7Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M34 18c3 1 3 6-1 7-.5-3-1-5 1-7Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <circle cx="20" cy="22" r="14" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eye(15, 20.5, 3.2)}
          {eye(25, 20.5, 3.2)}
          <ellipse cx="11.5" cy="25" rx="2.2" ry="1.5" fill="#E770A8" opacity="0.5" />
          <ellipse cx="28.5" cy="25" rx="2.2" ry="1.5" fill="#E770A8" opacity="0.5" />
          <path d="M16.5 27.5q3.5 2.4 7 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'zag',
    label: 'Zag',
    pair: ['#B9E38A', '#66A93C'],
    render: () =>
      badge(['#B9E38A', '#66A93C'], 'zag', (
        <>
          <path d="M20 25c-9 0-15-4.4-15-10S12 4 20 4s15 5.4 15 11-6 10-15 10Z" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eye(14, 12.5, 3.6)}
          {eye(26, 13, 2.6)}
          <path d="M11 19h18l-2.5 3.5h-13Z" fill={INK} />
          <path d="M12.5 19v3.5M15.5 19v3.5M18.5 19v3.5M21.5 19v3.5M24.5 19v3.5M27.5 19v3.5" stroke="#fff" strokeWidth="1" />
          <path d="M20 25c-6 4-10 8-8 11 3 1 7-2 8-6 1 4 5 7 8 6 2-3-2-7-8-11Z" fill="#fff" stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
        </>
      )),
  },
  {
    id: 'ember',
    label: 'Ember',
    pair: ['#FFAE8A', '#E4552F'],
    render: () =>
      badge(['#FFAE8A', '#E4552F'], 'ember', (
        <>
          <path d="M20 3c2.5 3 4 5.5 4 8a4 4 0 0 1-8 0c0-2.5 1.5-5 4-8Z" fill="#F7D354" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <circle cx="20" cy="24" r="14.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eye(15, 22.5, 4.6)}
          {eye(26, 22.5, 4.6)}
          <ellipse cx="20" cy="31" rx="4.4" ry="3" fill={INK} />
        </>
      )),
  },
  {
    id: 'lull',
    label: 'Lull',
    pair: ['#B6A6E8', '#6E56C4'],
    render: () =>
      badge(['#B6A6E8', '#6E56C4'], 'lull', (
        <>
          <path d="M14 8 12 13M26 8 28 13" stroke={INK} strokeWidth="1.5" strokeLinecap="round" />
          <ellipse cx="20" cy="23" rx="14.5" ry="13" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M10.5 20.5q4-3 8 0" stroke={INK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M21.5 20.5q4-3 8 0" stroke={INK} strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M15 29c2 2 8 2 10 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <ellipse cx="10.5" cy="26" rx="2" ry="1.4" fill="#6E56C4" opacity="0.5" />
          <ellipse cx="29.5" cy="26" rx="2" ry="1.4" fill="#6E56C4" opacity="0.5" />
        </>
      )),
  },
  {
    id: 'patch',
    label: 'Patch',
    pair: ['#8FB8DE', '#3E6FA8'],
    render: () =>
      badge(['#8FB8DE', '#3E6FA8'], 'patch', (
        <>
          <ellipse cx="20" cy="22" rx="15" ry="14" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M9.5 14a6 6 0 0 1 8.5 1.5 6 6 0 0 1-8.5-1.5Z" fill={INK} />
          {eye(26, 20, 4.4)}
          <path d="M15 28.5q5 2.6 10 0" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M23 28.8 24 30.5" stroke={INK} strokeWidth="1.1" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'puff',
    label: 'Puff',
    pair: ['#B9EBD6', '#4FAE84'],
    render: () =>
      badge(['#B9EBD6', '#4FAE84'], 'puff', (
        <>
          <circle cx="20" cy="21" r="15.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          <path d="M4 26c-2.5 2-2.5 6 0 8M36 26c2.5 2 2.5 6 0 8" stroke={INK} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          {eye(15, 19.5, 3.4)}
          {eye(25, 19.5, 3.4)}
          <ellipse cx="12" cy="25" rx="2.4" ry="1.6" fill="#F58FA0" opacity="0.7" />
          <ellipse cx="28" cy="25" rx="2.4" ry="1.6" fill="#F58FA0" opacity="0.7" />
          <path d="M16.5 25.5q3.5 2.2 7 0" stroke={INK} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </>
      )),
  },
  {
    id: 'flare',
    label: 'Flare',
    pair: ['#F6A6C1', '#D63B72'],
    render: () =>
      badge(['#F6A6C1', '#D63B72'], 'flare', (
        <>
          <path d="M20 4 24 12 20 10 16 12Z" fill="#fff" stroke={INK} strokeWidth="1.1" strokeLinejoin="round" />
          <circle cx="20" cy="23" r="14.5" fill="#fff" stroke={INK} strokeWidth="1.3" />
          {eye(14.5, 21, 4)}
          {eye(25.5, 21, 4)}
          <path d="M13.5 28h13l-6.5 5Z" fill={INK} />
          <path d="M15.5 28v2.4M18.5 28v3.4M21.5 28v3.4M24.5 28v2.4" stroke="#fff" strokeWidth="1" />
        </>
      )),
  },
];

export function getPlotAvatarDef(id: string): PlotAvatarDef | undefined {
  return PLOT_AVATARS.find((a) => a.id === id);
}
