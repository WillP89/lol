-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'DELETED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('HOME', 'WORK', 'FAVOURITE', 'CITY');

-- CreateEnum
CREATE TYPE "EnergyLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AuthTokenPurpose" AS ENUM ('MAGIC_LINK', 'EMAIL_VERIFY');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('APPLE', 'GOOGLE');

-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CrewRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "CrewMemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'LEFT');

-- CreateEnum
CREATE TYPE "DnaConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "PlanningPersonality" AS ENUM ('LAST_MINUTE', 'PLANNER', 'MIXED');

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE', 'APPLE', 'MICROSOFT');

-- CreateEnum
CREATE TYPE "CalendarConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "AvailabilitySource" AS ENUM ('CALENDAR_SYNC', 'MANUAL', 'INFERRED');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'DOWN', 'DISABLED');

-- CreateEnum
CREATE TYPE "ExperienceCategory" AS ENUM ('LIVE_MUSIC', 'CLUBBING', 'RESTAURANT', 'BAR', 'COMEDY', 'THEATRE', 'CINEMA', 'ART_CULTURE', 'SPORT', 'FITNESS', 'FESTIVAL', 'DAY_ACTIVITY', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('AVAILABLE', 'LIMITED', 'SOLD_OUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PlanStatusValue" AS ENUM ('IDEA', 'SHARED', 'GATHERING_INTEREST', 'LIKELY', 'READY', 'BOOKED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VoteValue" AS ENUM ('IN', 'MAYBE', 'OUT');

-- CreateEnum
CREATE TYPE "BookingModel" AS ENUM ('DEEP_LINK', 'AFFILIATE', 'API', 'NATIVE');

-- CreateEnum
CREATE TYPE "BookingModelStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('REQUIRES_PAYMENT', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('ACTION_REQUIRED', 'PLAN_MOMENTUM', 'AVAILABILITY_OPPORTUNITY', 'RELEVANT_INVENTORY', 'BOOKING_CHANGE', 'REMINDER', 'SOCIAL_ACTIVITY');

-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('WRONG_INFO', 'RECOMMENDATION_FEEDBACK', 'BOOKING_ISSUE', 'EVENT_CANCELLED', 'PRICE_INCORRECT', 'VENUE_INCORRECT', 'NOT_MY_VIBE', 'TOO_FAR', 'TOO_EXPENSIVE', 'ALREADY_KNEW', 'GREAT_RECOMMENDATION');

-- CreateEnum
CREATE TYPE "RewindRating" AS ENUM ('LOVE', 'LIKE', 'MEH', 'NO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "phone" TEXT,
    "displayName" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "homeCity" TEXT,
    "bio" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "label" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TasteProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryAffinity" JSONB NOT NULL,
    "budgetMinMinor" INTEGER NOT NULL DEFAULT 0,
    "budgetMaxMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "travelRadiusMeters" INTEGER NOT NULL DEFAULT 6000,
    "energyPreference" "EnergyLevel" NOT NULL DEFAULT 'MEDIUM',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TasteProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestIp" TEXT,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Relationship" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "friendId" TEXT NOT NULL,
    "status" "RelationshipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBlock" (
    "id" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactMatch" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "matchedUserId" TEXT NOT NULL,
    "contactHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Crew" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "defaultCity" TEXT,
    "createdById" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Crew_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewMember" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CrewRole" NOT NULL DEFAULT 'MEMBER',
    "status" "CrewMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrewMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewDNA" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "confidence" "DnaConfidence" NOT NULL DEFAULT 'LOW',
    "topCategories" JSONB NOT NULL,
    "medianSpendMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "bestNights" JSONB NOT NULL,
    "usualAreas" JSONB NOT NULL,
    "planningPersonality" "PlanningPersonality" NOT NULL DEFAULT 'MIXED',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrewDNA_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "encryptedTokenRef" TEXT NOT NULL,
    "status" "CalendarConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityWindow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "busy" BOOLEAN NOT NULL,
    "source" "AvailabilitySource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categories" JSONB NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "address" TEXT,
    "city" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experience" (
    "id" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ExperienceCategory" NOT NULL,
    "subcategories" JSONB NOT NULL,
    "venueId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "priceMinMinor" INTEGER,
    "priceMaxMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "bookingStatus" "BookingStatus" NOT NULL DEFAULT 'UNKNOWN',
    "imageUrl" TEXT,
    "tags" JSONB NOT NULL,
    "qualityScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderListing" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerListingId" TEXT NOT NULL,
    "experienceId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "externalUrl" TEXT NOT NULL,
    "commissionEligible" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanRecommendation" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanRecommendationOption" (
    "id" TEXT NOT NULL,
    "planRecommendationId" TEXT NOT NULL,
    "experienceId" TEXT NOT NULL,
    "matchScore" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "PlanRecommendationOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "experienceId" TEXT,
    "sourceOptionId" TEXT,
    "title" TEXT NOT NULL,
    "status" "PlanStatusValue" NOT NULL DEFAULT 'IDEA',
    "proposedByUserId" TEXT NOT NULL,
    "publicSlug" TEXT NOT NULL,
    "readyThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanMember" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanVote" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vote" "VoteValue" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "model" "BookingModel" NOT NULL,
    "status" "BookingModelStatus" NOT NULL DEFAULT 'PENDING',
    "externalUrl" TEXT,
    "externalRef" TEXT,
    "amountMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "failedReason" TEXT,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingParticipant" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BookingParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerIntentId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "refundedAmountMinor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "deepLink" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentSignal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "crewId" TEXT,
    "planId" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "context" TEXT NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewindSignal" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" "RewindRating" NOT NULL,
    "reasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewindSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperimentAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "experimentKey" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "planId" TEXT,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT,
    "channel" TEXT NOT NULL,
    "clickedAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3),
    "signedUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");

-- CreateIndex
CREATE INDEX "LocationPreference_userId_idx" ON "LocationPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TasteProfile_userId_key" ON "TasteProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_purpose_idx" ON "AuthToken"("userId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "OAuthIdentity_userId_idx" ON "OAuthIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthIdentity_provider_providerUserId_key" ON "OAuthIdentity"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Relationship_userId_friendId_key" ON "Relationship"("userId", "friendId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBlock_initiatorId_targetId_key" ON "UserBlock"("initiatorId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactMatch_ownerId_matchedUserId_key" ON "ContactMatch"("ownerId", "matchedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Crew_inviteCode_key" ON "Crew"("inviteCode");

-- CreateIndex
CREATE INDEX "Crew_createdById_idx" ON "Crew"("createdById");

-- CreateIndex
CREATE INDEX "CrewMember_userId_idx" ON "CrewMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CrewMember_crewId_userId_key" ON "CrewMember"("crewId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CrewDNA_crewId_key" ON "CrewDNA"("crewId");

-- CreateIndex
CREATE INDEX "CalendarConnection_userId_idx" ON "CalendarConnection"("userId");

-- CreateIndex
CREATE INDEX "AvailabilityWindow_userId_startsAt_endsAt_idx" ON "AvailabilityWindow"("userId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Experience_canonicalKey_key" ON "Experience"("canonicalKey");

-- CreateIndex
CREATE INDEX "Experience_category_startsAt_idx" ON "Experience"("category", "startsAt");

-- CreateIndex
CREATE INDEX "Experience_qualityScore_idx" ON "Experience"("qualityScore");

-- CreateIndex
CREATE INDEX "ProviderListing_experienceId_idx" ON "ProviderListing"("experienceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderListing_providerId_providerListingId_key" ON "ProviderListing"("providerId", "providerListingId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_sourceOptionId_key" ON "Plan"("sourceOptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_publicSlug_key" ON "Plan"("publicSlug");

-- CreateIndex
CREATE INDEX "Plan_crewId_status_idx" ON "Plan"("crewId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlanMember_planId_userId_key" ON "PlanMember"("planId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVote_planId_userId_key" ON "PlanVote"("planId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingParticipant_bookingId_userId_key" ON "BookingParticipant"("bookingId", "userId");

-- CreateIndex
CREATE INDEX "IntentSignal_name_occurredAt_idx" ON "IntentSignal"("name", "occurredAt");

-- CreateIndex
CREATE INDEX "IntentSignal_userId_occurredAt_idx" ON "IntentSignal"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "IntentSignal_crewId_idx" ON "IntentSignal"("crewId");

-- CreateIndex
CREATE INDEX "IntentSignal_planId_idx" ON "IntentSignal"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "RewindSignal_planId_userId_key" ON "RewindSignal"("planId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperimentAssignment_userId_experimentKey_key" ON "ExperimentAssignment"("userId", "experimentKey");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationPreference" ADD CONSTRAINT "LocationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TasteProfile" ADD CONSTRAINT "TasteProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMatch" ADD CONSTRAINT "ContactMatch_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMatch" ADD CONSTRAINT "ContactMatch_matchedUserId_fkey" FOREIGN KEY ("matchedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewDNA" ADD CONSTRAINT "CrewDNA_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityWindow" ADD CONSTRAINT "AvailabilityWindow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderListing" ADD CONSTRAINT "ProviderListing_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderListing" ADD CONSTRAINT "ProviderListing_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanRecommendationOption" ADD CONSTRAINT "PlanRecommendationOption_planRecommendationId_fkey" FOREIGN KEY ("planRecommendationId") REFERENCES "PlanRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanRecommendationOption" ADD CONSTRAINT "PlanRecommendationOption_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_sourceOptionId_fkey" FOREIGN KEY ("sourceOptionId") REFERENCES "PlanRecommendationOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanMember" ADD CONSTRAINT "PlanMember_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanMember" ADD CONSTRAINT "PlanMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVote" ADD CONSTRAINT "PlanVote_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanVote" ADD CONSTRAINT "PlanVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingParticipant" ADD CONSTRAINT "BookingParticipant_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingParticipant" ADD CONSTRAINT "BookingParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntentSignal" ADD CONSTRAINT "IntentSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackSignal" ADD CONSTRAINT "FeedbackSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewindSignal" ADD CONSTRAINT "RewindSignal_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewindSignal" ADD CONSTRAINT "RewindSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentAssignment" ADD CONSTRAINT "ExperimentAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
