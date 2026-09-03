import { logger } from './logger';
import { MIN_IMAGE_WIDTH, MIN_ASPECT_RATIO, MAX_ASPECT_RATIO } from './imageDimensions';

/**
 * The final real-photo fallback, for the listing that STILL has no image after a provider's own
 * photo AND artist/venue/team-name enrichment (imageEnrichment.ts's Wikipedia/TheSportsDB lookups)
 * both come up empty — a generic "Quiz Night at The Anchor"-shaped listing has no Wikipedia page
 * to enrich from, but it's still unambiguously a real, identifiable TYPE of event. This is the
 * fix for a real, explicit, repeated product directive: "I don't want to see ANY events without a
 * real image" — not a softer version of it, and not the app's own generated category-art graphic
 * (lib/v2Art.ts on the web side) standing in as if it were a photo. That graphic stays exactly
 * what it always was — a designed placeholder for the render path, never advertised as a photo —
 * but it is no longer an ACCEPTABLE outcome for a synced listing to reach; every real Experience
 * row should carry a genuine photograph by the time this file is done with it.
 *
 * Source: Wikimedia Commons' own `action=query&generator=search` API against the File namespace
 * (ns=6) — the same family of free, key-free, stably-documented, non-scraped Wikimedia REST
 * surface already trusted for the Wikipedia summary enrichment right next to this file (see
 * imageEnrichment.ts's own header comment on why that's a legitimate source, not "any photo that
 * came back"). A broad, honest category search term ("live music concert crowd", "restaurant
 * interior dining", …) reliably has thousands of real, freely-licensed candidate photographs on
 * Commons — nothing here is hand-picked from memory (a single wrong guessed filename would be a
 * real, silent production bug, not a sandbox artifact), it's a live query verified against the
 * real response every time, exactly like the existing Wikipedia lookup.
 *
 * NOT exercised against the live API from this environment — outbound network to
 * commons.wikimedia.org is blocked from the sandbox this was written in (same restriction that
 * already blocks en.wikipedia.org/thesportsdb.com/overpass-api.de — confirmed via curl
 * `connect_rejected` from the agent-proxy, not a production limitation). The endpoint contract
 * (GET .../w/api.php?action=query&generator=search&…, JSON body with `query.pages[].imageinfo`)
 * has been stable and publicly documented for years — verify against Render's own logs once
 * deployed, the same discipline already applied to every other live-provider adapter in this app.
 */

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const FETCH_TIMEOUT_MS = 4000;
// A generous page size — the point isn't finding the single "best" match (there is no such thing
// for a generic category search), it's building a real POOL of genuinely different real photos to
// hash-pick from per item, so ten different comedy nights don't all render the exact same club
// photo — the same "no two same-category tiles should look pixel-identical" principle v2Art.ts
// already applies to its own generated graphics, now applied to real photography too.
const RESULTS_PER_CATEGORY = 20;

export interface EnrichedImage {
  url: string;
  sourcePage: string;
}

// A broad, honest, real-photo search term per category — deliberately generic ("a real photo of
// what this TYPE of event looks like"), never a specific artist/venue name (that's Wikipedia
// enrichment's job, tried first, upstream of this file — see inventorySync.ts's call order).
const CATEGORY_SEARCH_QUERY: Record<string, string> = {
  LIVE_MUSIC: 'live music concert crowd stage',
  CLUBBING: 'nightclub dance floor lights',
  RESTAURANT: 'restaurant interior dining table',
  BAR: 'bar interior cocktails counter',
  COMEDY: 'stand-up comedy club stage',
  THEATRE: 'theatre stage performance auditorium',
  CINEMA: 'cinema auditorium screen seats',
  ART_CULTURE: 'art gallery exhibition visitors',
  SPORT: 'football stadium crowd match',
  FITNESS: 'gym fitness class workout',
  FESTIVAL: 'outdoor music festival crowd',
  DAY_ACTIVITY: 'hiking outdoor adventure countryside',
  COMMUNITY: 'community event people gathering',
  CUSTOM: 'celebration party people',
};
const DEFAULT_QUERY = CATEGORY_SEARCH_QUERY.CUSTOM;

// Process-lifetime memoisation of the whole CANDIDATE POOL per category — one live search per
// category per process, not per listing (a sync run touches hundreds of same-category listings;
// Commons has no need to be asked the same broad query hundreds of times). `null` pool entries
// (a failed/empty search) are cached too, briefly, via the timestamp below, so a down API doesn't
// get hammered once per listing for the rest of the run — but not forever, so a transient outage
// doesn't permanently blind one category for the process's whole lifetime.
interface PoolEntry { images: EnrichedImage[]; fetchedAt: number }
const pool = new Map<string, PoolEntry>();
const POOL_TTL_MS = 30 * 60 * 1000; // 30 minutes — long enough to not re-query mid-sync, short enough that a transient miss self-heals well within one day's sync cadence
// Real, production-confirmed bug this fixes — see pexelsStockImages.ts's own EMPTY_POOL_TTL_MS
// comment for the full story (a live backfill run filled only 144/432 rows, a category-shaped
// miss pattern that a same-TTL-for-failures cache exactly produces). A failed/empty search now
// expires in 30 seconds, not 30 minutes, so it self-heals within a single run.
const EMPTY_POOL_TTL_MS = 30 * 1000;

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface CommonsImageInfo {
  url?: string; // the full original file — often huge (tens of MB); not what gets displayed
  width?: number;
  height?: number;
  // Present because of `iiurlwidth` in the request below — a pre-scaled real photo at a sane hero-
  // image size, proportionally sized from the original, exactly what actually gets stored/shown.
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  mime?: string; // see PHOTO_MIME_TYPES's own comment below for why this is checked
}

// Real, production-confirmed bug this fixes: Wikimedia Commons stores scanned PDFs (old
// magazines, reports, newsletters) in the exact same File: namespace as photographs, and
// CirrusSearch's full-text search matches a PDF's own OCR'd text/description — a broad query like
// "nightclub dance floor lights" genuinely matched things like a 1994 naval facility energy-
// management report and a 1980s university yearbook, because ONE of those words happened to
// appear somewhere in the document. Commons renders a page-1 thumbnail for a PDF too, so it passed
// through as a normal `imageinfo` result — its DECLARED width even cleared this file's own
// MIN_IMAGE_WIDTH filter below, only for the real byte-probe further downstream (inventorySync.ts)
// to correctly catch that the actual served file was far smaller than declared and reject it. That
// safety net was working exactly as designed — but for the CLUBBING category specifically, so many
// of its top search results were mismatched PDFs that almost nothing real ever got through. The
// real fix is here, not downstream: only actual photograph file types are ever added to the pool.
const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
interface CommonsPage { title?: string; imageinfo?: CommonsImageInfo[] }
interface CommonsSearchResponse { query?: { pages?: Record<string, CommonsPage> } }

async function fetchCandidatePool(query: string): Promise<{ images: EnrichedImage[]; rawCount: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrnamespace: '6', // File: namespace only
      gsrlimit: String(RESULTS_PER_CATEGORY),
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      iiurlwidth: '1920', // ask Commons for an already-scaled real photo, not the raw (sometimes 20MB+) original
      format: 'json',
    });
    const res = await fetch(`${COMMONS_API}?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Plot/1.0 (https://plotmaker.co.uk; category-stock-image-search)' },
    });
    if (!res.ok) throw new Error(`Wikimedia Commons search returned ${res.status}`);
    const body = (await res.json()) as CommonsSearchResponse;
    const pages = Object.values(body.query?.pages ?? {});
    const rawCount = pages.length;
    const candidates: EnrichedImage[] = [];
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      // The real fix — see PHOTO_MIME_TYPES's own comment above. A missing mime (shouldn't happen
      // per Commons' own API contract, but never trusted blindly) is treated as "not a photo",
      // the same fail-closed posture as every other unprovable check in this app.
      if (!info.mime || !PHOTO_MIME_TYPES.has(info.mime)) continue;
      // Prefer the pre-scaled thumb (a sane real file size to actually serve) — falls back to the
      // full original only for the rare file MediaWiki didn't scale (already smaller than the
      // requested 1920px, so no thumb was generated).
      const url = info.thumburl ?? info.url;
      const width = info.thumbwidth ?? info.width;
      const height = info.thumbheight ?? info.height;
      if (!url || !width || !height) continue;
      // Same floor as everywhere else real photography is judged in this app (lib/imageDimensions
      // .ts) — a search result that's too small or too extreme an aspect ratio to be a usable hero
      // image is filtered out of the pool here rather than trusted through to a listing.
      if (width < MIN_IMAGE_WIDTH) continue;
      const ratio = width / height;
      if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) continue;
      candidates.push({ url, sourcePage: page.title ?? query });
    }
    return { images: candidates, rawCount };
  } finally {
    clearTimeout(timer);
  }
}

async function getCandidatePool(category: string): Promise<EnrichedImage[]> {
  const query = CATEGORY_SEARCH_QUERY[category] ?? DEFAULT_QUERY;
  const cached = pool.get(category);
  if (cached) {
    const ttl = cached.images.length > 0 ? POOL_TTL_MS : EMPTY_POOL_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.images;
  }

  // Real diagnostic gap found live — see pexelsStockImages.ts's own `missingKeyLogged` comment for
  // the full story: a production run filled 0/288 rows with NO warning logged here either, leaving
  // no way to tell "the search succeeded but nothing passed the quality filter" apart from "it's
  // silently broken somehow". Every fresh (non-cached) search now logs its raw/filtered candidate
  // counts at info level regardless of outcome.
  const { images, rawCount } = await fetchCandidatePool(query).catch((err) => {
    logger.warn({ err, category, query }, 'Wikimedia Commons category-stock image search failed — continuing without one');
    return { images: [] as EnrichedImage[], rawCount: 0 };
  });
  logger.info({ category, query, rawCount, keptCount: images.length }, 'Wikimedia Commons category-stock search complete');
  pool.set(category, { images, fetchedAt: Date.now() });
  return images;
}

/**
 * A real, category-appropriate photograph for a listing that has no more specific image — the
 * last resort tried before a listing is left with no imageUrl at all (inventorySync.ts). `seed`
 * should be stable per listing (its name, or canonical key) so the SAME listing always lands on
 * the same photo across resyncs, while DIFFERENT listings in the same category spread across the
 * whole candidate pool instead of all converging on the pool's first/best result.
 */
export async function getCategoryStockImage(category: string | null | undefined, seed: string): Promise<EnrichedImage | null> {
  const images = await getCandidatePool(category ?? 'CUSTOM');
  if (images.length === 0) return null;
  const idx = hashString(`${category ?? 'CUSTOM'}:${seed}`) % images.length;
  return images[idx];
}

/** Test-only: clears the in-process candidate-pool cache so each test starts from a clean slate. */
export function __resetCategoryStockImageCacheForTests(): void {
  pool.clear();
}
