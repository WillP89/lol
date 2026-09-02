-- AlterTable
ALTER TABLE "CrewRecommendationSettings" ADD COLUMN     "interestPreferences" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "TasteProfile" ADD COLUMN     "categoryBudget" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "freeTextSignals" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "interestAffinity" JSONB NOT NULL DEFAULT '{}';
