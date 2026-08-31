/**
 * No real photography exists for sample data (and even real Ticketmaster events don't always
 * have one) — category becomes the visual identity for an event card instead: a colour + emoji
 * pairing, consistent across Explore's map, Find Us Something's results, and Crew chat's
 * shared-event cards. One source of truth so those three surfaces can't visually drift apart.
 */
export interface CategoryVisual {
  emoji: string;
  bg: string;
}

export const CATEGORY_STYLE: Record<string, CategoryVisual> = {
  LIVE_MUSIC: { emoji: '🎵', bg: 'linear-gradient(135deg, #4a2f6b, #241a2e)' },
  CLUBBING: { emoji: '🕺', bg: 'linear-gradient(135deg, #6b2f4a, #241a2e)' },
  RESTAURANT: { emoji: '🍽️', bg: 'linear-gradient(135deg, #3f6b54, #182016)' },
  BAR: { emoji: '🍸', bg: 'linear-gradient(135deg, #6b4a1f, #241a10)' },
  COMEDY: { emoji: '🎤', bg: 'linear-gradient(135deg, #6b5a1f, #241f10)' },
  THEATRE: { emoji: '🎭', bg: 'linear-gradient(135deg, #55483a, #201c16)' },
  CINEMA: { emoji: '🎬', bg: 'linear-gradient(135deg, #2f3f6b, #16182a)' },
  ART_CULTURE: { emoji: '🖼️', bg: 'linear-gradient(135deg, #6b3a5c, #241628)' },
  SPORT: { emoji: '⚽', bg: 'linear-gradient(135deg, #2f6b4a, #16241c)' },
  FITNESS: { emoji: '🏋️', bg: 'linear-gradient(135deg, #6b2f2f, #241616)' },
  FESTIVAL: { emoji: '🎪', bg: 'linear-gradient(135deg, #cf8a3a, #241a10)' },
  DAY_ACTIVITY: { emoji: '☀️', bg: 'linear-gradient(135deg, #e0a94c, #241c10)' },
  COMMUNITY: { emoji: '🤝', bg: 'linear-gradient(135deg, #4a5c6b, #161e24)' },
};

export const DEFAULT_CATEGORY_STYLE: CategoryVisual = { emoji: '📍', bg: 'var(--ink-surface-2)' };

export function categoryStyle(category: string | null | undefined): CategoryVisual {
  return (category && CATEGORY_STYLE[category]) || DEFAULT_CATEGORY_STYLE;
}

/**
 * A real photo URL existing is not the same as that photo successfully loading — a slow
 * network, a provider's broken/expired link, or (in this sandbox) a blocked image CDN all
 * leave a plain CSS `background-image: url(...)` rendering nothing at all. Layering the
 * category gradient as a second, lower background — not swapping between "image OR gradient"
 * — means a failed image quietly reveals the gradient underneath instead of a blank box; a
 * gradient is the designed fallback, not a rectangle of nothing. Use with the `background`
 * shorthand (not `backgroundImage` alone), since only the shorthand's last layer may be a
 * plain colour.
 */
export function categoryBackground(imageUrl: string | null | undefined, category: string | null | undefined): string {
  const style = categoryStyle(category);
  return imageUrl ? `url("${imageUrl}") center / cover no-repeat, ${style.bg}` : style.bg;
}
