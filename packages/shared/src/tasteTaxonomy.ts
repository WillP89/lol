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
      t('indie', 'Indie', 'indie rock'),
      t('rock', 'Rock'),
      t('alternative', 'Alternative', 'alt rock'),
      t('pop', 'Pop'),
      t('hip_hop', 'Hip-hop & rap', 'hip-hop/rap', 'rap'),
      // Real gap this closes (live product directive, worked example verbatim): "RAP / UK RAP /
      // GRIME / DRILL / OLD SCHOOL... where metadata genuinely supports it" — grime and drill are
      // real, distinct UK genres, not synonyms of the broader "hip-hop & rap" bucket above; a
      // person who's specifically into one shouldn't be treated as generically "into rap".
      t('grime', 'Grime'),
      t('drill', 'Drill', 'uk drill'),
      t('rnb', 'R&B', 'r and b', 'rnb'),
      t('house', 'House'),
      t('techno', 'Techno'),
      t('drum_and_bass', 'Drum & bass', "d'n'b", 'dnb', 'jungle'),
      t('uk_garage', 'UK garage', 'garage', '2-step'),
      t('disco', 'Disco'),
      t('soul_funk', 'Soul & funk', 'soul', 'funk'),
      t('jazz', 'Jazz'),
      t('country', 'Country'),
      t('folk', 'Folk'),
      t('metal', 'Metal'),
      t('punk', 'Punk'),
      t('classical', 'Classical'),
      t('electronic', 'Electronic'),
      t('afrobeats', 'Afrobeats'),
      t('reggae', 'Reggae', 'dancehall'),
      t('latin', 'Latin'),
      t('nineties', '90s'),
      t('noughties', '00s', '2000s'),
    ],
  },
  {
    id: 'sport',
    label: 'Sport',
    categories: ['SPORT'],
    interests: [
      t('football', 'Football', 'footy'),
      t('premier_league', 'Premier League'),
      t('championship_football', 'Championship football', 'championship'),
      t('league_one_two', 'League One & Two', 'league one', 'league two'),
      t('non_league', 'Non-league football', 'non-league'),
      t('womens_football', "Women's football"),
      t('international_football', 'International football', 'england matches', 'internationals'),
      t('champions_league', 'Champions League & Europe', 'europa league', 'champions league'),
      t('local_football', 'Local football'),
      t('watching_big_matches', 'Watching big matches', 'sports bar', 'sports bars'),
      t('rugby', 'Rugby', 'rugby union', 'rugby league'),
      t('cricket', 'Cricket'),
      t('boxing', 'Boxing'),
      t('mma', 'MMA', 'ufc'),
      t('tennis', 'Tennis'),
      t('darts', 'Darts'),
      t('motorsport', 'F1 & motorsport', 'formula 1', 'f1', 'motorsport'),
      t('basketball', 'Basketball'),
      t('ice_hockey', 'Ice hockey'),
      t('athletics', 'Athletics'),
      t('golf', 'Golf'),
      t('cycling', 'Cycling'),
      t('horse_racing', 'Horse racing', 'racing'),
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
      t('italian', 'Italian'),
      t('japanese', 'Japanese', 'sushi'),
      t('thai', 'Thai'),
      t('indian', 'Indian'),
      t('mexican', 'Mexican'),
      t('korean', 'Korean'),
      t('middle_eastern', 'Middle Eastern'),
      t('steak', 'Steak'),
      t('seafood', 'Seafood'),
      t('vegan', 'Vegan', 'plant-based'),
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
