BEGIN;

ALTER TABLE "BankSessionExpiryEpisode"
  ADD COLUMN "consumerAttemptState" TEXT;

UPDATE "BankSessionExpiryEpisode"
  SET "consumerClaimToken" = NULL, "consumerAttemptState" = NULL
  WHERE "consumerClaimToken" IS NOT NULL AND "restoredAuditDeliveredAt" IS NOT NULL;

UPDATE "BankSessionExpiryEpisode"
  SET "consumerAttemptState" = 'reserved'
  WHERE "consumerClaimToken" IS NOT NULL AND "restoredAuditDeliveredAt" IS NULL;

ALTER TABLE "BankSessionExpiryEpisode"
  DROP CONSTRAINT "BankSessionExpiryEpisode_consumerClaimToken_check",
  ADD CONSTRAINT "BankSessionExpiryEpisode_consumerAttempt_check" CHECK (
    ("consumerClaimToken" IS NULL AND "consumerAttemptState" IS NULL)
    OR (
      "consumerClaimToken" IS NOT NULL
      AND "consumerAttemptState" IS NOT NULL
      AND "consumerClaimToken" ~ '[^[:space:]]'
      AND "consumerAttemptState" IN ('reserved', 'mutation_started', 'manual_recovery_required', 'resolved')
      AND ("consumerAttemptState" <> 'reserved' OR "restoredAuditDeliveredAt" IS NULL)
    )
  );

COMMIT;
