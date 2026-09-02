import { logger } from './logger';
import { config } from './config';

/**
 * Real-image enrichment for a listing whose primary provider gave no photo (PLOT-CONTENT
 * directive §7). Wikipedia's own REST "page summary" endpoint (`/api/rest_v1/page/summary/…`)
 * is the pragmatic legitimate source for this — free, no API key, no registration, stable for
 * years, and its `thumbnail`/`originalimage` fields are exactly the well-known artist/comedian/
 * venue/attraction photo that already sits in that subject's Wikipedia infobox: licensed under
 * one of Wikimedia Commons' allowed Creative Commons licenses (BY / BY-SA) or public domain —
 * genuinely legitimate for this use, unlike scraping arbitrary image search results (explicitly
 * banned by the directive). This is deliberately NOT a general image search: it only ever
 * returns an image when Wikipedia has an actual page matching the query closely enough to
 * disambiguate on the first try, which is a real (if imperfect) proxy for "this is a real,
 * identifiable subject", not "any photo that came back".
 *
 * NOT exercised against the live API from this environment — outbound network to
 * en.wikipedia.org is blocked from the sandbox this was written in (same restriction that
 * blocks Ticketmaster/Eventbrite/Postmark; confirmed via both direct curl and the WebFetch tool
 * during this session). The endpoint contract itself (GET .../page/summary/<title>, JSON body
 * with `thumbnail.source`/`originalimage.source`, 404 on no match) has been stable and publicly
 * documented for years — verify against Render's own logs once deployed, the same discipline
 * already applied to the Ticketmaster/Eventbrite adapters.
 */

const WIKIPEDIA_SUMMARY_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const FETCH_TIMEOUT_MS = 4000;

export interface EnrichedImage {
  url: string;
  /** The Wikipedia article this came from — kept for attribution, not shown to end users as a link target. */
  sourcePage: string;
}

// Process-lifetime memoisation: the same artist/venue name legitimately recurs across many
// listings within one sync run (a touring artist's whole date list, a venue's whole programme),
// and Wikipedia has no need to be asked the same question twice in the same process — cheap,
// dependency-free, and directly serves directive §15 ("provider-level caching, request dedupe").
const cache = new Map<string, EnrichedImage | null>();

const SPORTSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/';
// TheSportsDB's own published free test key — documented by TheSportsDB itself as fine for
// exactly this kind of light, low-volume use (thesportsdb.com/documentation), not indefinite
// production volume. `SPORTSDB_API_KEY` (config.ts) is the real-key upgrade path — set it once
// sync volume justifies registering one; unset, this falls back to the shared test key.
const SPORTSDB_KEY = () => config.SPORTSDB_API_KEY ?? '123';
const sportsDbCache = new Map<string, EnrichedImage | null>();

/** SPORT-category events benefit from a real team badge more than an arbitrary Wikipedia photo
 * — tried first for that one category (see inventorySync.ts), falling through to Wikipedia
 * enrichment on a miss (a smaller local team genuinely might not be in TheSportsDB's top-flight-
 * skewed database, and TheSportsDB's own free-key result cap is 10 — a real, documented
 * limitation, not a bug). NOT exercised against the live API from this environment — see this
 * file's own top comment for why (same egress restriction, confirmed for thesportsdb.com too). */
export async function enrichImageFromTheSportsDb(teamOrEventName: string): Promise<EnrichedImage | null> {
  const key = teamOrEventName.trim().toLowerCase();
  if (!key) return null;
  if (sportsDbCache.has(key)) return sportsDbCache.get(key) ?? null;

  const result = await fetchTeamBadge(teamOrEventName).catch((err) => {
    logger.warn({ err, teamOrEventName }, 'TheSportsDB image enrichment failed — continuing without an image');
    return null;
  });
  sportsDbCache.set(key, result);
  return result;
}

interface SportsDbTeam {
  strTeam?: string;
  strTeamBadge?: string;
  strTeamFanart1?: string;
}
interface SportsDbSearchResponse {
  teams?: SportsDbTeam[] | null;
}

async function fetchTeamBadge(name: string): Promise<EnrichedImage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // A sport event's own title is rarely a clean team name ("Aston Villa vs Everton" isn't
    // "Aston Villa") — a best-effort first-word-pair heuristic, deliberately conservative: a
    // miss here just falls through to Wikipedia enrichment, never blocks the sync.
    const candidate = name.split(/\s+(?:vs\.?|v\.?|@)\s+/i)[0].trim();
    const url = `${SPORTSDB_BASE}${SPORTSDB_KEY()}/searchteams.php?t=${encodeURIComponent(candidate)}`;
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Plot/1.0 (https://plotmaker.co.uk; discovery-image-enrichment)' } });
    if (!res.ok) throw new Error(`TheSportsDB returned ${res.status}`);
    const body = (await res.json()) as SportsDbSearchResponse;
    const team = body.teams?.[0];
    const badge = team?.strTeamBadge ?? team?.strTeamFanart1;
    if (!badge) return null;
    return { url: badge, sourcePage: team?.strTeam ?? candidate };
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichImageFromWikipedia(name: string): Promise<EnrichedImage | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;

  const result = await fetchSummary(name).catch((err) => {
    logger.warn({ err, name }, 'Wikipedia image enrichment failed — continuing without an image');
    return null;
  });
  cache.set(key, result);
  return result;
}

interface WikipediaSummary {
  type?: string; // 'standard' | 'disambiguation' | 'no-extract' | …
  title?: string;
  thumbnail?: { source?: string; width?: number; height?: number };
  originalimage?: { source?: string; width?: number; height?: number };
}

// Same reasoning, same number, as ticketmaster.ts's own MIN_IMAGE_WIDTH and lib/imageDimensions
// .ts's own (the real, final authority — this is just a coarse first pass) — a card renders this
// full-bleed up to a ~900px-wide desktop hero, and a bitmap narrower than that gets visibly
// blown up past its native resolution ("stretched and distorted", not premium). Wikipedia's
// REST summary almost always includes `originalimage` (the full-resolution source file)
// alongside `thumbnail` (a small, fixed-width crop) — this only matters for the rare case where
// only the thumbnail came back.
const MIN_IMAGE_WIDTH = 1000;

async function fetchSummary(name: string): Promise<EnrichedImage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${WIKIPEDIA_SUMMARY_BASE}${encodeURIComponent(name)}`, {
      signal: controller.signal,
      headers: {
        // Wikimedia's own etiquette guideline (meta.wikimedia.org/wiki/User-Agent_policy) asks
        // for an identifying User-Agent on programmatic access — a real, honest header, not a
        // spoofed browser one.
        'User-Agent': 'Plot/1.0 (https://plotmaker.co.uk; discovery-image-enrichment)',
      },
    });
    if (res.status === 404) return null; // no matching article — a real, expected outcome, not an error
    if (!res.ok) throw new Error(`Wikipedia summary API returned ${res.status}`);

    const body = (await res.json()) as WikipediaSummary;
    // A disambiguation page ("Nia" could mean a dozen things) or a stub with no extract is not
    // a confident match — better to show no image than the wrong person/venue's photo.
    if (body.type && body.type !== 'standard') return null;

    // originalimage is the full-resolution source file — trusted at whatever size it reports,
    // since it's never a fixed-width crop the way thumbnail is. A bare thumbnail is only used
    // when it clears the same resolution floor every other provider adapter applies; a small one
    // is worse than no photo (v2Art's editorial fallback), not better.
    const url = body.originalimage?.source ?? (body.thumbnail && (body.thumbnail.width ?? 0) >= MIN_IMAGE_WIDTH ? body.thumbnail.source : undefined);
    if (!url) return null;
    return { url, sourcePage: body.title ?? name };
  } finally {
    clearTimeout(timer);
  }
}
