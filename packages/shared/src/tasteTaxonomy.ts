/**
 * PLOT'S TASTE TAXONOMY — the personalisation-engine pass.
 *
 * The problem this exists to fix: "I like music" is a category, and a category tells Plot
 * almost nothing (see docs/DECISIONS.md#personalisation-engine). This is the layer underneath
 * every top-level ExperienceCategory — a fixed, real set of specific interests a person or Crew
 * can actually be into, granular enough that "UK garage, house, small venues" and "Championship
 * football, non-league, sports bars" produce genuinely different recommendations from the same
 * inventory in the same city.
 *
 * This is UI-facing (the "Tune My Plot" editor renders it) AND scoring-facing (an interest `id`
 * here is the exact key TasteProfile.interestAffinity is keyed by, and `synonyms` is what lets a
 * provider's raw genre string, or a person's own free-text signal, resolve onto it — see
 * apps/api/src/services/tasteSignals.ts). One taxonomy, not two drifting copies, is why this
 * lives in @plot/shared rather than being duplicated in the API and the web client.
 *
 * Deliberately NOT exhaustive — real, useful specificity per the brief's own worked examples,
 * not maximum coverage for its own sake. Extending it later is additive (new interest ids never
 * collide with stored affinity for ones that already exist).
 */
// Deliberately its own literal union, NOT `ExperienceCategory` from ./domain — that type is the
// lowercase wire-format shape (`'live_music'`); this taxonomy's `categories` field matches
// against the Prisma-generated Experience.category enum directly (services/match.ts reads
// `experience.category`, which is this uppercase shape), and packages/shared can't depend on
// @prisma/client to import the real enum type without pulling Prisma into the web bundle too.
export type TasteExperienceCategory =
  | 'LIVE_MUSIC'
  | 'CLUBBING'
  | 'RESTAURANT'
  | 'BAR'
  | 'COMEDY'
  | 'THEATRE'
  | 'CINEMA'
  | 'ART_CULTURE'
  | 'SPORT'
  | 'FITNESS'
  | 'FESTIVAL'
  | 'DAY_ACTIVITY'
  | 'COMMUNITY'
  | 'CUSTOM';

export interface TasteInterest {
  id: string;
  label: string;
  /** Lowercase alternate strings this interest should match against — a provider's own genre
   *  string ("Hip-Hop/Rap"), a person's free-text ("garage"), or an Experience's own subcategory
   *  tag. Matching is case-insensitive substring/token matching (see tasteSignals.ts), not ML —
   *  deliberately simple enough to be explainable and extensible by hand. */
  synonyms: string[];
  /**
   * Real, live-reported P0 failure this exists to fix: a Crew that picked BOTH "Live gigs" (a
   * broad activity/context pick) AND "Rock" (a specific genre pick within that same territory)
   * still got recommended a K-pop show — because every interest in a territory was treated as an
   * interchangeable, independent, additive tag: matching ANY one of a Crew's picks (including the
   * broad "Live gigs" one) was enough to admit a candidate, regardless of what a Crew's OTHER,
   * more specific pick said. `narrows: true` marks an interest as a genuine REFINEMENT of its
   * territory — a genre (rock, uk_garage), a cuisine (japanese, italian), a league (championship_
   * football) — evidence about WHAT WITHIN the territory, not just THAT the territory applies.
   * `narrows: false` (the default — see `t()` below) marks a broad/context/format pick — "Live
   * gigs", "Restaurants", "Watching big matches" — which describes the shape of the activity, not
   * a specific flavour within it, and is genuinely satisfied by anything in its territory (a
   * K-pop show IS honestly a "live gig" — that match is correct; the bug was letting it stand in
   * for "Rock" too). See services/match.ts#contradictsCrewInterestPreference (apps/api) for
   * exactly how this is used: a candidate carrying its own CONFIRMED (subcategory-sourced, never
   * a loose keyword hit) evidence of a DIFFERENT narrowing interest in the same territory as one a
   * Crew explicitly picked — and neither matching it nor a curated `RELATED_INTERESTS` sibling —
   * is a genuine contradiction, not just an unrelated broad match. A candidate with no confirmed
   * narrowing evidence at all is never a contradiction (Plot doesn't know enough to call it wrong)
   * — this only catches real, positive evidence of the WRONG specific thing. Deliberately narrow
   * in scope so far (music genres, food cuisines, sport leagues/disciplines — the exact examples
   * the P0 report gave); comedy/culture/drinks/outdoors territories are left `narrows: false`
   * throughout for now, same "grow it only with real, defensible cases" discipline
   * `TERRITORIES_REQUIRING_EXPLICIT_RELATION`/`RELATED_INTERESTS` already established, not a
   * blanket "mark everything narrowing" pass.
   */
  narrows?: boolean;
}

export interface TasteTerritory {
  id: string;
  label: string;
  /** Which real inventory categories this territory's interests can appear under — an interest
   *  only ever gets matched against an Experience whose category is in this list, so "indie" (MUSIC)
   *  can never accidentally match a restaurant. */
  categories: TasteExperienceCategory[];
  interests: TasteInterest[];
}

function t(id: string, label: string, ...synonyms: string[]): TasteInterest {
  return { id, label, synonyms: [label.toLowerCase(), ...synonyms.map((s) => s.toLowerCase())] };
}

/** Same as `t()`, but marks the interest `narrows: true` — see `TasteInterest.narrows`'s own doc
 *  comment for exactly what that means and why it exists. */
function tn(id: string, label: string, ...synonyms: string[]): TasteInterest {
  return { ...t(id, label, ...synonyms), narrows: true };
}

export const TASTE_TAXONOMY: TasteTerritory[] = [
  {
    id: 'music',
    label: 'Music',
    categories: ['LIVE_MUSIC', 'CLUBBING', 'FESTIVAL'],
    interests: [
      t('live_gigs', 'Live gigs', 'gig', 'live music'),
      t('small_venues', 'Small venues', 'intimate', 'acoustic'),
      t('festivals', 'Festivals'),
      t('club_nights', 'Club nights', 'clubbing'),
      t('dj_sets', 'DJ sets', 'dj'),
      t('tribute_throwback', 'Tribute & throwback nights', 'tribute act', 'tribute'),
      // Genre picks — each one a genuine REFINEMENT of "live gigs"/"club nights", not just
      // another independent broad tag (see `narrows`'s own doc comment, and the K-pop-to-a-Rock-
      // crew P0 failure it exists to fix).
      tn('indie', 'Indie', 'indie rock'),
      tn('rock', 'Rock'),
      tn('alternative', 'Alternative', 'alt rock'),
      tn('pop', 'Pop'),
      tn('hip_hop', 'Hip-hop & rap', 'hip-hop/rap', 'rap'),
      // Real gap this closes (live product directive, worked example verbatim): "RAP / UK RAP /
      // GRIME / DRILL / OLD SCHOOL... where metadata genuinely supports it" — grime and drill are
      // real, distinct UK genres, not synonyms of the broader "hip-hop & rap" bucket above; a
      // person who's specifically into one shouldn't be treated as generically "into rap".
      tn('grime', 'Grime'),
      tn('drill', 'Drill', 'uk drill'),
      tn('rnb', 'R&B', 'r and b', 'rnb'),
      tn('house', 'House'),
      tn('techno', 'Techno'),
      tn('drum_and_bass', 'Drum & bass', "d'n'b", 'dnb', 'jungle'),
      tn('uk_garage', 'UK garage', 'garage', '2-step'),
      tn('disco', 'Disco'),
      tn('soul_funk', 'Soul & funk', 'soul', 'funk'),
      tn('jazz', 'Jazz'),
      tn('country', 'Country'),
      tn('folk', 'Folk'),
      tn('metal', 'Metal'),
      tn('punk', 'Punk'),
      tn('classical', 'Classical'),
      tn('electronic', 'Electronic'),
      tn('afrobeats', 'Afrobeats'),
      tn('reggae', 'Reggae', 'dancehall'),
      tn('latin', 'Latin'),
      t('nineties', '90s'),
      t('noughties', '00s', '2000s'),
    ],
  },
  {
    id: 'sport',
    label: 'Sport',
    categories: ['SPORT'],
    interests: [
      // `football` (and every other discipline below) is the narrowing pick relative to the bare
      // SPORT category — a genuinely different sport is real, positive contradicting evidence.
      // The football-specific leagues directly below are deliberately left `narrows: false`: they
      // sit WITHIN football, not alongside it as a different discipline, so a confirmed Premier
      // League tag must never register as "contradicting" a Championship pick (or vice versa) —
      // that finer distinction is handled by the existing `crew_interest_preference` scoring
      // bonus (a literal league match already outranks a bare football one), never by exclusion.
      tn('football', 'Football', 'footy'),
      t('premier_league', 'Premier League'),
      t('championship_football', 'Championship football', 'championship'),
      t('league_one_two', 'League One & Two', 'league one', 'league two'),
      t('non_league', 'Non-league football', 'non-league'),
      t('womens_football', "Women's football"),
      t('international_football', 'International football', 'england matches', 'internationals'),
      t('champions_league', 'Champions League & Europe', 'europa league', 'champions league'),
      t('local_football', 'Local football'),
      t('watching_big_matches', 'Watching big matches', 'sports bar', 'sports bars'),
      tn('rugby', 'Rugby', 'rugby union', 'rugby league'),
      tn('cricket', 'Cricket'),
      tn('boxing', 'Boxing'),
      tn('mma', 'MMA', 'ufc'),
      tn('tennis', 'Tennis'),
      tn('darts', 'Darts'),
      tn('motorsport', 'F1 & motorsport', 'formula 1', 'f1', 'motorsport'),
      tn('basketball', 'Basketball'),
      tn('ice_hockey', 'Ice hockey'),
      tn('athletics', 'Athletics'),
      tn('golf', 'Golf'),
      tn('cycling', 'Cycling'),
      tn('horse_racing', 'Horse racing', 'racing'),
    ],
  },
  {
    id: 'comedy',
    label: 'Comedy',
    categories: ['COMEDY'],
    interests: [
      t('stand_up', 'Stand-up'),
      t('comedy_clubs', 'Comedy clubs'),
      t('big_touring_comedians', 'Big touring comedians', 'arena comedy'),
      t('emerging_comedians', 'Emerging comedians', 'new material night'),
      t('improv', 'Improv'),
      t('live_podcast', 'Panel & live podcast shows', 'live podcast'),
      t('dark_comedy', 'Dark comedy'),
      t('observational', 'Observational comedy', 'observational'),
      t('alternative_comedy', 'Alternative comedy'),
    ],
  },
  {
    id: 'food',
    label: 'Food',
    categories: ['RESTAURANT', 'DAY_ACTIVITY', 'COMMUNITY'],
    interests: [
      t('restaurants', 'Restaurants'),
      t('street_food', 'Street food'),
      t('food_festivals', 'Food festivals'),
      t('pop_ups', 'Pop-ups', 'pop-up'),
      t('brunch', 'Brunch'),
      t('fine_dining', 'Fine dining', 'tasting menu', 'michelin'),
      t('casual_dining', 'Casual dining', 'casual'),
      t('markets', 'Food markets', 'market'),
      // Cuisine/dietary picks — the same narrowing-within-a-broad-pick relationship as music
      // genres within "live gigs" (see `narrows`'s own doc comment): "Food" + "Japanese" should
      // mean Japanese food specifically, not any restaurant that happens to be nearby and cheap.
      tn('italian', 'Italian'),
      tn('japanese', 'Japanese', 'sushi'),
      tn('thai', 'Thai'),
      tn('indian', 'Indian'),
      tn('mexican', 'Mexican'),
      tn('korean', 'Korean'),
      tn('middle_eastern', 'Middle Eastern'),
      tn('steak', 'Steak'),
      tn('seafood', 'Seafood'),
      tn('vegan', 'Vegan', 'plant-based'),
    ],
  },
  {
    id: 'drinks_nightlife',
    label: 'Drinks & nightlife',
    categories: ['BAR', 'CLUBBING'],
    interests: [
      t('pubs', 'Pubs'),
      t('cocktail_bars', 'Cocktail bars', 'cocktails'),
      t('wine_bars', 'Wine bars'),
      t('breweries', 'Breweries', 'craft beer'),
      t('rooftops', 'Rooftop bars', 'rooftop'),
      t('late_night', 'Late-night', 'late night'),
      t('pub_quizzes', 'Pub quizzes', 'quiz night'),
      t('tastings', 'Tastings', 'wine tasting', 'beer tasting'),
      t('beer_festivals', 'Beer festivals'),
    ],
  },
  {
    id: 'culture',
    label: 'Culture',
    categories: ['THEATRE', 'CINEMA', 'ART_CULTURE'],
    interests: [
      t('theatre', 'Theatre'),
      t('musicals', 'Musicals'),
      t('exhibitions', 'Exhibitions'),
      t('galleries', 'Galleries', 'gallery'),
      t('museums', 'Museums', 'museum'),
      t('film', 'Film', 'cinema'),
      t('independent_cinema', 'Independent cinema', 'indie cinema'),
      t('talks', 'Talks & lectures', 'talk'),
      t('book_events', 'Book events'),
      t('immersive', 'Immersive experiences', 'immersive experience'),
    ],
  },
  {
    id: 'outdoors_active',
    label: 'Outdoors & active',
    categories: ['DAY_ACTIVITY', 'FITNESS'],
    interests: [
      t('hiking', 'Hiking'),
      t('walking', 'Walking'),
      t('cycling_active', 'Cycling'),
      t('running', 'Running'),
      t('climbing', 'Climbing'),
      t('padel', 'Padel'),
      t('golf_active', 'Golf'),
      t('watersports', 'Watersports'),
      t('escape_rooms', 'Escape rooms', 'escape room'),
      t('go_karting', 'Go-karting'),
      t('bowling', 'Bowling'),
      t('activity_bars', 'Activity bars', 'darts bar', 'crazy golf'),
      t('adventure', 'Adventure'),
      t('day_trips', 'Day trips'),
      // Real gap this closes (live product directive's own test-profile example: "family
      // activities, animals, outdoor activities, free events"): neither had any real taxonomy
      // entry before this, despite real mock inventory already existing for both (Trentham
      // Monkey Forest's own subcategories are literally ['nature', 'family'] —
      // providers/mock/activityProvider.ts) with nothing able to match it specifically.
      t('family_days_out', 'Family days out', 'family day out', 'family'),
      t('animals_wildlife', 'Animals & wildlife', 'zoo', 'safari', 'wildlife', 'nature'),
    ],
  },
];

/** Flat lookup, built once — every scoring/matching path needs "give me the interest for this
 *  id" far more often than "give me the whole taxonomy", so this is the shape actually used at
 *  runtime; TASTE_TAXONOMY stays the UI-facing/authoring shape. */
export const TASTE_INTEREST_INDEX: Map<string, { interest: TasteInterest; territory: TasteTerritory }> = new Map();
for (const territory of TASTE_TAXONOMY) {
  for (const interest of territory.interests) {
    TASTE_INTEREST_INDEX.set(interest.id, { interest, territory });
  }
}

export function interestLabel(id: string): string {
  return TASTE_INTEREST_INDEX.get(id)?.interest.label ?? id;
}

/** Every interest whose `categories` include the given ExperienceCategory — how match.ts scopes
 *  which interests are even eligible to match a given Experience. */
export function interestsForCategory(category: string): TasteInterest[] {
  const out: TasteInterest[] = [];
  for (const territory of TASTE_TAXONOMY) {
    if ((territory.categories as string[]).includes(category)) out.push(...territory.interests);
  }
  return out;
}

/**
 * REAL, LIVE-REPORTED BUG this exists to close: a brand-new Crew set its preferences to street
 * food / food festivals / wine bars, and the very first thing Plot ever sent it was a grime
 * artist's tour date — a category so unrelated it would "turn the user straight off" (verbatim).
 * Root cause: COMMUNITY sits in the `food` territory's own `categories` list (a genuine street-
 * food market that a provider can't classify any more specifically still needs a home), but it is
 * ALSO the one category every single live provider adapter (Ticketmaster, Eventbrite, PredictHQ,
 * Skiddle, OpenStreetMap — see each one's own `mapCategory`/`mapEventCode`) falls back to for
 * ANYTHING it cannot confidently classify at all, regardless of what the thing actually is. So
 * "this Experience is COMMUNITY" carries none of the confidence every other category in this
 * taxonomy carries (LIVE_MUSIC, SPORT, RESTAURANT, etc. are only ever assigned from a genuine,
 * specific provider signal) — it just as often means "an under-tagged live-music night" as it
 * does "a genuine community market". Callers that widen a person's or Crew's eligible categories
 * from an interest pick's *territory* alone (apps/api's services/match.ts for Crews,
 * services/tasteSignals.ts for individual Home/Explore) must never grant that widening for a
 * category in this set — only a real, literal interest/text match (the event's own name/
 * description actually saying something food-related) is trustworthy enough evidence for one.
 * Every other category in a territory's `categories` list stays a safe, confidence-carrying
 * signal on its own; this is deliberately the ONE exception, not a general "distrust categories"
 * mechanism.
 */
export const CATCH_ALL_CATEGORIES: ReadonlySet<TasteExperienceCategory> = new Set(['COMMUNITY']);

/**
 * REAL, LIVE-REPORTED BUG this exists to close (the SAME Crew, the SAME "Mr Traumatik" report,
 * reported again after `CATCH_ALL_CATEGORIES` above shipped — the fix for the first cause wasn't
 * enough): a Crew set its preferences to street food / food festivals / wine bars, and Plot's
 * guaranteed-first send was still a completely unrelated artist's tour date — this time
 * categorized CLUBBING, not COMMUNITY. Root cause: `wine_bars` lives under the `drinks_nightlife`
 * territory, whose own `categories` list is `['BAR', 'CLUBBING']` — but a wine bar and a
 * full nightclub/DJ night are genuinely different experiences, not two flavours of the same
 * thing, and a person or Crew who specifically picked "wine bars" said nothing at all about
 * wanting clubbing. This is the general form of a gap `services/personalHome.ts`/
 * `services/tasteSignals.ts` (apps/api) already found and fixed for individual Home/Explore
 * personalisation (CLUBBING is claimed by BOTH the `music` territory AND `drinks_nightlife`;
 * DAY_ACTIVITY is claimed by BOTH `food` AND `outdoors_active`) — a category claimed by more
 * than one territory can't be safely implied from a single interest pick, because a DIFFERENT,
 * unrelated interest under the OTHER territory claiming it would leak in too. That fix lived only
 * in tasteSignals.ts; `services/match.ts`'s own, separate Crew-side implied-category computation
 * never adopted it, so the exact same class of bug reopened there under a different category.
 * Precomputed once, here, as the ONE shared definition every caller that widens eligibility from
 * an interest's *territory* alone (never a literal interest/text match, which is always real
 * evidence regardless of category) must intersect against — so this can never again drift between
 * the Crew-scoring and individual-personalisation call sites the way it just did. Only a category
 * claimed by EXACTLY ONE territory, and not itself a `CATCH_ALL_CATEGORIES` member, is ever safe
 * to imply this way.
 */
export const UNAMBIGUOUS_CATEGORIES: ReadonlySet<TasteExperienceCategory> = (() => {
  const territoryCountByCategory = new Map<TasteExperienceCategory, number>();
  for (const territory of TASTE_TAXONOMY) {
    for (const category of territory.categories) {
      territoryCountByCategory.set(category, (territoryCountByCategory.get(category) ?? 0) + 1);
    }
  }
  return new Set(
    [...territoryCountByCategory.entries()]
      .filter(([category, count]) => count === 1 && !CATCH_ALL_CATEGORIES.has(category))
      .map(([category]) => category),
  );
})();

/**
 * REAL, LIVE-REPORTED BUG this exists to close — the most severe one yet: a person told Plot
 * "I love drill", and Plot showed them a Sam Smith event captioned "because you're into drill".
 * Root cause: `music` is by far the taxonomy's most genre-diverse territory — LIVE_MUSIC and
 * FESTIVAL between them bundle roughly thirty genuinely distinct, often mutually-exclusive
 * genres (a drill fan and a classical fan share nothing except both having picked something
 * under "music") — so the bare "any positive interest implies its whole territory's categories"
 * shortcut every other territory safely relies on (`UNAMBIGUOUS_CATEGORIES` above,
 * apps/api's tasteSignals.ts#categoriesImpliedByInterests, match.ts's own Crew-side equivalent)
 * is uniquely dangerous here: it grants a bare LIVE_MUSIC/FESTIVAL event to ANYONE with ANY
 * positive music-territory interest, genre completely ignored.
 *
 * `TERRITORIES_REQUIRING_EXPLICIT_RELATION` opts a territory OUT of that blanket category-
 * membership shortcut entirely — currently just `music`, the one territory broad and diverse
 * enough for it to produce genuinely wrong, specific claims rather than merely-broad ones.
 * `RELATED_INTERESTS` is what a territory in that set falls back to instead: a small,
 * intentionally sparse, hand-curated map of genuinely close sibling interests — real, specific,
 * testable relationships (brief's own worked example: drill and grime are the same UK scene,
 * commonly enjoyed by the same fans), never inferred from shared category membership. Consulted
 * only against an experience's own LITERAL matched interest tags (`experienceInterestTags`) —
 * this still requires real textual evidence the event is actually that related genre, never a
 * fabricated match. An interest with no entry here has NO close relations; that is the safe
 * default (see this file's own module comment: "a description that never mentions food should
 * return no food interests" — the same honesty rule applies here: an interest simply not
 * matching anything specific is honest, not a bug to paper over with an invented relation).
 * Deliberately small to start — grow it only with real, defensible, specific relationships, never
 * to "make more things eligible" as a goal in itself.
 */
export const TERRITORIES_REQUIRING_EXPLICIT_RELATION: ReadonlySet<string> = new Set(['music']);

export const RELATED_INTERESTS: Readonly<Record<string, readonly string[]>> = {
  drill: ['grime'],
  grime: ['drill'],
  hip_hop: ['rnb'],
  rnb: ['hip_hop'],
  // Real, live-reported ask: a Crew that picked MMA sees a genuine boxing card come up (both
  // combat sports, real fan overlap) — Plot should say so honestly ("you said MMA — this is
  // boxing, closely related"), not either hide it or silently caption it as if it were literally
  // MMA. `sport` itself stays a normal UNAMBIGUOUS_CATEGORIES territory (not moved into
  // TERRITORIES_REQUIRING_EXPLICIT_RELATION — unlike music's ~30 genres, its own hard eligibility
  // gate is still just one category, SPORT, and real provider genre tags are reliably present —
  // see match.ts's own consumer of this entry for exactly how it's used to keep the REASON
  // honest without narrowing which real inventory a Crew can be shown at all).
  boxing: ['mma'],
  mma: ['boxing'],
  // Real, defensible genre-family relationships within `music` (the P0 "K-pop to a Rock crew"
  // fix's own regression coverage: a Crew that picked Rock should see indie/alternative/punk/
  // metal as sensible, closely-related exploration — never treated as a contradiction the same
  // way an unrelated genre like K-pop/pop correctly is — see match.ts's own
  // `contradictsCrewInterestPreference` for exactly how this keeps that distinction honest).
  // Deliberately just this one well-established cluster, not an attempt at a full genre graph.
  rock: ['indie', 'alternative', 'punk', 'metal'],
  indie: ['rock', 'alternative'],
  alternative: ['rock', 'indie'],
  punk: ['rock', 'metal'],
  metal: ['rock', 'punk'],
};
