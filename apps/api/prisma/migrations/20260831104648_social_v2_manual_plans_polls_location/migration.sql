-- CreateEnum
CREATE TYPE "PollKind" AS ENUM ('GENERAL', 'AVAILABILITY');

-- AlterEnum
ALTER TYPE "ExperienceCategory" ADD VALUE 'CUSTOM';

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "manualStartsAt" TIMESTAMP(3),
ADD COLUMN     "manualVenueName" TEXT;

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "homeLat" DOUBLE PRECISION,
ADD COLUMN     "homeLng" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "MessagePoll" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "kind" "PollKind" NOT NULL DEFAULT 'GENERAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagePoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagePollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "option" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagePollVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessagePoll_messageId_key" ON "MessagePoll"("messageId");

-- CreateIndex
CREATE INDEX "MessagePollVote_pollId_idx" ON "MessagePollVote"("pollId");

-- CreateIndex
CREATE UNIQUE INDEX "MessagePollVote_pollId_userId_key" ON "MessagePollVote"("pollId", "userId");

-- AddForeignKey
ALTER TABLE "MessagePoll" ADD CONSTRAINT "MessagePoll_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "CrewMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagePollVote" ADD CONSTRAINT "MessagePollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "MessagePoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagePollVote" ADD CONSTRAINT "MessagePollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
