BEGIN;

ALTER TABLE "ManualRecoveryResolutionAuditOutbox"
  DROP CONSTRAINT "ManualRecoveryResolutionAuditOutbox_state_check",
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD CONSTRAINT "ManualRecoveryResolutionAuditOutbox_leaseOwner_check" CHECK ("leaseOwner" IS NULL OR "leaseOwner" ~ '[^[:space:]]'),
  ADD CONSTRAINT "ManualRecoveryResolutionAuditOutbox_deliveryState_check" CHECK (
    ("state" = 'pending' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "deliveredAt" IS NULL)
    OR ("state" = 'delivering' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "deliveredAt" IS NULL)
    OR ("state" = 'delivered' AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "deliveredAt" IS NOT NULL)
  );

COMMIT;
