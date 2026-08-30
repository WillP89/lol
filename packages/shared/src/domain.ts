/**
 * Cross-app domain types shared between the API and the web client.
 * These mirror (but do not replace) the Prisma schema in apps/api/prisma/schema.prisma —
 * Prisma generates the persistence-layer types; these are the wire-format / API-contract
 * types, deliberately decoupled so the database schema can evolve without breaking clients.
 */

// ---------- Plan lifecycle (see docs/ARCHITECTURE.md §Plan Pulse) ----------

export const PlanStatus = {
  Idea: 'IDEA', // soft plan, no venue/time locked
  Shared: 'SHARED', // Plan Card sent to crew
  GatheringInterest: 'GATHERING_INTEREST', // 1+ vote in, threshold not yet met
  Likely: 'LIKELY', // majority threshold met, not yet locked
  Ready: 'READY', // "this one's happening" — booking can proceed
  Booked: 'BOOKED',
  Completed: 'COMPLETED',
  Cancelled: 'CANCELLED',
} as const;
export type PlanStatusValue = (typeof PlanStatus)[keyof typeof PlanStatus];

export type VoteValue = 'in' | 'maybe' | 'out';

export interface PlanPulse {
  inCount: number;
  maybeCount: number;
  outCount: number;
  noResponseCount: number;
  totalMembers: number;
  /** 0-1: inCount / totalMembers, the number Plan Pulse UI renders as filled flames. */
  level: number;
  status: PlanStatusValue;
}

// ---------- Taste / Group DNA ----------

export interface TasteVector {
  /** category -> affinity score, -1 (not me) .. 1 (yes) */
  categories: Record<string, number>;
  budgetMinMinor: number;
  budgetMaxMinor: number;
  currency: string;
  travelRadiusMeters: number;
  energyPreference: 'low' | 'medium' | 'high';
}

export interface CrewDNA {
  crewId: string;
  memberCount: number;
  /** How much signal this is based on — low confidence for brand-new crews. See §Cold start. */
  confidence: 'low' | 'medium' | 'high';
  topCategories: string[];
  medianSpendMinor: number;
  currency: string;
  bestNights: string[]; // e.g. ['FRI', 'SAT']
  usualAreas: string[];
  planningPersonality: 'last_minute' | 'planner' | 'mixed';
  computedAt: string;
}

// ---------- Canonical inventory (see docs/ARCHITECTURE.md §Provider abstraction) ----------

export type ExperienceCategory =
  | 'live_music'
  | 'clubbing'
  | 'restaurant'
  | 'bar'
  | 'comedy'
  | 'theatre'
  | 'cinema'
  | 'art_culture'
  | 'sport'
  | 'fitness'
  | 'festival'
  | 'day_activity'
  | 'community';

export interface CanonicalEvent {
  id: string;
  canonicalKey: string; // stable dedup key, see entity-resolution.ts
  name: string;
  description: string;
  category: ExperienceCategory;
  subcategories: string[];
  venueName: string;
  latitude: number;
  longitude: number;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  currency: string;
  bookingStatus: 'available' | 'limited' | 'sold_out' | 'unknown';
  imageUrl: string | null;
  tags: {
    energy?: 'low' | 'medium' | 'high';
    formality?: 'casual' | 'smart_casual' | 'formal';
    crowd?: 'mainstream' | 'alternative' | 'local' | 'touristy';
    groupFriendly?: boolean;
    dateFriendly?: boolean;
    indoorOutdoor?: 'indoor' | 'outdoor' | 'mixed';
  };
  qualityScore: number; // 0-100, see quality-scoring.ts
  provider: string; // adapter id, e.g. 'mock_ticketing'
  providerListingId: string;
  externalUrl: string;
  lastRefreshedAt: string;
}

// ---------- Match / recommendation explainability ----------

export interface MatchReason {
  code: string; // stable key, e.g. 'under_budget', 'category_affinity', 'friend_saved'
  label: string; // human-readable, e.g. "Under your Crew's typical spend"
}

export interface MatchOption {
  event: CanonicalEvent;
  matchScore: number; // 0-100
  reasons: MatchReason[];
  availableMemberCount: number;
  totalMemberCount: number;
  estimatedTravelMinutes: number | null;
}
