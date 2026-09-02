-- AlterTable
ALTER TABLE "CrewRecommendationSettings" ADD COLUMN     "categoryPreferences" TEXT[] DEFAULT ARRAY[]::TEXT[];
