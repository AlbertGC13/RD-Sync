BEGIN;

ALTER TABLE "BankSessionExpiryEpisode"
  ADD COLUMN "consumerAttemptSource" TEXT,
  ADD COLUMN "consumerLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "BankSessionExpiryEpisode"
  ADD CONSTRAINT "BankSessionExpiryEpisode_consumerLease_check" CHECK (
    ("consumerAttemptSource" IS NULL AND "consumerLeaseExpiresAt" IS NULL)
    OR (
      "consumerAttemptSource" IS NOT NULL
      AND "consumerAttemptSource" IN ('scheduled', 'scrape_time')
      AND "consumerAttemptState" IS NOT NULL
      AND (
        (
          "consumerAttemptState" IN ('reserved', 'mutation_started')
          AND "consumerLeaseExpiresAt" IS NOT NULL
          AND "terminalFailureReason" IS NULL
        )
        OR (
          "consumerAttemptState" IN ('manual_recovery_required', 'resolved')
          AND "consumerLeaseExpiresAt" IS NULL
        )
      )
      AND (
        ("consumerAttemptSource" = 'scheduled' AND "publicationState" = 'published' AND "publicationClaimToken" ~ '[^[:space:]]')
        OR ("consumerAttemptSource" = 'scrape_time' AND "publicationState" <> 'published')
      )
    )
  );

COMMIT;
