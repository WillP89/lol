/**
 * A real "choose a Plot avatar" option — the brief's own requirement: "upload a photo, choose a
 * Plot avatar, or use a generated Plot identity" as three genuine choices, not upload-or-nothing.
 * Every creature here is drawn purpose-built for this, in the same bold, editorial, single-tone
 * language as the rest of Plot's iconography (components/icons.tsx) — no system emoji, no
 * clipart, no stock character rip-offs, no AI-portrait-soup. A coherent, small, deliberately
 * limited set (character over quantity) that reads as one family: solid silhouette forms with a
 * few confident cut-out details, filled in white on the same identity-gradient background every
 * other avatar fallback already uses (lib/identity.ts) — so a Plot avatar sits at home next to a
 * photo or an initial, never as a separate "sticker" register.
 *
 * Storage: NOT a real uploaded file — there is nothing to persist as a photo. A chosen Plot
 * avatar is stored as the marker string `plot-avatar:<id>` in the same `avatarUrl`/`imageUrl`
 * column a real upload would occupy; `PersonAvatar`/`CrewMark` (components/Avatar.tsx) detect
 * the prefix and render the matching vector here instead of an <img>. See
 * docs/DECISIONS.md#plot-avatar-gallery.
 */
export const PLOT_AVATAR_PREFIX = 'plot-avatar:';
export const PLOT_CREW_ART_PREFIX = 'plot-crew-art:';

export interface PlotAvatarDef {
  id: string;
  label: string;
  render: (color: string) => React.ReactNode;
}

export const PLOT_AVATARS: PlotAvatarDef[] = [
  {
    id: 'fox',
    label: 'Fox',
    render: (c) => (
      <>
        <path d="M20 10 8 6l3 10Z" fill={c} />
        <path d="M20 10 32 6l-3 10Z" fill={c} />
        <path d="M20 12c-8 0-13 5.5-13 12 0 6 5.5 10 13 10s13-4 13-10c0-6.5-5-12-13-12Z" fill={c} />
        <path d="M20 22 15 30h10Z" fill="#00000022" />
        <circle cx="15" cy="19" r="1.6" fill="#00000055" />
        <circle cx="25" cy="19" r="1.6" fill="#00000055" />
      </>
    ),
  },
  {
    id: 'owl',
    label: 'Owl',
    render: (c) => (
      <>
        <ellipse cx="20" cy="22" rx="13" ry="14" fill={c} />
        <path d="M9 10 14 15M31 10 26 15" stroke={c} strokeWidth="3" strokeLinecap="round" />
        <circle cx="14.5" cy="20" r="5.2" fill="#fff" />
        <circle cx="25.5" cy="20" r="5.2" fill="#fff" />
        <circle cx="14.5" cy="20" r="2.2" fill="#00000077" />
        <circle cx="25.5" cy="20" r="2.2" fill="#00000077" />
        <path d="M20 24 17.5 29h5Z" fill="#00000055" />
      </>
    ),
  },
  {
    id: 'bear',
    label: 'Bear',
    render: (c) => (
      <>
        <circle cx="10" cy="11" r="4.5" fill={c} />
        <circle cx="30" cy="11" r="4.5" fill={c} />
        <circle cx="20" cy="22" r="15" fill={c} />
        <ellipse cx="20" cy="26" rx="6" ry="5" fill="#fff" />
        <circle cx="20" cy="24" r="2" fill="#00000066" />
        <circle cx="14" cy="18" r="1.8" fill="#00000055" />
        <circle cx="26" cy="18" r="1.8" fill="#00000055" />
      </>
    ),
  },
  {
    id: 'tiger',
    label: 'Tiger',
    render: (c) => (
      <>
        <path d="M10 8 13 15M30 8 27 15M8 20l4 2M32 20l-4 2" stroke={c} strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="20" cy="21" r="14" fill={c} />
        <ellipse cx="20" cy="25" rx="6.5" ry="5" fill="#fff" />
        <circle cx="20" cy="23" r="2" fill="#00000066" />
        <circle cx="14" cy="17" r="1.7" fill="#00000055" />
        <circle cx="26" cy="17" r="1.7" fill="#00000055" />
      </>
    ),
  },
  {
    id: 'frog',
    label: 'Frog',
    render: (c) => (
      <>
        <circle cx="13" cy="11" r="5" fill={c} />
        <circle cx="27" cy="11" r="5" fill={c} />
        <circle cx="13" cy="11" r="2.1" fill="#00000066" />
        <circle cx="27" cy="11" r="2.1" fill="#00000066" />
        <ellipse cx="20" cy="25" rx="15" ry="10" fill={c} />
        <path d="M9 25c4 3 18 3 22 0" stroke="#00000055" strokeWidth="2" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'octopus',
    label: 'Octopus',
    render: (c) => (
      <>
        <circle cx="20" cy="15" r="11" fill={c} />
        <circle cx="16" cy="13" r="1.8" fill="#fff" />
        <circle cx="24" cy="13" r="1.8" fill="#fff" />
        <path
          d="M10 20c-2 4 0 9 3 8 1-4-1-6 0-8M15 23c-1 5 1 10 4 9 0-5-2-7-1-9M20 24c0 5 1 10 4 9 1-5-1-7 0-9M25 23c1 5 4 8 6 6-1-4-4-5-3-8M30 20c2 4 5 6 7 3-2-3-5-3-4-6"
          stroke={c}
          strokeWidth="3.2"
          fill="none"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    id: 'raccoon',
    label: 'Raccoon',
    render: (c) => (
      <>
        <path d="M9 9 13 15M31 9 27 15" stroke={c} strokeWidth="3" strokeLinecap="round" />
        <circle cx="20" cy="22" r="14" fill={c} />
        <path d="M8 19c0-4 4-6 8-4-2 3-3 6-1 9-4 1-7-1-7-5Z" fill="#00000044" />
        <path d="M32 19c0-4-4-6-8-4 2 3 3 6 1 9 4 1 7-1 7-5Z" fill="#00000044" />
        <circle cx="15" cy="20" r="1.8" fill="#fff" />
        <circle cx="25" cy="20" r="1.8" fill="#fff" />
        <ellipse cx="20" cy="27" rx="3" ry="2" fill="#00000066" />
      </>
    ),
  },
  {
    id: 'shark',
    label: 'Shark',
    render: (c) => (
      <>
        <path d="M20 5 24 15h-8Z" fill={c} />
        <ellipse cx="20" cy="23" rx="16" ry="10" fill={c} />
        <path d="M6 23 0 18v10Z" fill={c} />
        <circle cx="12" cy="20" r="1.6" fill="#fff" />
        <path d="M22 27h12l-6 5Z" fill="#00000044" />
      </>
    ),
  },
];

export function getPlotAvatarDef(id: string): PlotAvatarDef | undefined {
  return PLOT_AVATARS.find((a) => a.id === id);
}
