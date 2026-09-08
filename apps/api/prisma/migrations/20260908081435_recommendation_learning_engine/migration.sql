-- CreateEnum
CREATE TYPE "RecommendationConfidence" AS ENUM ('HIGH', 'MEDIUM', 'EXPLORATORY');

-- AlterTable
ALTER TABLE "CrewRecommendation" ADD COLUMN     "confidence" "RecommendationConfidence" NOT NULL DEFAULT 'MEDIUM';

-- AlterTable
ALTER TABLE "CrewRecommendationSettings" ALTER COLUMN "maxPerWeek" SET DEFAULT 3;

-- CreateTable
CREATE TABLE "RecommendationResponse" (
    "id" TEXT NOT NULL,
    "crewRecommendationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "CrewRecommendationStatus" NOT NULL,
    "reasonCode" TEXT,
    "reasonText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendationResponse_userId_idx" ON "RecommendationResponse"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationResponse_crewRecommendationId_userId_key" ON "RecommendationResponse"("crewRecommendationId", "userId");

-- AddForeignKey
ALTER TABLE "RecommendationResponse" ADD CONSTRAINT "RecommendationResponse_crewRecommendationId_fkey" FOREIGN KEY ("crewRecommendationId") REFERENCES "CrewRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationResponse" ADD CONSTRAINT "RecommendationResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
