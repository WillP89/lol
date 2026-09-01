-- CreateEnum
CREATE TYPE "ImageSource" AS ENUM ('TICKETMASTER', 'EVENTBRITE', 'OPENSTREETMAP', 'WIKIPEDIA', 'THESPORTSDB', 'MANUAL');

-- AlterTable
ALTER TABLE "Experience" ADD COLUMN     "imageSource" "ImageSource";
