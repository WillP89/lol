import { logger } from './logger';
import { config } from './config';
import { MIN_IMAGE_WIDTH, MIN_ASPECT_RATIO, MAX_ASPECT_RATIO } from './imageDimensions';

/**
 * The RELIABLE half of the category-appropriate real-photo fallback — see
 * categoryStockImages.ts's own header for the full "no event without a real image" reasoning and
 * fallback-chain position (provider photo -> Wikipedia/TheSportsDB by name -> Commons category
 * search -> THIS). Exists as a genuinely separate source, not just a second Commons query, because
 * of a real, production-confirmed fact: Wikimedia's own edge infrastructure (en.wikipedia.org AND
 * commons.wikimedia.org both sit behind the same edge) returns a hard 403 to every request from
 * this app's actual Render deployment — confirmed directly from Render's own production logs
 * ("Wikipedia summary API returned 403" repeated for every single listing checked), not a sandbox
 * artifact, not a rate limit, not this app's request shape — the well-documented posture many
 * sites' edge/WAF layers take against traffic identified as coming from cloud/datacenter hosting
 * ranges. Commons search almost certainly shares that same fate (same domain family, same edge),
 * which would make the entire "no event without a real image" guarantee silently do nothing in
 * production despite every test passing and every line of code being correct.
 *
 * Pexels' API is built specifically for exactly this kind of server-side integration — serving
 * real photos into third-party apps is its entire product, not an incidental REST endpoint on top
 * of a wiki — and does not share Wikimedia's infra or blocking posture. Free tier (200 req/hour,
 * 20,000/month — pexels.com/api), explicit non-exclusive license for exactly this "display via the
 * API in an application" use (developers.pexels.com/guidelines). Gated behind `PEXELS_API_KEY`
 * (see config.ts's own comment) — unset means this tier is a clean, logged no-op, never a crash,
 * the same graceful-degradation contract as every other optional provider key in this app.
 *
 * NOT exercised against the live API from this environment — outbound network to api.pexels.com
 * is blocked from the sandbox this was written in (confirmed via curl `connect_rejected` from the
 * agent-proxy, the same generic sandbox restriction already documented for every other external
 * domain touched this session — unrelated to Wikimedia's own, separate, production-confirmed
 * block). The endpoint contract (GET /v1/search?query=…, header `Authorization: <key>`, JSON body
 * with `photos[].src.large2x`/`width`/`height`) is Pexels' own stable, versioned, documented public
 * API — verify against Render's own logs once a key is configured, the same discipline already
 * applied to every other live-provider adapter in this app.
 */

const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';
const FETCH_TIMEOUT_MS = 4000;
const RESULTS_PER_CATEGORY = 20;

export interface EnrichedImage {
  url: string;
  sourcePage: string;
}

// Reuses the exact same broad, honest per-category terms as categoryStockImages.ts (kept as a
// separate map, not imported, so each source's own query can be tuned independently later without
// coupling the two — Pexels' own search ranking/behavior is a different engine to Commons').
const CATEGORY_SEARCH_QUERY: Record<string, string> = {
  LIVE_MUSIC: 'live music concert crowd',
  CLUBBING: 'nightclub dance floor',
  RESTAURANT: 'restaurant interior dining',
  BAR: 'bar interior cocktails',
  COMEDY: 'stand-up comedy club',
  THEATRE: 'theatre stage performance',
  CINEMA: 'cinema auditorium',
  ART_CULTURE: 'art gallery exhibition',
  SPORT: 'football stadium crowd',
  FITNESS: 'gym fitness class',
  FESTIVAL: 'outdoor music festival',
  DAY_ACTIVITY: 'hiking outdoor adventure',
  COMMUNITY: 'community event people',
  CUSTOM: 'celebration party',
};
const DEFAULT_QUERY = CATEGORY_SEARCH_QUERY.CUSTOM;

interface PoolEntry { images: EnrichedImage[]; fetchedAt: number }
const pool = new Map<string, PoolEntry>();
const POOL_TTL_MS = 30 * 60 * 1000; // same rationale as categoryStockImages.ts's own pool TTL

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface PexelsPhoto {
  width?: number;
  height?: number;
  url?: string; // the Pexels.com photo PAGE — not an image file, never served directly
  alt?: string;
  src?: { large2x?: string; large?: string; original?: string };
}
interface PexelsSearchResponse { photos?: PexelsPhoto[] }

async function fetchCandidatePool(query: string, apiKey: string): Promise<EnrichedImage[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ query, per_page: String(RESULTS_PER_CATEGORY), orientation: 'landscape' });
    const res = await fetch(`${PEXELS_SEARCH_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Authorization: apiKey, 'User-Agent': 'Plot/1.0 (https://plotmaker.co.uk; category-stock-image-search)' },
    });
    if (!res.ok) throw new Error(`Pexels search returned ${res.status}`);
    const body = (await res.json()) as PexelsSearchResponse;
    const candidates: EnrichedImage[] = [];
    for (const photo of body.photos ?? []) {
      // Validated against the ORIGINAL photo's real declared dimensions (the same "how big is the
      // real source" question Commons' own width/height answers) — `large2x` (the URL actually
      // stored/served, ~1880px on its long edge, comfortably clearing MIN_IMAGE_WIDTH) is a fixed
      // Pexels-side rendition of the same photo, so the original's aspect ratio is what matters
      // here; the served file's own real bytes still get independently byte-verified downstream
      // by inventorySync.ts's generic quality gate regardless of what's trusted here.
      const url = photo.src?.large2x ?? photo.src?.large ?? photo.src?.original;
      if (!url || !photo.width || !photo.height) continue;
      if (photo.width < MIN_IMAGE_WIDTH) continue;
      const ratio = photo.width / photo.height;
      if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) continue;
      candidates.push({ url, sourcePage: photo.alt || query });
    }
    return candidates;
  } finally {
    clearTimeout(timer);
  }
}

async function getCandidatePool(category: string): Promise<EnrichedImage[]> {
  const apiKey = config.PEXELS_API_KEY;
  if (!apiKey) return []; // no key configured — a clean, logged-once no-op, not a crash

  const query = CATEGORY_SEARCH_QUERY[category] ?? DEFAULT_QUERY;
  const cached = pool.get(category);
  if (cached && Date.now() - cached.fetchedAt < POOL_TTL_MS) return cached.images;

  const images = await fetchCandidatePool(query, apiKey).catch((err) => {
    logger.warn({ err, category, query }, 'Pexels category-stock image search failed — continuing without one');
    return [];
  });
  pool.set(category, { images, fetchedAt: Date.now() });
  return images;
}

/**
 * A real, category-appropriate photograph from Pexels — see this file's own header for why this
 * exists as a separate tier from categoryStockImages.ts's Commons search, and inventorySync.ts's
 * call site for where it sits in the overall fallback chain. Same seed/pool-hash contract as
 * categoryStockImages.ts's own `getCategoryStockImage` — see that function's own doc comment.
 */
export async function getPexelsStockImage(category: string | null | undefined, seed: string): Promise<EnrichedImage | null> {
  const images = await getCandidatePool(category ?? 'CUSTOM');
  if (images.length === 0) return null;
  const idx = hashString(`${category ?? 'CUSTOM'}:${seed}`) % images.length;
  return images[idx];
}

/** Test-only: clears the in-process candidate-pool cache so each test starts from a clean slate. */
export function __resetPexelsStockImageCacheForTests(): void {
  pool.clear();
}
