-- CreateEnum
CREATE TYPE "CrewRecommendationStatus" AS ENUM ('SENT', 'MORE_LIKE_THIS', 'NOT_FOR_US', 'TOO_FAR', 'TOO_EXPENSIVE', 'WRONG_VIBE');

-- CreateTable
CREATE TABLE "CrewRecommendationSettings" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxPerWeek" INTEGER NOT NULL DEFAULT 2,
    "travelRadiusMeters" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrewRecommendationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewRecommendation" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "experienceId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasonText" TEXT NOT NULL,
    "status" "CrewRecommendationStatus" NOT NULL DEFAULT 'SENT',
    "planId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "CrewRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrewRecommendationSettings_crewId_key" ON "CrewRecommendationSettings"("crewId");

-- CreateIndex
CREATE UNIQUE INDEX "CrewRecommendation_planId_key" ON "CrewRecommendation"("planId");

-- CreateIndex
CREATE INDEX "CrewRecommendation_crewId_createdAt_idx" ON "CrewRecommendation"("crewId", "createdAt");

-- CreateIndex
CREATE INDEX "CrewRecommendation_crewId_experienceId_idx" ON "CrewRecommendation"("crewId", "experienceId");

-- AddForeignKey
ALTER TABLE "CrewRecommendationSettings" ADD CONSTRAINT "CrewRecommendationSettings_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewRecommendation" ADD CONSTRAINT "CrewRecommendation_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewRecommendation" ADD CONSTRAINT "CrewRecommendation_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewRecommendation" ADD CONSTRAINT "CrewRecommendation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
