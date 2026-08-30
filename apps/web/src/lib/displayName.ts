/**
 * Mirrors apps/api/src/lib/displayName.ts — used wherever the frontend renders a name straight
 * from a { displayName, email } pair the API already sent back raw (chat messages, the Crew
 * member list), rather than a field the API pre-formats itself. Showing the full email address
 * in prose ("sam.taylor92@gmail.com: on for Friday?") reads as a database dump, not a social
 * product; a prettified guess from the email's local part is a small thing that shows up on
 * almost every screen in the app.
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
