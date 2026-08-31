/**
 * The image-fallback treatment for an experience/plan tile with no real photo yet. Built off
 * Partiful's own convention (a full-bleed hero washed in a vivid gradient — their reference case
 * is purple-to-pink) rather than a muted duotone: each category gets its own confetti-palette
 * gradient, vivid at the top and resolving to near-black at the bottom so an overlaid white
 * caption stays legible. A real photo (once a live provider is connected, or already present
 * from one) layers on top via the same "url(...) center/cover, <fallback>" CSS trick as before —
 * a failed/slow image reveals the gradient underneath instead of a blank box.
 */
const V2_CATEGORY_ART: Record<string, string> = {
  LIVE_MUSIC: 'linear-gradient(160deg, #ff2f7e 0%, #7c5cfc 45%, #0c0c0d 100%)',
  CLUBBING: 'linear-gradient(160deg, #7c5cfc 0%, #2f8aff 45%, #0c0c0d 100%)',
  COMEDY: 'linear-gradient(160deg, #ffc53d 0%, #ff7a3d 45%, #0c0c0d 100%)',
  RESTAURANT: 'linear-gradient(160deg, #34d399 0%, #2f8aff 45%, #0c0c0d 100%)',
  DEFAULT: 'linear-gradient(160deg, #ff7a3d 0%, #ff2f7e 45%, #0c0c0d 100%)',
};

export function v2Art(imageUrl: string | null | undefined, category: string | null | undefined): string {
  const art = V2_CATEGORY_ART[category ?? ''] ?? V2_CATEGORY_ART.DEFAULT;
  return imageUrl ? `url("${imageUrl}") center / cover no-repeat, ${art}` : art;
}
