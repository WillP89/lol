/**
 * Curated Crew cover art — the brief's "choose cool Plot Crew art" option, alongside upload and
 * the generated identity mark. Deliberately NOT photography: no stock-photo licensing exists to
 * use here honestly (a real curated licensed photo library needs a paid license this pass has
 * no budget/credentials for — see docs/DECISIONS.md#plot-avatar-gallery), so this is authored
 * abstract/editorial art instead, in the exact same technique as the category fallback art
 * (lib/v2Art.ts): a tonal duotone gradient plus a large, purpose-drawn icon watermark, one
 * distinct theme per real Crew occasion (a night out, a festival, food, a pub, outdoors, a
 * house party, the city, a road trip) rather than one generic wash for every Crew.
 */
interface CrewArtTheme {
  label: string;
  gradient: string;
  icon: string; // raw SVG markup, stroke="white"
}

const ICONS = {
  // A crescent moon + stars — a night out.
  nightOut: '<path d="M15 4a9 9 0 1 0 9 13.5A7 7 0 0 1 15 4Z"/><path d="M20 5v3M18.5 6.5h3M6 15v2.5M4.7 16.3h2.6" stroke-linecap="round"/>',
  // Bunting triangles + a burst — a festival.
  festival: '<path d="M4 8h20M6 8v4l3-2 3 2V8M13 8v4l3-2 3 2V8M20 8v4l3-2v-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 16v6M17 19h6" stroke-linecap="round"/>',
  // Fork + plate — food.
  food: '<circle cx="14" cy="14" r="9"/><path d="M22 6v8m-3-8v4a1.5 1.5 0 0 0 3 0V6m0 0v8" stroke-linecap="round" stroke-linejoin="round"/>',
  // A pint glass — a pub.
  pub: '<path d="M8 5h10l-1 16H9Z" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 8h2a2.5 2.5 0 0 1 0 5h-2" stroke-linecap="round"/>',
  // A mountain + sun — outdoors.
  outdoors: '<circle cx="9" cy="7" r="2.5"/><path d="M2 20 10 8l4 6 3-3 5 9Z" stroke-linecap="round" stroke-linejoin="round"/>',
  // Balloons — a house party.
  party: '<circle cx="9" cy="8" r="4.5"/><circle cx="18" cy="10" r="4"/><path d="M9 12.5V22M18 14v6" stroke-linecap="round"/>',
  // A skyline — the city.
  city: '<path d="M3 21V11l4-3 4 3v10M11 21V6l4-3 4 3v15M19 21v-8l3-2v10" stroke-linecap="round" stroke-linejoin="round"/>',
  // A winding road toward hills — a road trip.
  roadTrip: '<path d="M9 21c2-6-2-9 3-9s1-3 3-9" stroke-linecap="round" stroke-dasharray="2.5 2.5"/><path d="M2 21 8 9l4 6 3-3 6 9Z" stroke-linecap="round" stroke-linejoin="round"/>',
};

const THEMES: Record<string, CrewArtTheme> = {
  night_out: { label: 'Night out', gradient: 'linear-gradient(150deg, #16182c 0%, #453a6e 100%)', icon: ICONS.nightOut },
  festival: { label: 'Festival', gradient: 'linear-gradient(150deg, #3a190f 0%, #a8542c 100%)', icon: ICONS.festival },
  food: { label: 'Food', gradient: 'linear-gradient(150deg, #331c12 0%, #8f4d2c 100%)', icon: ICONS.food },
  pub: { label: 'Pub', gradient: 'linear-gradient(150deg, #3a2210 0%, #99591f 100%)', icon: ICONS.pub },
  outdoors: { label: 'Outdoors', gradient: 'linear-gradient(150deg, #182615 0%, #4f6a33 100%)', icon: ICONS.outdoors },
  house_party: { label: 'House party', gradient: 'linear-gradient(150deg, #2c1830 0%, #6f486c 100%)', icon: ICONS.party },
  city: { label: 'City', gradient: 'linear-gradient(150deg, #131a26 0%, #375670 100%)', icon: ICONS.city },
  road_trip: { label: 'Road trip', gradient: 'linear-gradient(150deg, #2a1230 0%, #74335a 100%)', icon: ICONS.roadTrip },
};

export const CREW_ART_THEME_IDS = Object.keys(THEMES);
export const CREW_ART_PREFIX = 'plot-crew-art:';

function iconDataUri(svgInner: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="1.4">${svgInner}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The background CSS for a themed Crew cover — large, centred watermark (unlike the small
 * corner one on category art: this IS the whole image, not a fallback behind a real photo). */
export function crewArtStyle(themeId: string): string {
  const theme = THEMES[themeId] ?? THEMES.night_out;
  const iconLayer = `${iconDataUri(theme.icon)} no-repeat center / 46% auto`;
  return `${iconLayer}, ${theme.gradient}`;
}

export function crewArtLabel(themeId: string): string {
  return THEMES[themeId]?.label ?? 'Plot art';
}

export function isCrewArtUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl || !imageUrl.startsWith(CREW_ART_PREFIX)) return null;
  return imageUrl.slice(CREW_ART_PREFIX.length);
}
