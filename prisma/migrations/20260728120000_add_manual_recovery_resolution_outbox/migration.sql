BEGIN;

CREATE TABLE "ManualRecoveryResolution" (
  "id" TEXT NOT NULL,
  "expiredEventId" TEXT NOT NULL,
  "bankCode" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManualRecoveryResolution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualRecoveryResolution_outcomeReason_check" CHECK (
    ("outcome" = 'safe_to_retry' AND "reason" = 'verified_no_mutation')
    OR ("outcome" = 'mutation_confirmed' AND "reason" = 'verified_mutation')
    OR ("outcome" = 'resolved_no_retry' AND "reason" = 'closed_without_retry')
  ),
  CONSTRAINT "ManualRecoveryResolution_operatorId_check" CHECK ("operatorId" ~ '[^[:space:]]')
);

CREATE UNIQUE INDEX "ManualRecoveryResolution_expiredEventId_key"
  ON "ManualRecoveryResolution"("expiredEventId");
CREATE UNIQUE INDEX "ManualRecoveryResolution_bankCode_runId_key"
  ON "ManualRecoveryResolution"("bankCode", "runId");

CREATE TABLE "ManualRecoveryResolutionAuditOutbox" (
  "id" TEXT NOT NULL,
  "resolutionId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManualRecoveryResolutionAuditOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualRecoveryResolutionAuditOutbox_state_check" CHECK ("state" = 'pending')
);

CREATE UNIQUE INDEX "ManualRecoveryResolutionAuditOutbox_resolutionId_key"
  ON "ManualRecoveryResolutionAuditOutbox"("resolutionId");

ALTER TABLE "ManualRecoveryResolutionAuditOutbox"
  ADD CONSTRAINT "ManualRecoveryResolutionAuditOutbox_resolutionId_fkey"
  FOREIGN KEY ("resolutionId") REFERENCES "ManualRecoveryResolution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
