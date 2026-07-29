BEGIN;

ALTER TABLE "BankSessionExpiryEpisode"
  ADD COLUMN "terminalFailureReason" TEXT,
  ADD COLUMN "terminalFailureReconciledAt" TIMESTAMP(3);

ALTER TABLE "BankSessionExpiryEpisode"
  ADD CONSTRAINT "BankSessionExpiryEpisode_terminalFailure_check" CHECK (
    ("terminalFailureReason" IS NULL AND "terminalFailureReconciledAt" IS NULL)
    OR (
      "terminalFailureReason" IN ('job_failed', 'job_missing')
      AND "terminalFailureReconciledAt" IS NOT NULL
      AND "publicationState" = 'published'
      AND "publicationClaimToken" ~ '[^[:space:]]'
    )
  );
