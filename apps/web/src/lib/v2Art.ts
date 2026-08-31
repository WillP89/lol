/**
 * The image-fallback treatment for an experience/plan tile with no real photo yet. Previously a
 * multi-stop radial-gradient "poster" (three overlapping neon blobs per category) — replaced: it
 * read as generic event-app chrome (the exact "Ticketmaster/Fever" comparison the product
 * explicitly should not invite), not as Plot's own identity, and it leaned on decoration to carry
 * a screen that had nothing else going on. A single confident duotone wash — the same warm ink
 * the rest of the dark surfaces use, through to one category tone — does the one job a fallback
 * actually needs (legible white text over it) without competing for attention with real content.
 * A real photo (once a live provider is connected, or already present from one) layers on top via
 * the same "url(...) center/cover, <fallback>" CSS trick as before — a failed/slow image reveals
 * the wash underneath instead of a blank box.
 */
const V2_CATEGORY_ART: Record<string, string> = {
  LIVE_MUSIC: 'linear-gradient(135deg, #1c1712 0%, #6b2a14 100%)',
  CLUBBING: 'linear-gradient(135deg, #1c1712 0%, #5c1a1a 100%)',
  COMEDY: 'linear-gradient(135deg, #1c1712 0%, #5c4212 100%)',
  RESTAURANT: 'linear-gradient(135deg, #1c1712 0%, #1b4a35 100%)',
  DEFAULT: 'linear-gradient(135deg, #1c1712 0%, #5c2a12 100%)',
};

export function v2Art(imageUrl: string | null | undefined, category: string | null | undefined): string {
  const art = V2_CATEGORY_ART[category ?? ''] ?? V2_CATEGORY_ART.DEFAULT;
  return imageUrl ? `url("${imageUrl}") center / cover no-repeat, ${art}` : art;
}
