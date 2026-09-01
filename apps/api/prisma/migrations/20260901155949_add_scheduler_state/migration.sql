-- CreateTable
CREATE TABLE "SchedulerState" (
    "jobName" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastClaimedAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerState_pkey" PRIMARY KEY ("jobName")
);
