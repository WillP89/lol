import { prisma } from '../lib/prisma';
import { track } from './analytics';
import { TASTE_INTEREST_INDEX, TASTE_TAXONOMY, interestsForCategory, CATCH_ALL_CATEGORIES, type TasteInterest } from '@plot/shared';
import type { TasteProfile } from '@prisma/client';

/**
 * THE PERSONALISATION-ENGINE PASS — the layer underneath TasteProfile.categoryAffinity that
 * actually gives Plot specific, usable signal ("UK garage", not "music"). See
 * @plot/shared/tasteTaxonomy.ts for the fixed taxonomy this all keys off, and
 * docs/DECISIONS.md#personalisation-engine for the full design rationale. Three jobs live here:
 *
 *  1. Turning a person's tap on a specific interest into a stored affinity (`applyInterestUpdates`).
 *  2. Turning free text ("Fred again..", "small indie gigs") into either a matched taxonomy
 *     interest or a preserved raw signal — never a fabricated match (`interpretFreeText`).
 *  3. Turning a real Experience's own provider data (subcategories, name, description) into the
 *     same interest-id space, so scoring can actually compare "what this person likes" against
 *     "what this event is" (`experienceInterestTags`) — this is the missing link that made the
 *     taxonomy real rather than decorative: providers already send subcategory strings (Ticketmaster
 *     genres, Skiddle event codes, OSM cuisine tags — see providers/live/*.ts), they just were
 *     never matched against anything before this pass.
 */

// `open`'s 0.2 here is never actually written to a TasteProfile any more — see
// applyInterestUpdates's own comment: clearing an interest now deletes its key outright (true
// neutral) rather than storing this as a residual weight. Kept in the map only so `TasteStrength`
// still derives 'open' as a valid value the client can send (the picker's own explicit "I'm
// clearing this" signal, distinct from simply omitting an id) and so the type-checked
// `STRENGTH_WEIGHT[u.strength]` lookup for the other three strengths compiles without a cast.
const STRENGTH_WEIGHT: Record<'love' | 'like' | 'open' | 'not_for_me', number> = {
  love: 1,
  like: 0.6,
  open: 0.2,
  not_for_me: -1,
};
export type TasteStrength = keyof typeof STRENGTH_WEIGHT;

// Real bug found via live verification: creating a TasteProfile row here for the first time
// (someone using "Tune my Plot" before ever completing onboarding's swipe step) with only the
// schema's bare column defaults (budgetMaxMinor: 0, travelRadiusMeters: 6000) silently read back
// as "Free" / "Nearby" on Profile — indistinguishable from a real, deliberate choice, when it was
// actually just "never set". These match Profile's own UI defaults (apps/web/.../profile/page.tsx)
// so a brand-new row reads the same as what the page was already showing before anyone touched it.
const DEFAULT_BUDGET_MAX_MINOR = 3000;
const DEFAULT_TRAVEL_RADIUS_METERS = 16000;

/** Lowercase, strip punctuation to spaces, collapse whitespace — deliberately simple
 *  normalisation so matching stays explainable (grep-able, not a black box), not real NLP. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every interest whose label or a synonym appears in (or IS) the normalised text, scanning the
 *  whole taxonomy — free text isn't scoped to one territory the way a provider's own category-
 *  tagged subcategory string is (see `matchInterestsForCategory` below). */
function matchInterests(rawText: string): TasteInterest[] {
  const text = normalize(rawText);
  if (!text) return [];
  const hits: TasteInterest[] = [];
  for (const { interest } of TASTE_INTEREST_INDEX.values()) {
    for (const syn of interest.synonyms) {
      // Word-boundary-ish substring check both ways: "garage" should match "uk garage"'s synonym
      // list, and a longer typed phrase ("small indie gigs") should match the shorter "indie"
      // synonym sitting inside it. Real bug this normalize() call fixes, caught by
      // test/personalHome.test.ts: a synonym straight from @plot/shared/tasteTaxonomy.ts (e.g.
      // "stand-up", "hip-hop/rap") keeps its own punctuation verbatim — it is NOT run through
      // this file's `normalize()` at authoring time, unlike `text` above. A provider's raw
      // subcategory tag, by this whole codebase's own snake_case convention (`stand_up`,
      // `hip_hop`), normalizes its underscore to a space ("stand up") — which then can never
      // match the synonym's un-normalized hyphen ("stand-up") on either side of an `.includes()`
      // check, silently failing every taxonomy entry whose label/synonym contains punctuation.
      // Normalizing the synonym here, at comparison time, is what actually makes "both sides
      // normalised the same way" true rather than just asserted.
      const normalizedSyn = normalize(syn);
      if (text.includes(normalizedSyn) || normalizedSyn.includes(text)) {
        hits.push(interest);
        break;
      }
    }
  }
  return hits;
}

/** Same idea, scoped to the interests valid for one Experience category — used for provider
 *  subcategory strings, where we already know the category and scoping avoids a cross-territory
 *  false positive (a restaurant's "market" cuisine tag should never match MUSIC's territory). */
function matchInterestsForCategory(rawText: string, category: string): TasteInterest[] {
  const text = normalize(rawText);
  if (!text) return [];
  const scoped = interestsForCategory(category);
  // See matchInterests' own comment on why the synonym itself needs normalizing too, not just
  // the input text — this is the same fix, applied to the category-scoped path (provider
  // subcategory tags) that surfaced the bug in the first place.
  return scoped.filter((interest) => interest.synonyms.some((syn) => { const n = normalize(syn); return text.includes(n) || n.includes(text); }));
}

export interface FreeTextSignal {
  text: string;
  matchedInterestIds: string[];
  confidence: 'high' | 'low';
  addedAt: string;
}

/** THE HONESTY RULE the brief is explicit about: if "Fred again.." doesn't map onto anything in
 *  the fixed taxonomy (it doesn't — it's an artist, not a genre), this returns zero matches and
 *  `confidence: 'low'` rather than guessing. The raw text is still preserved by the caller
 *  (`addFreeTextSignal`) and used for literal matching against an Experience's own name/description
 *  later (see `experienceInterestTags`) — so "Fred again.." can still surface an actual Fred
 *  again.. event by name, just never claims a fake genre match to get there. */
export function interpretFreeText(rawText: string): { matchedInterestIds: string[]; confidence: 'high' | 'low' } {
  const matches = matchInterests(rawText);
  return { matchedInterestIds: [...new Set(matches.map((m) => m.id))], confidence: matches.length > 0 ? 'high' : 'low' };
}

/** Merges (never overwrites) taps from the "Tune My Plot" editor into TasteProfile.interestAffinity
 *  — unlike the bulk onboarding swipe write (services/taste.ts#submitTasteSwipes), this gets
 *  called repeatedly over a user's lifetime, one or a few interests at a time, so a partial
 *  update must never clobber everything else already set.
 *
 *  Real, live-reported bug this fixes: "once I tune my plot, it saves the previous preferences as
 *  well as the newly set... if I had Rock selected but then go back and set different ones, I do
 *  not then want to see Rock on the home page." Root cause — the picker's own clear tap
 *  (TuneMyPlotSheet.tsx#cycleInterest cycling like -> love -> cleared) sent `strength: 'open'`
 *  rather than skipping the write specifically so clearing was never silently dropped, but this
 *  function then stored `STRENGTH_WEIGHT.open` (0.2) as the new affinity — a real, nonzero,
 *  POSITIVE number, not "no preference". Home's own scoring (personalHome.ts) treats any
 *  `matchedInterestAffinity > 0` as a genuine match ("Because you like Rock"), so a "cleared"
 *  interest kept influencing Home forever, and re-opening Tune My Plot even showed it as still
 *  tapped (`strengthFromAffinity` treats any v > 0 as 'like') — indistinguishable from never
 *  having cleared it at all. `'open'` now means what the UI actually intends by it — true
 *  neutral, zero influence — by deleting the key outright rather than writing a residual weight;
 *  every other strength (love/like/not_for_me) is unchanged, still a real, deliberate signal. */
export async function applyInterestUpdates(
  userId: string,
  updates: { interestId: string; strength: TasteStrength }[],
): Promise<TasteProfile> {
  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  const current = (existing?.interestAffinity as Record<string, number> | undefined) ?? {};
  const next = { ...current };
  const touchedTerritoryIds = new Set<string>();
  for (const u of updates) {
    const entry = TASTE_INTEREST_INDEX.get(u.interestId);
    if (!entry) continue; // never store an id the taxonomy doesn't recognise
    touchedTerritoryIds.add(entry.territory.id);
    if (u.strength === 'open') {
      delete next[u.interestId]; // true neutral — never a residual weight that outlives the tap that cleared it
    } else {
      next[u.interestId] = STRENGTH_WEIGHT[u.strength];
    }
  }

  // Real, live-reported bug this fixes: "it should not show live music on the home page if live
  // music is not a preference set at profile level" — TasteProfile.categoryAffinity is a
  // SEPARATE, older store, bulk-written once by onboarding's category swipe
  // (services/taste.ts#submitTasteSwipes) and never otherwise editable — Tune My Plot only ever
  // wrote interestAffinity, above. So clearing every specific music interest here left the
  // ORIGINAL onboarding-era categoryAffinity.live_music sitting there untouched, and
  // evaluateTasteRelevance's eligibility gate (`catScore > 0 || matchedInterestAffinity > 0 ||
  // freeTextHit`) kept treating EVERY live-music event as eligible regardless of what Tune My
  // Plot now shows selected — a category the picker itself displays as fully cleared kept
  // leaking through on a completely separate, invisible signal. Once a person touches a
  // territory here at all, its categories are considered owned by this granular editor from then
  // on: if NO interest anywhere in that territory (not just the ones this call touched) still has
  // a positive affinity, the stale category-level affinity for every category it covers is
  // cleared too — unless a DIFFERENT territory that still has real positive signal also covers
  // that same category (one category can belong to more than one territory, e.g. DAY_ACTIVITY
  // under both Food and Outdoors & Active).
  const categoryAffinity = { ...((existing?.categoryAffinity as Record<string, number> | undefined) ?? {}) };
  for (const territoryId of touchedTerritoryIds) {
    const territory = TASTE_TAXONOMY.find((t) => t.id === territoryId);
    if (!territory) continue;
    const territoryStillHasSignal = territory.interests.some((i) => (next[i.id] ?? 0) > 0);
    if (territoryStillHasSignal) continue;
    for (const category of territory.categories) {
      const coveredByAnotherTerritory = TASTE_TAXONOMY.some(
        (t) => t.id !== territoryId && t.categories.includes(category) && t.interests.some((i) => (next[i.id] ?? 0) > 0),
      );
      if (!coveredByAnotherTerritory) delete categoryAffinity[categoryToTasteKey(category)];
    }
  }

  const profile = await prisma.tasteProfile.upsert({
    where: { userId },
    update: { interestAffinity: next, categoryAffinity },
    create: { userId, categoryAffinity, interestAffinity: next, budgetMaxMinor: DEFAULT_BUDGET_MAX_MINOR, travelRadiusMeters: DEFAULT_TRAVEL_RADIUS_METERS },
  });
  await track('TasteInterestUpdated', { userId, count: updates.length }, { userId });
  return profile;
}

/** Adds one free-text signal, preserving the raw string always, and — only where confidence is
 *  genuinely high (a real taxonomy match, not a guess) — also nudging that matched interest's
 *  affinity up, so a person who types "UK garage" gets the same scoring benefit as someone who
 *  tapped it in the picker, without making them do both. */
export async function addFreeTextSignal(userId: string, rawText: string): Promise<TasteProfile> {
  const text = rawText.trim().slice(0, 120);
  if (!text) throw new Error('empty_signal');
  const { matchedInterestIds, confidence } = interpretFreeText(text);

  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  const signals = ((existing?.freeTextSignals as unknown as FreeTextSignal[] | undefined) ?? []).filter(
    (s) => s.text.toLowerCase() !== text.toLowerCase(), // re-adding the same text just refreshes it
  );
  signals.unshift({ text, matchedInterestIds, confidence, addedAt: new Date().toISOString() });

  const affinity = { ...((existing?.interestAffinity as Record<string, number> | undefined) ?? {}) };
  if (confidence === 'high') {
    for (const id of matchedInterestIds) affinity[id] = Math.max(affinity[id] ?? 0, STRENGTH_WEIGHT.like);
  }

  const profile = await prisma.tasteProfile.upsert({
    where: { userId },
    update: { freeTextSignals: signals.slice(0, 40) as unknown as object[], interestAffinity: affinity },
    create: { userId, categoryAffinity: {}, freeTextSignals: signals as unknown as object[], interestAffinity: affinity, budgetMaxMinor: DEFAULT_BUDGET_MAX_MINOR, travelRadiusMeters: DEFAULT_TRAVEL_RADIUS_METERS },
  });
  await track('TasteFreeTextAdded', { userId, matched: matchedInterestIds.length > 0 }, { userId });
  return profile;
}

export async function removeFreeTextSignal(userId: string, text: string): Promise<void> {
  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  if (!existing) return;
  const signals = ((existing.freeTextSignals as unknown as FreeTextSignal[] | undefined) ?? []).filter(
    (s) => s.text.toLowerCase() !== text.toLowerCase(),
  );
  await prisma.tasteProfile.update({ where: { userId }, data: { freeTextSignals: signals as unknown as object[] } });
}

export async function setCategoryBudget(
  userId: string,
  category: string,
  range: { minMinor: number; maxMinor: number } | null,
): Promise<TasteProfile> {
  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  const current = { ...((existing?.categoryBudget as Record<string, { minMinor: number; maxMinor: number }> | undefined) ?? {}) };
  if (range) current[category] = range;
  else delete current[category];
  return prisma.tasteProfile.upsert({
    where: { userId },
    update: { categoryBudget: current },
    create: { userId, categoryAffinity: {}, categoryBudget: current, budgetMaxMinor: DEFAULT_BUDGET_MAX_MINOR, travelRadiusMeters: DEFAULT_TRAVEL_RADIUS_METERS },
  });
}

/** The other half of the link: what specific interests does THIS Experience actually represent?
 *  Real provider data first (subcategories — Ticketmaster genres, Skiddle event codes, OSM
 *  cuisine — scoped to the Experience's own category so a match is always plausible), then a
 *  bounded keyword scan of the name/description for anything the subcategory data missed (e.g. a
 *  Ticketmaster event whose genre is generic "Music" but whose name says "UK Garage Classics").
 *  Never invents a tag with no textual basis in the Experience's own real data. */
export function experienceInterestTags(experience: {
  category: string;
  subcategories: unknown;
  name: string;
  description: string;
}): string[] {
  const ids = new Set<string>();
  const subcats = Array.isArray(experience.subcategories) ? (experience.subcategories as string[]) : [];
  for (const raw of subcats) {
    for (const interest of matchInterestsForCategory(raw, experience.category)) ids.add(interest.id);
  }
  // Keyword scan is deliberately scoped to interests valid for this Experience's own category —
  // "market" in a restaurant's description shouldn't light up an unrelated territory.
  const haystack = `${experience.name} ${experience.description}`.slice(0, 500);
  for (const interest of matchInterestsForCategory(haystack, experience.category)) ids.add(interest.id);
  return [...ids];
}

/** Does this Experience's own text literally contain a person's raw free-text signal (e.g. an
 *  artist name Plot's taxonomy has no genre entry for)? The one case a plain substring check is
 *  MORE honest than a taxonomy match — "Fred again.." either is or isn't in this event's name. */
export function experienceMatchesFreeText(experience: { name: string; description: string }, rawText: string): boolean {
  const needle = normalize(rawText);
  if (needle.length < 3) return false; // too short to mean anything reliably
  return normalize(experience.name).includes(needle) || normalize(experience.description).includes(needle);
}

/** TasteProfile.categoryAffinity keys are the free-text onboarding swipe categories (e.g.
 *  "clubbing", "live music"), which don't line up 1:1 with the Experience.category enum — this
 *  maps enum values to the closest onboarding key. A real mapping table grows with the taxonomy;
 *  this is deliberately a small, visible function rather than buried inline. Lives here (not
 *  match.ts, which used to own it) so this file — the one place both Crew scoring (match.ts) and
 *  individual scoring (personalHome.ts) get their taxonomy logic from — has no reverse dependency
 *  on either of them; moving it avoided a circular import the moment personalHome.ts needed it
 *  too. */
export function categoryToTasteKey(category: string): string {
  const map: Record<string, string> = {
    LIVE_MUSIC: 'live_music',
    CLUBBING: 'clubbing',
    RESTAURANT: 'restaurant',
    BAR: 'bar',
    COMEDY: 'comedy',
    THEATRE: 'theatre',
    CINEMA: 'cinema',
    ART_CULTURE: 'art_culture',
    SPORT: 'sport',
    FITNESS: 'fitness',
    FESTIVAL: 'festival',
    DAY_ACTIVITY: 'day_activity',
    COMMUNITY: 'community',
  };
  return map[category] ?? category.toLowerCase();
}

// Real, live-reported gap this closes, found the moment the plain territory-category fallback
// below first shipped: a taxonomy territory can list MORE THAN ONE real category (Food covers
// RESTAURANT, DAY_ACTIVITY AND COMMUNITY; Outdoors & Active covers DAY_ACTIVITY AND FITNESS) — so
// two people with completely unrelated interests (one picks a food interest, the other picks
// 'walking') both got DAY_ACTIVITY implied, and DAY_ACTIVITY inventory started leaking across
// both of them, re-breaking the exact "three genuinely different people, one shared pool, must
// see genuinely different homes" acceptance test this whole session's work was proving
// (test/personalHome.test.ts). Precomputed once here: which categories belong to EXACTLY ONE
// territory across the whole taxonomy — only those are ever safe to imply from a single interest
// pick without risk of pulling in a category some OTHER, unrelated interest also happens to
// share. CLUBBING (Music + Nightlife) and DAY_ACTIVITY (Food + Outdoors) are the only two
// currently ambiguous; every other category in the taxonomy belongs to exactly one territory.
// REAL, LIVE-REPORTED BUG this same set closes (found via the Crew-side equivalent of this exact
// widening, services/match.ts#scoreExperiencesForCrew): COMMUNITY belongs to exactly one
// territory (Food) by the count above, so it would otherwise pass as "unambiguous" — but every
// live provider adapter (Ticketmaster, Eventbrite, PredictHQ, Skiddle, OpenStreetMap) ALSO uses
// COMMUNITY as its universal fallback for anything it can't confidently classify at all, so
// "this Experience is COMMUNITY" carries none of the real signal every other category here does.
// See @plot/shared's CATCH_ALL_CATEGORIES for the full provider-by-provider evidence — excluded
// here for the same reason match.ts excludes it from its own implied-category set.
const UNAMBIGUOUS_CATEGORIES: ReadonlySet<string> = (() => {
  const territoryCountByCategory = new Map<string, number>();
  for (const territory of TASTE_TAXONOMY) {
    for (const category of territory.categories) {
      territoryCountByCategory.set(category, (territoryCountByCategory.get(category) ?? 0) + 1);
    }
  }
  return new Set(
    [...territoryCountByCategory.entries()]
      .filter(([category, count]) => count === 1 && !(CATCH_ALL_CATEGORIES as ReadonlySet<string>).has(category))
      .map(([category]) => category),
  );
})();

/** Given a person's CURRENT, specific interestAffinity, the set of real inventory categories
 *  those interests unambiguously imply — via each interest's own taxonomy territory (e.g.
 *  'boxing' and 'mma' both live under the 'sport' territory, whose own `categories` is
 *  `['SPORT']`; 'street_food' and 'restaurants' both live under 'food', whose `categories` is
 *  `['RESTAURANT', 'DAY_ACTIVITY', 'COMMUNITY']` — RESTAURANT and COMMUNITY are both returned,
 *  DAY_ACTIVITY is not, since a DIFFERENT territory also claims it — see
 *  `UNAMBIGUOUS_CATEGORIES`'s own comment). Real, live-reported gap this closes: real provider
 *  inventory (Ticketmaster, Skiddle, PredictHQ) essentially never happens to use Plot's own
 *  specific taxonomy wording in an Experience's name/description/subcategories — "0
 *  recommendations" for an account with real, current interests set (boxing, MMA, restaurants,
 *  street food) is otherwise a real, likely outcome the moment `experienceInterestTags`' literal-
 *  text match finds nothing, even though there's genuinely relevant SPORT/RESTAURANT inventory
 *  sitting right there. Picking a specific interest is still picking that interest's own
 *  category — this is never a route back to the bare, unclearable, one-time onboarding-swipe
 *  signal `evaluateTasteRelevance` deliberately stopped trusting (see its own comment): every
 *  category this returns is backed by a CURRENT, positive, specific interest the person picked
 *  themselves, today, in Tune My Plot — not a stale swipe with no UI to see or revise it. */
export function categoriesImpliedByInterests(interestAffinity: Record<string, number>): Set<string> {
  const categories = new Set<string>();
  for (const [interestId, affinity] of Object.entries(interestAffinity)) {
    if (affinity <= 0) continue;
    const territory = TASTE_INTEREST_INDEX.get(interestId)?.territory;
    if (!territory) continue;
    for (const category of territory.categories) {
      if (UNAMBIGUOUS_CATEGORIES.has(category)) categories.add(category);
    }
  }
  return categories;
}

export interface TasteRelevance {
  /** Stage-A eligibility (see docs/DECISIONS.md#personal-home): true the moment a REAL, specific
   *  signal — a specific interest tag, or a literal free-text match — is positive. This is
   *  the ONE STRICT eligibility rule every individual-facing surface (Explore, Home) shares; Crew
   *  scoring (match.ts#scoreExperiencesForCrew) is deliberately separate — a Crew's own
   *  aggregate/DNA/preference signals mean something different from any one member's.
   *  Deliberately does NOT fold in `impliedByInterestId` below — that's a distinct, LAST-RESORT
   *  widening a caller opts into explicitly (see its own doc comment for why), never baked into
   *  the strict definition of "eligible" itself.
   *
   *  Real, live-reported bug this fixes (third round on the same root cause): "It should ONLY
   *  show events they're interested in (MMA, Boxing, Street food, Restaurants)" — Home kept
   *  showing Comedy and Live Music cards ("Because you're into comedy") for a person whose own
   *  Profile page ("Your taste — what Plot actually understands about you", deliberately built
   *  from interestAffinity ALONE, see profile/page.tsx#tasteSummary's own comment: "specific
   *  interests, never bare categories") showed no such thing. `categoryAffinity` USED to count on
   *  its own here — a raw, bulk, ONE-TIME write from onboarding's category swipe
   *  (services/taste.ts#submitTasteSwipes) that Tune My Plot can never fully re-derive (a person
   *  who's simply never revisited a territory in the granular picker at all still carries it,
   *  forever, with no UI anywhere to see or clear it) — so a category the person swiped "yes" to
   *  once, months ago, and has done nothing about since, could keep independently granting
   *  eligibility to an entire category on Home/Explore, completely invisibly, regardless of what
   *  the person's actual current, specific taste (interestAffinity) says. That directly
   *  contradicts the one promise Profile itself makes about what "your taste" means. Category-
   *  level affinity is kept on this type (`categoryAffinity` below) purely as a minor, non-gating
   *  scoring input where a caller chooses to use it — it can no longer, by itself, make anything
   *  eligible. */
  eligible: boolean;
  categoryAffinity: number;
  /** The single strongest matching specific interest, if any — not "some interest matched" but
   *  WHICH one, so a caller can build an honest "because you like UK garage" reason rather than
   *  a vague "matches your taste". */
  matchedInterestId: string | null;
  matchedInterestAffinity: number;
  matchedFreeText: string | null;
  /** Fourth round, immediately after the fix above shipped: "my account has boxing, MMA,
   *  restaurants and street food set... it says 0 recommendations... this needs to actually show
   *  events." Dropping bare categoryAffinity from `eligible` was correct, but a HARD requirement
   *  that `experienceInterestTags` literally find "boxing"/"street food" etc. in an Experience's
   *  own text turned out to be far stricter than real provider data can meet — real SPORT/
   *  RESTAURANT inventory overwhelmingly doesn't happen to use Plot's own specific wording, so a
   *  person with entirely real, current, specific interests set could still legitimately see
   *  nothing at all. Set only when NO real interest tag literally matched (`matchedInterestId` is
   *  null) but this Experience's own category is implied by one of the viewer's CURRENT, specific
   *  interests anyway (`categoriesImpliedByInterests` above) — never a route back to the bare,
   *  stale onboarding signal `eligible` itself excludes.
   *
   *  Deliberately NOT folded into `eligible` above: a taxonomy territory can span several
   *  genuinely different real-world categories (Culture covers THEATRE, CINEMA AND ART_CULTURE;
   *  Food covers RESTAURANT, DAY_ACTIVITY AND COMMUNITY) — a person who picks 'museums'
   *  specifically does not thereby mean "show me touring theatre shows too". Baking this
   *  unconditionally into eligibility re-broke exactly the personalisation-engine acceptance test
   *  this whole session's work was proving (test/personalHome.test.ts: three genuinely different
   *  people, sharing one inventory pool, must see genuinely different homes) — a shared, multi-
   *  category territory would leak a completely different real category into someone's Home
   *  purely because DIFFERENT interest under the SAME territory tests eligible via a literal tag
   *  match. Callers (personalHome.ts, explore.ts) instead use this as an explicit LAST-RESORT
   *  widening — only when the strict `eligible` set comes up completely empty for someone who
   *  does have real, current interest signal — so it only ever fills a genuine void, never
   *  contaminates an already-working, specific personalisation with an unrelated category from
   *  the same broad territory. */
  impliedByInterestId: string | null;
}

/** THE canonical "does this belong to this person at all" check — Stage A of the two-stage
 *  eligibility-then-ranking model (docs/DECISIONS.md#personal-home). Used by both
 *  services/explore.ts (Explore's own "only show what's relevant" filter) and
 *  services/personalHome.ts (Home's personal feed) so "relevant" means exactly one thing across
 *  the app, not two definitions that can quietly drift apart. An Experience is STRICTLY eligible
 *  the moment EITHER of these is true: (1) at least one of its real interest tags
 *  (experienceInterestTags below — provider subcategories + a scoped keyword scan, never
 *  invented) has positive affinity, or (2) it textually matches one of the viewer's own free-text
 *  signals. See TasteRelevance's own `eligible` and `impliedByInterestId` doc comments for the
 *  full reasoning, including why the latter is a separate, opt-in, last-resort widening rather
 *  than a third way into `eligible` itself — a hard gate, not a soft reorder (see match.ts's own
 *  scorer for the softer, additive version Crew recommendations use instead). */
export function evaluateTasteRelevance(
  experience: { category: string; subcategories: unknown; name: string; description: string },
  categoryAffinity: Record<string, number>,
  interestAffinity: Record<string, number>,
  freeTextSignals: FreeTextSignal[],
): TasteRelevance {
  const catScore = categoryAffinity[categoryToTasteKey(experience.category)] ?? 0;

  let matchedInterestId: string | null = null;
  let matchedInterestAffinity = 0;
  for (const tag of experienceInterestTags(experience)) {
    const affinity = interestAffinity[tag] ?? 0;
    if (affinity > matchedInterestAffinity) {
      matchedInterestAffinity = affinity;
      matchedInterestId = tag;
    }
  }

  const freeTextHit = freeTextSignals.find((s) => experienceMatchesFreeText(experience, s.text));

  // Only computed/consulted when the literal-tag match above found nothing — a real interest tag
  // match is always more specific and always takes priority (see the `matchedInterestId` branch
  // above and scoreForIndividual's own reason-picking order). Gated on `UNAMBIGUOUS_CATEGORIES`
  // (see its own comment) so this never implies a category a DIFFERENT, unrelated territory also
  // claims — the exact cross-contamination this same widening caused when it first shipped.
  let impliedByInterestId: string | null = null;
  if (!matchedInterestId && UNAMBIGUOUS_CATEGORIES.has(experience.category)) {
    let bestImpliedAffinity = 0;
    for (const [interestId, affinity] of Object.entries(interestAffinity)) {
      if (affinity <= bestImpliedAffinity) continue;
      const territory = TASTE_INTEREST_INDEX.get(interestId)?.territory;
      if (territory?.categories.some((c) => c === experience.category)) {
        bestImpliedAffinity = affinity;
        impliedByInterestId = interestId;
      }
    }
  }

  return {
    // Deliberately NOT `|| catScore > 0` and NOT `|| Boolean(impliedByInterestId)` — see this
    // type's own `eligible` and `impliedByInterestId` doc comments for why each is excluded.
    eligible: matchedInterestAffinity > 0 || Boolean(freeTextHit),
    categoryAffinity: catScore,
    matchedInterestId,
    matchedInterestAffinity,
    matchedFreeText: freeTextHit?.text ?? null,
    impliedByInterestId,
  };
}

export { TASTE_TAXONOMY };
