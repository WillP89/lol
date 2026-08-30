/**
 * Every surface that shows a Crew member's name falls back to this when they haven't set a
 * displayName — which is most people, most of the time, since nothing in onboarding currently
 * asks for one. Showing the raw email address in prose ("sam.taylor92@gmail.com: on for
 * Friday?") reads as a database dump, not a social product; a prettified first-name-ish guess
 * from the local part is a small thing that shows up on almost every screen in the app.
 */
export function displayNameOf(displayName: string | null | undefined, email: string): string {
  if (displayName?.trim()) return displayName.trim();

  const local = email.split('@')[0] ?? email;
  const words = local
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));

  return words.length ? words.join(' ') : email;
}
