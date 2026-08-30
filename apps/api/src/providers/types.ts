import type { ExperienceCategory } from '@prisma/client';

/**
 * Every inventory source — Ticketmaster, DICE, OpenTable, a manually-curated spreadsheet —
 * implements this same interface. Product/Match code never talks to a provider directly; it
 * only ever sees canonical `Experience` rows (see prisma schema comment (1) and
 * services/entityResolution.ts). This is what lets us add a new supplier without touching the
 * recommendation engine, and what stops the catalogue being biased toward "whichever provider
 * has the easiest API" (brief §3).
 */
export interface RawListing {
  /** Provider's own id for this listing — used for the (providerId, providerListingId) unique key. */
  externalId: string;
  raw: unknown; // the untouched payload, kept for debugging/re-mapping later
}

export interface ProviderHealth {
  status: 'ACTIVE' | 'DEGRADED' | 'DOWN';
  error?: string;
  checkedAt: Date;
}

export interface FetchListingsParams {
  city: string;
  fromDate: Date;
  toDate: Date;
}

export interface ProviderAdapter {
  id: string;
  displayName: string;
  categories: ExperienceCategory[];
  /** Whether this adapter has real credentials configured — false means it's running in mock mode. */
  isLive: boolean;

  healthCheck(): Promise<ProviderHealth>;
  fetchListings(params: FetchListingsParams): Promise<RawListing[]>;
  /** Maps one provider-native raw payload into Plot's canonical shape. Throws on malformed data — the sync
   *  job catches per-listing errors so one bad record can't fail an entire sync run. */
  mapToCanonical(listing: RawListing): CanonicalListingInput;
}

/** What entityResolution.ts needs to decide "is this the same Experience as one we already have?" */
export interface CanonicalListingInput {
  name: string;
  description: string;
  category: ExperienceCategory;
  subcategories: string[];
  venueName: string;
  latitude: number;
  longitude: number;
  startsAt: Date;
  endsAt: Date | null;
  timezone: string;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  currency: string;
  bookingStatus: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN';
  imageUrl: string | null;
  tags: Record<string, unknown>;
  externalUrl: string;
  commissionEligible: boolean;
}
