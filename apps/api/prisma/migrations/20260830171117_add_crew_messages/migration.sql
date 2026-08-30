-- CreateTable
CREATE TABLE "CrewMessage" (
    "id" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrewMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrewMessage_crewId_createdAt_idx" ON "CrewMessage"("crewId", "createdAt");

-- AddForeignKey
ALTER TABLE "CrewMessage" ADD CONSTRAINT "CrewMessage_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMessage" ADD CONSTRAINT "CrewMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
