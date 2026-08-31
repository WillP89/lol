/**
 * V2's image treatment (Home / Explore / Crew) — a rich, category-tinted abstract "poster" wash
 * instead of a flat single gradient with an emoji bled off a corner. Each category gets its own
 * distinct multi-stop composition so a row of fallback cards reads as art directed, not as the
 * same placeholder recoloured. A real photo (once a live provider is connected, or already
 * present from a provider that does return one) layers on top via the same
 * "url(...) center/cover, <fallback>" CSS trick as v1's categoryBackground — a failed/slow image
 * reveals the composition underneath instead of a blank box.
 */
const V2_CATEGORY_ART: Record<string, string> = {
  CLUBBING:
    'radial-gradient(130% 150% at 12% -10%, rgba(255,111,174,0.9) 0%, transparent 52%), radial-gradient(110% 130% at 105% 110%, rgba(91,61,240,0.95) 0%, transparent 58%), linear-gradient(160deg, #2b1750, #150b2c)',
  LIVE_MUSIC:
    'radial-gradient(130% 150% at 8% -10%, rgba(255,178,56,0.9) 0%, transparent 50%), radial-gradient(115% 135% at 105% 110%, rgba(255,61,90,0.95) 0%, transparent 58%), linear-gradient(160deg, #4a1420, #290b13)',
  COMEDY:
    'radial-gradient(130% 150% at 18% -10%, rgba(255,209,102,0.95) 0%, transparent 52%), radial-gradient(110% 130% at 105% 110%, rgba(255,140,66,0.9) 0%, transparent 58%), linear-gradient(160deg, #4a2c0a, #2c1a06)',
  RESTAURANT:
    'radial-gradient(130% 150% at 10% -10%, rgba(255,138,101,0.9) 0%, transparent 52%), radial-gradient(110% 130% at 105% 110%, rgba(194,24,91,0.95) 0%, transparent 58%), linear-gradient(160deg, #3a1020, #1c0a13)',
  DEFAULT:
    'radial-gradient(130% 150% at 12% -10%, rgba(255,111,174,0.85) 0%, transparent 52%), radial-gradient(110% 130% at 105% 110%, rgba(255,178,56,0.9) 0%, transparent 58%), linear-gradient(160deg, #2b1750, #150b2c)',
};

export function v2Art(imageUrl: string | null | undefined, category: string | null | undefined): string {
  const art = V2_CATEGORY_ART[category ?? ''] ?? V2_CATEGORY_ART.DEFAULT;
  return imageUrl ? `url("${imageUrl}") center / cover no-repeat, ${art}` : art;
}
