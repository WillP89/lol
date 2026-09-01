/**
 * The one real interests taxonomy Plot uses — onboarding's tap-to-include chips and Profile's
 * editable "into" chips both read/write against this exact list and slug function, so a
 * category picked in one place is recognised (not silently duplicated) when shown in the other.
 */
export const INTERESTS = [
  'Live music', 'Food', 'Pubs & drinks', 'Comedy', 'Sport', 'Festivals',
  'Cinema', 'Theatre', 'Days out', 'Family', 'Outdoors', 'Markets', 'Something different',
];

export function interestSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z]+/g, '_');
}

/** Reverse of interestSlug for a category coming back from the API — falls back to a
 * title-cased read of the slug itself for any category outside the curated list (a swipe
 * category from an earlier taste-deck era, say), so nothing renders as a raw `something_else`. */
export function interestLabel(slug: string): string {
  const known = INTERESTS.find((label) => interestSlug(label) === slug);
  if (known) return known;
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
