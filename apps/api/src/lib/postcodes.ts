import { logger } from './logger';

/**
 * Real UK postcode -> coordinates resolution via postcodes.io — free, no API key, no
 * registration, built on Ordnance Survey/ONS open data (the Office for National Statistics'
 * own postcode-to-geography product), actively maintained, and widely used in production by
 * other UK civic-tech and consumer products. This is the "Even a postcode" part of the
 * directive: typing a real postcode into Explore's location search resolves to a real point,
 * not a fabricated one.
 *
 * NOT exercised against the live API from this environment — outbound network to
 * api.postcodes.io is blocked from the sandbox this was written in (the same restriction that
 * blocks every other live provider this session touched — Ticketmaster, Wikipedia, Overpass,
 * confirmed via direct curl and WebFetch). The endpoint contract itself (GET
 * /postcodes/<postcode>, GET /outcodes/<outcode>, JSON body with result.latitude/longitude,
 * 404 on no match) is publicly documented and has been stable for years — verify against
 * Render's own logs once deployed, the same discipline already applied to every other live
 * adapter this session added.
 */

const POSTCODES_BASE = 'https://api.postcodes.io';
const FETCH_TIMEOUT_MS = 4000;

export interface ResolvedPostcode {
  /** The normalised postcode/outcode as postcodes.io returns it, e.g. "ST16 2LZ" or "ST16". */
  label: string;
  /** Whether this was a full postcode or just an outward code (partial postcode / postcode district). */
  kind: 'postcode' | 'outcode';
  district: string;
  lat: number;
  lng: number;
}

// Full UK postcode, e.g. "ST16 2LZ", "SW1A 1AA" — space optional. Outward code alone (the part
// before the space, e.g. "ST16", "SW1A", "M1") is the more common partial-search case ("someone
// starts typing a postcode") and is checked separately below.
const FULL_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

/** True for anything shaped like a UK postcode or outward code — used by /locations/search to
 * decide whether a query is worth a postcode lookup at all, rather than firing one on every
 * keystroke of an ordinary town-name search. */
export function looksLikeUkPostcode(query: string): boolean {
  const q = query.trim();
  return FULL_POSTCODE_RE.test(q) || OUTCODE_RE.test(q);
}

const cache = new Map<string, ResolvedPostcode | null>();

export async function resolvePostcode(query: string): Promise<ResolvedPostcode | null> {
  const q = query.trim().toUpperCase();
  if (!q) return null;
  if (cache.has(q)) return cache.get(q) ?? null;

  const result = await fetchPostcode(q).catch((err) => {
    logger.warn({ err, query: q }, 'Postcode lookup failed — continuing without it');
    return null;
  });
  cache.set(q, result);
  return result;
}

async function fetchPostcode(q: string): Promise<ResolvedPostcode | null> {
  // A full postcode always wins when the input parses as one — more precise than treating
  // "ST16 2LZ" as an outcode lookup on just its first half. Falls back to the outcode endpoint
  // (a postcode DISTRICT centroid — less precise, but real) for a partial entry.
  if (FULL_POSTCODE_RE.test(q)) {
    const full = await fetchFrom(`${POSTCODES_BASE}/postcodes/${encodeURIComponent(q)}`);
    if (full) return full;
    // Some valid-shaped inputs aren't real allocated postcodes (postcodes.io 404s); fall through
    // to treating the outward-code portion as a district search rather than giving up entirely.
  }
  const outcode = q.split(/\s+/)[0];
  if (!OUTCODE_RE.test(outcode)) return null;
  return fetchFrom(`${POSTCODES_BASE}/outcodes/${encodeURIComponent(outcode)}`, true);
}

interface PostcodesIoResult {
  result?: {
    postcode?: string;
    outcode?: string;
    latitude?: number;
    longitude?: number;
    admin_district?: string | null;
    region?: string | null;
  } | null;
}

async function fetchFrom(url: string, isOutcode = false): Promise<ResolvedPostcode | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Plot/1.0 (https://plotmaker.co.uk; postcode-location-search)' },
    });
    if (res.status === 404) return null; // not a real/allocated postcode — a real, expected outcome
    if (!res.ok) throw new Error(`postcodes.io returned ${res.status}`);
    const body = (await res.json()) as PostcodesIoResult;
    const r = body.result;
    if (!r || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return null;
    return {
      label: r.postcode ?? r.outcode ?? url.split('/').pop() ?? '',
      kind: isOutcode ? 'outcode' : 'postcode',
      district: r.admin_district ?? r.region ?? '',
      lat: r.latitude,
      lng: r.longitude,
    };
  } finally {
    clearTimeout(timer);
  }
}
