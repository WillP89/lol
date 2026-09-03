-- AlterTable
ALTER TABLE "CrewMember" ADD COLUMN     "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastEmailNotifiedAt" TIMESTAMP(3);
