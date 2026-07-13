CREATE TABLE "BankSessionExpiryEpisode" (
  "bankCode" TEXT NOT NULL,
  "expiredEventId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "expiredAuditDeliveredAt" TIMESTAMP(3),
  "restoredAuditDeliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankSessionExpiryEpisode_pkey" PRIMARY KEY ("bankCode")
);

CREATE UNIQUE INDEX "BankSessionExpiryEpisode_expiredEventId_key"
  ON "BankSessionExpiryEpisode"("expiredEventId");
CREATE UNIQUE INDEX "BankSessionExpiryEpisode_runId_key"
  ON "BankSessionExpiryEpisode"("runId");
